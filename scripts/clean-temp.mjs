#!/usr/bin/env node
/**
 * 清理本项目在 %TEMP% 留下的沙箱目录（默认只列出，不删）。
 *
 *   node scripts/clean-temp.mjs                 # 列出候选
 *   node scripts/clean-temp.mjs --apply         # 删除 6 小时前的
 *   node scripts/clean-temp.mjs --apply --older-than=24
 *
 * 只匹配本项目产生的命名：anki-*、HeadlessEdge*、sim-*。
 * 正在被进程占用的目录会删不掉，跳过并报告，不影响其他。
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const older = Number((args.find((arg) => arg.startsWith('--older-than=')) ?? '').split('=')[1] ?? 6)
const patterns = [/^anki-/, /^HeadlessEdge/, /^sim-/]

function sizeOf(dir) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        files += 1
        try { bytes += statSync(full).size } catch { /* 跳过 */ }
      }
    }
  }
  return { bytes, files }
}

const now = Date.now()
const rows = []
let skippedYoung = 0
for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
  if (!entry.isDirectory() || !patterns.some((pattern) => pattern.test(entry.name))) continue
  const full = join(tmpdir(), entry.name)
  let stat
  try { stat = statSync(full) } catch { continue }
  const ageHours = (now - stat.mtimeMs) / 3_600_000
  if (ageHours < older) { skippedYoung += 1; continue }
  const { bytes, files } = sizeOf(full)
  rows.push({ name: entry.name, files, mb: bytes / 1_048_576, ageHours })
}

const totalFiles = rows.reduce((sum, row) => sum + row.files, 0)
const totalMb = rows.reduce((sum, row) => sum + row.mb, 0)
rows.sort((a, b) => b.mb - a.mb)

console.log(`候选目录 ${rows.length} 个｜文件 ${totalFiles} 个｜约 ${totalMb.toFixed(1)} MB｜跳过 ${skippedYoung} 个（${older}h 内）`)
for (const row of rows.slice(0, 12)) {
  console.log(`  ${row.name}  ${row.files} 个文件 / ${row.mb.toFixed(1)} MB / ${row.ageHours.toFixed(0)}h 前`)
}
if (rows.length > 12) console.log(`  … 还有 ${rows.length - 12} 个`)

if (!apply) {
  console.log('\n只列出，未删除。确认后加 --apply（可加 --older-than=24）。')
  process.exit(0)
}

let removed = 0
let failed = 0
for (const row of rows) {
  try {
    rmSync(join(tmpdir(), row.name), { recursive: true, force: true })
    removed += 1
  } catch {
    failed += 1
  }
}
console.log(`\n已删除 ${removed} 个目录，失败 ${failed} 个（多半被进程占用）。`)
