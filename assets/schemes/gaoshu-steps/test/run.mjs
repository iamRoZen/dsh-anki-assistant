#!/usr/bin/env node
/**
 * gaoshu-steps 自带复验入口：只依赖本目录。
 *
 *   node assets/schemes/gaoshu-steps/test/run.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validate } from '../validate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const schemeDir = join(here, '..')
const scheme = JSON.parse(readFileSync(join(schemeDir, 'scheme.json'), 'utf8'))
const checks = scheme.quality?.validator?.checks ?? []
console.log(`检查码：${checks.join(', ')}`)

let failed = 0
for (const name of ['pass', 'fail']) {
  const sample = JSON.parse(readFileSync(join(schemeDir, 'samples', `${name}.json`), 'utf8'))
  const verdict = await validate(sample.fields, { checks })
  const codes = verdict.issues.map((issue) => issue.code)
  console.log(`\n[${name}] ok=${verdict.ok} issues=${[...new Set(codes)].join(',') || '（无）'}`)
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

console.log(failed === 0 ? '\n复验通过' : `\n复验失败：${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
