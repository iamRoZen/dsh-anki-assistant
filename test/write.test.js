import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { buildPlan, commitPlan, verifyCommitted, batchTag, loadPlan } from '../lib/write.js'
import { createBatch, upsertItems, saveBatch, loadBatch, setStatus } from '../lib/batch.js'
import { evaluate, visibleLength } from '../lib/rules.js'
import { saveScheme } from '../lib/scheme.js'

const scheme = {
  id: 'cloze-memory',
  version: 1,
  status: 'active',
  title: 't',
  appliesTo: { cardTypes: [], subjects: [], materials: [] },
  inputs: [],
  methods: [{ stage: 'make', how: 'x' }],
  output: {
    model: 'Cloze',
    fields: [
      { name: '问题', spec: 'a' },
      { name: '答案', spec: 'b' },
    ],
  },
  quality: {
    rules: [{ id: 'cloze', field: '答案', kind: 'startsWith', value: '{{c1::' }],
    rubric: '',
  },
  limits: [],
  origin: { kind: 'test' },
}

/** 内存版 Anki：支持新增、修改、缺卡，用来验证提交与回读。 */
function fakeAnki({ fields = ['问题', '答案'], existing = [], failChunk = false } = {}) {
  const notes = new Map()
  let nextId = 500
  function view(id) {
    const note = notes.get(id)
    if (!note) return null
    const rendered = {}
    for (const [name, value] of Object.entries(note.fields)) rendered[name] = { value }
    return { noteId: id, fields: rendered, tags: note.tags }
  }
  return {
    notes,
    async modelFields() {
      return fields
    },
    async findNotes(query) {
      if (query.startsWith('tag:')) {
        const tag = query.slice(4)
        return [...notes.entries()].filter(([, note]) => note.tags.includes(tag)).map(([id]) => id)
      }
      return existing
    },
    async notesInfo(ids) {
      return ids.map((id) => view(id))
    },
    async addNotes(batch) {
      if (failChunk) throw new Error('batch rejected')
      return batch.map((note) => {
        nextId += 1
        notes.set(nextId, { fields: { ...note.fields }, tags: note.tags })
        return nextId
      })
    },
    async addNote(note) {
      nextId += 1
      notes.set(nextId, { fields: { ...note.fields }, tags: note.tags })
      return nextId
    },
    async updateNoteFields({ id, fields }) {
      const note = notes.get(id)
      if (!note) throw new Error('note not found')
      Object.assign(note.fields, fields)
    },
  }
}

async function setup({ items, schemeNow = scheme } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'anki-as-write-'))
  const store = createStore(root)
  await store.init()
  // 计划校验会回读方案，测试里也要真的落盘一份。
  await saveScheme(root, { ...schemeNow, changeWhy: '测试' })
  const batch = createBatch({ id: 'b-write', scheme: schemeNow, target: { deck: 'D', model: 'Cloze' } })
  batch.fields = ['问题', '答案']
  upsertItems(batch, items ?? [{ id: 'i1', fields: { 问题: 'A', 答案: '{{c1::B}}' } }])
  await saveBatch(root, batch)
  return { root, batch }
}

test('新增：提交成功并落盘快照', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  const outcomes = await commitPlan({ root, batch, plan, anki })
  assert.equal(outcomes[0].ok, true)
  assert.equal(typeof outcomes[0].noteId, 'number')
  assert.equal(outcomes[0].fields.问题, 'A')
  const result = await verifyCommitted({ root, planId: plan.id, anki })
  assert.equal(result.checked, 1)
  assert.deepEqual(result.mismatches, [])
})

test('新增：同内容重跑被全局标签判重挡住', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  await commitPlan({ root, batch, plan, anki })

  const again = await loadBatch(root, 'b-write')
  upsertItems(again, [{ id: 'i1', fields: { 问题: 'A', 答案: '{{c1::B}}' } }])
  const second = await buildPlan({ root, batch: again, scheme, anki })
  assert.equal(second.plan.items[0].status, 'blocked')
  assert.equal(second.plan.items[0].issues.some((issue) => issue.ruleId === 'duplicate-in-anki'), true)
})

test('草稿改过之后旧计划失效', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  batch.items[0].fields.答案 = '{{c1::改过了}}'
  await assert.rejects(() => commitPlan({ root, batch, plan, anki }), /草稿改过/)
})

test('目标牌组改过之后旧计划失效', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  batch.target.deck = '另一个牌组'
  await assert.rejects(() => commitPlan({ root, batch, plan, anki }), /目标已从/)
})

test('批次改绑方案版本之后旧计划失效', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  batch.scheme = { id: scheme.id, version: 2 }
  await assert.rejects(() => commitPlan({ root, batch, plan, anki }), /改绑到|读不到/)
})

