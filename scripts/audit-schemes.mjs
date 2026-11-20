#!/usr/bin/env node
/**
 * 旧方案体检（只读）。
 *
 *   node scripts/audit-schemes.mjs                 # 默认 ~/.dsh/anki-assistant
 *   node scripts/audit-schemes.mjs <dataDir>
 *
 * 输出每个方案的版本、状态、交付物、字段/规则、附件与问题清单。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { schemeBodyPath } from '../lib/library.js'
import { schemeAssetDir } from '../lib/scheme.js'

const dataDir = process.argv[2] ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'anki-assistant')
const schemesDir = join(dataDir, 'schemes')

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

if (!existsSync(schemesDir)) {
  console.log(`没有方案目录：${schemesDir}`)
  process.exit(0)
}

const rows = []
for (const name of readdirSync(schemesDir)) {
  const dir = join(schemesDir, name)
  if (!existsSync(join(dir, 'active.json'))) continue
  const pointer = readJson(join(dir, 'active.json'))
  const record = Number.isSafeInteger(pointer?.version) && pointer.version > 0 ? readJson(join(dir, `v${pointer.version}.json`)) : null
  if (!record) {
    rows.push({ name, problem: '读不到 active 版本记录' })
    continue
  }
  const fields = record.output?.fields ?? []
  const names = new Set(fields.map((field) => field.name))
  const problems = []
  if (record.id !== name) problems.push(`目录名 ${name} ≠ id ${record.id}`)
  const lookup = { ...record, id: name, version: pointer.version }
  const assets = schemeAssetDir(dataDir, lookup)
  const body = existsSync(schemeBodyPath(dataDir, lookup))
  if (!body) problems.push('缺 body.md')
  if (record.deliverable === 'cards' && (!record.output?.model || fields.length === 0)) {
    problems.push('cards 方案缺模型或字段')
  }
  for (const rule of record.quality?.rules ?? []) {
    const targets = Array.isArray(rule.fields) ? rule.fields : [rule.field]
    for (const target of targets) {
      if (target && !names.has(target)) problems.push(`规则 ${rule.id} 指向不存在的字段 ${target}`)
    }
  }
  if (!record.status) problems.push('缺 status')
  const extras = ['samples', 'validate.mjs', 'print.css', 'evidence.md', 'checks.md']
    .filter((file) => existsSync(join(assets, file)))
  rows.push({
    id: record.id,
    version: pointer.version,
    status: record.status,
    deliverable: record.deliverable ?? 'method',
    fields: fields.length,
    rules: record.quality?.rules?.length ?? 0,
    validator: Boolean(record.quality?.validator ?? record.quality?.legacy),
    body,
    extras,
    problems,
  })
}

console.log(`数据目录：${dataDir}\n方案数：${rows.length}\n`)
for (const row of rows) {
  if (row.problem) {
    console.log(`✗ ${row.name}：${row.problem}`)
    continue
  }
  const flag = row.problems.length ? '⚠' : '✓'
  console.log(`${flag} ${row.id}@${row.version} [${row.status}] ${row.deliverable}｜字段 ${row.fields}｜规则 ${row.rules}｜校验器 ${row.validator ? '有' : '无'}｜正文 ${row.body ? '有' : '无'}`)
  if (row.extras.length) console.log(`    附件：${row.extras.join(', ')}`)
  for (const problem of row.problems) console.log(`    - ${problem}`)
}
const bad = rows.filter((row) => row.problem || row.problems.length).length
console.log(`\n有问题的方案：${bad}/${rows.length}`)
