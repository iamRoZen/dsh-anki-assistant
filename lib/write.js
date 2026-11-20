/**
 * 写入闸门：先出计划（预览），再提交。
 *
 * 三条硬规则：
 * 1. 计划绑定内容与目标——草稿、方案版本、牌组或模型任何一处变了，旧计划立刻失效；
 * 2. 新增用标签销账，重跑不会重复；
 * 3. 改卡只有真的改到目标字段才算成功，"内容已相同"与"卡片不存在"都明确报出。
 * 回读一律对照提交时落盘的快照，而不是"当前应有的样子"。
 */
import { createHash, randomBytes } from 'node:crypto'
import { dataPath } from './paths.js'
import { loadBatch, saveBatch, withBatchLock } from './batch.js'
import { isNoteId, isNoteInfo } from './anki.js'
import { readJson, writeJson } from './store.js'
import { evaluate, compareFields } from './rules.js'
import { getScheme } from './scheme.js'
import { clozeFieldName, scanCloze } from './cloze.js'

export class WriteError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WriteError'
  }
}

export const GLOBAL_TAG = 'ai-assistant'

function checkPlanId(id) {
  if (typeof id !== 'string' || !/^p-[a-z0-9]+-[a-f0-9]+$/u.test(id)) throw new WriteError('计划 id 不合法')
  return id
}

export function planFile(root, id) {
  return dataPath(root, 'plans', checkPlanId(id) + '.json')
}

export function commitFile(root, id) {
  return dataPath(root, 'plans', checkPlanId(id) + '.commit.json')
}

/** 批次标签带原始 id 的哈希后缀，避免不同 id 归一化后撞车。 */
export function batchTag(batchId) {
  const safe = String(batchId).replace(/[^A-Za-z0-9]/g, '-').slice(0, 32)
  const hash = createHash('sha1').update(String(batchId)).digest('hex').slice(0, 8)
  return `${GLOBAL_TAG}::${safe}-${hash}`
}

function digestOf(plan) {
  return createHash('sha256')
    .update(JSON.stringify({
      format: plan.format,
      id: plan.id,
      batchId: plan.batchId,
      batchRevision: plan.batchRevision,
      mode: plan.mode,
      scheme: plan.scheme,
      deck: plan.deck,
      model: plan.model,
      items: plan.items.map(({ id, noteId, fields, before, status, batchStatus }) => ({ id, noteId, fields, before, status, batchStatus })),
    }))
    .digest('hex')
}

function noteFields(scheme, item) {
  return Object.fromEntries(scheme.output.fields.map(({ name }) => [name, item.fields?.[name] ?? '']))
}

