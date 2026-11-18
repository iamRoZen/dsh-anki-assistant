/**
 * 写入闸门：先出计划（预览），再提交。
 *
 * 提交是幂等的：先用标签找回已经写进去的卡，再补写剩下的。
 * 这样即使中途崩溃、或 AnkiConnect 只报错不报明细，也不会重复出卡。
 */
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from './store.js'
import { evaluate, compareFields } from './rules.js'

export class WriteError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WriteError'
  }
}

export function planFile(root, id) {
  return join(root, 'plans', `${id}.json`)
}

export function batchTag(batchId) {
  const safe = String(batchId).replace(/[^A-Za-z0-9]/g, '-').slice(0, 40)
  return `ai-assistant::${safe}`
}

/** 所有由本插件写入的卡都带这个全局标签，用来跨批次判重。 */
export const GLOBAL_TAG = 'ai-assistant'

/** Anki 搜索里的字段短语：只保留能安全放进引号的内容。 */
function fieldQuery(field, key) {
  const safe = String(key).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${field}:"${safe}"`
}

/** 取本插件已写过的卡的首字段值，作为本地判重集合。 */
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

function digestOf(plan) {
  return createHash('sha256')
    .update(JSON.stringify({ deck: plan.deck, model: plan.model, items: plan.items }))
    .digest('hex')
}

function noteFields(batch, scheme, item) {
  const fields = {}
  for (const spec of scheme.output.fields) {
    fields[spec.name] = item.fields?.[spec.name] ?? ''
  }
  return fields
}

/**
 * 生成计划：字段规范、判重、模型字段三者都检查一遍。
 * 只读 Anki，不写。
 */
export async function buildPlan({ root, batch, scheme, anki }) {
  const modelFields = await anki.modelFields(batch.target.model).catch((error) => {
    throw new WriteError(`读不到笔记模型「${batch.target.model}」的字段：${error.message}`)
  })
  const schemeIssues = compareFields(scheme.output.fields, modelFields)
  const keyField = scheme.output.fields[0].name
  const ours = await writtenKeys(anki)

  const items = []
  const seen = new Set()
  for (const item of batch.items) {
    if (item.status === 'written') continue
    const fields = noteFields(batch, scheme, item)
    const key = String(fields[keyField] ?? '').trim()
    const issues = evaluate(fields, scheme.quality?.rules)
    let status = 'ready'
    if (issues.length > 0) status = 'blocked'
    if (!key) {
      issues.push({ ruleId: 'dedupe-key', field: keyField, message: '判重键为空' })
      status = 'blocked'
    }
    if (seen.has(key)) {
      issues.push({ ruleId: 'duplicate-in-batch', field: keyField, message: '本批内重复' })
      status = 'blocked'
    }
    seen.add(key)
    if (key && ours.has(key)) {
      issues.push({ ruleId: 'duplicate-in-anki', field: keyField, message: '本插件已写过同样的首字段' })
      status = 'blocked'
    } else if (key) {
      // 别人写的卡只能靠 Anki 搜索判断；查询语法不兼容时静默放过，
      // 由写入时 Anki 自己的重复检查兜底。
      const found = await anki.findNotes(fieldQuery(keyField, key)).catch(() => [])
      if ((found ?? []).length > 0) {
        issues.push({ ruleId: 'duplicate-in-anki', field: keyField, message: `Anki 中已有 ${found.length} 条同字段` })
        status = 'blocked'
      }
    }
    items.push({ id: item.id, fields, key, status, issues })
  }

  const plan = {
    id: `p-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    batchId: batch.id,
    scheme: { id: scheme.id, version: scheme.version },
    deck: batch.target.deck,
    model: batch.target.model,
    tag: batchTag(batch.id),
    chunkSize: 20,
    items,
    modelIssues: schemeIssues,
    createdAt: new Date().toISOString(),
  }
  plan.digest = digestOf(plan)

  const blocked = items.filter((item) => item.status === 'blocked')
  if (schemeIssues.length === 0) {
    await writeJson(planFile(root, plan.id), plan)
  }
  return { plan, blocked, schemeIssues }
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

/** 用标签把已经写进去的题找回来：崩溃后重跑靠这一步去重。 */
async function reconcile({ batch, plan, anki }) {
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

export async function commitPlan({ root, batch, plan, anki }) {
  if (plan.digest !== digestOf(plan)) throw new WriteError('计划内容被改动过，请重新 plan')
  if (plan.modelIssues?.length) {
    throw new WriteError(`方案与模型字段不一致，先修正：${plan.modelIssues.map((i) => i.message).join('；')}`)
  }
  if (!batch.items.some((item) => ['queued', 'ready', 'failed'].includes(item.status))) {
    throw new WriteError('批次里没有待写入的题')
  }

  const already = await reconcile({ batch, plan, anki })
  const outcomes = []

  for (const [itemId, noteId] of already) {
    const item = batch.items.find((entry) => entry.id === itemId)
    if (!item) continue
    item.status = 'written'
    item.noteId = noteId
    outcomes.push({ id: itemId, ok: true, noteId, reconciled: true })
  }

  const pending = plan.items.filter(
    (item) => item.status === 'ready' && !already.has(item.id),
  )

  for (let offset = 0; offset < pending.length; offset += plan.chunkSize) {
    const chunk = pending.slice(offset, offset + plan.chunkSize)
    try {
      const ids = await anki.addNotes(ankiNotes(plan, chunk))
      for (const [index, id] of (ids ?? []).entries()) {
        const item = chunk[index]
        const entry = batch.items.find((candidate) => candidate.id === item.id)
        if (!entry) continue
        if (typeof id === 'number') {
          entry.status = 'written'
          entry.noteId = id
          outcomes.push({ id: item.id, ok: true, noteId: id })
        } else {
          entry.status = 'failed'
          outcomes.push({ id: item.id, ok: false, error: 'Anki 未返回条目（多为重复或字段不合规）' })
        }
      }
    } catch (error) {
      // 整批失败时逐条重试，把失败原因落到具体题上。
      for (const item of chunk) {
        const entry = batch.items.find((candidate) => candidate.id === item.id)
        if (!entry) continue
        try {
          const id = await anki.addNote(ankiNotes(plan, [item])[0])
          if (typeof id === 'number') {
            entry.status = 'written'
            entry.noteId = id
            outcomes.push({ id: item.id, ok: true, noteId: id })
          } else {
            entry.status = 'failed'
            entry.reason = '重复或字段不合规'
            outcomes.push({ id: item.id, ok: false, error: '未返回条目' })
          }
        } catch (singleError) {
          entry.status = 'failed'
          entry.reason = singleError.message
          outcomes.push({ id: item.id, ok: false, error: singleError.message })
        }
      }
    }
  }

  return outcomes
}

/** 回读：确认写入的卡字段与计划一致。 */
export async function verifyWritten({ plan, batch, anki }) {
  const written = batch.items.filter((item) => item.status === 'written' && item.noteId)
  if (written.length === 0) return { checked: 0, mismatches: [] }
  const info = await anki.notesInfo(written.map((item) => item.noteId))
  const mismatches = []
  for (const note of info ?? []) {
    const item = written.find((entry) => entry.noteId === note.noteId)
    if (!item) continue
    for (const [name, value] of Object.entries(note.fields ?? {})) {
      const planned = item.fields?.[name] ?? ''
      if (String(value?.value ?? '') !== String(planned)) {
        mismatches.push({ id: item.id, noteId: note.noteId, field: name })
      }
    }
  }
  return { checked: written.length, mismatches }
}

export async function loadPlan(root, id) {
  return readJson(planFile(root, id))
}
