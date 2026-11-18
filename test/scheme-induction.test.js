/**
 * 根测试：只做一层调用，判据实现全在方案目录里。
 *   - 方案自带 test/run.mjs（纯 Python 复验 + 缺检测器）；
 *   - 方案自带 test/entry.mjs（真实调用 batch validate / card_write plan，含升级回归）；
 *   - 方案自带 validate.mjs 的缺失检测器行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validate } from '../assets/schemes/medical-qac-2026/validate.mjs'

const SCHEME_DIR = fileURLToPath(new URL('../assets/schemes/medical-qac-2026/', import.meta.url))
const RUNNER = join(SCHEME_DIR, 'test', 'run.mjs')
const ENTRY = pathToFileURL(join(SCHEME_DIR, 'test', 'entry.mjs')).href

test('方案目录的复验入口可独立运行', async () => {
  const status = await new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER], { stdio: 'inherit' })
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })
  assert.equal(status, 0, 'run.mjs 应通过（需要 Python 与方案自带适配器）')
})

test('batch validate 与 card_write plan 都真实调用旧判据', async () => {
  const { runEntryTests } = await import(ENTRY)
  const result = await runEntryTests()
  const expected = ['CLOZE', 'ORDINAL', 'WEIGHT']

  for (const code of expected) {
    assert.equal(result.validate.codes.includes(code), true, `validate 应命中 ${code}，实际 ${result.validate.codes}`)
    assert.equal(result.plan.codes.includes(code), true, `plan 应命中 ${code}，实际 ${result.plan.codes}`)
  }

  assert.notEqual(result.validate.status, 'ready')
  assert.equal(result.plan.blocked, 'blocked')
  assert.equal(result.plan.legacySuite, 'medical_qac')
  assert.equal(result.plan.source, 'unverified')
  assert.equal(
    result.validate.warnings.some((warning) => warning.includes('出处未核')),
    true,
    '结构通过不等于出处已核，必须带出提示',
  )
})

test('Python 不可用时两个入口都明确报错', async () => {
  const { runEntryTests } = await import(ENTRY)
  // 正向流程照常用正常 Python；缺解释器只在 entry.mjs 的反向段里出现
  const result = await runEntryTests()
  assert.equal(result.missingPython.validateRejected, true, result.missingPython.message)
  assert.equal(result.missingPython.planRejected, true, result.missingPython.planMessage)
})

test('已装 v0.4.0 的旧方案按 revision 追加新版本，旧记录/旧正文/批次不动', async () => {
  const { runUpgradeTest } = await import(ENTRY)
  const result = await runUpgradeTest()

  assert.equal(result.storedV1.hasLegacy, false, 'v1 应保持旧记录，不能凭空长出 legacy')
  assert.equal(result.active.hasLegacy, true, '新版本必须带 quality.legacy')
  assert.equal(result.active.version > result.oldVersion, true, '应追加新版本而不是覆盖')
  assert.equal(result.active.checks.includes('CLOZE'), true)

  assert.match(result.bodies.v1, /OLD JS BODY v1/, '旧正文要留住，供旧版本回看')
  assert.doesNotMatch(result.bodies.active, /OLD JS BODY v1/, '新版本读到的应是包内新正文')

  assert.equal(result.batch.version, result.oldVersion, '已在跑的批次仍钉旧版本')
})

test('适配器缺失时抛错而不是通过', async () => {
  await assert.rejects(
    () => validate({ 答案: 'x' }, { adapter: join(SCHEME_DIR, 'vendor', 'no-such-adapter.py') }),
    /检测器缺失/,
  )
})
