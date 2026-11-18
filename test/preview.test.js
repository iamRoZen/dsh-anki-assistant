import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCardsHtml, clozeBack, clozeFront, splitFields } from '../lib/preview.js'

const scheme = {
  output: {
    fields: [
      { name: '问题', role: 'content' },
      { name: '章节定位', role: 'locator' },
      { name: '要点数', role: 'meta' },
      { name: '答案', role: 'content' },
      { name: '笔记', role: 'memory' },
      { name: '引用', role: 'locator' },
    ],
  },
}

const fields = {
  问题: '格林公式的使用条件',
  章节定位: '高等数学 ‖ 第十一章',
  要点数: '',
  答案: '{{c1::<ol><li>条件一</li></ol>}}',
  笔记: '按 区域 → 函数 → 方向',
  引用: '高等数学 ‖ p200:L12-20',
}

test('挖空：正面隐藏、背面揭示', () => {
  assert.equal(clozeFront('{{c1::甲}}乙'), '[...]乙')
  assert.match(clozeBack('{{c1::甲}}乙'), /class="cloze">甲</)
  assert.equal(clozeFront('无挖空'), '无挖空')
})

test('字段按角色分正反面：memory 只在背面，答案只在背面揭示', () => {
  const { front, back } = splitFields(scheme, fields)
  const frontFields = front.map((item) => item.field)
  const backFields = back.map((item) => item.field)
  assert.deepEqual(frontFields, ['问题', '章节定位', '答案'])
  assert.equal(front.find((item) => item.field === '答案').html, '[...]')
  assert.deepEqual(backFields, ['答案', '笔记', '引用'])
  assert.match(back.find((item) => item.field === '笔记').html, /区域/)
})

test('渲染出的 HTML 含模型 CSS 与正反面分区', () => {
  const html = buildCardsHtml({
    cards: [splitFields(scheme, fields)],
    css: '.card{color:#123}',
    title: '测试',
  })
  assert.match(html, /<!doctype html>/)
  assert.match(html, /正面/)
  assert.match(html, /背面/)
  assert.match(html, /\.card\{color:#123\}/)
  assert.match(html, /格林公式的使用条件/)
})

test('缺字段不炸：空字段跳过', () => {
  const { front } = splitFields(scheme, { 问题: '只有问题' })
  assert.equal(front.length, 1)
})
