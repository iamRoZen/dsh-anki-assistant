import test from 'node:test'
import assert from 'node:assert/strict'

import { compareFields, evaluate } from '../lib/rules.js'

const rules = [
  { id: 'q', field: '问题', kind: 'endsWith', value: '？' },
  { id: 'caps', field: '答案', kind: 'maxLength', value: 10 },
  { id: 'cloze', field: '答案', kind: 'startsWith', value: '{{c1::' },
  { id: 'nomd', field: '答案', kind: 'forbids', value: '\\*\\*' },
  { id: 'both', fields: ['问题', '答案'], kind: 'required' },
]

test('规则逐条命中，错误里带字段与规则 id', () => {
  const issues = evaluate({ 问题: '这是什么', 答案: '{{c1::短}}' }, rules)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, '问题')
  assert.equal(issues[0].ruleId, 'q')
})

test('长度按字符计，中文算一个', () => {
  const limit = [{ id: 'a', field: '答案', kind: 'maxLength', value: 12 }]
  // "{{c1::" 6 字 + 中文 3 字 + "}}" 2 字 = 11，未超
  assert.equal(evaluate({ 答案: '{{c1::一二三}}' }, limit).length, 0)
  // 多一个字就超：6 + 5 + 2 = 13
  assert.equal(evaluate({ 答案: '{{c1::一二三四五}}' }, limit).length, 1)
})

test('required 把空白当作缺失', () => {
  assert.equal(evaluate({ 问题: '   ', 答案: '' }, [{ id: 'r', fields: ['问题', '答案'], kind: 'required' }]).length, 2)
})

test('forbids 抓 Markdown 粗体', () => {
  const issues = evaluate({ 答案: '{{c1::**重点**}}' }, rules)
  assert.equal(issues.some((issue) => issue.ruleId === 'nomd'), true)
})

test('未知规则类型被忽略而不是抛错', () => {
  assert.deepEqual(evaluate({ 答案: 'x' }, [{ id: 'x', field: '答案', kind: 'nope' }]), [])
})

test('字段比对报出缺字段与判重键不一致', () => {
  const issues = compareFields(
    [{ name: '问题' }, { name: '答案' }, { name: '笔记' }],
    ['答案', '问题'],
  )
  assert.equal(issues.some((issue) => issue.kind === 'model-fields'), true)
  assert.equal(issues.some((issue) => issue.kind === 'dedupe-key'), true)
})

test('字段完全一致时没有问题', () => {
  assert.deepEqual(compareFields([{ name: '问题' }, { name: '答案' }], ['问题', '答案']), [])
})