/** 本插件写过的卡的首字段集合，用于跨批次判重。 */
async function writtenKeys(anki) {
  const found = await anki.findNotes(`tag:${GLOBAL_TAG}`)
  if (!found.length) return new Set()
  const info = [...(await readNotes(anki, found)).values()]
  const keys = new Set()
  for (const note of info ?? []) {
    const first = Object.values(note.fields ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.value
    if (typeof first === 'string' && first.trim()) keys.add(first.trim())
  }
  return keys
}

export function fieldQuery(field, key) {
  const escape = (value) => value.replace(/[\\":_*]/gu, '\\$&')
  const text = String(key).replace(/\s+/gu, ' ').trim()
  return '"' + escape(field) + ':' + escape(text) + '"'
}

/**
 * 生成计划：只读 Anki，不写。
 * mode=add 新建；mode=update 按 noteId 改已有卡。
 */
export async function buildPlan({ root, batch, scheme, anki, mode = 'add', validator = null }) {
  if (!['add', 'update'].includes(mode)) throw new WriteError(`未知模式：${mode}`)
  if (!scheme.output?.fields?.length) throw new WriteError('方案没有制卡字段，请先补充模型和字段')
  const modelFields = await anki.modelFields(batch.target.model).catch((error) => {
    throw new WriteError(`读不到笔记模型「${batch.target.model}」的字段：${error.message}`)
  })
  const schemeIssues = compareFields(scheme.output.fields, modelFields)
  const keyField = scheme.output.fields[0].name

  const candidates = mode === 'update'
    ? batch.items.filter((item) => isNoteId(item.noteId) && item.status !== 'parked')
    : batch.items.filter((item) => !['written', 'parked'].includes(item.status))
  if (mode === 'update' && candidates.length === 0) {
    throw new WriteError('改卡模式需要题上已有 noteId；先写入或用 mark noteId=… 回填')
  }

  const ours = mode === 'add' ? await writtenKeys(anki) : new Set()
  const currentById = mode === 'update'
    ? await readNotes(anki, candidates.map((item) => item.noteId))
    : new Map()

  const items = []
  const seen = new Set()
  // 出处状态属于整份计划：在循环外声明，否则组装 plan 时越界。
  // 没有适配器返回的状态就保持 null，绝不在展示层当成「已核」。
  let legacySource = null
  for (const item of candidates) {
    const fields = noteFields(scheme, item)
    const key = String(fields[keyField] ?? '').trim()
    const clozeField = clozeFieldName(scheme)
    const issues = [
      ...evaluate(fields, scheme.quality?.rules),
      ...(clozeField ? scanCloze(fields[clozeField]).map((issue) => ({
        ruleId: `cloze:${issue.code}`,
        field: clozeField,
        message: issue.message,
      })) : []),
    ]
    let status = 'ready'
    let before = null
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value !== 'string') issues.push({ ruleId: 'field-type', field: name, message: '字段必须是字符串' })
    }

    if (!key) {
      issues.push({ ruleId: 'dedupe-key', field: keyField, message: '判重键为空' })
      status = 'blocked'
    }

    if (mode === 'update') {
      const note = currentById.get(item.noteId)
      before = fieldSnapshot(note)
      if (!note) {
        issues.push({ ruleId: 'note-missing', field: keyField, message: '卡片 ' + item.noteId + ' 不存在' })
      } else if (note.modelName !== batch.target.model || !before || Object.keys(fields).some((name) => !Object.hasOwn(before, name))) {
        issues.push({ ruleId: 'note-model', field: keyField, message: '卡片模型或字段与更新目标不同' })
      } else if (!await isInDeck(anki, note, batch.target.deck)) {
        issues.push({ ruleId: 'note-deck', field: keyField, message: '笔记在目标牌组中没有卡片' })
      }
      if (seen.has(item.noteId)) issues.push({ ruleId: 'duplicate-note-id', field: keyField, message: '同一笔记在本批多次更新' })
      seen.add(item.noteId)
    } else {
      if (seen.has(key)) {
        issues.push({ ruleId: 'duplicate-in-batch', field: keyField, message: '本批内重复' })
        status = 'blocked'
      }
      seen.add(key)
      if (key && ours.has(key)) {
        issues.push({ ruleId: 'duplicate-in-anki', field: keyField, message: '本插件已写过同样的首字段' })
        status = 'blocked'
      } else if (key) {
        const found = await anki.findNotes(fieldQuery(keyField, key))
        if ((found ?? []).length > 0) {
          issues.push({ ruleId: 'duplicate-in-anki', field: keyField, message: `Anki 中已有 ${found.length} 条同字段` })
          status = 'blocked'
        }
      }
    }

    if (issues.length > 0 && status !== 'blocked') status = 'blocked'

    // 旧判据：由随包 Python 原实现执行。失败不吞、不降级、不算通过。
    if (validator) {
      const verdict = await validator(fields)
      legacySource = verdict.source ?? null
      for (const finding of verdict.issues ?? []) {
        issues.push({
          ruleId: `legacy:${finding.code}`,
          field: '答案',
          message: finding.message,
        })
      }
      if (verdict.ok === false && !verdict.issues?.length) issues.push({ ruleId: 'validator-rejected', field: keyField, message: '方案校验器拒绝了这组字段' })
      if (issues.length) status = 'blocked'
    }

    items.push({
      id: item.id,
      noteId: item.noteId ?? null,
      fields,
      key,
      status,
      issues,
      batchStatus: item.status,
      before,
    })
  }

  const plan = {
    id: `p-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`,
    format: 2,
    batchId: batch.id,
    batchRevision: batch.revision ?? 0,
    mode,
    scheme: { id: scheme.id, version: scheme.version },
    deck: batch.target.deck,
    model: batch.target.model,
    items,
    modelIssues: schemeIssues,
    legacy: scheme.quality?.validator ?? scheme.quality?.legacy ?? null,
    legacySource,
    createdAt: new Date().toISOString(),
  }
  plan.digest = digestOf(plan)

  const blocked = items.filter((item) => item.status === 'blocked')
  if (schemeIssues.length === 0) await writeJson(planFile(root, plan.id), plan)
  return { plan, blocked, schemeIssues }
}

/** 比较计划所见状态，允许恢复本计划已经落盘的台账更新。 */
export async function assertPlanFresh({ root, batch, plan, receipt }) {
  if (plan.format !== 2) throw new WriteError('此计划使用旧版格式，请重新 plan')
  if (digestOf(plan) !== plan.digest) throw new WriteError('计划内容被改动过，请重新 plan')
  const scheme = await getScheme(root, plan.scheme.id, plan.scheme.version)
  if (!scheme || batch.scheme?.id !== plan.scheme.id || batch.scheme?.version !== plan.scheme.version) {
    throw new WriteError('批次已改绑方案或方案读不到，旧计划作废，请重新 plan')
  }
  if (batch.target?.deck !== plan.deck || batch.target?.model !== plan.model) {
    throw new WriteError('目标已从 ' + plan.deck + '/' + plan.model + ' 改为 ' + batch.target?.deck + '/' + batch.target?.model + '，请重新 plan')
  }
  const posted = new Map((receipt?.outcomes ?? []).map((result) => [result.id, result]))
  const currentItems = new Map(batch.items.map((item) => [item.id, item]))
  for (const item of plan.items) {
    const current = currentItems.get(item.id)
    if (!current) throw new WriteError('题目 ' + item.id + ' 已不在批次里，请重新 plan')
    if (!sameFields(noteFields(scheme, current), item.fields)) {
      throw new WriteError('题目 ' + item.id + ' 的草稿改过了，旧计划作废，请重新 plan')
    }
    const result = posted.get(item.id)
    const applied = result && current.status === (result.ok ? 'written' : 'failed')
      && (current.noteId ?? null) === (result.ok ? result.noteId : item.noteId)
    if (!applied && ((current.noteId ?? null) !== item.noteId || current.status !== item.batchStatus)) {
      throw new WriteError('题目 ' + item.id + ' 的状态或 noteId 变了，请重新 plan')
    }
  }
  if (!receipt && (batch.revision ?? 0) !== plan.batchRevision) {
    throw new WriteError('批次修订已变，请重新 plan')
  }
  return scheme
}

async function readNotes(anki, ids) {
  const notes = await anki.notesInfo(ids)
  if (!Array.isArray(notes)) throw new WriteError('Anki 未返回笔记列表')
  const wanted = new Set(ids)
  return new Map(notes.filter((note) => isNoteInfo(note) && wanted.has(note.noteId)).map((note) => [note.noteId, note]))
}

async function isInDeck(anki, note, deck) {
  if (!Array.isArray(note.cards) || !note.cards.length) return false
  const cards = await anki.cardsInfo(note.cards)
  if (!Array.isArray(cards)) throw new WriteError('Anki 未返回卡片所在牌组')
  return cards.some((card) => note.cards.includes(card?.cardId) && card.deckName === deck)
}

function fieldSnapshot(note) {
  const entries = Object.entries(note?.fields ?? {})
  if (!entries.length || entries.some(([, field]) => typeof field?.value !== 'string')) return null
  return Object.fromEntries(entries.map(([name, field]) => [name, field.value]))
}

function sameFields(left, right) {
  if (!left || !right) return false
  const names = Object.keys(left)
  return names.length === Object.keys(right).length
    && names.every((name) => Object.hasOwn(right, name) && JSON.stringify(left[name]) === JSON.stringify(right[name]))
}

function planTag(plan) {
  return GLOBAL_TAG + '::plan-' + plan.id
}

function itemTag(plan, item) {
  return planTag(plan) + '-' + createHash('sha256').update(String(item.id)).digest('hex').slice(0, 20)
}

function ankiNote(plan, item) {
  return {
    deckName: plan.deck,
    modelName: plan.model,
    fields: item.fields,
    tags: [GLOBAL_TAG, batchTag(plan.batchId), planTag(plan), itemTag(plan, item)],
    options: { allowDuplicate: false },
  }
}

function failed(item, error) {
  return { id: item.id, ok: false, error }
}

function succeeded(item, noteId, fields) {
  return { id: item.id, ok: true, noteId, fields }
}

async function checkAdded(state, item, noteId) {
  const note = (await readNotes(state.anki, [noteId])).get(noteId)
  const fields = fieldSnapshot(note)
  if (!fields) throw new WriteError('尚未读到笔记 ' + noteId + ' 的完整字段')
  if (note.modelName !== state.plan.model || !note.tags?.includes(itemTag(state.plan, item))
    || !sameFields(fields, item.fields) || !await isInDeck(state.anki, note, state.plan.deck)) {
    state.outcomes.set(item.id, { ...failed(item, '新增笔记的牌组、模型、标记或字段与计划不符'), noteId })
    return
  }
  state.outcomes.set(item.id, succeeded(item, noteId, fields))
}

async function reconcileAdds(state, items) {
  const { plan, anki, attempts, outcomes } = state
  const attempted = items.filter((item) => attempts.has(item.id) && !outcomes.has(item.id))
  if (!attempted.length) return
  const unknown = attempted.some((item) => !isNoteId(attempts.get(item.id).noteId))
  const ids = unknown ? await anki.findNotes('tag:' + planTag(plan)) : []
  if (!Array.isArray(ids)) throw new WriteError('Anki 未返回可用于对账的笔记 ID')
  const found = ids.length ? [...(await readNotes(anki, ids)).values()] : []
  if (found.length !== new Set(ids).size) throw new WriteError('Anki 对账结果不完整')
  for (const item of attempted) {
    const attempt = attempts.get(item.id)
    const matches = isNoteId(attempt.noteId) ? [attempt.noteId] : found
      .filter((note) => note.tags?.includes(itemTag(plan, item)))
      .map((note) => note.noteId)
    if (matches.length > 1) {
      outcomes.set(item.id, failed(item, '发现多张属于本计划同一题的笔记，需要人工核对'))
    } else if (matches.length === 1) {
      attempt.noteId = matches[0]
      await state.persist()
      await checkAdded(state, item, matches[0])
    }
  }
  await state.persist()
}

async function rememberAddResults(state, items, ids) {
  if (!Array.isArray(ids) || ids.length !== items.length) throw new WriteError('Anki 新增结果缺少对应的笔记 ID')
  for (const [index, id] of ids.entries()) {
    const item = items[index]
    if (isNoteId(id)) state.attempts.get(item.id).noteId = id
    else if (id === null) state.outcomes.set(item.id, failed(item, 'Anki 未创建笔记，请检查重复或字段'))
    else throw new WriteError('Anki 返回了无效的笔记 ID')
  }
  // 保存 Anki 已确认的 ID，再回读字段。回读失败时可以续查该 ID。
  await state.persist()
  for (const item of items) {
    if (!state.outcomes.has(item.id)) {
      await checkAdded(state, item, state.attempts.get(item.id).noteId)
      await state.persist()
    }
  }
}

async function commitAdds(state, items) {
  const { anki, plan, attempts, outcomes } = state
  await reconcileAdds(state, items)
  const remaining = items.filter((item) => !outcomes.has(item.id))
  for (let offset = 0; offset < remaining.length; offset += 20) {
    const chunk = remaining.slice(offset, offset + 20)
    for (const item of chunk) attempts.set(item.id, { id: item.id })
    await state.persist()
    let ids
    try {
      ids = await anki.addNotes(chunk.map((item) => ankiNote(plan, item)))
    } catch (error) {
      await reconcileAdds(state, chunk)
      if (error.uncertain) throw error
      for (const item of chunk.filter((entry) => !outcomes.has(entry.id))) {
        state.assertLocked()
        let noteId
        try {
          noteId = await anki.addNote(ankiNote(plan, item))
        } catch (singleError) {
          if (singleError.uncertain) throw singleError
          outcomes.set(item.id, failed(item, singleError.message))
          await state.persist()
          continue
        }
        await rememberAddResults(state, [item], [noteId])
      }
      continue
    }
    await rememberAddResults(state, chunk, ids)
  }
}

async function commitUpdates(state, items) {
  const { anki, plan, attempts, outcomes } = state
  for (const item of items) {
    if (outcomes.has(item.id)) continue
    const note = (await readNotes(anki, [item.noteId])).get(item.noteId)
    const before = fieldSnapshot(note)
    const changed = Object.keys(item.fields).filter((name) => item.before[name] !== item.fields[name])
    let result
    if (!before || note.modelName !== plan.model || !await isInDeck(anki, note, plan.deck)) {
      result = failed(item, '笔记不存在或牌组、模型、字段变了')
    } else if (sameFields(before, item.fields)) {
      result = attempts.has(item.id)
        ? { ...succeeded(item, item.noteId, before), changed }
        : failed(item, '目标字段内容已相同，未改动')
    } else if (!sameFields(before, item.before)) {
      result = failed(item, '计划生成后 Anki 字段已改动，请重新 plan')
    } else {
      attempts.set(item.id, { id: item.id, noteId: item.noteId })
      await state.persist()
      try {
        await anki.updateNoteFields({ id: item.noteId, fields: item.fields })
      } catch (error) {
        if (error.uncertain) throw error
        result = failed(item, error.message)
      }
      const updated = (await readNotes(anki, [item.noteId])).get(item.noteId)
      const after = fieldSnapshot(updated)
      if (!after) throw new WriteError('改卡后尚未读到笔记的完整字段')
      if (updated.modelName === plan.model && sameFields(after, item.fields)) {
        result = { ...succeeded(item, item.noteId, after), changed }
      } else {
        result ??= failed(item, '改卡后模型或字段与计划不符')
      }
    }
    outcomes.set(item.id, result)
    await state.persist()
  }
}

async function applyReceipt(root, batch, results) {
  let changed = false
  for (const entry of batch.items) {
    const result = results.get(entry.id)
    if (!result) continue
    const status = result.ok ? 'written' : 'failed'
    const noteId = result.ok ? result.noteId : entry.noteId
    const reason = result.ok ? undefined : result.error
    if (entry.status === status && entry.noteId === noteId && entry.reason === reason) continue
    entry.status = status
    entry.noteId = noteId
    if (reason === undefined) delete entry.reason
    else entry.reason = reason
    changed = true
  }
  if (changed) await saveBatch(root, batch)
}

export async function commitPlan({ root, plan, anki }) {
  return withBatchLock(root, plan.batchId, async (assertLocked) => {
    const existing = await loadCommit(root, plan.id)
    if (existing && existing.complete !== false) return existing.outcomes
    const batch = await loadBatch(root, plan.batchId)
    if (!batch) throw new WriteError('计划对应的批次 ' + plan.batchId + ' 不存在')
    const scheme = await assertPlanFresh({ root, batch, plan, receipt: existing })
    const items = plan.items.filter((item) => item.status === 'ready')
    const outcomes = new Map(existing?.outcomes.map((result) => [result.id, result]))
    const attempts = new Map(existing?.attempts.map((item) => [item.id, item]))
    const persist = async (complete = false) => {
      assertLocked()
      await writeJson(commitFile(root, plan.id), {
        planId: plan.id,
        batchId: plan.batchId,
        mode: plan.mode,
        scheme: plan.scheme,
        complete,
        ...(complete ? { committedAt: new Date().toISOString() } : { attempts: [...attempts.values()] }),
        outcomes: items.map((item) => outcomes.get(item.id)).filter(Boolean),
      })
    }
    const state = { plan, anki, attempts, outcomes, persist, assertLocked }
    let pendingMessage
    if (items.some((item) => !outcomes.has(item.id))) {
      const issues = compareFields(scheme.output.fields, await anki.modelFields(plan.model))
      if (issues.length) throw new WriteError('目标模型字段已变化，请重新 plan')
      try {
        if (plan.mode === 'update') await commitUpdates(state, items)
        else await commitAdds(state, items)
      } catch (error) {
        pendingMessage = error.message
      }
    }
    await persist()
    assertLocked()
    await applyReceipt(root, batch, outcomes)
    if (outcomes.size === items.length) await persist(true)
    return items.map((item) => outcomes.get(item.id) ?? { ...failed(item, pendingMessage), pending: true })
  })
}

/** 回读：对照提交时落盘的快照，缺卡、缺字段、字段不符都报。 */
export async function verifyCommitted({ root, planId, anki }) {
  const record = await loadCommit(root, planId)
  if (!record) throw new WriteError(`没有 ${planId} 的提交记录，先 commit`)
  const done = record.outcomes.filter((entry) => entry.ok)
  const mismatches = []
  if (done.length === 0) return { checked: 0, mismatches, mode: record.mode, pending: record.complete === false }
  const byId = await readNotes(anki, done.map((entry) => entry.noteId))
  for (const entry of done) {
    const note = byId.get(entry.noteId)
    if (!note) {
      mismatches.push({ id: entry.id, noteId: entry.noteId, field: '*', message: '卡片不存在' })
      continue
    }
    const fields = Object.entries(entry.fields ?? {})
    if (!fields.length) mismatches.push({ id: entry.id, noteId: entry.noteId, field: '*', message: '提交记录缺少有效字段快照' })
    for (const [name, value] of fields) {
      const actual = note.fields?.[name]
      if (actual === undefined) {
        mismatches.push({ id: entry.id, noteId: entry.noteId, field: name, message: '字段不存在' })
      } else if (String(actual.value ?? '') !== String(value)) {
        mismatches.push({ id: entry.id, noteId: entry.noteId, field: name, message: '字段内容与提交快照不一致' })
      }
    }
  }
  return { checked: done.length, mismatches, mode: record.mode, pending: record.complete === false }
}

export async function loadPlan(root, id) {
  const plan = await readJson(planFile(root, id))
  return plan?.id === id ? plan : null
}

export async function loadCommit(root, id) {
  const receipt = await readJson(commitFile(root, id))
  return receipt?.planId === id ? receipt : null
}
