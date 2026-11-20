/**
 * practice 工具：实践库，每次真实制卡留下的记录（list / get / save / delete）。
 */
import { deletePracticeSync, getPracticeSync, listPracticesSync, upsertPracticeSync } from '../library.js'

export function register(runtime) {
  const { store, boot, text } = runtime

  runtime.ctx.tools.register(runtime.defineTool({
    name: 'practice',
    description:
      '实践库：每次真实制卡留下的记录。list 给摘要，可按方案、模块或标签筛选；'
      + 'get 读全文；save 记录一次真实运行（正文 + 关联方案/批次/noteId）；delete 需 confirm=true。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'get', 'save', 'delete'] },
      id: { type: 'string', description: 'get/save/delete 时的实践 id（文件名去掉 .md）' },
      title: { type: 'string', description: 'save 时的标题' },
      body: { type: 'string', description: 'save 时的正文（Markdown，必填）' },
      schemeVersion: { type: 'integer', description: 'save 时关联的方案版本' },
      modules: { type: 'array', items: { type: 'string' }, description: 'save 时用了哪些模块' },
      tags: { type: 'array', items: { type: 'string' }, description: 'save 时的标签' },
      batch: { type: 'string', description: 'save 时关联的批次 id' },
      notes: { type: 'array', items: { type: 'integer' }, description: 'save 时关联的 noteId' },
      confirm: { type: 'boolean', description: 'delete 时需要 confirm=true' },
      scheme: { type: 'string', description: 'list 时按方案 id 过滤' },
      module: { type: 'string', description: 'list 时按模块过滤，如 制作卡片' },
      tag: { type: 'string', description: 'list 时按标签过滤' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cases: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          case: { type: 'object', additionalProperties: true, properties: {} },
        },
      },
      render(_args, value) {
        if (value.case?.deleted) return text(`已删除实践 ${value.case.id}`)
        if (value.case) {
          return text(`${value.case.title ?? value.case.id}\n\n${String(value.case.body ?? '').slice(0, 12000)}`)
        }
        if (!value.cases?.length) return text('还没有实践记录')
        return text(value.cases
          .map((entry) => `${entry.id}｜${entry.date ?? ''}｜${(entry.modules ?? []).join('/')}｜${entry.scheme ? `${entry.scheme.id}@${entry.scheme.version}` : '无方案'}`)
          .join('\n'))
      },
    },
    async execute(args) {
      await boot()
      if (args.action === 'save') {
        if (!args.body) throw new Error('save 需要 body（Markdown 正文）')
        const id = String(args.id ?? '').trim() || `practice-${Date.now().toString(36)}`
        const entry = {
          id,
          title: args.title ?? id,
          doc: `${id}.md`,
          date: new Date().toISOString().slice(0, 10),
          modules: args.modules ?? [],
          tags: args.tags ?? [],
          scheme: args.scheme ? { id: args.scheme, version: args.schemeVersion ?? null } : null,
          batch: args.batch ?? null,
          notes: args.notes ?? [],
          body: String(args.body),
        }
        const saved = upsertPracticeSync(store.root, entry)
        return { case: { ...saved, body: entry.body } }
      }
      if (args.action === 'delete') {
        if (args.confirm !== true) throw new Error('delete 需要 confirm=true')
        if (!args.id) throw new Error('delete 需要 id')
        if (!deletePracticeSync(store.root, args.id)) throw new Error(`没有实践 ${args.id}`)
        return { case: { id: args.id, deleted: true } }
      }
      if (args.action === 'get') {
        if (!args.id) throw new Error('get 需要 id')
        const found = getPracticeSync(store.root, args.id)
        if (!found) throw new Error(`没有实践 ${args.id}`)
        return { case: found }
      }
      let cases = listPracticesSync(store.root)
      if (args.scheme) cases = cases.filter((entry) => entry.scheme?.id === args.scheme)
      if (args.module) cases = cases.filter((entry) => (entry.modules ?? []).includes(args.module))
      if (args.tag) cases = cases.filter((entry) => (entry.tags ?? []).includes(args.tag))
      return { cases }
    },
  }))
}
