/**
 * 方案自带判据的语义测试：直接调方案目录里的 validate.mjs（不进插件通用层）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { adapterPath, validate } from '../assets/schemes/medical-qac-2026/validate.mjs'

const DIR = new URL('../assets/schemes/medical-qac-2026/', import.meta.url)
const SCHEME_DIR = fileURLToPath(DIR)
const scheme = JSON.parse(readFileSync(new URL('scheme.json', DIR), 'utf8'))
const checks = scheme.quality.legacy.checks
const pass = JSON.parse(readFileSync(new URL('samples/pass.json', DIR), 'utf8'))
const fail = JSON.parse(readFileSync(new URL('samples/fail.json', DIR), 'utf8'))

test('方案自带校验器与检查码', () => {
  assert.equal(scheme.quality.legacy.suite, 'medical_qac')
  assert.equal(scheme.quality.legacy.module, 'validate.mjs')
  assert.deepEqual(checks, ['CLOZE', 'ORDINAL', 'LONGLINE', 'NEEDNEXT', 'TOOBIG', 'WEIGHT'])
  assert.equal(adapterPath.endsWith('legacy_adapter.py'), true)
})

test('合格样卡在旧判据下 0 问题', async () => {
  const verdict = await validate(pass.fields, { checks })
  assert.deepEqual(verdict.issues, [])
  assert.equal(verdict.ok, true)
  // 结构已核，但出处没有 refdb → 必须明确「未核」
  assert.equal(verdict.source.status, 'unverified')
})

test('反例被旧判据按预期拦下', async () => {
  const verdict = await validate(fail.fields, { checks })
  const codes = verdict.issues.map((issue) => issue.code)
  for (const expected of fail.expect) {
    assert.equal(codes.includes(expected), true, `应拦 ${expected}，实际：${codes.join(',')}`)
  }
  assert.equal(verdict.ok, false)
})

test('检测器缺失时抛错，而不是回退成通过', async () => {
  await assert.rejects(
    () => validate(pass.fields, { adapter: join(SCHEME_DIR, 'vendor', 'no-such-adapter.py') }),
    /检测器缺失/,
  )
})

test('反例的失败可解释：尾巴、缺号、字当量', async () => {
  const verdict = await validate(fail.fields, { checks })
  const text = verdict.issues.map((issue) => issue.message).join(' / ')
  assert.match(text, /之后/)
  assert.match(text, /缺号/)
  assert.match(text, /字当量|应/)
})
