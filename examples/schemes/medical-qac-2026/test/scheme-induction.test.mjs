/**
 * 方案内测试：入口级真实调用 + 升级回归，均只依赖方案目录与插件包。
 * 解包后从方案目录运行本文件即可复验。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validate } from '../validate.mjs'
import { runEntryTests, runUpgradeTest } from './entry.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const schemeDir = join(here, '..')

test('复验入口可独立运行', async () => {
  const status = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, 'run.mjs')], { stdio: 'inherit' })
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })
  assert.equal(status, 0)
})

test('batch validate 与 card_write plan 都真实调用旧判据', async () => {
  const result = await runEntryTests()
  for (const code of ['CLOZE', 'ORDINAL', 'WEIGHT']) {
    assert.equal(result.validate.codes.includes(code), true, `validate 应命中 ${code}`)
    assert.equal(result.plan.codes.includes(code), true, `plan 应命中 ${code}`)
  }
  assert.notEqual(result.validate.status, 'ready')
  assert.equal(result.plan.blocked, 'blocked')
  assert.equal(result.plan.source, 'unverified')
  assert.equal(result.validate.warnings.some((warning) => warning.includes('出处未核')), true)
})

test('Python 不可用时两个入口都报错', async () => {
  const result = await runEntryTests()
  assert.equal(result.missingPython.validateRejected, true, result.missingPython.message)
  assert.equal(result.missingPython.planRejected, true, result.missingPython.planMessage)
})

test('v0.4.0 升级追加新版本且不动旧记录/正文/批次', async () => {
  const result = await runUpgradeTest()
  assert.equal(result.storedV1.hasLegacy, false)
  assert.equal(result.active.hasLegacy, true)
  assert.equal(result.active.version > result.oldVersion, true)
  assert.match(result.bodies.v1, /OLD JS BODY v1/)
  assert.doesNotMatch(result.bodies.active, /OLD JS BODY v1/)
  assert.equal(result.batch.version, result.oldVersion)
})

test('缺检测器抛错', async () => {
  await assert.rejects(
    () => validate({ 答案: 'x' }, { adapter: join(schemeDir, 'vendor', 'no-such-adapter.py') }),
    /检测器缺失/,
  )
})
