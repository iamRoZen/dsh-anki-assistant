/**
 * gaoshu-steps 的校验入口：本方案自带，纯 JS，不依赖 Python 或插件通用层。
 *
 * 只管数学卡能机器判的部分：挖空形状、公式定界符、公式内裸尖括号、公式内 }}、
 * 答案是否条目化、问题是否是合格名词短语、有没有残留 Markdown。
 * 字当量与出处覆盖率本方案未接管。
 */

const CJK = /[\u4e00-\u9fff]/

function plain(html) {
  return String(html ?? '')
    .replace(/\{\{c\d+::/g, '')
    .replace(/\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function mathSpans(text) {
  const spans = []
  const inline = /\\\(([\s\S]*?)\\\)/g
  const block = /\\\[([\s\S]*?)\\\]/g
  for (const match of String(text ?? '').matchAll(inline)) spans.push({ kind: 'inline', body: match[1] })
  for (const match of String(text ?? '').matchAll(block)) spans.push({ kind: 'block', body: match[1] })
  return spans
}

function count(text, token) {
  return String(text ?? '').split(token).length - 1
}

function clozeIssues(answer) {
  const issues = []
  const text = String(answer ?? '').trim()
  if (!text.startsWith('{{c1::')) issues.push({ code: 'CLOZE', message: '答案不以 {{c1:: 开头' })
  if (!text.endsWith('}}')) issues.push({ code: 'CLOZE', message: '答案不以 }} 结尾' })
  const first = text.indexOf('}}')
  if (first !== -1) {
    const tail = text.slice(first + 2).trim()
    if (tail) issues.push({ code: 'CLOZE', message: `}} 之后还有 ${tail.length} 字符：${tail.slice(0, 30)}` })
  }
  return issues
}

function mathIssues(answer) {
  const issues = []
  const text = String(answer ?? '')
  if (count(text, '\\(') !== count(text, '\\)')) {
    issues.push({ code: 'MATH_DELIM', message: '\\( 与 \\) 数量不匹配' })
  }
  if (count(text, '\\[') !== count(text, '\\]')) {
    issues.push({ code: 'MATH_DELIM', message: '\\[ 与 \\] 数量不匹配' })
  }
  if (/\\\\[(\[]/.test(text)) {
    issues.push({ code: 'MATH_DELIM', message: '出现双反斜杠 \\\\( 或 \\\\[：MathJax 只认单反斜杠' })
  }
  for (const span of mathSpans(text)) {
    if (/[<>]/.test(span.body)) {
      issues.push({ code: 'MATH_ANGLE', message: `公式内含裸 < 或 >，改用 \\lt / \\gt：${span.body.slice(0, 30)}` })
    }
    if (span.body.includes('}}')) {
      issues.push({ code: 'MATH_BRACE', message: `公式内含 }}，会提前结束挖空：${span.body.slice(0, 30)}` })
    }
  }
  return issues
}

function stepsIssues(answer) {
  const text = String(answer ?? '')
  const body = plain(text)
  // 触发条件：显式换行、分号分点，或正文够长（数学卡按可见字数近似）
  const multiLine = /<br\s*\/?>/i.test(text)
  const semicolons = (body.match(/[；;]/g) ?? []).length
  const longEnough = [...body].length >= 40
  if ((multiLine || semicolons > 0 || longEnough) && !/<ol[\s>]/i.test(text)) {
    return [{
      code: 'STEPS',
      message: '答案应拆成 <ol><li>，一条一个动作；不要用 <br> 或分号把多条糊成一段',
    }]
  }
  return []
}

function problemIssues(question) {
  const issues = []
  const text = String(question ?? '').trim()
  const body = plain(text)
  if (/[？?]\s*$/.test(text)) {
    issues.push({ code: 'PROBLEM_FORM', message: '问题用名词短语，不用问句（不要以「？」结尾）' })
  }
  if (/^(怎么|怎样|如何|什么|为什么|什么叫|是否)/.test(body)) {
    issues.push({ code: 'PROBLEM_FORM', message: '问题不用自反性/提问式开头，改写成名词短语' })
  }
  if ([...body].length < 6) {
    issues.push({ code: 'PROBLEM_FORM', message: `问题过短（${[...body].length} 字），要有主语、能独立看懂` })
  }
  if (!CJK.test(body)) {
    issues.push({ code: 'PROBLEM_FORM', message: '问题里没有中文，检查是否写错字段' })
  }
  return issues
}

function mdIssues(text) {
  const issues = []
  const body = String(text ?? '')
  if (body.includes('**')) issues.push({ code: 'MD', message: '残留 Markdown 粗体 **，改用 <b>' })
  if (body.includes('`')) issues.push({ code: 'MD', message: '残留 Markdown 反引号' })
  return issues
}

/** 插件调用约定：validate(fields, options) → { suite, ok, issues, source } */
export async function validate(fields) {
  const answer = fields?.['答案'] ?? ''
  const question = fields?.['问题'] ?? ''
  const issues = [
    ...clozeIssues(answer),
    ...mathIssues(answer),
    ...stepsIssues(answer),
    ...problemIssues(question),
    ...mdIssues(answer),
    ...mdIssues(question),
  ]
  return {
    suite: 'gaoshu-steps',
    ok: issues.length === 0,
    issues,
    source: {
      status: 'unverified',
      reason: '本方案未接管出处覆盖率核验：结构已核，出处未核',
    },
  }
}
