import test from 'node:test'
import assert from 'node:assert/strict'

import { itemsToLines, findLines } from '../lib/materials.js'

function item(str, x, y) {
  return { str, transform: [1, 0, 0, 1, x, y], width: 10, height: 10 }
}

test('同一 y 的片段按 x 合并成一行，y 大的在前', () => {
  const lines = itemsToLines([
    item('第二行', 0, 80),
    item('第一行', 0, 90),
    item('后半', 40, 90),
  ])
  assert.deepEqual(lines, ['第一行后半', '第二行'])
})

test('中文之间不留空格，拉丁词之间保留空格', () => {
  const lines = itemsToLines([
    item('心肌', 0, 100),
    item('梗死', 22, 100),
  ])
  assert.deepEqual(lines, ['心肌梗死'])

  const latin = itemsToLines([
    item('Johann', 0, 100),
    item('Jakob', 30, 100),
  ])
  assert.deepEqual(latin, ['Johann Jakob'])
})

test('空白片段被丢掉', () => {
  const lines = itemsToLines([item('  ', 0, 100), item('内容', 10, 100)])
  assert.deepEqual(lines, ['内容'])
})

test('findLines 返回页码与 1 基行号', () => {
  const material = {
    pages: [
      { page: 31, lines: ['第一章', '药理学的诞生', '实验药理学的奠基'] },
      { page: 32, lines: ['继续'] },
    ],
  }
  const hits = findLines(material, '药理学')
  assert.equal(hits.length, 2)
  assert.equal(hits[0].page, 31)
  assert.equal(hits[0].line, 2)
})

test('空关键词不命中', () => {
  assert.deepEqual(findLines({ pages: [{ page: 1, lines: ['x'] }] }, '  '), [])
})

test('同高度相距较远的双栏保留独立行', () => {
  const lines = itemsToLines([
    item('左栏第一行', 0, 100), item('右栏第一行', 350, 100),
    item('左栏第二行', 0, 90), item('右栏第二行', 350, 90),
  ])
  assert.deepEqual(lines, ['左栏第一行', '右栏第一行', '左栏第二行', '右栏第二行'])
})
