/**
 * 与旧方案对齐的结构检查器：字当量、序号树、行长、表格格内并列、挖空尾巴。
 *
 * 算法照 tools/measure.py 与 tools/structure.py 的口径实现，差异由 parity 测试兜住。
 * 这里只算，不判好坏；阈值由方案的 quality.rules 给。
 */

const CODE_RE = /<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi
const MATH_RE = /<anki-mathjax block="true">([\s\S]*?)<\/anki-mathjax>|\\\[([\s\S]*?)\\\]|<anki-mathjax>([\s\S]*?)<\/anki-mathjax>|\\\((.+?)\\\)/g
const ORD_RE = /<b>(\d+(?:\.\d+)*)[.、]?<\/b>/g
const CJK_RE = /[\u4e00-\u9fff]/g
const ASCII_RUN = /[A-Za-z0-9]+/g
const TAG_RE = /<[^>]+>/g

const WEIGHT_BLOCK = 15
const WEIGHT_INLINE = 4

function maskCode(text) {
  return text.replace(CODE_RE, (match) => ' '.repeat(match.length))
}

/** 字当量：汉字 + ASCII/2 + Σ max(起价, 源码长/2)；手写序号不计。 */
export function weigh(html) {
  let text = String(html ?? '').replaceAll('{{c1::', '').replaceAll('}}', '')
  text = text.replace(/<b>\d+(?:\.\d+)*[.、]?<\/b>/g, '')

  const pieces = []
  const spans = []
  let pos = 0
  MATH_RE.lastIndex = 0
  for (const match of maskCode(text).matchAll(MATH_RE)) {
    pieces.push(text.slice(pos, match.index))
    const groups = match.slice(1)
    const block = groups[0] !== undefined ? groups[0] : groups[1]
    let src = groups.find((group) => group !== undefined) ?? ''
    src = src.replace(/<\/?anki-mathjax[^>]*>/g, '')
    for (const delim of ['\\[', '\\]', '\\(', '\\)']) src = src.replaceAll(delim, '')
    spans.push({ kind: block !== undefined ? 'block' : 'inline', length: src.length })
    pos = match.index + match[0].length
  }
  pieces.push(text.slice(pos))

  const plain = pieces.join('').replace(TAG_RE, '').replace(/\s+/g, '')
  const han = (plain.match(CJK_RE) ?? []).length
  const ascii = (plain.match(ASCII_RUN) ?? []).reduce((sum, run) => sum + run.length, 0)

  let total = han + ascii / 2
  for (const span of spans) {
    total += Math.max(span.kind === 'block' ? WEIGHT_BLOCK : WEIGHT_INLINE, span.length / 2)
  }
  return {
    value: pyRound(total),
    han,
    ascii,
    block: spans.filter((span) => span.kind === 'block').length,
    inline: spans.filter((span) => span.kind === 'inline').length,
  }
}

