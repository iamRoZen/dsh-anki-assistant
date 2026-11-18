/**
 * 资料读取：把 PDF / 文本变成"有行结构的页面"。
 *
 * PDF 用 pdfjs 解析，但**自己按 y 坐标重建行**——第三方插件把一页压成一行，
 * 双栏会串行、表格会糊，无法作为原文与引文使用。
 */
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, sep } from 'node:path'
import { createRequire } from 'node:module'

export class MaterialError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'MaterialError'
    this.hint = hint
  }
}

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

function joinPieces(pieces) {
  let out = ''
  for (const piece of pieces) {
    if (!piece) continue
    if (!out) {
      out = piece
      continue
    }
    const previous = out.at(-1)
    const next = piece[0]
    out += CJK.test(previous) || CJK.test(next) ? '' : ' '
    out += piece
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

/** 把 pdfjs 的文本片段按 y 归行，再按 x 排序。 */
export function itemsToLines(items) {
  const buckets = new Map()
  for (const item of items) {
    if (typeof item?.str !== 'string' || item.str.trim() === '') continue
    const y = item.transform?.[5] ?? 0
    const x = item.transform?.[4] ?? 0
    const key = Math.round(y / 3)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ x, str: item.str })
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, pieces]) => joinPieces(pieces.sort((a, b) => a.x - b.x).map((piece) => piece.str)))
    .filter((line) => line !== '')
}

function parsePages(spec, total) {
  if (spec === undefined || spec === null || spec === '' || spec === 'all') {
    return Array.from({ length: total }, (_, index) => index + 1)
  }
  const chosen = new Set()
  for (const part of String(spec).split(',')) {
    const trimmed = part.trim()
    const match = /^(\d+)(?:-(\d+))?$/.exec(trimmed)
    if (!match) throw new MaterialError(`页码写法不对：${spec}，应形如 "1-3,5" 或 "all"`)
    const start = Number(match[1])
    const end = match[2] ? Number(match[2]) : start
    if (start < 1 || end < start) throw new MaterialError(`页码范围不成立：${trimmed}`)
    for (let page = start; page <= end; page += 1) chosen.add(page)
  }
  return [...chosen].filter((page) => page <= total).sort((a, b) => a - b)
}

async function loadPdfjs() {
  try {
    const module = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const require = createRequire(import.meta.url)
    // pdfjs 要求字体目录以正斜杠结尾；Windows 的路径分隔符要先换掉。
    const root = dirname(require.resolve('pdfjs-dist/package.json'))
    const fontDir = `${join(root, 'standard_fonts').replaceAll('\\', '/')}/`
    return { getDocument: module.getDocument, fontDir }
  } catch (error) {
    throw new MaterialError(
      '读不了 PDF：缺少可选依赖 pdfjs-dist',
      '在插件目录执行 npm install pdfjs-dist，或先用其他工具把 PDF 转成 .txt/.md',
    )
  }
}

export async function readMaterial(file, { pages = 'all', maxPages = 40, maxChars = 60000 } = {}) {
  const extension = extname(file).toLowerCase()
  if (extension === '.pdf') {
    const { getDocument, fontDir } = await loadPdfjs()
    const data = new Uint8Array(await readFile(file))
    const task = getDocument({ data, standardFontDataUrl: fontDir, isEvalSupported: false })
    const doc = await task.promise
    try {
      const totalPages = doc.numPages
      const explicit = pages !== undefined && pages !== null && pages !== '' && pages !== 'all'
      // 显式页码按真实总页数校验；'all' 才受 maxPages 限制。
      const wanted = parsePages(pages, totalPages).slice(0, maxPages)
      if (wanted.length === 0) {
        throw new MaterialError(`页码 ${pages} 超出范围：文档共 ${totalPages} 页`)
      }
      const capped = !explicit && totalPages > maxPages
      const out = []
      let chars = 0
      let truncated = false
      for (const pageNumber of wanted) {
        const page = await doc.getPage(pageNumber)
        const content = await page.getTextContent()
        const lines = itemsToLines(content.items)
        const size = lines.join('\n').length
        if (chars + size > maxChars && out.length > 0) {
          truncated = true
          break
        }
        out.push({ page: pageNumber, lines })
        chars += size
      }
      return {
        kind: 'pdf',
        file,
        totalPages,
        pages: out,
        truncated,
        capped,
        note: capped ? `文档共 ${totalPages} 页，本次上限 ${maxPages} 页，用 pages 继续` : undefined,
      }
    } finally {
      await task.destroy()
    }
  }

  const text = await readFile(file, 'utf8').catch((error) => {
    throw new MaterialError(`读不了文件：${file}`, error.message)
  })
  const lines = text.split(/\r?\n/)
  return { kind: 'text', file, totalPages: null, pages: [{ page: 0, lines }], truncated: false, capped: false }
}

/** 在已读的页面里按关键词找行，返回页码与行号，用来做定位。 */
export function findLines(material, keyword) {
  const hits = []
  const needle = String(keyword ?? '').trim()
  if (!needle) return hits
  for (const page of material.pages ?? []) {
    page.lines.forEach((line, index) => {
      if (line.includes(needle)) hits.push({ page: page.page, line: index + 1, text: line })
    })
  }
  return hits
}
