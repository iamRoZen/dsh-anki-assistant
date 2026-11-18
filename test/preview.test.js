import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCardsHtml, clozeBack, clozeFront, fieldsToHtml, renderTemplate, splitFields,
} from '../lib/preview.js'

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

test('真实模板：字段替换、FrontSide、条件段、cloze 两面不同', () => {
  const front = '{{#问题}}<b>{{问题}}</b>{{/问题}}{{cloze:答案}}'
  const back = '{{FrontSide}}<hr>{{cloze:答案}}{{^笔记}}（无笔记）{{/笔记}}'
  const f = renderTemplate(front, fields, 'front')
  const b = renderTemplate(back, fields, 'back', f)
  assert.match(f, /<b>格林公式的使用条件<\/b>/)
  assert.match(f, /\[\.\.\.\]/)
  assert.match(b, /格林公式的使用条件/)
  assert.match(b, /class="cloze"/)
  assert.doesNotMatch(b, /无笔记/)
})

test('字段按角色分正反面：memory 只在背面，答案只在背面揭示', () => {
  const { front, back } = splitFields(scheme, fields)
  assert.deepEqual(front.map((item) => item.field), ['问题', '章节定位', '答案'])
  assert.equal(front.find((item) => item.field === '答案').html, '[...]')
  assert.deepEqual(back.map((item) => item.field), ['答案', '笔记', '引用'])
})

test('渲染出的 HTML 含模型 CSS 与正反面分区', () => {
  const split = splitFields(scheme, fields)
  const html = buildCardsHtml({
    cards: [{ frontHtml: fieldsToHtml(split.front), backHtml: fieldsToHtml(split.back) }],
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

test('默认加载 MathJax，mathjax=false 可关闭', () => {
  const split = splitFields(scheme, fields)
  const cards = [{ frontHtml: fieldsToHtml(split.front), backHtml: fieldsToHtml(split.back) }]
  assert.match(buildCardsHtml({ cards }), /mathjax@3/)
  assert.doesNotMatch(buildCardsHtml({ cards, mathjax: false }), /mathjax@3/)
})
