/**
 * 离线预览渲染：按方案的字段角色拼正面/背面，套 Anki 模型自带的 CSS。
 *
 * 不是 Anki 模板引擎的复刻：只处理 c1 挖空、字段角色、基本样式，
 * 目的是让人在对话外快速看清"这张卡长什么样"，不是像素级还原。
 */
import { spawn } from 'node:child_process'

const CLOZE_RE = /\{\{c1::([\s\S]*?)\}\}/g

export function clozeFront(html) {
  return String(html ?? '').replace(CLOZE_RE, '[...]')
}

export function clozeBack(html) {
  return String(html ?? '').replace(CLOZE_RE, '<span class="cloze">$1</span>')
}

/** 按字段角色分配正反面：locator/meta 在正面，memory 只在背面，答案在背面揭示。 */
export function splitFields(scheme, fields) {
  const specs = scheme?.output?.fields ?? []
  const answerName = specs.find((field) => field.role === 'content' && field.name !== '问题')?.name
    ?? '答案'
  const front = []
  const back = []
  for (const spec of specs) {
    const value = fields?.[spec.name] ?? ''
    if (spec.role === 'memory') {
      if (value) back.push({ field: spec.name, html: value, memory: true })
      continue
    }
    // 引用/出处这类定位放背面，章节定位留正面（与 QAC 模板观感一致）
    if (spec.role === 'locator' && spec.name !== '章节定位') {
      if (value) back.push({ field: spec.name, html: value, cite: true })
      continue
    }
    if (spec.name === answerName) {
      if (!value) continue
      front.push({ field: spec.name, html: clozeFront(value), hidden: true })
      back.push({ field: spec.name, html: clozeBack(value), answer: true })
      continue
    }
    if (value) front.push({ field: spec.name, html: value })
  }
  if (!specs.length) {
    for (const [name, value] of Object.entries(fields ?? {})) {
      if (value) front.push({ field: name, html: String(value) })
    }
  }
  return { front, back, answerName }
}

function block(items) {
  return items.map((item) => `<div class="field" data-field="${escapeAttr(item.field)}">${item.html}</div>`).join('\n')
}

function escapeAttr(value) {
  return String(value ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

const BASE_CSS = `
  body { margin: 0; padding: 24px; background: #f5f5f7; font: 16px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1d1d1f; }
  h1 { font-size: 18px; margin: 0 0 16px; font-weight: 600; }
  .card { background: #fff; border-radius: 12px; padding: 20px 24px; margin: 0 0 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card h2 { font-size: 13px; color: #6e6e73; margin: 0 0 12px; font-weight: 500; letter-spacing: .04em; }
  .pane { border-top: 1px solid #e5e5ea; padding-top: 12px; margin-top: 12px; }
  .pane h3 { font-size: 12px; color: #8e8e93; margin: 0 0 8px; font-weight: 500; }
  .field { margin: 0 0 8px; }
  .field[data-field="引用"], .field[data-field="章节定位"] { color: #6e6e73; font-size: 13px; }
  .cloze { color: #0a84ff; font-weight: 600; }
  .hidden { color: #8e8e93; }
`

export function buildCardsHtml({ cards, css = '', title = 'Anki 预览' }) {
  const body = cards.map((card, index) => {
    const front = `<div class="pane"><h3>正面</h3>${block(card.front)}</div>`
    const back = `<div class="pane"><h3>背面</h3>${block(card.back)}</div>`
    return `<section class="card"><h2>#${index + 1}</h2>${front}${back}</section>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeAttr(title)}</title>
<style>${BASE_CSS}\n/* 模型自带样式 */\n${css || ''}</style></head>
<body><h1>${escapeAttr(title)}（${cards.length} 张）</h1>
${body}
</body></html>`
}

/** 用系统默认浏览器打开本地文件；失败静默，不影响主流程。 */
export function openFile(file) {
  const platform = process.platform
  const command = platform === 'win32' ? 'explorer' : (platform === 'darwin' ? 'open' : 'xdg-open')
  try {
    spawn(command, [file], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    // 打不开就只返回路径
  }
}
