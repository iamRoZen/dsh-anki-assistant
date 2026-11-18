/**
 * 真机联调：把整条写入链路跑一遍，最后清干净。
 *
 * 只在设置 ANKI_SMOKE=1 时运行，避免误触真实牌组：
 *   $env:ANKI_SMOKE="1"; node test/integration.smoke.mjs
 *
 * 它会建一个临时牌组 AnkiAssistant::smoke，写 1 张卡，重跑一次验证幂等，
 * 回读字段，然后删卡删牌组。全程走真实 AnkiConnect。
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { createAnki } from '../lib/anki.js'
import { createBatch, upsertItems, saveBatch, loadBatch, summarize } from '../lib/batch.js'
import { buildPlan, commitPlan, verifyWritten } from '../lib/write.js'

if (!process.env.ANKI_SMOKE) {
  console.log('跳过：设置 ANKI_SMOKE=1 才运行真机联调')
  process.exit(0)
}

const DECK = 'AnkiAssistant::smoke'
const MODEL = 'Cloze'
const anki = createAnki({})

const scheme = {
  id: 'smoke-scheme',
  version: 1,
  status: 'active',
  title: '联调用',
  appliesTo: { cardTypes: ['单点'], subjects: ['测试'], materials: [] },
  inputs: [],
  methods: [{ stage: 'make', how: '写一句挖空' }],
  output: {
    model: MODEL,
    fields: [
      { name: '文字', role: 'content', spec: '一句完整的话' },
      { name: '背面额外', role: 'memory', spec: '怎么背' },
    ],
  },
  quality: {
    rules: [{ id: 'c1', field: '文字', kind: 'startsWith', value: '{{c1::' }],
    rubric: '',
  },
  limits: [],
  origin: { kind: 'smoke' },
}

let noteIds = []
try {
  await anki.version()
  await anki.createDeck(DECK).catch(() => null)

  const root = await mkdtemp(join(tmpdir(), 'anki-as-smoke-'))
  const store = createStore(root)
  await store.init()

  const batch = createBatch({ id: 'smoke', scheme, target: { deck: DECK, model: MODEL } })
  batch.fields = ['文字', '背面额外']
  upsertItems(batch, [{
    id: 'i1',
    ref: 'smoke',
    fields: {
      文字: '{{c1::心肌梗死}}最早出现的实验室指标是肌红蛋白。',
      背面额外: '先想"最早"再看时间轴｜p1:L1',
    },
  }])
  await saveBatch(root, batch)

  const first = await buildPlan({ root, batch, scheme, anki })
  assert.equal(first.plan.items[0].status, 'ready', '计划应可写')
  const outcomes = await commitPlan({ root, batch, plan: first.plan, anki })
  assert.equal(outcomes[0].ok, true, `写入应成功：${JSON.stringify(outcomes)}`)
  noteIds = batch.items.filter((item) => item.noteId).map((item) => item.noteId)
  console.log('写入成功，noteId =', noteIds)
  await saveBatch(root, batch)

  const reloaded = await loadBatch(root, 'smoke')

  // 新开一批写同样的内容：应被全局标签的判重挡住，而不是再写一张。
  const dup = createBatch({ id: 'smoke2', scheme, target: { deck: DECK, model: MODEL } })
  dup.fields = ['文字', '背面额外']
  upsertItems(dup, [{
    id: 'd1',
    fields: {
      文字: '{{c1::心肌梗死}}最早出现的实验室指标是肌红蛋白。',
      背面额外: '重复检查用',
    },
  }])
  const second = await buildPlan({ root, batch: dup, scheme, anki })
  assert.equal(second.blocked.length, 1, '重跑时同题应被判重挡住')
  assert.equal(second.plan.items[0].issues.some((issue) => issue.ruleId === 'duplicate-in-anki'), true)
  console.log('幂等检查通过：同内容第二次被判定为已存在')

  const verify = await verifyWritten({ plan: first.plan, batch: reloaded, anki })
  assert.equal(verify.checked, 1)
  assert.deepEqual(verify.mismatches, [])
  console.log('回读一致：', summarize(reloaded).counts)
} finally {
  if (noteIds.length) await anki.deleteNotes(noteIds).catch((error) => console.log('清理卡片失败', error.message))
  await anki.invoke('deleteDecks', { decks: [DECK], cardsToo: true }).catch(() => null)
  console.log('已清理临时牌组')
}
