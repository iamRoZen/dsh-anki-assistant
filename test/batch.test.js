import test from 'node:test'
import assert from 'node:assert/strict'

import { createBatch, nextItem, setStatus, summarize, upsertItems, view } from '../lib/batch.js'

function batch() {
  const created = createBatch({
    id: 'b1',
    title: '示例',
    scheme: { id: 'cloze-memory', version: 1 },
    target: { deck: 'D', model: 'Cloze' },
  })
  created.fields = ['问题', '答案']
  return created
}

test('建批必须给方案、牌组与模型', () => {
  assert.throws(() => createBatch({ id: 'x', scheme: {}, target: {} }), /方案/)
  assert.throws(() => createBatch({ id: 'x', scheme: { id: 'a' }, target: {} }), /牌组/)
  assert.throws(() => createBatch({ id: 'bad id!', scheme: { id: 'a' }, target: { deck: 'd', model: 'm' } }), /批次 id/)
})

test('同一 id 重复 put 只更新，不产生第二条', () => {
  const created = batch()
  const first = upsertItems(created, [{ id: 'i1', fields: { 问题: 'A', 答案: 'B' } }])
  assert.deepEqual(first.added, ['i1'])
  const second = upsertItems(created, [{ id: 'i1', fields: { 答案: 'B2' } }])
  assert.deepEqual(second.added, [])
  assert.deepEqual(second.updated, ['i1'])
  assert.equal(created.items.length, 1)
  assert.equal(created.items[0].fields.答案, 'B2')
  assert.equal(created.items[0].fields.问题, 'A')
})

test('next 只取 queued，写完就不再返回', () => {
  const created = batch()
  upsertItems(created, [{ id: 'i1', fields: { 问题: 'A' } }, { id: 'i2', fields: { 问题: 'B' } }])
  assert.equal(nextItem(created).id, 'i1')
  setStatus(created, 'i1', 'written', { noteId: 42 })
  assert.equal(nextItem(created).id, 'i2')
  assert.equal(created.items[0].noteId, 42)
})

test('未知状态与未知题目都报错', () => {
  const created = batch()
  upsertItems(created, [{ id: 'i1', fields: { 问题: 'A' } }])
  assert.throws(() => setStatus(created, 'i1', 'done'), /未知状态/)
  assert.throws(() => setStatus(created, 'nope', 'ready'), /没有题/)
})

test('写过的题被再次 put 时会退回 ready，等待重写', () => {
  const created = batch()
  upsertItems(created, [{ id: 'i1', fields: { 问题: 'A' } }])
  setStatus(created, 'i1', 'written', { noteId: 7 })
  upsertItems(created, [{ id: 'i1', fields: { 答案: '新' } }])
  assert.equal(created.items[0].status, 'ready')
})

test('summary 按状态计数，全部落定才算 done', () => {
  const created = batch()
  upsertItems(created, [{ id: 'i1', fields: { 问题: 'A' } }, { id: 'i2', fields: { 问题: 'B' } }])
  setStatus(created, 'i1', 'written', { noteId: 1 })
  const partial = summarize(created)
  assert.equal(partial.counts.written, 1)
  assert.equal(partial.done, false)
  setStatus(created, 'i2', 'parked', { reason: '缺原文' })
  assert.equal(summarize(created).done, true)
})

test('view 只暴露状态相关字段', () => {
  const created = batch()
  upsertItems(created, [{ id: 'i1', fields: { 问题: 'A' }, ref: 'p1:L2' }])
  const [row] = view(created)
  assert.equal(row.ref, 'p1:L2')
  assert.equal(row.status, 'queued')
  assert.equal(row.fields, undefined)
})
