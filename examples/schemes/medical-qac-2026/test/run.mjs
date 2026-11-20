#!/usr/bin/env node
/**
 * medical-qac-2026 自带复验入口：只依赖本目录，不进插件通用层。
 *
 *   node examples/schemes/medical-qac-2026/test/run.mjs
 *   ANKI_ASSISTANT_PYTHON="python -X utf8" node test/run.mjs
 *
 * 检查三件：
 *   1. 合格样卡必须 0 问题；
 *   2. 反例必须被预期检查码拦下；
 *   3. 检测器缺失必须报错，不能当通过。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validate } from '../validate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const schemeDir = join(here, '..')
const scheme = JSON.parse(readFileSync(join(schemeDir, 'scheme.json'), 'utf8'))
const checks = scheme.quality?.legacy?.checks ?? []

console.log(`检查码：${checks.join(', ')}`)

let failed = 0
for (const name of ['pass', 'fail']) {
  const sample = JSON.parse(readFileSync(join(schemeDir, 'samples', `${name}.json`), 'utf8'))
  const verdict = await validate(sample.fields, { checks })
  const codes = verdict.issues.map((issue) => issue.code)
  console.log(`\n[${name}] ok=${verdict.ok} issues=${codes.join(',') || '（无）'} 出处=${verdict.source?.status}`)
  for (const issue of verdict.issues) console.log(`  - ${issue.code}: ${issue.message}`)

  if (name === 'pass') {
    if (!verdict.ok || codes.length > 0) {
      failed += 1
      console.log('  ✗ 合格样卡不应报问题')
    }
  } else {
    const missing = (sample.expect ?? []).filter((code) => !codes.includes(code))
    if (missing.length > 0) {
      failed += 1
      console.log(`  ✗ 反例缺少预期拦截：${missing.join(',')}`)
    }
  }
}

// 缺检测器必须抛错
try {
  await validate({ 答案: 'x' }, { adapter: join(schemeDir, 'vendor', 'no-such-adapter.py') })
  failed += 1
  console.log('\n✗ 缺检测器却被当成通过')
} catch (error) {
  console.log(`\n[detector-missing] ${error.message}`)
}

console.log(failed === 0 ? '\n复验通过' : `\n复验失败：${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
