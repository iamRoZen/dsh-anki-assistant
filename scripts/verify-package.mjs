#!/usr/bin/env node
/**
 * 打包体检：确认 npm 包里没有不该出现的东西。
 *
 *   npm run verify:package
 */
import { execFileSync } from 'node:child_process'

let report
try {
  report = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    shell: true,
  }))
} catch (error) {
  console.error(`npm pack 失败：${error.message}`)
  process.exit(2)
}

const files = report[0]?.files?.map((file) => file.path) ?? []
const problems = []
if (files.some((file) => file.includes('__pycache__') || file.endsWith('.pyc'))) problems.push('包含 __pycache__ / *.pyc')
if (files.some((file) => file.startsWith('dist/'))) problems.push('包含 dist/')
if (files.some((file) => file.startsWith('test/'))) problems.push('包含根 test/')
if (files.some((file) => file.startsWith('examples/'))) problems.push('包含 examples/')
for (const required of ['index.js', 'package.json', 'LICENSE', 'README.md']) {
  if (!files.includes(required)) problems.push(`缺少 ${required}`)
}

console.log(`文件数：${files.length}`)
console.log(`打包大小：${report[0]?.size ? Math.round(report[0].size / 1024) : '?'} kB（压缩后）`)
for (const problem of problems) console.log(`✗ ${problem}`)
if (problems.length === 0) console.log('✓ 包内容干净')
process.exit(problems.length === 0 ? 0 : 1)
