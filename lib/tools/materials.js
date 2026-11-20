/**
 * materials 工具：读资料并给出行号定位，供卡片的定位字段回查原文。
 */
import { basename } from 'node:path'

import { findLines, readMaterial } from '../materials.js'

export function register(runtime) {
  const { text } = runtime

  runtime.ctx.tools.register(runtime.defineTool({
    name: 'materials',
    description:
      '读资料并给出行号定位。PDF 按页切分、按坐标重建行（双栏、表格可用），也可给关键词只取命中行。'
      + '返回的页码与行号可直接写进卡的定位字段，用来回查原文。',
    parameters: {
      path: { type: 'string', required: true, description: '文件路径（.pdf/.txt/.md 等）' },
      pages: { type: 'string', description: '页码，如 "31-33" 或 "all"，缺省 all（受 maxPages 限制）' },
      keyword: { type: 'string', description: '只回包含该词的行，并给出行号' },
      maxPages: { type: 'integer', description: '本次最多读几页，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          totalPages: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          text: { type: 'string' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return text(value.text)
      },
    },
    async execute(args) {
      const material = await readMaterial(args.path, {
        pages: args.pages ?? 'all',
        maxPages: args.maxPages ?? 20,
      })
      if (args.keyword) {
        const hits = findLines(material, args.keyword)
        const lines = hits.slice(0, 60).map((hit) => `p${hit.page}:L${hit.line} ${hit.text.slice(0, 160)}`)
        return {
          kind: material.kind,
          totalPages: material.totalPages,
          hits,
          text: `${basename(args.path)} 命中 ${hits.length} 行\n${lines.join('\n') || '（没有命中，换关键词或用 pages 直接读）'}`,
        }
      }
      const blocks = []
      let chars = 0
      for (const page of material.pages) {
        const head = page.page > 0 ? `=== p${page.page} ===` : `=== ${basename(args.path)} ===`
        const body = page.lines.map((line, index) => `${String(index + 1).padStart(3, ' ')}| ${line}`)
        const block = [head, ...body].join('\n')
        if (chars + block.length > 24000 && blocks.length > 0) {
          blocks.push('[截断：本次输出已到上限，用 pages 继续]')
          break
        }
        blocks.push(block)
        chars += block.length
      }
      return {
        kind: material.kind,
        totalPages: material.totalPages,
        hits: [],
        note: material.note ?? '',
        text: [
          `${basename(args.path)}（${material.kind}）${material.totalPages ? `共 ${material.totalPages} 页` : ''}；本次 ${material.pages.length} 页`,
          material.note ?? '',
          ...blocks,
        ].filter(Boolean).join('\n'),
      }
    },
  }))
}
