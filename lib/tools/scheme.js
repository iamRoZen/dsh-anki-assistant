/**
 * scheme 工具：制卡方案的读写（list / get / save / import / test / delete / derive / prune）。
 *
 * 工具定义从 index.js 原样搬来，依赖只从 runtime 取，不再自己持有状态。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename } from 'node:path'

import { getScheme, listSchemes, listVersions, normalizeSchemeId, removeSchemeVersion, saveScheme, schemeAssetDir, schemeAssetFile, schemeDir, withSchemeLock } from '../scheme.js'
import { dataPath } from '../paths.js'
import { listProjects } from '../project.js'
import { writeJson, readJson } from '../store.js'
import { practicesForScheme, readSchemeBody, readTemplate, schemeBodyPath } from '../library.js'

async function schemeReferences(root, id) {
  const refs = []
  const batches = dataPath(root, 'batches')
  if (existsSync(batches)) {
    for (const entry of readdirSync(batches, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const batch = JSON.parse(readFileSync(dataPath(batches, entry.name), 'utf8'))
      if (batch.scheme?.id === id) refs.push({ ref: batch.scheme, label: batch.id ?? entry.name })
    }
  }
  for (const project of await listProjects(root)) {
    if (project.scheme?.id === id) refs.push({ ref: project.scheme, label: project.id })
  }
  return refs
}

export function register(runtime) {
  const { store, boot, text, schemeFiles, runNodeScript, requireTrustedCode, legacyValidatorFor } = runtime

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
      title: { type: 'string', description: 'derive 时的方案标题' },
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
          id: { type: 'string' },
          from: { type: 'string' },
          upgraded: { type: 'boolean' },
          text: { type: 'string' },
          files: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true, properties: {} }] } },
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
            ...(value.text ? [value.text] : []),
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
            return (readSchemeBody(store.root, entry) ?? '').toLowerCase().includes(query)
          })
        }
        return { schemes }
      }
      if (args.action === 'get') {
        if (!args.id) throw new Error('get 需要 id')
        const scheme = await getScheme(store.root, args.id, args.version)
        if (!scheme) throw new Error(`没有方案 ${args.id}${args.version ? `@${args.version}` : ''}`)
        const body = readSchemeBody(store.root, scheme)
        return {
          scheme: {
            ...scheme,
            body,
            bodyPath: schemeBodyPath(store.root, scheme),
            assetDir: schemeAssetDir(store.root, scheme),
            templateBody: readTemplate(store.root, scheme.output?.template),
            practices: practicesForScheme(store.root, scheme.id),
            files: schemeFiles(schemeAssetDir(store.root, scheme)),
          },
        }
      }
      if (args.action === 'test') {
        if (!args.id) throw new Error('test 需要 id')
        const scheme = await getScheme(store.root, args.id, args.version)
        if (!scheme) throw new Error(`没有方案 ${args.id}`)
        const dir = schemeAssetDir(store.root, scheme)
        const runner = schemeAssetFile(store.root, scheme, 'test/run.mjs')
        if (existsSync(runner)) {
          requireTrustedCode(scheme)
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
        const validate = legacyValidatorFor(scheme, { includeDefault: true })
        if (validate) {
          const cases = []
          for (const name of ['pass', 'fail']) {
            const sampleFile = schemeAssetFile(store.root, scheme, 'samples/' + name + '.json')
            if (!existsSync(sampleFile)) continue
            const sample = JSON.parse(readFileSync(sampleFile, 'utf8'))
            const verdict = await validate(sample.fields ?? {})
            const codes = (verdict.issues ?? []).map((issue) => issue.code)
            const expected = sample.expect ?? []
            const missing = expected.filter((code) => !codes.includes(code))
            const ok = name === 'pass'
              ? verdict.ok !== false && codes.length === 0
              : verdict.ok === false && codes.length > 0 && missing.length === 0
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
      if (args.action === 'delete' || args.action === 'prune') {
        const action = args.action
        if (args.confirm !== true) throw new Error(action + ' 需要 confirm=true')
        if (!args.id) throw new Error(action + ' 需要 id')
        return withSchemeLock(store.root, args.id, async (assertLocked) => {
          const scheme = await getScheme(store.root, args.id)
          if (!scheme) throw new Error('没有方案 ' + args.id)
          const references = await schemeReferences(store.root, scheme.id)
          const dir = schemeDir(store.root, scheme.id)
          const versions = await listVersions(store.root, scheme.id)
          assertLocked()
          if (action === 'delete') {
            if (scheme.status === 'active' && args.force !== true) {
              throw new Error('方案 ' + scheme.id + ' 仍是 active：先改成 deprecated，或加 force=true')
            }
            if (references.length) {
              throw new Error('批次或项目仍钉着 ' + scheme.id + '：' + references.map((ref) => ref.label).join(', '))
            }
            const files = readdirSync(dir).length
            await rm(dir, { recursive: true, force: true })
            return { deleted: { id: scheme.id, files, versions: versions.length } }
          }

          const keep = new Set([scheme.version])
          for (const { ref } of references) {
            if (Number.isSafeInteger(ref.version) && ref.version > 0) keep.add(ref.version)
            else for (const version of versions) keep.add(version)
          }
          const deleted = versions.filter((version) => !keep.has(version))
          if (deleted.length > 0) {
            const pointer = dataPath(dir, 'active.json')
            const current = await readJson(pointer)
            await writeJson(pointer, { ...current, lastVersion: Math.max(current.lastVersion ?? 0, ...versions) })
            for (const version of deleted) {
              assertLocked()
              await removeSchemeVersion(store.root, scheme.id, version)
            }
          }
          return { pruned: { id: scheme.id, kept: [...keep].sort((a, b) => a - b), deleted } }
        })
      }
      if (args.action === 'derive') {
        if (!args.id) throw new Error('derive 需要 id')
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
          changeWhy: args.changeWhy ?? '根据外部文件整理：' + used.map((entry) => basename(entry.path)).join('、'),
        }, { body })
        return {
          scheme: saved,
          text: '已从 ' + used.length + ' 个文件生成方案 ' + saved.id + '@' + saved.version + '（draft）',
        }
      }
      if (args.action === 'import') {
        if (!args.path) throw new Error('import 需要 path（外来方案目录）')
        const src = args.path
        const recordFile = dataPath(src, 'scheme.json')
        if (!existsSync(recordFile)) throw new Error('导入目录里没有 scheme.json')
        let record
        try {
          record = JSON.parse(readFileSync(recordFile, 'utf8'))
        } catch (error) {
          throw new Error('scheme.json 解析失败：' + error.message)
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('scheme.json 应为对象')
        const id = normalizeSchemeId(record.id ?? basename(src))
        const saved = await saveScheme(store.root, {
          ...record,
          id,
          title: record.title ?? basename(src),
          status: record.status ?? 'draft',
          changeWhy: args.changeWhy ?? '从外部项目 ' + basename(src) + ' 导入',
        }, { sourceDir: src, upgrade: args.upgrade === true })
        return {
          scheme: saved,
          ...(args.upgrade && saved.version > 1 ? { upgraded: true } : {}),
          id,
          from: src,
          files: schemeFiles(schemeAssetDir(store.root, saved)),
        }
      }
      if (!args.scheme) throw new Error('save 需要 scheme 对象')
      if (!args.scheme.id) throw new Error('save 需要 scheme.id')
      if (!args.changeWhy) throw new Error('save 需要 changeWhy：这次改了什么、为什么')
      const saved = await saveScheme(store.root, { ...args.scheme, changeWhy: args.changeWhy }, {
        body: args.body,
        files: args.files,
      })
      return { scheme: saved, ...(args.files?.length ? { files: args.files.map((file) => file.path) } : {}) }
    },
  }))
}
