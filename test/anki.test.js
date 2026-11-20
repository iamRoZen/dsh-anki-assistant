import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveAnkiExe } from '../lib/anki.js'
import { tempDirSync } from './temp.js'

test('resolveAnkiExe 优先使用显式且存在的路径', () => {
  const dir = tempDirSync('anki-as-anki-')
  const exe = join(dir, 'anki.exe')
  writeFileSync(exe, '')
  assert.equal(resolveAnkiExe(exe), exe)
})

test('不存在或未配置时不会原样返回', () => {
  const missing = 'C:/definitely/not/here/anki.exe'
  assert.notEqual(resolveAnkiExe(missing), missing)
})
