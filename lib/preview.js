/**
 * 卡面渲染：按 Anki 模型的真实模板（Front/Back + CSS）生成 HTML，可选 PNG / PDF。
 *
 * 模板语法只支持常用子集：{{字段}}、{{cloze:字段}}、{{FrontSide}}、
 * {{#字段}}…{{/字段}}、{{^字段}}…{{/字段}}；type/tts/hint 直接去掉。
 *
 * 另外提供：
 *  - ankiBase：近似 Anki 基础样式（.card、图片、表格、夜间），与模型 CSS 叠加
 *  - measure：页面加载后量一遍横向溢出，把结果写进 <title>，供 dump-dom 读回
 *  - renderPdf：Edge 无头打印成 PDF
 */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { parseFragment, serialize } from 'parse5'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataPath } from './paths.js'

/**
 * 与 Anki 一致：非贪婪找第一个 `}}` 收尾。
 * `^{\mathrm{T}}` 结尾自带 `}}`，Anki 同样会在这里截断——
 * 这类卡片由 lib/cloze.js 的检查负责拦下，预览不做"聪明"的修补，否则会掩盖问题。
 */
export function replaceCloze(html, render) {
  const text = String(html ?? '')
  let out = ''
  let cursor = 0
  while (cursor <= text.length) {
    const start = text.indexOf('{{c1::', cursor)
    if (start === -1) {
      out += text.slice(cursor)
      break
    }
    const close = text.indexOf('}}', start + 6)
    if (close === -1) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, start) + render(text.slice(start + 6, close))
    cursor = close + 2
  }
  return out
}

export function clozeFront(html) {
  return replaceCloze(html, () => '[...]')
}

export function clozeBack(html) {
  return replaceCloze(html, (body) => `<span class="cloze">${body}</span>`)
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

/** Anki 基础样式的近似版：模型 CSS 负责大部分外观，这里补通用部分。 */
export const ANKI_BASE_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .card { font-family: "Helvetica Neue", Helvetica, Arial, "Microsoft YaHei", sans-serif; font-size: 20px; line-height: 1.5; text-align: left; color: black; background: white; padding: 20px; }
  .card img { max-width: 100%; height: auto; }
  .card table { border-collapse: collapse; max-width: 100%; }
  .card th, .card td { border: 1px solid #ccc; padding: 4px 8px; }
  .card ol, .card ul { margin: .4em 0; padding-left: 1.6em; }
  .card pre, .card code { font-family: Consolas, monospace; }
  .card .cloze { font-weight: bold; color: blue; }
  .card hr { border: 0; border-top: 1px solid #ccc; margin: 12px 0; }
`

const PREVIEW_CSS = `
  body { padding: 24px; background: #f5f5f7; font: 16px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1d1d1f; }
  h1 { font-size: 18px; margin: 0 0 16px; font-weight: 600; }
  .wrap { background: #fff; border-radius: 12px; padding: 0 24px 8px; margin: 0 0 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .wrap h2 { font-size: 13px; color: #6e6e73; margin: 0 0 4px; padding-top: 16px; font-weight: 500; }
  .pane { border-top: 1px solid #e5e5ea; padding-top: 12px; margin-top: 12px; }
  .pane h3 { font-size: 12px; color: #8e8e93; margin: 0 0 8px; font-weight: 500; }
`

const MEASURE_SCRIPT = `
<script>
window.addEventListener('load', () => {
  setTimeout(() => {
    const out = [];
    document.querySelectorAll('.wrap').forEach((wrap, index) => {
      const bad = new Set();
      wrap.querySelectorAll('.card').forEach((card) => {
        const cardRect = card.getBoundingClientRect();
        if (card.scrollWidth > card.clientWidth + 2) bad.add('横向溢出');
        card.querySelectorAll('img,table').forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 2) bad.add(String(el.tagName).toLowerCase() + '超宽');
        });
        card.querySelectorAll('*').forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.right > cardRect.right + 4) bad.add(String(el.tagName).toLowerCase() + '越界');
          if (rect.width > 0 && rect.left < cardRect.left - 4) bad.add(String(el.tagName).toLowerCase() + '越左');
        });
      });
      out.push({ card: index + 1, bad: [...bad].slice(0, 6) });
    });
    document.title = 'MEASURE:' + JSON.stringify(out);
  }, 300);
});
</script>`

const CONTENT_TAGS = new Set((
  'div span p a b strong i em u s del sup sub br hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd '
  + 'table thead tbody tfoot tr th td col colgroup caption img code pre blockquote small mark kbd var anki-mathjax '
  + 'section article header footer main aside address figure figcaption ruby rp rt'
).split(' '))
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'title', 'textarea', 'xmp'])
const CONTENT_ATTRS = new Set('id class style title lang dir role colspan rowspan width height alt start reversed value block'.split(' '))

function safeAttribute(tag, { name, value, namespace }) {
  if (namespace) return false
  if (name === 'href') return tag === 'a' && /^(?:https?:\/\/|#)/iu.test(value)
  if (name === 'src') return tag === 'img' && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/iu.test(value)
  return CONTENT_ATTRS.has(name) || name.startsWith('aria-') || name === 'data-field'
}

function safeCardHtml(html) {
  const fragment = parseFragment(String(html ?? ''))
  function safeNodes(nodes) {
    return nodes.flatMap((node) => {
      if (node.nodeName === '#text') return [node]
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROP_CONTENT.has(node.tagName)) return []
      const children = safeNodes(node.childNodes)
      if (!CONTENT_TAGS.has(node.tagName)) return children
      node.attrs = node.attrs.filter((attr) => safeAttribute(node.tagName, attr))
      node.childNodes = children
      return [node]
    })
  }
  fragment.childNodes = safeNodes(fragment.childNodes)
  return serialize(fragment)
}

function safeTitle(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function safeCss(text) {
  return String(text ?? '').replaceAll('<', '\\3C ')
}

function securityMeta(nonce, mathjax) {
  const cdn = mathjax ? ' https://cdn.jsdelivr.net/npm/mathjax@3/' : ''
  return '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-'
    + nonce + '\'' + cdn + '; style-src \'unsafe-inline\'; img-src data:; font-src data:' + cdn
    + '; base-uri \'none\'; form-action \'none\'">'
}

function mathScript(nonce) {
  return `<script nonce="${nonce}">window.MathJax = { tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['\\\\[', '\\\\]']] } };</script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" async></script>`
}

