import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clozeIssues, longLines, ordinalIssues, ordinals, tableCellIssues, weigh,
} from '../lib/validators.js'

test('字当量：汉字 1、ASCII 0.5、公式起价', () => {
  assert.equal(weigh('汉字').value, 2)
  assert.equal(weigh('ab汉字').value, 3)          // 2/2 + 2
  assert.equal(weigh('汉字<anki-mathjax>x</anki-mathjax>').value, 2 + 4)
  assert.equal(weigh('<anki-mathjax block="true">x</anki-mathjax>').value, 15)
})

test('字当量：手写序号与挖空标记不计', () => {
  assert.equal(weigh('{{c1::<b>1.</b>甲}}').value, 1)
})

test('序号只认块首，正文里的数字不算', () => {
  assert.deepEqual(ordinals('<b>1.</b>甲<br><b>1.1</b>乙'), [[1], [1, 1]])
  assert.deepEqual(ordinals('起病3～6小时'), [])
  assert.deepEqual(ordinals('甲<b>2.</b>乙'), [])
})

test('序号树：重复、父号缺失、缺号', () => {
  assert.equal(ordinalIssues('<b>1.</b>a<br><b>1.</b>b').length, 1)
  assert.match(ordinalIssues('<b>1.1</b>a').join(''), /父号 1 不存在/)
  assert.match(ordinalIssues('<b>1.</b>a<br><b>1.2</b>b').join(''), /缺号/)
  assert.deepEqual(ordinalIssues('<b>1.</b>a<br><b>1.1</b>b<br><b>2.</b>c'), [])
})

test('行长：按序号行与 li 分别算，表格不算', () => {
  const long = `<b>1.</b>${'甲'.repeat(30)}`
  assert.equal(longLines(long, 25).length, 1)
  assert.equal(longLines(`<table><tr><td>${'甲'.repeat(30)}</td></tr></table>`, 25).length, 0)
  const withList = `<b>1.</b>短<br><ul><li>${'甲'.repeat(30)}</li></ul>`
  assert.equal(longLines(withList, 25).length, 1)
})

test('表格格内 ≥3 项且有择一标记才报', () => {
  const bad = '<table><tr><td>激素无效或耐药或禁忌</td></tr></table>'
  assert.equal(tableCellIssues(bad).length, 1)
  const ok = '<table><tr><td><ol><li>a</li></ol></td></tr></table>'
  assert.equal(tableCellIssues(ok).length, 0)
  const two = '<table><tr><td>甲或乙</td></tr></table>'
  assert.equal(tableCellIssues(two).length, 0)
})

test('挖空尾巴：}} 之后还有内容要报', () => {
  assert.deepEqual(clozeIssues('{{c1::甲}}'), [])
  assert.equal(clozeIssues('{{c1::甲}}尾巴}}').some((issue) => issue.includes('之后')), true)
  assert.equal(clozeIssues('甲}}').some((issue) => issue.includes('开头')), true)
})
