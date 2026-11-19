import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { tempDir } from './temp.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listSchemes, getScheme, saveScheme, validateScheme, seedSchemes } from '../lib/scheme.js'
import { createStore } from '../lib/store.js'

function baseScheme(overrides = {}) {
  return {
    id: 'demo-scheme',
    status: 'active',
    title: '示例方案',
    appliesTo: { cardTypes: ['问答'], subjects: ['内科学'], materials: ['教材'] },
    inputs: [{ kind: 'textbook', required: true }],
    methods: [{ stage: 'make', how: '先骨架后填字' }],
    output: {
      model: 'Cloze',
      fields: [
        { name: 'Text', role: 'content', spec: '一句完整的话' },
        { name: 'Extra', role: 'memory', spec: '怎么背' },
      ],
    },
    quality: {
      rules: [{ id: 'r1', field: 'Text', kind: 'startsWith', value: '{{c1::' }],
      rubric: '上下文要能推回来',
    },
    acceptance: { criteria: '两张样卡' },
    limits: [],
    origin: { kind: 'authored' },
    ...overrides,
  }
}

test('validateScheme 接受最小合法方案', () => {
  assert.doesNotThrow(() => validateScheme(baseScheme({ version: 1 })))
})

test('字段名重复直接拒绝', () => {
  const bad = baseScheme({
    version: 1,
    output: { model: 'Cloze', fields: [{ name: 'Text', spec: 'a' }, { name: 'Text', spec: 'b' }] },
  })
  assert.throws(() => validateScheme(bad), /重复/)
})

test('规则引用了不存在的字段会被拒', () => {
  const bad = baseScheme({ version: 1, quality: { rules: [{ id: 'x', field: 'Nope', kind: 'required' }] } })
  assert.throws(() => validateScheme(bad), /不在 output\.fields/)
})

test('save 只增不改：第二次 save 得到 v2，v1 仍可读', async () => {
  const root = await tempDir('anki-as-scheme-')
  const store = createStore(root)
  await store.init()

  const v1 = await saveScheme(root, { ...baseScheme(), changeWhy: '初版' })
  assert.equal(v1.version, 1)
  const v2 = await saveScheme(root, { ...baseScheme({ title: '示例方案改' }), changeWhy: '改标题' })
  assert.equal(v2.version, 2)
  assert.equal(v2.changelog.length, 2)

  const active = await getScheme(root, 'demo-scheme')
  assert.equal(active.version, 2)
  assert.equal(active.title, '示例方案改')

  const old = await getScheme(root, 'demo-scheme', 1)
  assert.equal(old.title, '示例方案')
})

test('list 默认不返回 draft', async () => {
  const root = await tempDir('anki-as-scheme-')
  const store = createStore(root)
  await store.init()
  await saveScheme(root, { ...baseScheme({ status: 'active' }), changeWhy: 'a' })
  await saveScheme(root, { ...baseScheme({ id: 'draft-one', status: 'draft' }), changeWhy: 'd' })

  const visible = await listSchemes(root)
  assert.deepEqual(visible.map((entry) => entry.id), ['demo-scheme'])
  const all = await listSchemes(root, { includeDrafts: true })
  assert.equal(all.length, 2)
})

test('种子只补缺，不覆盖已有版本', async () => {
  const root = await tempDir('anki-as-scheme-')
  const store = createStore(root)
  await store.init()
  const seeds = [baseScheme({ id: 'seed-a' }), baseScheme({ id: 'seed-b' })]
  const first = await seedSchemes(root, seeds)
  assert.deepEqual(first, ['seed-a@1', 'seed-b@1'])

  const second = await seedSchemes(root, seeds)
  assert.deepEqual(second, [])
})

test('损坏的方案文件被隔离，不再阻塞其他方案', async () => {
  const root = await tempDir('anki-as-scheme-')
  const store = createStore(root)
  await store.init()
  await saveScheme(root, { ...baseScheme(), changeWhy: 'ok' })
  await writeFile(join(root, 'schemes', 'demo-scheme', 'active.json'), '{not json', 'utf8')

  const scheme = await getScheme(root, 'demo-scheme')
  assert.equal(scheme, null)
  const files = await readdir(join(root, 'schemes', 'demo-scheme'))
  assert.equal(files.some((name) => name.includes('.corrupt-')), true)
})

test('并发保存同一方案会得到不同版本号', async () => {
  const root = await tempDir('anki-as-scheme-')
  const [a, b] = await Promise.all([
    saveScheme(root, { id: 'race', title: 'A', status: 'draft', changeWhy: 'a' }),
    saveScheme(root, { id: 'race', title: 'B', status: 'draft', changeWhy: 'b' }),
  ])
  assert.notEqual(a.version, b.version)
  const files = await readdir(join(root, 'schemes', 'race'))
  assert.equal(files.filter((name) => /^v\d+\.json$/.test(name)).length, 2)
})