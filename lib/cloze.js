/**
 * 挖空结构检查：按 Anki 的解析方式（非贪婪找第一个 `}}`）判断一根答案是否会被截断。
 *
 * 典型问题：`^{\mathrm{T}}` 结尾自带 `}}`，Anki 会在这里结束挖空，
 * 后面的 LaTeX 和真正的结尾 `}}` 全部丢掉——预览看着像"公式坏了"，其实是卡写错了。
 */

export const CLOZE_BRACE_MESSAGE = '挖空内出现连续 }}（常见于 ^{\\mathrm{T}} 这类上标）：Anki 会在此提前截断，请把上标写成 ^{\\mathrm{T} }（大括号间加空格）或改用 T'

/**
 * 哪个字段是挖空字段，由方案决定：优先 role=content 且不是「问题」的那个，
 * 其次名字叫「答案」的，最后看 spec 里是否写了「挖空」。找不到返回 null。
 */
export function clozeFieldName(scheme) {
  const fields = scheme?.output?.fields ?? []
  const byRole = fields.find((field) => field.role === 'content' && field.name !== '问题')
  if (byRole) return byRole.name
  const named = fields.find((field) => field.name === '答案')
  if (named) return named.name
  const bySpec = fields.find((field) => String(field.spec ?? '').includes('挖空'))
  return bySpec ? bySpec.name : null
}

export function scanCloze(answer) {  const text = String(answer ?? '')
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

/**
 * 自动修复：把挖空内部的连续 `}}` 改成 `} }`，答案末尾的关闭符保留。
 * 只处理「整段以 {{c1:: 开头、以 }} 结尾」的卡；其它形状原样返回，不猜。
 */
export function fixClozeBraces(answer) {
  const text = String(answer ?? '')
  const start = text.indexOf('{{c1::')
  if (start === -1) return { text, changed: false }
  const end = text.lastIndexOf('}}')
  if (end <= start + 6) return { text, changed: false }
  const inner = text.slice(start + 6, end)
  if (!inner.includes('}}')) return { text, changed: false }
  const fixed = inner.replaceAll('}}', '} }')
  return { text: text.slice(0, start) + '{{c1::' + fixed + '}}', changed: true }
}
