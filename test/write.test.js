import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { buildPlan, commitPlan, verifyWritten, batchTag } from '../lib/write.js'
import { createBatch, upsertItems, saveBatch } from '../lib/batch.js'

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

function fakeAnki({ existing = [], tagHits = [], failChunk = false } = {}) {
  const state = { added: [], nextId: 500 }
  const anki = {
    async modelFields() {
      return ['问题', '答案']
    },
    async findNotes(query) {
      if (query.startsWith('tag:')) {
        return tagHits.map((hit) => hit.noteId)
      }
      return existing
    },
    async notesInfo(ids) {
      return ids.map((id) => {
        const hit = tagHits.find((entry) => entry.noteId === id)
        return { noteId: id, fields: { 问题: { value: hit?.key ?? '' }, 答案: { value: hit?.answer ?? '' } } }
      })
    },
    async addNotes(notes) {
      if (failChunk) throw new Error('batch rejected')
      return notes.map(() => {
        state.nextId += 1
        state.added.push(state.nextId)
        return state.nextId
      })
    },
    async addNote() {
      state.nextId += 1
      state.added.push(state.nextId)
      return state.nextId
    },
    state,
  }
  return anki
}

async function setup({ items = [{ id: 'i1', fields: { 问题: 'A', 答案: '{{c1::B}}' } }] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'anki-as-write-'))
  const store = createStore(root)
  await store.init()
  const batch = createBatch({
    id: 'b-write',
    scheme,
    target: { deck: 'D', model: 'Cloze' },
  })
  batch.fields = ['问题', '答案']
  upsertItems(batch, items)
  await saveBatch(root, batch)
  return { root, batch }
}

test('规则不过的题进 blocked，可写数为零', async () => {
  const { root, batch } = await setup({ items: [{ id: 'i1', fields: { 问题: 'A', 答案: 'B' } }] })
  const anki = fakeAnki()
  const { plan, blocked } = await buildPlan({ root, batch, scheme, anki })
  assert.equal(blocked.length, 1)
  assert.equal(plan.items[0].issues[0].ruleId, 'cloze')
  assert.equal(plan.items.filter((item) => item.status === 'ready').length, 0)
})

test('Anki 里已有的题被判重', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki({ existing: [1] })
  const { blocked } = await buildPlan({ root, batch, scheme, anki })
  assert.equal(blocked[0].issues.some((issue) => issue.ruleId === 'duplicate-in-anki'), true)
})

test('正常提交后题目标为 written 并带 noteId', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  const outcomes = await commitPlan({ root, batch, plan, anki })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].ok, true)
  assert.equal(batch.items[0].status, 'written')
  assert.equal(typeof batch.items[0].noteId, 'number')
})

test('重跑提交靠标签找回已写的卡，不重复写入', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki({ tagHits: [{ noteId: 900, key: 'A', answer: '{{c1::B}}' }] })
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  const outcomes = await commitPlan({ root, batch, plan, anki })
  assert.equal(outcomes[0].reconciled, true)
  assert.equal(outcomes[0].noteId, 900)
  assert.equal(anki.state.added.length, 0)
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
  assert.equal(outcomes.filter((entry) => entry.ok).length, 0)
  assert.equal(batch.items.every((item) => item.status === 'failed'), true)
  assert.match(batch.items[0].reason, /rejected/)
})

test('计划被改动后 commit 拒绝执行', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  plan.items[0].fields.答案 = '{{c1::tampered}}'
  await assert.rejects(() => commitPlan({ root, batch, plan, anki }), /被改动/)
})

test('模型字段对不上时计划里报出来', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  anki.modelFields = async () => ['Text', 'Extra']
  const { schemeIssues } = await buildPlan({ root, batch, scheme, anki })
  assert.equal(schemeIssues.some((issue) => issue.kind === 'model-fields'), true)
})

test('verify 回读发现字段不一致', async () => {
  const { root, batch } = await setup()
  const anki = fakeAnki()
  const { plan } = await buildPlan({ root, batch, scheme, anki })
  await commitPlan({ root, batch, plan, anki })
  const result = await verifyWritten({ plan, batch, anki })
  assert.equal(result.checked, 1)
  assert.equal(result.mismatches.length > 0, true)
})

test('标签名稳定且不含特殊字符', () => {
  assert.equal(batchTag('b 1/x'), 'ai-assistant::b-1-x')
})