test('计划被篡改后 commit 拒绝', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  plan.items[0].fields.答案 = '{{c1::tampered}}'
  await assert.rejects(() => commitPlan({ root, batch, plan, anki }), /改动过|草稿改过/)
})

test('改卡：只有真的改到目标字段才算成功', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const first = await buildPlan({ root, batch, scheme, anki })
  await commitPlan({ root, batch, plan: first.plan, anki })
  const noteId = batch.items[0].noteId

  const updated = await loadBatch(root, 'b-write')
  updated.items[0].noteId = noteId
  updated.items[0].status = 'ready'
  updated.items[0].fields.答案 = '{{c1::新答案}}'
  const { plan } = await buildPlan({ root, batch: updated, scheme, anki, mode: 'update' })
  const outcomes = await commitPlan({ root, batch: updated, plan, anki })
  assert.equal(outcomes[0].ok, true)
  assert.deepEqual(outcomes[0].changed, ['答案'])

  const result = await verifyCommitted({ root, planId: plan.id, anki })
  assert.deepEqual(result.mismatches, [])
  assert.equal(anki.notes.get(noteId).fields.答案, '{{c1::新答案}}')
})

test('改卡：内容没变时报"已相同"，不报成功', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const first = await buildPlan({ root, batch, scheme, anki })
  await commitPlan({ root, batch, plan: first.plan, anki })
  const noteId = batch.items[0].noteId

  const updated = await loadBatch(root, 'b-write')
  updated.items[0].noteId = noteId
  updated.items[0].status = 'ready'
  const { plan } = await buildPlan({ root, batch: updated, scheme, anki, mode: 'update' })
  const outcomes = await commitPlan({ root, batch: updated, plan, anki })
  assert.equal(outcomes[0].ok, false)
  assert.match(outcomes[0].error, /已相同/)
})

test('改卡：卡片不存在时计划里就报出来', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  batch.items[0].noteId = 999999
  const { blocked } = await buildPlan({ root, batch, scheme, anki, mode: 'update' })
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].issues.some((issue) => issue.ruleId === 'note-missing'), true)
})

test('回读：提交后卡片被改，能报出字段不一致', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  await commitPlan({ root, batch, plan, anki })
  for (const note of anki.notes.values()) note.fields.答案 = '被手工改过'
  const result = await verifyCommitted({ root, planId: plan.id, anki })
  assert.equal(result.mismatches[0].message, '字段内容与提交快照不一致')
})

test('回读：卡片被删时报"卡片不存在"', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  await commitPlan({ root, batch, plan, anki })
  anki.notes.clear()
  const result = await verifyCommitted({ root, planId: plan.id, anki })
  assert.equal(result.mismatches[0].message, '卡片不存在')
})

test('整批失败时逐条重下，失败原因落到具体题', async () => {
  const { root, batch } = await setup({
    items: [
      { id: 'i1', fields: { 问题: 'A', 答案: '{{c1::B}}' } },
      { id: 'i2', fields: { 问题: 'C', 答案: '{{c1::D}}' } },
    ],
  })
  const anki = fakeAnki({ failChunk: true })
  anki.addNote = async () => {
    throw new Error('single rejected')
  }
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  const outcomes = await commitPlan({ root, batch, plan, anki })
  assert.equal(outcomes.every((entry) => !entry.ok), true)
  assert.match(batch.items[0].reason, /rejected/)
})

test('模型字段对不上时计划里报出来', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki({ fields: ['文字', '背面额外'] })
  const { schemeIssues } = await buildPlan({ root, batch, scheme, anki })
  assert.equal(schemeIssues.some((issue) => issue.kind === 'model-fields'), true)
})

test('批次标签不会因为 id 归一化而撞车', () => {
  assert.notEqual(batchTag('a b'), batchTag('a-b'))
  assert.equal(batchTag('b 1/x'), batchTag('b 1/x'))
  assert.match(batchTag('b 1/x'), /^ai-assistant::b-1-x-[0-9a-f]{8}$/)
})

test('计划 id 每次不同', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const a = await buildPlan({ root, batch, scheme, anki })
  const b = await buildPlan({ root, batch, scheme, anki })
  assert.notEqual(a.plan.id, b.plan.id)
  assert.equal(await loadPlan(root, a.plan.id) !== null, true)
})

test('字数规则按实际答案算，光有 N字 不算通过', () => {
  const fields = { 要点数: '99字', 答案: '{{c1::<b>1.</b> 三个字}}' }
  const rule = { id: 'len', field: '要点数', kind: 'lengthOf', sourceField: '答案' }
  assert.equal(evaluate(fields, [rule]).length, 1)
  fields.要点数 = `${visibleLength(fields.答案)}字`
  assert.equal(evaluate(fields, [rule]).length, 0)
})
