import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { evaluate } from '../lib/rules.js'
import { weigh } from '../lib/validators.js'

const DIR = new URL('../assets/schemes/medical-qac-2026/', import.meta.url)
const scheme = JSON.parse(readFileSync(new URL('scheme.json', DIR), 'utf8'))
const pass = JSON.parse(readFileSync(new URL('samples/pass.json', DIR), 'utf8'))
const fail = JSON.parse(readFileSync(new URL('samples/fail.json', DIR), 'utf8'))

test('归纳方案本身可校验：规则引用的字段都在', () => {
  const names = new Set(scheme.output.fields.map((field) => field.name))
  for (const rule of scheme.quality.rules) {
    for (const field of rule.field ? [rule.field] : rule.fields ?? []) {
      assert.equal(names.has(field), true, `规则 ${rule.id} 引用了不存在的字段 ${field}`)
    }
  }
})

test('合格样卡逐条通过，且要点数等于字当量', () => {
  const issues = evaluate(pass.fields, scheme.quality.rules)
  assert.deepEqual(issues, [], `不应有问题：${JSON.stringify(issues)}`)
  assert.equal(pass.fields.要点数, `${weigh(pass.fields.答案).value}字`)
})

test('反例被预期规则拦下', () => {
  const issues = evaluate(fail.fields, scheme.quality.rules)
  const hit = new Set(issues.map((issue) => issue.ruleId))
  for (const expected of fail.expect) {
    assert.equal(hit.has(expected), true, `应拦 ${expected}，实际拦下：${[...hit].join(',')}`)
  }
  // 反例的问题与引用本身是合格的，避免"整张都烂"掩盖定位问题
  assert.equal(issues.some((issue) => issue.ruleId === 'loc-form' || issue.ruleId === 'cite-locator'), false)
})

test('反例的失败理由可解释：尾巴、缺号、字当量', () => {
  const issues = evaluate(fail.fields, scheme.quality.rules)
  const text = issues.map((issue) => issue.message).join(' / ')
  assert.match(text, /之后/)
  assert.match(text, /缺号/)
  assert.match(text, /字当量/)
})
