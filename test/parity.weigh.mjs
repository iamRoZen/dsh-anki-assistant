/**
 * 字当量口径对齐：同一段 HTML，JS 实现与旧 tools/measure.py 必须给出同一个数。
 *
 *   node test/parity.weigh.mjs
 *
 * 找不到旧仓库或 Python 时跳过（不算失败），只提示未验证。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { weigh } from '../lib/validators.js'

const VENDOR = 'D:\\Users\\lsz\\Documents\\ChatGPT\\Anki制卡\\dsh-anki-cards\\vendor\\anki-cards'
if (!existsSync(join(VENDOR, 'tools', 'measure.py'))) {
  console.log('跳过：找不到旧 measure.py，字当量未做对齐验证')
  process.exit(0)
}

const fixtures = [
  '汉字两个',
  'ASCII and 汉字 mixed 123',
  '<b>1.</b>手写序号不计',
  '{{c1::挖空包裹}}',
  '行内 <anki-mathjax>x^2</anki-mathjax> 公式',
  '<anki-mathjax block="true">\\int_0^1 x dx</anki-mathjax>',
  '<code>let x = 1</code> 代码不计',
  '<b>1.</b>甲<br><b>1.1</b>乙丙丁',
]

const script = [
  'import sys, json',
  `sys.path.insert(0, r"${VENDOR}")`,
  'from tools.measure import weigh',
  'print(json.dumps(weigh(sys.argv[1]), ensure_ascii=False))',
].join('\n')

let failures = 0
for (const html of fixtures) {
  const py = JSON.parse(execFileSync('python', ['-X', 'utf8', '-c', script, html], { encoding: 'utf8' }))
  const js = weigh(html)
  const same = py.value === js.value && py.han === js.han && py.ascii === js.ascii
    && py.block === js.block && py.inline === js.inline
  if (!same) {
    failures += 1
    console.log('✗', JSON.stringify(html))
    console.log('   py:', JSON.stringify(py))
    console.log('   js:', JSON.stringify(js))
  } else {
    console.log('✓', py.value, JSON.stringify(html))
  }
}
console.log(failures === 0 ? `全部一致（${fixtures.length} 例）` : `${failures} 例不一致`)
process.exit(failures === 0 ? 0 : 1)
