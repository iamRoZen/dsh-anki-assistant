#!/usr/bin/env node
/**
 * 工作区体检（只读）：看插件仓库里有没有不该出现的改动/垃圾。
 *
 *   node scripts/check-workspace.mjs
 *
 * 退出码：有未跟踪文件或意外修改时 1，干净时 0。
 */
import { execFileSync } from 'node:child_process'

let output = ''
try {
  output = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
} catch (error) {
  console.error(`不是 git 仓库或 git 不可用：${error.message}`)
  process.exit(2)
}

const lines = output.split(/\r?\n/).filter(Boolean)
const untracked = lines.filter((line) => line.startsWith('?? ')).map((line) => line.slice(3))
const modified = lines.filter((line) => !line.startsWith('?? '))

for (const line of modified) console.log(`改动 ${line}`)
for (const file of untracked) console.log(`未跟踪 ${file}`)

if (lines.length === 0) {
  console.log('工作区干净')
  process.exit(0)
}
console.log(`\n共 ${lines.length} 项：改动 ${modified.length}，未跟踪 ${untracked.length}`)
console.log('插件仓库不应出现方案/批次/预览/脚本产物；它们属于 <dataDir>。')
process.exit(1)
