/**
 * 卡面渲染：按 Anki 模型的真实模板（Front/Back + CSS）生成 HTML，可选转 PNG。
 *
 * 模板语法只支持常用子集：{{字段}}、{{cloze:字段}}、{{FrontSide}}、
 * {{#字段}}…{{/字段}}、{{^字段}}…{{/字段}}；type/tts/hint 直接去掉。
 * 不追求像素级还原，但字段与挖空的取值路径和 Anki 一致。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CLOZE_RE = /\{\{c1::([\s\S]*?)\}\}/g

export function clozeFront(html) {
  return String(html ?? '').replace(CLOZE_RE, '[...]')
}

export function clozeBack(html) {
  return String(html ?? '').replace(CLOZE_RE, '<span class="cloze">$1</span>')
}

function fieldValue(fields, name) {
  return String(fields?.[name.trim()] ?? '')
}

/** 按真实模板渲染一面。side = 'front' | 'back'；背面需要正面结果填 FrontSide。 */
export function renderTemplate(template, fields, side = 'front', frontHtml = '') {
  let out = String(template ?? '')
  out = out.replace(/\{\{#([^{}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name, body) => (fieldValue(fields, name) ? body : ''))
  out = out.replace(/\{\{\^([^{}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, name, body) => (fieldValue(fields, name) ? '' : body))
  out = out.replace(/\{\{FrontSide\}\}/g, frontHtml)
  out = out.replace(/\{\{cloze:([^{}]+)\}\}/g, (_, name) => (side === 'front'
    ? clozeFront(fieldValue(fields, name))
    : clozeBack(fieldValue(fields, name))))
  out = out.replace(/\{\{\s*(?:type|tts|hint):[^{}]+\}\}/g, '')
  out = out.replace(/\{\{([^{}:]+)\}\}/g, (_, name) => fieldValue(fields, name))
  return out
}

/** 没有模板时的兜底：按字段角色拼正反面。 */
export function splitFields(scheme, fields) {
  const specs = scheme?.output?.fields ?? []
  const answerName = specs.find((field) => field.role === 'content' && field.name !== '问题')?.name ?? '答案'
  const front = []
  const back = []
  for (const spec of specs) {
    const value = fields?.[spec.name] ?? ''
    if (spec.role === 'memory') {
      if (value) back.push({ field: spec.name, html: value })
      continue
    }
    if (spec.role === 'locator' && spec.name !== '章节定位') {
      if (value) back.push({ field: spec.name, html: value })
      continue
    }
    if (spec.name === answerName) {
      if (!value) continue
      front.push({ field: spec.name, html: clozeFront(value) })
      back.push({ field: spec.name, html: clozeBack(value) })
      continue
    }
    if (value) front.push({ field: spec.name, html: value })
  }
  return { front, back, answerName }
}

export function fieldsToHtml(items) {
  return (items ?? [])
    .map((item) => `<div class="field" data-field="${String(item.field ?? '').replace(/"/g, '&quot;')}">${item.html}</div>`)
    .join('\n')
}

const BASE_CSS = `
  body { margin: 0; padding: 24px; background: #f5f5f7; font: 16px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1d1d1f; }
  h1 { font-size: 18px; margin: 0 0 16px; font-weight: 600; }
  .card { background: #fff; border-radius: 12px; padding: 20px 24px; margin: 0 0 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card h2 { font-size: 13px; color: #6e6e73; margin: 0 0 12px; font-weight: 500; }
  .pane { border-top: 1px solid #e5e5ea; padding-top: 12px; margin-top: 12px; }
  .pane h3 { font-size: 12px; color: #8e8e93; margin: 0 0 8px; font-weight: 500; }
  .cloze { color: #0a84ff; font-weight: 600; }
`

export function buildCardsHtml({ cards, css = '', title = 'Anki 预览', mathjax = true }) {
  const body = cards.map((card, index) => `<section class="card"><h2>#${index + 1}</h2>
<div class="pane"><h3>正面</h3>${card.frontHtml}</div>
<div class="pane"><h3>背面</h3>${card.backHtml}</div></section>`).join('\n')
  const math = mathjax
    ? `<script>window.MathJax = { tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['\\\\[', '\\\\]']] } };</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" async></script>`
    : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>${BASE_CSS}\n/* 模型自带样式 */\n${css || ''}</style></head>
<body><h1>${title}（${cards.length} 张）</h1>
${body}
${math}
</body></html>`
}

function findEdge() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  ]
  return candidates.find((path) => path && existsSync(path))
}

/** 用 Edge 无头模式把预览 HTML 截成 PNG；没有 Edge 或失败返回 null。 */
export async function renderPng(htmlFile, pngFile, { width = 1100, height = 1400, timeoutMs = 20000, virtualTimeBudget = 0 } = {}) {
  const edge = findEdge()
  if (!edge) return null
  const url = pathToFileURL(htmlFile).href
  return await new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(edge, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      ...(virtualTimeBudget > 0 ? [`--virtual-time-budget=${virtualTimeBudget}`] : []),
      `--screenshot=${pngFile}`,
      `--window-size=${width},${height}`,
      url,
    ], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 && existsSync(pngFile) ? pngFile : null))
  })
}

/** 用系统默认浏览器打开本地文件。 */
export function openFile(file) {
  const command = process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open')
  try {
    spawn(command, [file], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    // 打不开就只返回路径
  }
}
