/**
 * scheme 工具：制卡方案的读写（list / get / save / import / test / delete / derive / prune）。
 *
 * 工具定义从 index.js 原样搬来，依赖只从 runtime 取，不再自己持有状态。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { getScheme, listSchemes, normalizeSchemeId, saveScheme } from '../scheme.js'
import { practicesForScheme, readSchemeBody, readTemplate, schemeBodyPath } from '../library.js'

export function register(runtime) {
  const { store, boot, text, schemeFiles, runNodeScript } = runtime

  runtime.ctx.tools.register(runtime.defineTool({
    name: 'scheme',
    description:
      '制卡方案的读写。方案是数据不是代码：适用场景、所需输入、各阶段方法、输出字段规范、'
      + '质量规则、验收标准、已知局限。list 返回摘要，get 返回全文，save 永远写新版本（旧版本保留）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'get', 'save', 'import', 'test', 'delete', 'derive', 'prune'] },
      confirm: { type: 'boolean', description: 'delete 时需要 confirm=true' },
      force: { type: 'boolean', description: 'delete 时允许删 active 方案（默认只允许 draft/deprecated）' },
      id: { type: 'string', description: '方案 id（get/save 必填）' },
      version: { type: 'integer', description: '版本号，缺省取当前 active' },
      scheme: { type: 'object', additionalProperties: true, description: 'save 时的方案对象（除 id/title/status 外都可省略）' },
      body: { type: 'string', description: 'save 时的方案正文（Markdown，可原样贴入网上的自然语言提示词）' },
      files: {
        type: 'array',
        description: 'save 时随方案写入的附件（样卡、脚本、笔记、样式等），路径相对方案目录',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '相对路径，如 samples/pass.json、scripts/check.mjs、notes/经验.md（必填）' },
            content: { type: 'string', description: '文件内容（文本，必填）' },
          },
        },
      },
      path: { type: 'string', description: 'import 时：外来方案目录的绝对路径（内含 scheme.json）' },
      upgrade: { type: 'boolean', description: 'import 遇到同名方案时：给已有 id 出一个新版本，旧版本保留' },
      sources: { type: 'array', items: { type: 'string' }, description: 'derive 时：外部文件路径（文本），拼成方案正文的起点' },
      changeWhy: { type: 'string', description: 'save 时说明这次改了什么、为什么' },
      includeDrafts: { type: 'boolean', description: 'list 时是否包含 draft 方案，默认 false' },
      query: { type: 'string', description: 'list 时按 id / 标题 / 正文关键词过滤' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemes: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          scheme: { type: 'object', additionalProperties: true, properties: {} },
          test: { type: 'object', additionalProperties: true, properties: {} },
          pruned: { type: 'object', additionalProperties: true, properties: {} },
          deleted: { type: 'object', additionalProperties: true, properties: {} },
        },
      },
      render(_args, value) {
        if (value.pruned) {
          return text(`保留 v${value.pruned.kept}，删除 ${value.pruned.deleted.length} 个旧版本${value.pruned.deleted.length ? `：v${value.pruned.deleted.join(', v')}` : ''}`)
        }
        if (value.deleted) {
          return text(`已删除方案 ${value.deleted.id}（${value.deleted.files} 个文件，${value.deleted.versions} 个版本）`)
        }
        if (value.test) {
          const lines = [`测试：${value.test.ok ? '通过' : (value.test.kind === 'none' ? '无测试' : '未通过')}（${value.test.kind}）`]
          if (value.test.note) lines.push(`  ${value.test.note}`)
          for (const entry of value.test.cases ?? []) {
            lines.push(`  ${entry.case}: ${entry.ok ? '✓' : '✗'}${entry.codes?.length ? ` 命中 ${entry.codes.join(',')}` : ''}${entry.missing?.length ? ` 缺 ${entry.missing.join(',')}` : ''}`)
          }
          if (value.test.output) lines.push('', value.test.output)
          return text(lines.join('\n'))
        }
        if (value.scheme) {
          const scheme = value.scheme
          const lines = [
            `${scheme.id}@${scheme.version} ${scheme.title}（${scheme.status}）`,
            ...(scheme.deliverable === 'method'
              ? ['这是方法草稿：只有正文，还没有卡片产出。要出卡时再补模型与字段，并先做样卡。']
              : []),
            `适用：${(scheme.appliesTo?.cardTypes ?? []).join('、')}｜${(scheme.appliesTo?.subjects ?? []).join('、')}`,
            `输入：${(scheme.inputs ?? []).map((input) => `${input.kind}${input.required ? '*' : ''}`).join('、')}`,
          ]
          for (const step of scheme.methods ?? []) {
            lines.push(`- [${step.stage}] ${step.how}`)
          }
          lines.push(`模型：${scheme.output?.model}`)
          for (const field of scheme.output?.fields ?? []) {
            lines.push(`  字段 ${field.name}${field.role ? `（${field.role}）` : ''}：${field.spec}`)
          }
          if (scheme.quality?.rules?.length) {
            lines.push(`规则：${scheme.quality.rules.map((rule) => rule.id).join('，')}`)
          }
          const validatorMeta = scheme.quality?.validator ?? scheme.quality?.legacy
          if (validatorMeta) {
            lines.push(`方案校验器：${validatorMeta.suite ?? 'custom'}（${(validatorMeta.checks ?? []).join('/')}），由方案目录 ${validatorMeta.module ?? 'validate.mjs'} 执行`)
          }
          if (scheme.quality?.rubric) lines.push(`人工判据：${scheme.quality.rubric}`)
          if (scheme.acceptance?.criteria) lines.push(`验收：${scheme.acceptance.criteria}`)
          for (const limit of scheme.limits ?? []) lines.push(`局限：${limit}`)
          if (value.scheme.practices?.length) {
            lines.push(`用过它的实践：${value.scheme.practices.map((entry) => `${entry.id}（v${entry.version}）`).join('、')}`)
          }
          if (value.scheme.body) {
            lines.push('', '--- 方案正文 ---', String(value.scheme.body).slice(0, 12000))
          }
          if (value.scheme.templateBody) {
            lines.push('', '--- 卡片模板 ---', String(value.scheme.templateBody).slice(0, 8000))
          }
          if (value.scheme.files?.length) {
            const shown = value.scheme.files.slice(0, 40).map((file) => `  ${file.path}（${Math.max(1, Math.round(file.size / 1024))} KB）`)
            lines.push('', `--- 方案目录文件（${value.scheme.files.length} 个，按需读取）---`, ...shown)
            if (value.scheme.files.length > 40) lines.push(`  … 还有 ${value.scheme.files.length - 40} 个`)
          }
          return text(lines.join('\n'))
        }
        return text((value.schemes ?? [])
          .map((entry) => {
            const kind = entry.deliverable === 'method' ? '方法草稿' : '卡片方案'
            const types = (entry.appliesTo?.cardTypes ?? []).join('/')
            return `${entry.id}@${entry.version}｜${entry.title}｜${kind}${types ? `：${types}` : ''}｜${entry.status}`
          })
          .join('\n') || '还没有方案，用 save 建档')
      },
    },
    async execute(args) {
      await boot()
      if (args.action === 'list') {
        let schemes = await listSchemes(store.root, { includeDrafts: Boolean(args.includeDrafts) })
        if (args.query) {
          const query = String(args.query).toLowerCase()
          schemes = schemes.filter((entry) => {
            const meta = `${entry.id} ${entry.title} ${(entry.appliesTo?.cardTypes ?? []).join(' ')}`.toLowerCase()
            if (meta.includes(query)) return true
            return (readSchemeBody(store.root, entry.id, entry.version) ?? '').toLowerCase().includes(query)
          })
        }
        return { schemes }
      }
      if (args.action === 'get') {
        if (!args.id) throw new Error('get 需要 id')
        const scheme = await getScheme(store.root, args.id, args.version)
        if (!scheme) throw new Error(`没有方案 ${args.id}${args.version ? `@${args.version}` : ''}`)
        const body = readSchemeBody(store.root, scheme.id, scheme.version)
        return {
          scheme: {
            ...scheme,
            body,
            bodyPath: schemeBodyPath(store.root, scheme.id),
            templateBody: readTemplate(store.root, scheme.output?.template),
            practices: practicesForScheme(store.root, scheme.id),
            files: schemeFiles(store.root, scheme.id),
          },
        }
      }
      if (args.action === 'test') {
        if (!args.id) throw new Error('test 需要 id')
        const scheme = await getScheme(store.root, args.id, args.version)
        if (!scheme) throw new Error(`没有方案 ${args.id}`)
        const dir = join(store.root, 'schemes', scheme.id)
        const runner = join(dir, 'test', 'run.mjs')
        if (existsSync(runner)) {
          const result = await runNodeScript(runner, dir)
          return {
            test: {
              ok: result.code === 0,
              kind: 'test/run.mjs',
              code: result.code,
              output: result.out.slice(-4000),
            },
          }
        }
        const validatorFile = join(dir, scheme.quality?.validator?.module ?? scheme.quality?.legacy?.module ?? 'validate.mjs')
        if (existsSync(validatorFile)) {
          const mod = await import(pathToFileURL(validatorFile).href)
          if (typeof mod.validate !== 'function') {
            throw new Error(`方案 ${scheme.id} 的 ${validatorFile.split(/[\\/]/).pop()} 没有导出 validate`)
          }
          const cases = []
          for (const name of ['pass', 'fail']) {
            const sampleFile = join(dir, 'samples', `${name}.json`)
            if (!existsSync(sampleFile)) continue
            const sample = JSON.parse(readFileSync(sampleFile, 'utf8'))
            const verdict = await mod.validate(sample.fields ?? {}, {
              checks: scheme.quality?.validator?.checks ?? scheme.quality?.legacy?.checks ?? null,
            })
            const codes = (verdict.issues ?? []).map((issue) => issue.code)
            const expected = sample.expect ?? []
            const missing = expected.filter((code) => !codes.includes(code))
            const ok = name === 'pass'
              ? verdict.ok !== false && codes.length === 0
              : missing.length === 0
            cases.push({ case: name, ok, codes, missing })
          }
          return {
            test: {
              ok: cases.length > 0 && cases.every((entry) => entry.ok),
              kind: 'validate.mjs + samples',
              cases,
            },
          }
        }
        return {
          test: {
            ok: false,
            kind: 'none',
            note: `方案 ${scheme.id} 没有可执行的测试：方法草稿可以没有测试；卡片方案建议补 test/run.mjs 或 validate.mjs + samples/`,
          },
        }
      }
      if (args.action === 'delete') {
        if (args.confirm !== true) throw new Error('delete 需要 confirm=true')
        if (!args.id) throw new Error('delete 需要 id')
        const scheme = await getScheme(store.root, args.id)
        if (!scheme) throw new Error(`没有方案 ${args.id}`)
        if (scheme.status === 'active' && args.force !== true) {
          throw new Error(`方案 ${scheme.id} 仍是 active：先改成 deprecated，或加 force=true`)
        }
        const pinned = []
        try {
          for (const file of readdirSync(join(store.root, 'batches'))) {
            if (!file.endsWith('.json')) continue
            try {
              const batch = JSON.parse(readFileSync(join(store.root, 'batches', file), 'utf8'))
              if (batch.scheme?.id === scheme.id) pinned.push(batch.id)
            } catch {
              // 坏批次文件忽略
            }
          }
        } catch {
          // 没有批次目录
        }
        if (pinned.length > 0) throw new Error(`批次仍钉着 ${scheme.id}：${pinned.join(', ')}；先处理批次再删`)
        const dir = join(store.root, 'schemes', scheme.id)
        const remaining = existsSync(dir) ? readdirSync(dir) : []
        rmSync(dir, { recursive: true, force: true })
        return {
          deleted: {
            id: scheme.id,
            files: remaining.length,
            versions: remaining.filter((name) => /^v\d+\.json$/.test(name)).length,
          },
        }
      }
      if (args.action === 'prune') {
        if (args.confirm !== true) throw new Error('prune 需要 confirm=true')
        const scheme = await getScheme(store.root, args.id)
        if (!scheme) throw new Error(`没有方案 ${args.id}`)
        const dir = join(store.root, 'schemes', scheme.id)
        const versions = readdirSync(dir)
          .map((name) => /^v(\d+)\.json$/.exec(name))
          .filter(Boolean)
          .map((match) => Number(match[1]))
          .sort((a, b) => a - b)
        const keep = new Set([scheme.version])
        try {
          for (const file of readdirSync(join(store.root, 'batches'))) {
            if (!file.endsWith('.json')) continue
            try {
              const batch = JSON.parse(readFileSync(join(store.root, 'batches', file), 'utf8'))
              if (batch.scheme?.id === scheme.id) keep.add(Number(batch.scheme.version))
            } catch {
              // 坏批次文件忽略
            }
          }
        } catch {
          // 没有批次目录
        }
        const deleting = versions.filter((version) => !keep.has(version))
        if (deleting.length === 0) {
          return { pruned: { id: scheme.id, kept: [...keep].sort((a, b) => a - b), deleted: [] } }
        }
        for (const version of deleting) {
          rmSync(join(dir, `v${version}.json`), { force: true })
          rmSync(join(dir, `body.v${version}.md`), { force: true })
        }
        rmSync(join(dir, 'scheme.json'), { force: true })
        return { pruned: { id: scheme.id, kept: [...keep].sort((a, b) => a - b), deleted: deleting } }
      }
      if (args.action === 'derive') {        if (!args.id) throw new Error('derive 需要 id')
        if (!args.sources?.length) throw new Error('derive 需要 sources（外部文件路径数组）')
        const chunks = []
        const used = []
        for (const path of args.sources) {
          if (!existsSync(path)) throw new Error(`找不到文件：${path}`)
          const fileText = readFileSync(path, 'utf8')
          used.push({ path, chars: fileText.length })
          chunks.push(`## 来源：${basename(path)}\n\n${fileText.trim()}`)
        }
        const header = `# ${args.title ?? args.id}\n\n> 由外部文件汇总而来，待提炼成可执行方法；用 scheme save 出新版本时再补字段、判据与样卡。`
        const body = `${header}\n\n${chunks.join('\n\n---\n\n')}\n`
        const saved = await saveScheme(store.root, {
          id: args.id,
          title: args.title ?? args.id,
          status: 'draft',
          deliverable: 'method',
          origin: { kind: 'derived', refs: used.map((entry) => entry.path) },
          changeWhy: args.changeWhy ?? `根据外部文件整理：${used.map((entry) => basename(entry.path)).join('、')}`,
        })
        const dir = join(store.root, 'schemes', saved.id)
        writeFileSync(join(dir, 'body.md'), body, 'utf8')
        copyFileSync(join(dir, 'body.md'), join(dir, `body.v${saved.version}.md`))
        return {
          scheme: saved,
          text: `已从 ${used.length} 个文件生成方案 ${saved.id}@${saved.version}（draft）；下一步 scheme save 补字段与判据`,
        }
      }
      if (args.action === 'import') {
        if (!args.path) throw new Error('import 需要 path（外来方案目录）')
        const src = String(args.path)
        if (!existsSync(src)) throw new Error(`找不到目录：${src}`)
        const recordFile = join(src, 'scheme.json')
        if (!existsSync(recordFile)) throw new Error('导入目录里没有 scheme.json')
        let record
        try {
          record = JSON.parse(readFileSync(recordFile, 'utf8'))
        } catch (error) {
          throw new Error(`scheme.json 解析失败：${error.message}`)
        }
        const id = normalizeSchemeId(record.id ?? basename(src))
        const dest = join(store.root, 'schemes', id)
        const existing = await getScheme(store.root, id)
        if (existing) {
          if (args.upgrade !== true) {
            throw new Error(`已有方案 ${id}（v${existing.version}）：要出新版本请加 upgrade=true，否则先换名`)
          }
          const saved = await saveScheme(store.root, {
            ...record,
            id,
            title: existing.title ?? record.title ?? basename(src),
            status: record.status ?? existing.status ?? 'draft',
            changeWhy: args.changeWhy ?? `从外部项目 ${basename(src)} 升级`,
          })
          for (const name of ['body.md', 'validate.mjs', 'print.css', 'evidence.md', 'checks.md']) {
            if (existsSync(join(src, name))) copyFileSync(join(src, name), join(dest, name))
          }
          for (const sub of ['samples', 'scripts', 'vendor', 'test', 'notes']) {
            if (existsSync(join(src, sub))) cpSync(join(src, sub), join(dest, sub), { recursive: true, force: true })
          }
          const upgradedBody = join(dest, 'body.md')
          if (existsSync(upgradedBody)) copyFileSync(upgradedBody, join(dest, `body.v${saved.version}.md`))
          return {
            scheme: saved,
            upgraded: true,
            id,
            from: src,
            files: schemeFiles(store.root, id),
          }
        }
        cpSync(src, dest, { recursive: true })
        const saved = await saveScheme(store.root, {
          ...record,
          id,
          title: record.title ?? basename(src),
          status: record.status ?? 'draft',
          changeWhy: args.changeWhy ?? '导入外来方案',
        })
        const bodyFile = join(dest, 'body.md')
        if (existsSync(bodyFile)) copyFileSync(bodyFile, join(dest, `body.v${saved.version}.md`))
        return { scheme: saved, id, from: src, files: schemeFiles(store.root, id) }
      }
      if (!args.scheme) throw new Error('save 需要 scheme 对象')
      if (!args.scheme.id) throw new Error('save 需要 scheme.id')
      if (!args.changeWhy) throw new Error('save 需要 changeWhy：这次改了什么、为什么')
      const saved = await saveScheme(store.root, { ...args.scheme, changeWhy: args.changeWhy })
      const dir = join(store.root, 'schemes', saved.id)
      mkdirSync(dir, { recursive: true })
      // 正文以用户给的为准；保存时给这一版留一份快照，旧版仍可回看。
      if (typeof args.body === 'string') writeFileSync(join(dir, 'body.md'), args.body, 'utf8')
      const bodyFile = join(dir, 'body.md')
      if (existsSync(bodyFile)) copyFileSync(bodyFile, join(dir, `body.v${saved.version}.md`))
      const written = []
      for (const file of args.files ?? []) {
        if (!file?.path || typeof file.content !== 'string') throw new Error('files 每项需要 path 与 content')
        if (file.path.includes('..') || file.path.startsWith('/') || file.path.startsWith('\\') || /^[a-zA-Z]:/.test(file.path)) {
          throw new Error(`非法附件路径：${file.path}`)
        }
        const target = join(dir, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content, 'utf8')
        written.push(file.path)
      }
      return { scheme: saved, ...(written.length ? { files: written } : {}) }
    },
  }))
}
