import test from 'node:test'
import assert from 'node:assert/strict'

import { scanCloze } from '../lib/cloze.js'

const okCard = '{{c1::<ol><li>闭区域 \\(D\\) 由分段光滑曲线围成</li></ol>}}'

test('正常挖空不报问题', () => {
  assert.deepEqual(scanCloze(okCard), [])
  assert.deepEqual(scanCloze('没有挖空的答案'), [])
})

test('^{\mathrm{T}} 造成的连续 }} 会被拦下', () => {
  // 与 linalg-1-1 第 8 张同形：上标结尾的 }} 让 Anki 提前收尾
  const broken = '{{c1::取 \\(v=[\\,1\\ 2\\,]^{\\mathrm{T}}\\)、\\(w=[\\,3\\ 6\\,]^{\\mathrm{T}}\\)，方程组为 \\(c+3d=1\\)；</li></ol>}}'
  const codes = scanCloze(broken).map((issue) => issue.code)
  assert.equal(codes.includes('BRACE'), true, `应报 BRACE，实际 ${codes.join(',')}`)
  assert.equal(codes.includes('TAIL'), true, '截断后的尾巴也要报')
})

test('未闭合的挖空单独报', () => {
  const codes = scanCloze('{{c1::只有开头').map((issue) => issue.code)
  assert.deepEqual(codes, ['UNCLOSED'])
})
