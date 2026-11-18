/**
 * 方案内自测：只依赖方案目录（validate.mjs + vendor/ + samples/）。
 * 目录被单独复制或解包后，这个文件仍可运行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { adapterPath, validate } from '../validate.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const schemeDir = join(here, '..')
const scheme = JSON.parse(readFileSync(join(schemeDir, 'scheme.json'), 'utf8'))
const checks = scheme.quality.legacy.checks
const pass = JSON.parse(readFileSync(join(schemeDir, 'samples', 'pass.json'), 'utf8'))
const fail = JSON.parse(readFileSync(join(schemeDir, 'samples', 'fail.json'), 'utf8'))

test('方案自带校验器与检查码', () => {
  assert.equal(scheme.quality.legacy.module, 'validate.mjs')
  assert.equal(adapterPath.endsWith('legacy_adapter.py'), true)
  assert.deepEqual(checks, ['CLOZE', 'ORDINAL', 'LONGLINE', 'NEEDNEXT', 'TOOBIG', 'WEIGHT'])
})

test('合格样卡 0 问题，出处如实标未核', async () => {
  const verdict = await validate(pass.fields, { checks })
  assert.deepEqual(verdict.issues, [])
  assert.equal(verdict.source.status, 'unverified')
})

test('反例按预期被拦', async () => {
  const verdict = await validate(fail.fields, { checks })
  const codes = verdict.issues.map((issue) => issue.code)
  for (const expected of fail.expect) assert.equal(codes.includes(expected), true, `应拦 ${expected}`)
})

test('缺检测器抛错', async () => {
  await assert.rejects(
    () => validate(pass.fields, { adapter: join(schemeDir, 'vendor', 'no-such-adapter.py') }),
    /检测器缺失/,
  )
})
