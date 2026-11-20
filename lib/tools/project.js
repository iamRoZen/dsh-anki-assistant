/**
 * project 工具：一次任务的现场（目标、资料、批次、决策记录），跑通后可提炼成方案草稿。
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadBatch } from '../batch.js'
import { collectSamples, composeNotesBody, createProject, listProjects, loadProject, projectDir, saveProject } from '../project.js'
import { normalizeSchemeId, saveScheme } from '../scheme.js'

export function register(runtime) {
  const { store, boot, text } = runtime

  runtime.ctx.tools.register(runtime.defineTool({
    name: 'project',
    description:
      '项目目录：一次任务的现场（目标、资料、批次、决策记录）。跑通之后用 to-scheme 提炼成方案草稿；'
      + '项目本身不是方案。open/list/get/update/close/to-scheme/delete（删除需 confirm）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'list', 'get', 'update', 'close', 'to-scheme', 'delete'] },
      id: { type: 'string', description: '项目 id（open 时可省略，由 title 生成）' },
      title: { type: 'string', description: 'open 时的标题' },
      goal: { type: 'string', description: '目标：这一批要什么' },
      scheme: { type: 'string', description: 'open 时钉住的方案 id' },
      schemeVersion: { type: 'integer', description: 'open 时钉住的方案版本' },
      deck: { type: 'string', description: '目标牌组' },
      model: { type: 'string', description: '目标模型' },
      sources: { type: 'array', items: { type: 'string' }, description: 'open/update 时的资料路径' },
      batch: { type: 'string', description: 'update 时追加一个批次 id' },
      practice: { type: 'string', description: 'update 时追加一个实践 id' },
      note: { type: 'string', description: 'update 时写一条设计记录（notes/ 下的 md）' },
      summary: { type: 'string', description: 'close 时的结项摘要' },
      schemeId: { type: 'string', description: 'to-scheme 的目标方案 id，默认 <项目>-scheme' },
      confirm: { type: 'boolean', description: 'delete 时需要 confirm=true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projects: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          project: { type: 'object', additionalProperties: true, properties: {} },
          scheme: { type: 'object', additionalProperties: true, properties: {} },
          text: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.scheme) {
          return text(`已提炼方案 ${value.scheme.id}@${value.scheme.version}（${value.files?.length ?? 0} 个附件）`)
        }
        if (value.text) return text(value.text)
        if (value.project) {
          const project = value.project
          return text(`${project.id}［${project.status}］${project.title}\n`
            + `目标：${project.goal || '（未写）'}\n`
            + `方案：${project.scheme ? `${project.scheme.id}@${project.scheme.version}` : '未钉'}\n`
            + `批次：${(project.batches ?? []).join(', ') || '无'}｜实践：${(project.practices ?? []).join(', ') || '无'}`)
        }
        return text((value.projects ?? []).map((entry) => `${entry.id}［${entry.status}］${entry.title}`).join('\n') || '还没有项目')
      },
    },
    async execute(args) {
      await boot()
      if (args.action === 'open') {
        const project = await createProject(store.root, {
          id: args.id,
          title: args.title,
          goal: args.goal,
          scheme: args.scheme ? { id: args.scheme, version: args.schemeVersion ?? null } : null,
          deck: args.deck,
          model: args.model,
          sources: args.sources ?? [],
        })
        return { project, text: `已建项目 ${project.id}（目录 ${projectDir(store.root, project.id)}）` }
      }
      if (args.action === 'list') {
        return { projects: await listProjects(store.root) }
      }
      const project = args.id ? await loadProject(store.root, args.id) : null
      if (args.action !== 'list' && !project) throw new Error(`没有项目 ${args.id}`)
      if (args.action === 'get') {
        const batches = []
        for (const id of project.batches ?? []) {
          try { batches.push(await loadBatch(store.root, id)) } catch { /* 批次被删 */ }
        }
        return {
          project,
          text: `${project.id}［${project.status}］${project.title}\n`
            + `目标：${project.goal || '（未写）'}\n`
            + `方案：${project.scheme ? `${project.scheme.id}@${project.scheme.version}` : '未钉'}\n`
            + `批次：${batches.map((batch) => `${batch.id}(${batch.items.length} 题)`).join(', ') || '无'}\n`
            + `实践：${(project.practices ?? []).join(', ') || '无'}`,
        }
      }
      if (args.action === 'update') {
        for (const key of ['title', 'goal', 'deck', 'model']) {
          if (args[key]) project[key] = args[key]
        }
        if (args.scheme) project.scheme = { id: args.scheme, version: args.schemeVersion ?? null }
        if (args.sources?.length) project.sources = [...new Set([...(project.sources ?? []), ...args.sources])]
        if (args.batch && !project.batches.includes(args.batch)) project.batches.push(args.batch)
        if (args.practice && !project.practices.includes(args.practice)) project.practices.push(args.practice)
        if (args.note) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          writeFileSync(join(projectDir(store.root, project.id), 'notes', `${stamp}.md`), `${args.note}\n`, 'utf8')
        }
        const saved = await saveProject(store.root, project)
        return { project: saved, text: `已更新项目 ${saved.id}` }
      }
      if (args.action === 'close') {
        project.status = 'done'
        project.summary = args.summary ?? project.summary
        const saved = await saveProject(store.root, project)
        writeFileSync(join(projectDir(store.root, project.id), 'notes', '结项.md'), `# 结项\n\n${saved.summary || ''}\n`, 'utf8')
        return { project: saved, text: `已结项 ${saved.id}` }
      }
      if (args.action === 'to-scheme') {
        const body = await composeNotesBody(store.root, project.id, project)
        if (!body.trim()) throw new Error('项目还没有 notes 或结项摘要，先记录再提炼')
        const schemeId = normalizeSchemeId(args.schemeId ?? `${project.id}-scheme`)
        const saved = await saveScheme(store.root, {
          id: schemeId,
          title: `${project.title} 的方案`,
          status: 'draft',
          deliverable: 'method',
          changeWhy: `从项目 ${project.id} 提炼`,
        })
        const dir = join(store.root, 'schemes', saved.id)
        mkdirSync(join(dir, 'samples'), { recursive: true })
        writeFileSync(join(dir, 'body.md'), `${body}\n`, 'utf8')
        copyFileSync(join(dir, 'body.md'), join(dir, `body.v${saved.version}.md`))
        const samples = await collectSamples(store.root, project.id)
        for (const sample of samples) writeFileSync(join(dir, 'samples', sample.name), sample.content, 'utf8')
        const files = ['body.md', ...samples.map((sample) => `samples/${sample.name}`)]
        return { scheme: saved, files, text: `已从项目 ${project.id} 提炼方案 ${saved.id}@${saved.version}（${files.length} 个文件）` }
      }
      if (args.action === 'delete') {
        if (args.confirm !== true) throw new Error('delete 需要 confirm=true')
        rmSync(projectDir(store.root, project.id), { recursive: true, force: true })
        return { text: `已删除项目 ${project.id}` }
      }
      throw new Error(`未知动作 ${args.action}`)
    },
  }))
}
