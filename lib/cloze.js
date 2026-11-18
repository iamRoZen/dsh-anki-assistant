/**
 * 挖空结构检查：按 Anki 的解析方式（非贪婪找第一个 `}}`）判断一根答案是否会被截断。
 *
 * 典型问题：`^{\mathrm{T}}` 结尾自带 `}}`，Anki 会在这里结束挖空，
 * 后面的 LaTeX 和真正的结尾 `}}` 全部丢掉——预览看着像"公式坏了"，其实是卡写错了。
 */

export const CLOZE_BRACE_MESSAGE = '挖空内出现连续 }}（常见于 ^{\\mathrm{T}} 这类上标）：Anki 会在此提前截断，请把上标写成 ^{\\mathrm{T} }（大括号间加空格）或改用 T'

export function scanCloze(answer) {
  const text = String(answer ?? '')
  const issues = []
  const start = text.indexOf('{{c1::')
  if (start === -1) return issues

  const firstClose = text.indexOf('}}', start + 6)
  const lastClose = text.lastIndexOf('}}')

  if (firstClose === -1) {
    issues.push({ code: 'UNCLOSED', message: '挖空没有闭合（缺少 }}）' })
    return issues
  }

  if (lastClose > firstClose) {
    const body = text.slice(start + 6, lastClose)
    if (body.includes('}}')) {
      issues.push({ code: 'BRACE', message: CLOZE_BRACE_MESSAGE })
    }
  }

  const tail = text.slice(firstClose + 2)
  if (tail.trim()) {
    issues.push({
      code: 'TAIL',
      message: `}} 之后还有 ${tail.trim().length} 字符，Anki 会丢弃：${tail.trim().slice(0, 40)}`,
    })
  }
  return issues
}
