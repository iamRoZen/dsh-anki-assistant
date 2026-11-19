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
import { join } from 'node:path'
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

export function planFile(root, id) {
  return join(root, 'plans', `${id}.json`)
}

export function commitFile(root, id) {
  return join(root, 'plans', `${id}.commit.json`)
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
      mode: plan.mode,
      scheme: plan.scheme,
      deck: plan.deck,
      model: plan.model,
      items: plan.items.map((item) => ({ id: item.id, noteId: item.noteId ?? null, fields: item.fields })),
    }))
    .digest('hex')
}

function noteFields(scheme, item) {
  const fields = {}
  for (const spec of scheme.output.fields) fields[spec.name] = item.fields?.[spec.name] ?? ''
  return fields
}

/** 本插件写过的卡的首字段集合，用于跨批次判重。 */
async function writtenKeys(anki) {
  const found = await anki.findNotes(`tag:${GLOBAL_TAG}`).catch(() => [])
  if (!(found ?? []).length) return new Set()
  const info = await anki.notesInfo(found).catch(() => [])
  const keys = new Set()
  for (const note of info ?? []) {
    const first = Object.values(note?.fields ?? {})[0]?.value
    if (typeof first === 'string' && first.trim()) keys.add(first.trim())
  }
  return keys
}

function fieldQuery(field, key) {
  const safe = String(key).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${field}:"${safe}"`
}

/**
 * 生成计划：只读 Anki，不写。
 * mode=add 新建；mode=update 按 noteId 改已有卡。
 */
export async function buildPlan({ root, batch, scheme, anki, mode = 'add', validator = null }) {
  if (!['add', 'update'].includes(mode)) throw new WriteError(`未知模式：${mode}`)
  const modelFields = await anki.modelFields(batch.target.model).catch((error) => {
    throw new WriteError(`读不到笔记模型「${batch.target.model}」的字段：${error.message}`)
  })
  const schemeIssues = compareFields(scheme.output.fields, modelFields)
  const keyField = scheme.output.fields[0].name

  const candidates = mode === 'update'
    ? batch.items.filter((item) => item.noteId)
    : batch.items.filter((item) => item.status !== 'written')
  if (mode === 'update' && candidates.length === 0) {
    throw new WriteError('改卡模式需要题上已有 noteId；先写入或用 mark noteId=… 回填')
  }

  const ours = mode === 'add' ? await writtenKeys(anki) : new Set()
  const current = mode === 'update'
    ? await anki.notesInfo(candidates.map((item) => item.noteId))
    : []
  const currentById = new Map((current ?? []).filter(Boolean).map((note) => [note.noteId, note]))

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

    if (!key) {
      issues.push({ ruleId: 'dedupe-key', field: keyField, message: '判重键为空' })
      status = 'blocked'
    }

    if (mode === 'update') {
      const note = currentById.get(item.noteId)
      if (!note) {
        issues.push({ ruleId: 'note-missing', field: keyField, message: `卡片 ${item.noteId} 不存在` })
        status = 'blocked'
      }
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
        const found = await anki.findNotes(fieldQuery(keyField, key)).catch(() => [])
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
      if ((verdict.issues ?? []).length > 0) status = 'blocked'
    }

    items.push({
      id: item.id,
      noteId: item.noteId ?? null,
      fields,
      key,
      status,
      issues,
    })
  }

  const plan = {
    id: `p-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    batchId: batch.id,
    mode,
    scheme: { id: scheme.id, version: scheme.version },
    deck: batch.target.deck,
    model: batch.target.model,
    tag: batchTag(batch.id),
    chunkSize: 20,
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

/** 提交前确认：批次内容、方案版本、牌组与模型都还是计划里的那一份。 */
export async function assertPlanFresh({ root, batch, plan }) {
  if (!plan?.digest) throw new WriteError('计划缺少摘要，无法校验')
  const scheme = await getScheme(root, plan.scheme.id, plan.scheme.version)
  if (!scheme) throw new WriteError(`计划引用的方案 ${plan.scheme.id}@${plan.scheme.version} 读不到了`)
  if (batch.scheme?.id !== plan.scheme.id || batch.scheme?.version !== plan.scheme.version) {
    throw new WriteError(
      `批次已改绑到 ${batch.scheme?.id}@${batch.scheme?.version}，旧计划作废，请重新 plan`,
    )
  }
  if (batch.target?.deck !== plan.deck || batch.target?.model !== plan.model) {
    throw new WriteError(`目标已从 ${plan.deck}/${plan.model} 改为 ${batch.target?.deck}/${batch.target?.model}，请重新 plan`)
  }
  for (const item of plan.items) {
    const current = batch.items.find((entry) => entry.id === item.id)
    if (!current) throw new WriteError(`题目 ${item.id} 已不在批次里，请重新 plan`)
    const currentFields = noteFields(scheme, current)
    if (JSON.stringify(currentFields) !== JSON.stringify(item.fields)) {
      throw new WriteError(`题目 ${item.id} 的草稿改过了，旧计划作废，请重新 plan`)
    }
    if ((current.noteId ?? null) !== (item.noteId ?? null)) {
      throw new WriteError(`题目 ${item.id} 的 noteId 变了，请重新 plan`)
    }
  }
  if (digestOf(plan) !== plan.digest) throw new WriteError('计划内容被改动过，请重新 plan')
  return scheme
}

function ankiNotes(plan, items) {
  return items.map((item) => ({
    deckName: plan.deck,
    modelName: plan.model,
    fields: item.fields,
    tags: [GLOBAL_TAG, plan.tag],
    options: { allowDuplicate: false },
  }))
}

async function reconcile({ plan, anki }) {
  const found = await anki.findNotes(`tag:${plan.tag}`).catch(() => [])
  if (!(found ?? []).length) return new Map()
  const info = await anki.notesInfo(found)
  const byKey = new Map()
  for (const note of info ?? []) {
    if (!note?.fields) continue
    const first = Object.values(note.fields)[0]?.value ?? ''
    byKey.set(String(first).trim(), note.noteId)
  }
  const reconciled = new Map()
  for (const item of plan.items) {
    const noteId = byKey.get(item.key)
    if (noteId) reconciled.set(item.id, noteId)
  }
  return reconciled
}

/** 取一张卡的字段快照，作为回读基准。 */
async function snapshot(anki, noteId) {
  const [note] = (await anki.notesInfo([noteId])) ?? []
  if (!note) return null
  const fields = {}
  for (const [name, value] of Object.entries(note.fields ?? {})) fields[name] = value?.value ?? ''
  return fields
}

async function commitAdds({ batch, plan, anki, outcomes }) {
  const already = await reconcile({ plan, anki })
  for (const [itemId, noteId] of already) {
    const item = batch.items.find((entry) => entry.id === itemId)
    if (!item) continue
    item.status = 'written'
    item.noteId = noteId
    outcomes.push({ id: itemId, ok: true, noteId, reconciled: true, fields: await snapshot(anki, noteId) })
  }

  const pending = plan.items.filter((item) => item.status === 'ready' && !already.has(item.id))
  for (let offset = 0; offset < pending.length; offset += plan.chunkSize) {
    const chunk = pending.slice(offset, offset + plan.chunkSize)
    let ids
    try {
      ids = await anki.addNotes(ankiNotes(plan, chunk))
    } catch (error) {
      for (const item of chunk) {
        const entry = batch.items.find((candidate) => candidate.id === item.id)
        if (!entry) continue
        try {
          const id = await anki.addNote(ankiNotes(plan, [item])[0])
          if (typeof id === 'number') {
            entry.status = 'written'
            entry.noteId = id
            outcomes.push({ id: item.id, ok: true, noteId: id, fields: await snapshot(anki, id) })
          } else {
            entry.status = 'failed'
            entry.reason = '未返回条目'
            outcomes.push({ id: item.id, ok: false, error: '未返回条目（多为重复或字段不合规）' })
          }
        } catch (singleError) {
          entry.status = 'failed'
          entry.reason = singleError.message
          outcomes.push({ id: item.id, ok: false, error: singleError.message })
        }
      }
      continue
    }
    for (const [index, id] of (ids ?? []).entries()) {
      const item = chunk[index]
      const entry = batch.items.find((candidate) => candidate.id === item.id)
      if (!entry) continue
      if (typeof id === 'number') {
        entry.status = 'written'
        entry.noteId = id
        outcomes.push({ id: item.id, ok: true, noteId: id, fields: await snapshot(anki, id) })
      } else {
        entry.status = 'failed'
        entry.reason = 'Anki 未返回条目'
        outcomes.push({ id: item.id, ok: false, error: 'Anki 未返回条目（多为重复或字段不合规）' })
      }
    }
  }
}

async function commitUpdates({ batch, plan, anki, outcomes }) {
  for (const item of plan.items.filter((entry) => entry.status === 'ready')) {
    const entry = batch.items.find((candidate) => candidate.id === item.id)
    if (!entry) continue
    const before = await snapshot(anki, item.noteId)
    if (!before) {
      entry.status = 'failed'
      entry.reason = '卡片不存在'
      outcomes.push({ id: item.id, ok: false, error: `卡片 ${item.noteId} 不存在` })
      continue
    }
    const changed = Object.keys(item.fields).filter((name) => before[name] !== item.fields[name])
    if (changed.length === 0) {
      entry.status = 'failed'
      entry.reason = '目标字段内容已相同'
      outcomes.push({ id: item.id, ok: false, error: '目标字段内容已相同，未改动' })
      continue
    }
    try {
      await anki.updateNoteFields({ id: item.noteId, fields: item.fields })
    } catch (error) {
      entry.status = 'failed'
      entry.reason = error.message
      outcomes.push({ id: item.id, ok: false, error: error.message })
      continue
    }
    const after = await snapshot(anki, item.noteId)
    const stillOff = Object.keys(item.fields).filter((name) => (after?.[name] ?? null) !== item.fields[name])
    if (!after || stillOff.length > 0) {
      entry.status = 'failed'
      entry.reason = `回读不符：${stillOff.join('、') || '卡片丢失'}`
      outcomes.push({ id: item.id, ok: false, error: entry.reason })
      continue
    }
    entry.status = 'written'
    outcomes.push({ id: item.id, ok: true, noteId: item.noteId, fields: after, changed })
  }
}

export async function commitPlan({ root, batch, plan, anki }) {
  const scheme = await assertPlanFresh({ root, batch, plan })
  if (plan.modelIssues?.length) {
    throw new WriteError(`方案与模型字段不一致，先修正：${plan.modelIssues.map((issue) => issue.message).join('；')}`)
  }
  const outcomes = []
  if (plan.mode === 'update') {
    await commitUpdates({ batch, plan, anki, outcomes })
  } else {
    await commitAdds({ batch, plan, anki, outcomes })
  }
  await writeJson(commitFile(root, plan.id), {
    planId: plan.id,
    batchId: plan.batchId,
    mode: plan.mode,
    scheme: plan.scheme,
    committedAt: new Date().toISOString(),
    outcomes,
  })
  return outcomes
}

/** 回读：对照提交时落盘的快照，缺卡、缺字段、字段不符都报。 */
export async function verifyCommitted({ root, planId, anki }) {
  const record = await readJson(commitFile(root, planId))
  if (!record) throw new WriteError(`没有 ${planId} 的提交记录，先 commit`)
  const done = record.outcomes.filter((entry) => entry.ok)
  const mismatches = []
  if (done.length === 0) return { checked: 0, mismatches, mode: record.mode }
  const notes = (await anki.notesInfo(done.map((entry) => entry.noteId))) ?? []
  const byId = new Map(notes.filter(Boolean).map((note) => [note.noteId, note]))
  for (const entry of done) {
    const note = byId.get(entry.noteId)
    if (!note) {
      mismatches.push({ id: entry.id, noteId: entry.noteId, field: '*', message: '卡片不存在' })
      continue
    }
    for (const [name, value] of Object.entries(entry.fields ?? {})) {
      const actual = note.fields?.[name]
      if (actual === undefined) {
        mismatches.push({ id: entry.id, noteId: entry.noteId, field: name, message: '字段不存在' })
      } else if (String(actual.value ?? '') !== String(value)) {
        mismatches.push({ id: entry.id, noteId: entry.noteId, field: name, message: '字段内容与提交快照不一致' })
      }
    }
  }
  return { checked: done.length, mismatches, mode: record.mode }
}

export async function loadPlan(root, id) {
  return readJson(planFile(root, id))
}

export async function loadCommit(root, id) {
  return readJson(commitFile(root, id))
}
