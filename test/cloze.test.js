import test from 'node:test'
import assert from 'node:assert/strict'

import { clozeFieldName, fixClozeBraces, scanCloze } from '../lib/cloze.js'

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

test('fixClozeBraces 把内部 }} 改成 } }，保留结尾', () => {
  const broken = '{{c1::取 \\(v=[\\,1\\ 2\\,]^{\\mathrm{T}}\\) 两组}}'
  const { text, changed } = fixClozeBraces(broken)
  assert.equal(changed, true)
  assert.match(text, /\\mathrm\{T\} \}/)
  assert.match(text, /\}\}$/)
  const codes = scanCloze(text).map((issue) => issue.code)
  assert.equal(codes.length, 0, `修复后不应再有挖空问题，实际 ${codes.join(',')}`)
})

test('fixClozeBraces 对正常卡不改动', () => {
  const ok = '{{c1::<ol><li>条件一</li></ol>}}'
  const { text, changed } = fixClozeBraces(ok)
  assert.equal(changed, false)
  assert.equal(text, ok)
})

test('挖空字段由方案决定，不写死「答案」', () => {
  assert.equal(clozeFieldName({
    output: { fields: [{ name: '问题', role: 'content' }, { name: '解答', role: 'content' }] },
  }), '解答')
  assert.equal(clozeFieldName({
    output: { fields: [{ name: '问题' }, { name: '答案' }] },
  }), '答案')
  assert.equal(clozeFieldName({
    output: { fields: [{ name: '问题' }, { name: '要点', spec: '写挖空答案' }] },
  }), '要点')
  assert.equal(clozeFieldName({ output: { fields: [{ name: '问题' }] } }), null)
})