export function buildCardsHtml({
  cards, css = '', title = 'Anki 预览', mathjax = true, ankiBase = true, measure = false,
}) {
  const nonce = randomBytes(16).toString('base64')
  const caption = safeTitle(title)
  const body = cards.map((card, index) => `<section class="wrap"><h2>#${index + 1}</h2>
<div class="pane"><h3>正面</h3><div class="card">${safeCardHtml(card.frontHtml)}</div></div>
<div class="pane"><h3>背面</h3><div class="card">${safeCardHtml(card.backHtml)}</div></div></section>`).join('\n')
  const style = `${ankiBase ? ANKI_BASE_CSS : ''}\n${PREVIEW_CSS}\n/* 模型自带样式 */\n${safeCss(css)}`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">${securityMeta(nonce, mathjax)}<title>${caption}</title>
<style>${style}</style></head>
<body><h1>${caption}（${cards.length} 张）</h1>
${body}
${mathjax ? mathScript(nonce) : ''}
${measure ? MEASURE_SCRIPT.replace('<script>', `<script nonce="${nonce}">`) : ''}
</body></html>`
}

const PRINT_CSS = `
  @page { size: A4; margin: 14mm; }
  body { background: #fff; margin: 0; }
  .sheet { page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
  .sheet .card { font-size: 14px; }
  .sheet hr { border: 0; border-top: 1px dashed #bbb; margin: 18px 0; }
`

const PRINT_LAYOUT_CSS = {
  qa: '',
  question: '.sheet .pane-back { display: none; }',
  answer: '.sheet .pane-front { display: none; }',
}

/** 纸质版：默认一页一张（正面 + 背面），也可只要正面或只要背面；可叠加自定义 CSS。 */
export function buildPrintHtml({
  cards, css = '', title = 'Anki 打印版', ankiBase = true, mathjax = true,
  layout = 'qa', extraCss = '',
}) {
  const nonce = randomBytes(16).toString('base64')
  const styleName = Object.hasOwn(PRINT_LAYOUT_CSS, layout) ? layout : 'qa'
  const body = cards.map((card) => `<section class="sheet sheet-${styleName}">
<div class="pane pane-front"><div class="card">${safeCardHtml(card.frontHtml)}</div></div>
<hr class="pane-sep">
<div class="pane pane-back"><div class="card">${safeCardHtml(card.backHtml)}</div></div>
</section>`).join('\n')
  const style = [
    ankiBase ? ANKI_BASE_CSS : '',
    PRINT_CSS,
    PRINT_LAYOUT_CSS[styleName],
    safeCss(extraCss),
    '/* 模型自带样式 */',
    safeCss(css),
  ].join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">${securityMeta(nonce, mathjax)}<title>${safeTitle(title)}</title>
<style>${style}</style></head>
<body>${body}
${mathjax ? mathScript(nonce) : ''}
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

function runEdge(args, timeoutMs, outputFile) {
  const edge = findEdge()
  if (!edge) return Promise.resolve(null)
  // 每次渲染一个临时 profile：既避免多个渲染抢同一个浏览器锁，也不会长期堆目录。
  const profile = dataPath(tmpdir(), 'anki-assistant-edge-profile', randomUUID())
  try { mkdirSync(profile, { recursive: true }) } catch { return Promise.resolve(null) }
  const cleanup = () => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 文件仍被 Edge 占用 */ } }
  return new Promise((resolve) => {
    let done = false
    let poll
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(poll)
      cleanup()
      resolve(value)
    }
    const child = spawn(edge, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      ...args,
    ], {
      windowsHide: true,
    })
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (done) return
      if (code !== 0 || !outputFile) {
        finish({ code, out })
        return
      }
      // Windows Edge can detach its renderer before the launcher exits.
      let lastSize
      const waitForFile = () => {
        let size
        try {
          size = statSync(outputFile, { throwIfNoEntry: false })?.size
        } catch (error) {
          if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
            finish(null)
            return
          }
        }
        if (size > 0 && size === lastSize) finish({ code, out })
        else {
          lastSize = size
          poll = setTimeout(waitForFile, 100)
        }
      }
      waitForFile()
    })
  })
}

export async function renderPng(htmlFile, pngFile, { width = 1100, height = 1400, timeoutMs = 60000, virtualTimeBudget = 15000 } = {}) {
  const url = pathToFileURL(htmlFile).href
  const result = await runEdge([
    ...(virtualTimeBudget > 0 ? [`--virtual-time-budget=${virtualTimeBudget}`] : []),
    `--screenshot=${pngFile}`,
    `--window-size=${width},${height}`,
    url,
  ], timeoutMs, pngFile)
  return result?.code === 0 ? pngFile : null
}

export async function renderPdf(htmlFile, pdfFile, { timeoutMs = 60000, virtualTimeBudget = 15000 } = {}) {
  const url = pathToFileURL(htmlFile).href
  const result = await runEdge([
    ...(virtualTimeBudget > 0 ? [`--virtual-time-budget=${virtualTimeBudget}`] : []),
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',
    `--print-to-pdf=${pdfFile}`,
    url,
  ], timeoutMs, pdfFile)
  return result?.code === 0 ? pdfFile : null
}

/** 量横向溢出：返回 [{card, bad[]}]，量不了返回 null。 */
export async function measureOverflow(htmlFile, { timeoutMs = 60000, virtualTimeBudget = 15000 } = {}) {
  const url = pathToFileURL(htmlFile).href
  const result = await runEdge([
    ...(virtualTimeBudget > 0 ? [`--virtual-time-budget=${virtualTimeBudget}`] : []),
    '--dump-dom',
    url,
  ], timeoutMs)
  if (!result?.out) return null
  const match = result.out.match(/MEASURE:(\[[\s\S]*?\])<\/title>/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

/** 用系统默认浏览器打开本地文件。 */
export function openFile(file) {
  const command = process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open')
  try {
    const child = spawn(command, [file], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 打不开就只返回路径
  }
}
