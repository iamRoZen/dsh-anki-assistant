import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { tempDir } from './temp.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, readJson, writeJson } from '../lib/store.js'

test('原子写读写往返', async () => {
  const dir = await tempDir('anki-as-store-')
  const file = join(dir, 'a', 'b.json')
  await writeJson(file, { x: 1 })
  assert.deepEqual(await readJson(file), { x: 1 })
  const files = await readdir(join(dir, 'a'))
  assert.deepEqual(files, ['b.json'])
})

test('不存在的文件返回 null', async () => {
  const dir = await tempDir('anki-as-store-')
  assert.equal(await readJson(join(dir, 'nope.json')), null)
})

test('损坏的 JSON 被改名保留，不删除', async () => {
  const dir = await tempDir('anki-as-store-')
  const file = join(dir, 'bad.json')
  await writeFile(file, '{oops', 'utf8')
  assert.equal(await readJson(file), null)
  const files = await readdir(dir)
  assert.equal(files.some((name) => name.startsWith('bad.json.corrupt-')), true)
  const kept = files.find((name) => name.startsWith('bad.json.corrupt-'))
  assert.equal(await readFile(join(dir, kept), 'utf8'), '{oops')
})

test('init 建目录并写 meta', async () => {
  const root = await tempDir('anki-as-store-')
  const store = createStore(root)
  const meta = await store.init()
  assert.equal(meta.schemaVersion, 1)
  for (const dir of ['schemes', 'batches', 'plans', 'audit', 'sources']) {
    assert.equal((await stat(join(root, dir))).isDirectory(), true)
  }
})

test('数据版本高于插件时拒绝启动，避免降级损坏', async () => {
  const root = await tempDir('anki-as-store-')
  await writeJson(join(root, 'meta.json'), { schemaVersion: 99 })
  const store = createStore(root)
  await assert.rejects(() => store.init(), /升级插件/)
})
