/**
 * 实际 Anki 联调。只有 ANKI_SMOKE=1 时才创建临时牌组和笔记。
 * ANKI_SMOKE_MODEL 可指定已存在的笔记模型，默认 Cloze。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createAnki } from '../lib/anki.js'
import { dataPath } from '../lib/paths.js'
import { mountTools } from './tool-host.js'

if (process.env.ANKI_SMOKE !== '1') {
  console.log('跳过：设置 ANKI_SMOKE=1 才运行真机联调')
  process.exit(0)
}

const token = randomUUID()
const deck = 'AnkiAssistant-Smoke-' + token
const model = process.env.ANKI_SMOKE_MODEL || 'Cloze'
const root = await mkdtemp(join(tmpdir(), 'anki-as-smoke-'))
const anki = createAnki({ autoLaunch: false })
const noteIds = new Set()
let planId
let ownDeck = false

try {
  await anki.version()
  const names = await anki.modelFields(model)
  assert.ok(names.length > 0, '联调模型需要字段')
  assert.ok(!(await anki.decks()).includes(deck), '临时牌组重名')
  await anki.createDeck(deck)
  ownDeck = true

  const { tools } = mountTools({ dataDir: root, ankiClient: anki, autoLaunchAnki: false })
  const scheme = tools.get('scheme')
  const batch = tools.get('batch')
  const cardWrite = tools.get('card_write')
  await scheme.execute({
    action: 'save',
    scheme: { id: 'smoke', title: '真机联调', status: 'draft', output: { model, fields: names.map((name) => ({ name, spec: name })) } },
    changeWhy: '真机联调',
  })
  const fields = Object.fromEntries(names.map((name, index) => [
    name, index === 0 ? '{{c1::联调 ' + token + '}}' : '',
  ]))
  await batch.execute({ action: 'open', batch: 'smoke', scheme: 'smoke', deck, model, items: [{ id: 'one', fields }] })
  const plan = await cardWrite.execute({ action: 'plan', batch: 'smoke' })
  assert.equal(plan.ready, 1, plan.text)
  planId = plan.plan
  const committed = await cardWrite.execute({ action: 'commit', plan: plan.plan })
  for (const result of committed.outcomes) {
    if (Number.isSafeInteger(result.noteId)) noteIds.add(result.noteId)
  }
  assert.equal(committed.ready, 1, committed.text)
  const replayed = await cardWrite.execute({ action: 'commit', plan: plan.plan })
  assert.deepEqual(replayed.outcomes, committed.outcomes)
  const verified = await cardWrite.execute({ action: 'verify', plan: plan.plan })
  assert.equal(verified.checked, 1)
  assert.deepEqual(verified.mismatches, [])
  console.log('plan → commit → retry → verify 通过')
} finally {
  try {
    if (planId) {
      for (const id of await anki.findNotes('tag:ai-assistant::plan-' + planId)) noteIds.add(id)
    }
    if (noteIds.size) await anki.deleteNotes([...noteIds])
  } finally {
    try {
      if (ownDeck) await anki.invoke('deleteDecks', { decks: [deck], cardsToo: true })
    } finally {
      await rm(dataPath(tmpdir(), basename(root)), { recursive: true, force: true })
    }
  }
}
