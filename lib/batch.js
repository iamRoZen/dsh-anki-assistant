/**
 * 批次：一批待生产的题。
 *
 * 队列只记"哪些题、到哪一步"，判重永远问 Anki，不在本地维护指纹库。
 */
import { join } from 'node:path'
import { readJson, writeJson } from './store.js'

const STATUS = ['queued', 'ready', 'written', 'failed', 'parked']

export class BatchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BatchError'
  }
}

export function batchFile(root, id) {
  return join(root, 'batches', `${id}.json`)
}

export function createBatch({ id, title = '', scheme, target }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id ?? '')) {
    throw new BatchError(`批次 id 只能用字母、数字、- 和 _，最多 64 位：${id}`)
  }
  if (!scheme?.id) throw new BatchError('批次需要方案 id')
  if (!target?.deck || !target?.model) throw new BatchError('批次需要目标牌组和笔记模型')
  return {
    id,
    title,
    scheme: { id: scheme.id, version: scheme.version ?? null },
    target,
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export async function loadBatch(root, id) {
  return readJson(batchFile(root, id))
}

export async function saveBatch(root, batch) {
  batch.updatedAt = new Date().toISOString()
  await writeJson(batchFile(root, batch.id), batch)
  return batch
}

/** 按 id upsert；同一题重跑不会产生第二条。 */
export function upsertItems(batch, items) {
  const added = []
  const updated = []
  for (const item of items ?? []) {
    if (!item?.id) throw new BatchError('每条题都需要 id')
    if (!item.question && !item.fields) throw new BatchError(`题 ${item.id} 需要 question 或 fields`)
    const existing = batch.items.find((entry) => entry.id === item.id)
    if (existing) {
      Object.assign(existing, {
        fields: { ...existing.fields, ...(item.fields ?? {}) },
        ref: item.ref ?? existing.ref,
        question: item.question ?? existing.question,
        updatedAt: new Date().toISOString(),
      })
      if (existing.status === 'written') existing.status = 'ready'
      updated.push(existing.id)
    } else {
      batch.items.push({
        id: item.id,
        question: item.question ?? '',
        ref: item.ref ?? '',
        fields: item.fields ?? (item.question ? { [firstField(batch)]: item.question } : {}),
        status: 'queued',
        noteId: null,
        issues: [],
        createdAt: new Date().toISOString(),
      })
      added.push(item.id)
    }
  }
  return { added, updated }
}

function firstField(batch) {
  return batch.fields?.[0] ?? '问题'
}

export function nextItem(batch) {
  return batch.items.find((item) => item.status === 'queued') ?? null
}

export function setStatus(batch, itemId, status, patch = {}) {
  if (!STATUS.includes(status)) throw new BatchError(`未知状态：${status}`)
  const item = batch.items.find((entry) => entry.id === itemId)
  if (!item) throw new BatchError(`批次里没有题 ${itemId}`)
  item.status = status
  if (patch.noteId !== undefined) item.noteId = patch.noteId
  if (patch.issues !== undefined) item.issues = patch.issues
  if (patch.reason !== undefined) item.reason = patch.reason
  item.updatedAt = new Date().toISOString()
  return item
}

export function summarize(batch) {
  const counts = Object.fromEntries(STATUS.map((status) => [status, 0]))
  for (const item of batch.items) counts[item.status] = (counts[item.status] ?? 0) + 1
  return {
    id: batch.id,
    total: batch.items.length,
    counts,
    deck: batch.target?.deck,
    model: batch.target?.model,
    scheme: batch.scheme,
    done: batch.items.every((item) => ['written', 'failed', 'parked'].includes(item.status)),
  }
}

export function view(batch) {
  return batch.items.map((item) => ({
    id: item.id,
    question: item.question,
    ref: item.ref,
    status: item.status,
    noteId: item.noteId,
    issues: item.issues ?? [],
  }))
}