/** Python round() 是「四舍六入五取偶」，直接 Math.round 会在 .5 上错 1。 */
function pyRound(value) {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** 只认块首的 <b>1.</b> / <b>1.1</b>；正文里的数字不算序号。 */
export function ordinals(html) {
  const found = []
  for (const match of String(html ?? '').matchAll(ORD_RE)) {
    const before = String(html).slice(0, match.index)
    const cut = before.lastIndexOf('>')
    const tail = cut >= 0 ? before.slice(cut + 1) : before
    if (tail.trim()) continue
    found.push(match[1].split('.').map(Number))
  }
  return found
}

export function formatOrdinal(item) {
  return `${item.join('.')}${item.length > 1 ? '' : '.'}`
}

export function ordinalIssues(html) {
  const found = ordinals(html)
  if (found.length === 0) return []
  const issues = []
  const key = (item) => item.join('.')
  const seen = new Set(found.map(key))
  const counts = new Map()
  for (const item of found) {
    const id = key(item)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const [id, count] of counts) if (count > 1) issues.push(`序号重复：${id}`)

  const siblings = new Map()
  for (const item of found) {
    const parent = item.slice(0, -1).join('.')
    if (!siblings.has(parent)) siblings.set(parent, new Set())
    siblings.get(parent).add(item.at(-1))
  }
  for (const parent of siblings.keys()) {
    if (parent && !seen.has(parent)) issues.push(`父号 ${parent} 不存在`)
  }
  for (const [parent, kids] of siblings) {
    const list = [...kids].sort((a, b) => a - b)
    const expected = Array.from({ length: Math.max(...list) }, (_, i) => i + 1)
    if (list.join(',') !== expected.join(',')) {
      issues.push(`${parent ? `${parent} 的子号` : '顶层'}缺号：${list.join(',')}`)
    }
  }
  return issues
}

const LI_RE = /<li[^>]*>([\s\S]*?)<\/li>/g

/** 按块首序号切段，每段返回 [序号, 段内文本]。 */
export function segments(html) {
  const marks = []
  for (const match of String(html ?? '').matchAll(ORD_RE)) {
    const before = String(html).slice(0, match.index)
    const cut = before.lastIndexOf('>')
    const tail = cut >= 0 ? before.slice(cut + 1) : before
    if (tail.trim()) continue
    marks.push({ start: match.index, end: match.index + match[0].length, num: match[1] })
  }
  return marks.map((mark, index) => ({
    num: mark.num,
    body: String(html).slice(mark.end, index + 1 < marks.length ? marks[index + 1].start : undefined),
  }))
}

/** 一行一「眼」：序号行一行，每个 <li> 各一行；表格不参与行长检查。 */
export function visualLines(answer) {
  const text = String(answer ?? '')
  if (text.toLowerCase().includes('<table')) return []
  const lines = []
  for (const segment of segments(text)) {
    const items = [...segment.body.matchAll(LI_RE)].map((match) => match[1])
    const head = segment.body.replace(LI_RE, '').replaceAll('</ul>', '').replaceAll('<ul>', '')
    if (head.trim()) lines.push({ label: segment.num, weight: weigh(head).value })
    items.forEach((item, index) => lines.push({ label: `${segment.num}-${index + 1}`, weight: weigh(item).value }))
  }
  return lines
}

export function longLines(answer, limit = 25) {
  return visualLines(answer).filter((line) => line.weight > limit)
}

/** 表格格内并列：≥3 项、含「或 / 」这类择一标记、又没有 <br> 或 <li>。 */
export function tableCellIssues(answer) {
  const text = String(answer ?? '')
  if (!text.toLowerCase().includes('<table')) return []
  const issues = []
  const rows = [...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
  rows.forEach((row, rowIndex) => {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    cells.forEach((cell, colIndex) => {
      const html = cell[1]
      if (/<li/i.test(html) || /<br/i.test(html)) return
      const plain = html.replace(TAG_RE, '')
      const items = plain.split(/[、；;]|或/).map((part) => part.trim()).filter(Boolean)
      if (items.length < 3) return
      if (!/[或/／]/.test(plain)) return
      issues.push({ row: rowIndex + 1, col: colIndex + 1, items: items.length })
    })
  })
  return issues
}

/** 挖空形状：开头、结尾，以及 `}}` 之后挂尾巴（静默丢失）。 */
export function clozeIssues(answer) {
  const text = String(answer ?? '').trim()
  const issues = []
  if (!text.startsWith('{{c1::')) issues.push('答案不以 {{c1:: 开头')
  if (!text.endsWith('}}')) issues.push('答案不以 }} 结尾')
  const first = text.indexOf('}}')
  if (first !== -1) {
    const tail = text.slice(first + 2).trim()
    if (tail) issues.push(`}} 之后还有 ${tail.length} 字符：${tail.slice(0, 40)}`)
  }
  return issues
}
