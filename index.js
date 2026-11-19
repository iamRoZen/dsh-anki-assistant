/**
 * Anki Assistant：方案驱动的制卡助手。
 *
 * 这一层只做两件事：把数据层的确定性操作暴露成工具，并把"什么时候该用哪一层"
 * 写进提示词。它不产出步骤序列——顺序由 Agent 决定。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { createStore, readJson } from './lib/store.js'
import { getScheme, listSchemes, normalizeSchemeId, saveScheme, seedSchemes, seedSchemesSync } from './lib/scheme.js'
import { createAnki, AnkiError } from './lib/anki.js'
import {
  batchFile, createBatch, loadBatch, nextItem, saveBatch, setStatus, summarize, upsertItems, view,
} from './lib/batch.js'
import { buildPlan, commitPlan, loadCommit, loadPlan, verifyCommitted, WriteError } from './lib/write.js'
import { findLines, readMaterial } from './lib/materials.js'
import { clozeFieldName, fixClozeBraces, scanCloze } from './lib/cloze.js'
import { buildCardsHtml, buildPrintHtml, fieldsToHtml, measureOverflow, openFile, renderPdf, renderPng, renderTemplate, splitFields } from './lib/preview.js'
import { getPracticeSync, deletePracticeSync, listPracticesSync, practicesForScheme, readAssetSchemeJson, readPackageSchemeRecord, readSchemeBody, readTemplate, refreshSchemeAssets, schemeBodyPath, seedLibrarySync, seedSchemeDirsSync, upsertPracticeSync } from './lib/library.js'
import { evaluate } from './lib/rules.js'

const PROVIDER = 'anki-assistant'
/** 跑方案自带的测试脚本：node <script>，收 stdout/stderr，超时杀掉。 */
function runNodeScript(script, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd, windowsHide: true })
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { out += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, out: `${out}\n[超时 ${timeoutMs}ms]` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(error.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/** 方案目录文件清单：让 Agent 知道除了正文还有什么（脚本、样卡、截图、笔记）。 */
function schemeFiles(root, id) {
  const dir = join(root, 'schemes', id)
  if (!existsSync(dir)) return []
  const out = []
  const walk = (base, prefix) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(base, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relative)
      else out.push({ path: relative, size: statSync(full).size })
    }
  }
  walk(dir, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url))
const SKILL_FILE = new URL('./assets/skills/anki-assistant.md', import.meta.url)

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 提示词用的方案索引：同步读，短，最多 15 行。 */
function schemeIndexSync(root) {
  const dir = join(root, 'schemes')
  let ids = []
  try {
    ids = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const rows = []
  for (const id of ids) {
    try {
      const pointer = JSON.parse(readFileSync(join(dir, id, 'active.json'), 'utf8'))
      const scheme = JSON.parse(readFileSync(join(dir, id, `v${pointer.version}.json`), 'utf8'))
      if (scheme.status !== 'active') continue
      rows.push(`${scheme.id}@${scheme.version} ${scheme.title}｜${(scheme.appliesTo?.cardTypes ?? []).join('/')}`)
    } catch {
      // 方案损坏时索引略过它，工具调用会给出具体错误
    }
  }
  return rows.sort()
}

const skillProvider = {
  name: PROVIDER,
  list: () => Promise.resolve([{
    name: 'anki-assistant',
    description: 'Anki Assistant 的制卡方法：选方案、取原文、判形状、写记忆提示、样卡确认、批量写入与回查。用于"从资料做卡""这批卡怎么改""答案怎么组织""卡怎么背"这类请求。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: ASSETS },
    rank: 620,
    locator: SKILL_FILE,
  }]),
  async get(candidate) {
    if (candidate.name !== 'anki-assistant') return undefined
    const { locator, rank, ...summary } = skillProviderList()[0]
    return { ...summary, content: readFileSync(locator, 'utf8') }
  },
}

function skillProviderList() {
  return [{
    name: 'anki-assistant',
    description: 'Anki Assistant 的制卡方法。',
    provider: PROVIDER,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: ASSETS },
    invocation: { modelInvocable: true, userInvocable: true },
    rank: 620,
    locator: SKILL_FILE,
  }]
}

function text(value) {
  return [{ type: 'text', text: value }]
}

export function apply(ctx, config = {}) {
  const settings = {
    dataDir: typeof config.dataDir === 'string' && config.dataDir
      ? config.dataDir
      : join(dshHome(), 'anki-assistant'),
    ankiUrl: typeof config.ankiUrl === 'string' && config.ankiUrl
      ? config.ankiUrl
      : 'http://127.0.0.1:8765',
    python: typeof config.python === 'string' && config.python
      ? config.python
      : (process.platform === 'win32' ? 'python -X utf8' : 'python3'),
  }

  /**
   * 方案自带校验器：优先 quality.validator，兼容 quality.legacy；
   * 只认方案目录里的 module（默认 validate.mjs）。插件不实现判据、也不内置 Python 调用。
   */
  function legacyValidatorFor(scheme) {
    const validatorConfig = scheme?.quality?.validator ?? scheme?.quality?.legacy
    if (!validatorConfig) return null
    const moduleName = validatorConfig.module ?? 'validate.mjs'
    const moduleFile = join(store.root, 'schemes', scheme.id, moduleName)
    return async (fields) => {
      if (!existsSync(moduleFile)) {
        throw new Error(`旧判据缺失：方案 ${scheme.id} 没有 ${moduleName}`)
      }
      let mod
      try {
        mod = await import(pathToFileURL(moduleFile).href)
      } catch (error) {
        throw new Error(`旧判据未加载：${moduleFile}（${error.message}）`)
      }
      if (typeof mod.validate !== 'function') {
        throw new Error(`旧判据无效：${moduleFile} 没有导出 validate(fields)`)
      }
      return mod.validate(fields, {
        checks: validatorConfig.checks ?? null,
        python: settings.python,
      })
    }
  }

  const store = createStore(settings.dataDir)
  // 测试注入点：给一个实现同样方法的对象即可，不必连真实 Anki。
  const anki = config.ankiClient && typeof config.ankiClient.modelFields === 'function'
    ? config.ankiClient
    : createAnki({
      url: settings.ankiUrl,
      auditFile: join(settings.dataDir, 'audit', 'anki.jsonl'),
    })

  let ready = null
  async function boot() {
    if (!ready) {
      ready = (async () => {
        await store.init()
        const seeds = JSON.parse(readFileSync(new URL('./assets/schemes/seed.json', import.meta.url), 'utf8'))
        const added = await seedSchemes(store.root, seeds)
        seedLibrarySync(store.root, ASSETS)
        seedSchemeDirsSync(store.root, ASSETS)
        // 目录式方案：首次登记 v1；随包 revision 更高时追加新版本。
        // 不覆盖旧版本、不改绑已有批次（批次钉的是版本号）。
        for (const entry of readdirSync(new URL('./assets/schemes/', import.meta.url), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          // 读包内资产，不读数据目录里的旧副本——否则升级永远不会发生
          const record = readPackageSchemeRecord(ASSETS, entry.name)
          if (!record) continue
          const stored = await getScheme(store.root, entry.name)
          if (!stored) {
            const saved = await saveScheme(store.root, { ...record, changeWhy: '归纳方案种子 v1' })
            added.push(`${saved.id}@${saved.version}`)
            continue
          }
          const storedRevision = Number(stored.revision ?? 0)
          const assetRevision = Number(record.revision ?? 0)
          if (assetRevision > storedRevision) {
            const dir = join(store.root, 'schemes', entry.name)
            const bodyFile = join(dir, 'body.md')
            const oldSnapshot = join(dir, `body.v${stored.version}.md`)
            // 先把旧正文按版本快照留住，再让包内新版覆盖 body.md
            if (!existsSync(oldSnapshot) && existsSync(bodyFile)) copyFileSync(bodyFile, oldSnapshot)
            refreshSchemeAssets(store.root, ASSETS, entry.name)
            const saved = await saveScheme(store.root, {
              ...record,
              changeWhy: `随包判据升级：revision ${storedRevision} → ${assetRevision}；旧版本与旧正文保留，批次不自动改绑`,
            })
            if (existsSync(bodyFile)) copyFileSync(bodyFile, join(dir, `body.v${saved.version}.md`))
            added.push(`${saved.id}@${saved.version}`)
          }
        }
        return { added }
      })()
    }
    return ready
  }

  // 提示词第一次装配就要看到方案索引，所以播种先同步做一遍。
  try {
    const seeds = JSON.parse(readFileSync(new URL('./assets/schemes/seed.json', import.meta.url), 'utf8'))
    seedSchemesSync(store.root, seeds)
    seedLibrarySync(store.root, ASSETS)
    seedSchemeDirsSync(store.root, ASSETS)
  } catch (error) {
    // 播种失败不阻塞加载；工具调用时 boot() 会再试一次并给出错误
  }

  ctx.tools.register(defineTool({
    name: 'scheme',
    description:
      '制卡方案的读写。方案是数据不是代码：适用场景、所需输入、各阶段方法、输出字段规范、'
      + '质量规则、验收标准、已知局限。list 返回摘要，get 返回全文，save 永远写新版本（旧版本保留）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'get', 'save', 'import', 'test', 'delete'] },
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
          deleted: { type: 'object', additionalProperties: true, properties: {} },
        },
      },
      render(_args, value) {
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
        if (existsSync(dest)) {
          throw new Error(`已有方案 ${id}：确认要改成新版本还是换名，再决定是否导入`)
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

  ctx.tools.register(defineTool({
    name: 'batch',
    description:
      '一批待生产的题。open 建批，put 录入或补字段，validate 跑方案规则并查重（判重问 Anki），'
      + 'next 取下一道待办，mark 记结果，status 看全批。台账在数据目录，不进包也不进 Anki。',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'put', 'validate', 'fix', 'next', 'mark', 'status'] },
      batch: { type: 'string', required: true, description: '批次 id（字母数字-_）' },
      title: { type: 'string', description: 'open 时的说明' },
      scheme: { type: 'string', description: 'open 时的方案 id' },
      schemeVersion: { type: 'integer', description: 'open 时钉住方案版本' },
      deck: { type: 'string', description: 'open 时的目标牌组' },
      model: { type: 'string', description: 'open 时的目标笔记模型' },
      apply: { type: 'boolean', description: 'fix 时是否真的写回批次；默认只报告，不改数据' },
      items: {
        type: 'array',
        description: 'put 时的题目：id 必填，fields 按方案字段名给',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            question: { type: 'string' },
            ref: { type: 'string' },
            fields: { type: 'object', additionalProperties: true, properties: {} },
          },
        },
      },
      item: { type: 'string', description: 'mark 时的题 id' },
      status: { type: 'string', enum: ['queued', 'ready', 'written', 'failed', 'parked'] },
      noteId: { type: 'integer', description: 'mark=written 时的 noteId' },
      reason: { type: 'string', description: 'mark=failed/parked 时的原因' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'object', additionalProperties: true, properties: {} },
          items: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          added: { type: 'array', items: { type: 'string' } },
          updated: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const counts = value.summary.counts ?? {}
        const lines = [
          `${value.summary.id}：共 ${value.summary.total} 题｜待办 ${counts.queued}｜就绪 ${counts.ready}｜已写 ${counts.written}｜失败 ${counts.failed}｜挂起 ${counts.parked}`,
        ]
        for (const item of value.items ?? []) {
          const issues = (item.issues ?? []).map((issue) => `${issue.field}:${issue.message}`).join('；')
          lines.push(`- ${item.id} [${item.status}]${item.noteId ? ` #${item.noteId}` : ''}${issues ? ` ⚠ ${issues}` : ''}`)
        }
        for (const warning of value.warnings ?? []) lines.push(`注意：${warning}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      await boot()
      const name = args.batch
      if (args.action === 'open') {
        if (!args.scheme) throw new Error('open 需要 scheme')
        const scheme = await getScheme(store.root, args.scheme, args.schemeVersion)
        if (!scheme) throw new Error(`没有方案 ${args.scheme}`)
        if (!args.deck || !args.model) throw new Error('open 需要 deck 和 model')
        // 同名再 open 视为改绑：换方案版本或换目标，已写的题保持原状。
        const existing = await loadBatch(store.root, name)
        let batch = existing ?? createBatch({
          id: name,
          title: args.title ?? '',
          scheme,
          target: { deck: args.deck, model: args.model },
        })
        batch.scheme = { id: scheme.id, version: scheme.version }
        batch.target = { deck: args.deck, model: args.model }
        if (args.title) batch.title = args.title
        batch.fields = scheme.output.fields.map((field) => field.name)
        const applied = upsertItems(batch, args.items ?? [])
        await saveBatch(store.root, batch)
        return {
          summary: summarize(batch),
          items: view(batch),
          ...applied,
          warnings: existing ? [`已把批次改绑到 ${scheme.id}@${scheme.version}`] : [],
        }
      }

      const batch = await loadBatch(store.root, name)
      if (!batch) throw new Error(`没有批次 ${name}，先用 action=open`)

      if (args.action === 'put') {
        const applied = upsertItems(batch, args.items ?? [])
        await saveBatch(store.root, batch)
        return { summary: summarize(batch), items: view(batch), ...applied }
      }

      if (args.action === 'fix') {
        const scheme = await getScheme(store.root, batch.scheme.id, batch.scheme.version)
        if (!scheme) throw new Error(`批次钉住的方案 ${batch.scheme.id}@${batch.scheme.version} 读不到`)
        const clozeField = clozeFieldName(scheme)
        if (!clozeField) {
          return {
            summary: summarize(batch),
            items: view(batch),
            warnings: ['本方案没有可识别的挖空字段（role=content 或名为「答案」），不自动修复'],
          }
        }
        const changes = []
        for (const item of batch.items) {
          if (item.status === 'written') continue
          const current = item.fields?.[clozeField] ?? ''
          const { text: fixed, changed } = fixClozeBraces(current)
          if (!changed) continue
          changes.push(item.id)
          if (args.apply) {
            item.fields = { ...item.fields, [clozeField]: fixed }
            item.updatedAt = new Date().toISOString()
          }
        }
        if (args.apply && changes.length > 0) await saveBatch(store.root, batch)
        return {
          summary: summarize(batch),
          items: view(batch),
          warnings: changes.length === 0
            ? ['没有需要修复的挖空']
            : [`${args.apply ? '已修复' : '可修复'} ${changes.length} 题：${changes.join(', ')}（连续 }} 改为 } }）${args.apply ? '；跑一次 validate 刷新 issues' : '；加 apply=true 写回'}`],
        }
      }

      if (args.action === 'validate') {
        const scheme = await getScheme(store.root, batch.scheme.id, batch.scheme.version)
        if (!scheme) throw new Error(`批次钉住的方案 ${batch.scheme.id}@${batch.scheme.version} 读不到`)
        let ankiUp = true
        try {
          await anki.version()
        } catch {
          ankiUp = false
        }
        const keyField = scheme.output.fields[0].name
        const legacyValidator = legacyValidatorFor(scheme)
        const warnings = ankiUp ? [] : ['Anki 连不上：本次只跑了方案规则，没有查重']
        if (!legacyValidator && (scheme.quality?.rules?.length ?? 0) === 0) {
          warnings.push('本方案没有机器校验规则：写入前请人工逐张核对')
        }
        let sourceNoted = false
        for (const item of batch.items) {
          if (item.status === 'written') continue
          const fields = Object.fromEntries(
            scheme.output.fields.map((field) => [field.name, item.fields?.[field.name] ?? '']),
          )
          const clozeField = clozeFieldName(scheme)
          const issues = [
            ...evaluate(fields, scheme.quality?.rules),
            ...(clozeField ? scanCloze(fields[clozeField]).map((issue) => ({
              ruleId: `cloze:${issue.code}`,
              field: clozeField,
              message: issue.message,
            })) : []),
          ]
          if (legacyValidator) {
            let verdict
            try {
              verdict = await legacyValidator(fields)
            } catch (error) {
              // 检测器缺失/异常：明确失败，不退化成 JS 规则
              throw new Error(`旧判据未执行（${scheme.id}@${scheme.version}）：${error.message}`)
            }
            for (const finding of verdict.issues ?? []) {
              issues.push({ ruleId: `legacy:${finding.code}`, field: '答案', message: finding.message })
            }
            if (!sourceNoted && verdict.source?.status === 'unverified') {
              warnings.push(`出处未核：${verdict.source.reason ?? '未配置 refdb'}`)
              sourceNoted = true
            }
          }
          const key = String(fields[keyField] ?? '').trim()
          if (ankiUp && key) {
            const found = await anki.findNotes(`"${keyField}:${key}"`).catch(() => [])
            if ((found ?? []).length > 0) {
              issues.push({ ruleId: 'duplicate-in-anki', field: keyField, message: `Anki 已有 ${found.length} 条` })
            }
          }
          item.issues = issues
          item.status = issues.length === 0 ? 'ready' : 'queued'
        }
        await saveBatch(store.root, batch)
        return {
          summary: summarize(batch),
          items: view(batch),
          warnings,
        }
      }

      if (args.action === 'next') {
        return { summary: summarize(batch), items: nextItem(batch) ? [view({ ...batch, items: [nextItem(batch)] })[0]] : [] }
      }

      if (args.action === 'status') {
        return { summary: summarize(batch), items: view(batch) }
      }

      if (args.action === 'mark') {
        if (!args.item) throw new Error('mark 需要 item')
        const item = setStatus(batch, args.item, args.status ?? 'failed', {
          noteId: args.noteId,
          reason: args.reason,
        })
        await saveBatch(store.root, batch)
        return { summary: summarize(batch), items: [{ ...item, issues: item.issues ?? [] }] }
      }

      throw new Error(`未知 action ${args.action}`)
    },
  }))

  ctx.tools.register(defineTool({
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

  ctx.tools.register(defineTool({
    name: 'card_write',
    description:
      '写入 Anki 的两段式入口。plan 只读：查字段规范、批内重复、Anki 已有重复，出预览和一个计划 id；'
      + 'commit 按计划写入，先按标签找回已写过的卡再补写剩下的，所以重跑不会重复。verify 回读核对字段。'
      + '写入前请让用户看过 plan 的预览。',
    parameters: {
      action: { type: 'string', required: true, enum: ['plan', 'commit', 'verify', 'delete'] },
      batch: { type: 'string', description: 'plan/verify 时的批次 id' },
      plan: { type: 'string', description: 'commit/verify 时的计划 id' },
      mode: { type: 'string', enum: ['add', 'update'], description: 'plan 时：add 新建卡（默认），update 改已有卡（题上需有 noteId）' },
      open: { type: 'boolean', description: 'commit 成功后用 Anki 浏览器打开刚写入的卡' },
      notes: { type: 'array', items: { type: 'integer' }, description: 'delete 时的 noteId 数组' },
      confirm: { type: 'boolean', description: 'delete 时需要 confirm=true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan: { type: 'string' },
          ready: { type: 'integer' },
          blocked: { type: 'integer' },
          text: { type: 'string' },
          outcomes: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          checked: { type: 'integer' },
          mismatches: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        },
      },
      render(_args, value) {
        return text(value.text ?? '已完成')
      },
    },
    async execute(args) {
      await boot()
      if (args.action === 'delete') {
        if (args.confirm !== true) throw new Error('delete 需要 confirm=true')
        const ids = (args.notes ?? []).map(Number).filter((id) => Number.isInteger(id))
        if (ids.length === 0) throw new Error('delete 需要 notes（noteId 数组）')
        const before = (await anki.notesInfo(ids)).filter(Boolean)
        await anki.deleteNotes(ids)
        const left = (await anki.notesInfo(ids)).filter(Boolean)
        let detail
        if (before.length === 0) {
          detail = `请求删除 ${ids.length} 张：这些 note 本来就不存在，没有可删的`
        } else if (left.length === 0) {
          detail = `请求删除 ${ids.length} 张：删除前存在 ${before.length} 张，已核对全部不存在`
        } else {
          detail = `请求删除 ${ids.length} 张：删除前存在 ${before.length} 张，仍有 ${left.length} 张存在（${left.map((note) => note.noteId).join(',')}）`
        }
        return { text: detail }
      }
      if (args.action === 'plan') {
        if (!args.batch) throw new Error('plan 需要 batch')
        const batch = await loadBatch(store.root, args.batch)
        if (!batch) throw new Error(`没有批次 ${args.batch}`)
        const scheme = await getScheme(store.root, batch.scheme.id, batch.scheme.version)
        if (!scheme) throw new Error(`批次钉住的方案 ${batch.scheme.id}@${batch.scheme.version} 读不到`)
        const { plan, blocked } = await buildPlan({
          root: store.root,
          batch,
          scheme,
          anki,
          mode: args.mode ?? 'add',
          validator: legacyValidatorFor(scheme),
        })
        const ready = plan.items.filter((item) => item.status === 'ready').length
        const lines = [
          `计划 ${plan.id}｜${plan.mode === 'update' ? '改卡' : '新增'}｜${plan.deck} / ${plan.model}｜可写 ${ready} 张，受阻 ${blocked.length} 张`,
        ]
        if (!plan.legacy && (scheme.quality?.rules?.length ?? 0) === 0) {
          lines.push('⚠ 本方案没有机器校验规则：请人工逐张核对后再 commit')
        }
        if (plan.modelIssues.length) {
          for (const issue of plan.modelIssues) lines.push(`✗ ${issue.message}`)
        }
        for (const item of plan.items) {
          const head = `${item.status === 'ready' ? '✓' : '✗'} ${item.id}`
          lines.push(`${head}：${item.key || '（空判重键）'}`)
          for (const issue of item.issues) lines.push(`   - ${issue.field}：${issue.message}`)
        }
        if (plan.legacy) {
          const source = plan.legacySource
          const sourceText = source?.status === 'unverified'
            ? `未核（${source.reason ?? '未配置 refdb'}）`
            : (source ? '已核' : '未知（适配器未返回出处状态）')
          lines.push(`方案校验器 ${plan.legacy.suite ?? 'custom'}：${(plan.legacy.checks ?? []).join('/')}｜出处：${sourceText}`)
        }
        lines.push('确认无误后用 card_write commit plan=<id> 写入。')
        return { plan: plan.id, ready, blocked: blocked.length, text: lines.join('\n') }
      }

      if (args.action === 'commit') {
        if (!args.plan) throw new Error('commit 需要 plan')
        const plan = await loadPlan(store.root, args.plan)
        if (!plan) throw new Error(`没有计划 ${args.plan}`)
        const batch = await loadBatch(store.root, plan.batchId)
        if (!batch) throw new Error(`计划对应的批次 ${plan.batchId} 不在了`)
        const outcomes = await commitPlan({ root: store.root, batch, plan, anki })
        await saveBatch(store.root, batch)
        const ok = outcomes.filter((entry) => entry.ok).length
        const lines = [`写入完成：成功 ${ok}，失败 ${outcomes.length - ok}`]
        if (args.open) {
          const ids = outcomes.filter((entry) => entry.ok).map((entry) => entry.noteId)
          if (ids.length > 0) {
            try {
              await anki.guiBrowse(`nid:${ids.join(',')}`)
              lines.push(`已在 Anki 浏览器中打开这 ${ids.length} 张卡`)
            } catch (error) {
              lines.push(`打开 Anki 浏览器失败：${error.message}`)
            }
          }
        }
        for (const entry of outcomes.filter((entry) => !entry.ok)) {
          lines.push(`✗ ${entry.id}：${entry.error}`)
        }
        return {
          plan: plan.id,
          ready: ok,
          blocked: outcomes.length - ok,
          outcomes,
          text: lines.join('\n'),
        }
      }

      if (args.action === 'verify') {
        if (!args.plan) throw new Error('verify 需要 plan：回读对照的是那次提交的快照')
        const record = await loadCommit(store.root, args.plan)
        if (!record) throw new Error(`没有 ${args.plan} 的提交记录，先 commit`)
        const result = await verifyCommitted({ root: store.root, planId: args.plan, anki })
        const lines = [`回读 ${result.checked} 张（${result.mode === 'update' ? '改卡' : '新增'}），异常 ${result.mismatches.length} 处`]
        for (const mismatch of result.mismatches) {
          lines.push(`✗ ${mismatch.id}（#${mismatch.noteId}）${mismatch.field}：${mismatch.message}`)
        }
        if (result.mismatches.length === 0 && result.checked > 0) lines.push('与提交快照一致')
        return { plan: args.plan, checked: result.checked, mismatches: result.mismatches, text: lines.join('\n') }
      }

      throw new Error(`未知 action ${args.action}`)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'card_preview',
    description:
      '把批次 / 计划 / 指定 noteId 的卡渲染成离线 HTML（正面、背面、模型自带 CSS），返回文件路径；'
      + 'open=true 时用默认浏览器打开。只读 Anki，不写卡。',
    parameters: {
      batch: { type: 'string', description: '批次 id' },
      plan: { type: 'string', description: '计划 id（缺批次时按其批次预览）' },
      notes: { type: 'array', items: { type: 'integer' }, description: '指定 noteId，优先于批次' },
      png: { type: 'boolean', description: '再截一张 PNG（用本机 Edge 无头渲染；没有 Edge 时只出 HTML）' },
      mathjax: { type: 'boolean', description: '加载 MathJax 排版公式（默认开；mathjax=false 关闭）' },
      ankiBase: { type: 'boolean', description: '叠加近似版 Anki 基础样式（默认开）' },
      split: { type: 'boolean', description: '逐张另存 PNG，便于单张放大看（每张一次无头渲染，较慢）' },
      pdf: { type: 'boolean', description: '另出一份 A4 PDF，一张卡一页（正面、背面）' },
      measure: { type: 'boolean', description: '量横向溢出并回报（png 时默认开启）' },
      pdfStyle: { type: 'string', enum: ['qa', 'question', 'answer'], description: 'PDF 版式：qa 正反同页（默认）、question 只看正面、answer 只看背面' },
      pdfCss: { type: 'string', description: '自定义打印 CSS：文件路径，或 assets/print 下的文件名' },
      open: { type: 'boolean', description: '生成后用默认浏览器打开' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          png: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          cards: { type: 'integer' },
          text: { type: 'string' },
        },
      },
      render(_args, value) {
        return text(value.text)
      },
    },
    async execute(args) {
      await boot()
      let fieldsList = []
      let scheme = null
      let model = null
      let title = 'Anki 预览'

      if (args.notes?.length) {
        const info = (await anki.notesInfo(args.notes)) ?? []
        const present = info.filter(Boolean)
        for (const note of present) {
          fieldsList.push(Object.fromEntries(
            Object.entries(note.fields ?? {}).map(([name, value]) => [name, value?.value ?? '']),
          ))
        }
        model = present[0]?.modelName ?? null
        title = `预览 ${args.notes.length} 张`
        if (present.length < args.notes.length) title += `（缺 ${args.notes.length - present.length} 张）`
      } else {
        const plan = args.plan ? await loadPlan(store.root, args.plan) : null
        const batch = args.batch
          ? await loadBatch(store.root, args.batch)
          : (plan ? await loadBatch(store.root, plan.batchId) : null)
        if (!batch) throw new Error('preview 需要 batch、plan 或 notes')
        const ref = plan?.scheme ?? batch.scheme
        scheme = await getScheme(store.root, ref.id, ref.version)
        if (!scheme) throw new Error(`读不到方案 ${ref.id}@${ref.version}`)
        model = plan?.model ?? batch.target.model
        fieldsList = batch.items.map((item) => Object.fromEntries(
          scheme.output.fields.map((field) => [field.name, item.fields?.[field.name] ?? '']),
        ))
        title = batch.title || batch.id
      }

      let css = ''
      let template = null
      if (model) {
        try {
          css = (await anki.modelStyling(model))?.css ?? ''
        } catch {
          css = ''
        }
        try {
          const templates = await anki.modelTemplates(model)
          template = templates ? Object.values(templates)[0] ?? null : null
        } catch {
          template = null
        }
      }

      // 有真实模板就按模板渲染；没有才退回字段角色兜底
      const cards = fieldsList.map((fields) => {
        if (template?.Front && template?.Back) {
          const frontHtml = renderTemplate(template.Front, fields, 'front')
          const backHtml = renderTemplate(template.Back, fields, 'back', frontHtml)
          return { frontHtml, backHtml }
        }
        const split = splitFields(scheme, fields)
        return { frontHtml: fieldsToHtml(split.front), backHtml: fieldsToHtml(split.back) }
      })

      const useMath = args.mathjax !== false
      const useBase = args.ankiBase !== false
      const html = buildCardsHtml({
        cards,
        css,
        title,
        mathjax: useMath,
        ankiBase: useBase,
        measure: Boolean(args.png) && args.measure !== false,
      })
      const dir = join(store.root, 'previews')
      await mkdir(dir, { recursive: true })
      const stamp = Date.now().toString(36)
      const file = join(dir, `preview-${stamp}.html`)
      await writeFile(file, html, 'utf8')

      const files = []
      const edgeOptions = useMath
        ? { timeoutMs: 60000, virtualTimeBudget: 15000 }
        : { timeoutMs: 20000, virtualTimeBudget: 0 }

      let pngFile = null
      let pngNote = ''
      if (args.png) {
        pngFile = await renderPng(file, join(dir, `preview-${stamp}.png`), {
          width: 1100,
          height: Math.min(300 + cards.length * 700, 16000),
          ...edgeOptions,
        })
        if (pngFile) files.push(pngFile)
        pngNote = pngFile ? `；PNG：${pngFile}` : '；PNG 未生成（没找到 Edge 或渲染超时）'
      }

      if (args.split) {
        for (let index = 0; index < cards.length; index += 1) {
          const singleHtml = join(dir, `preview-${stamp}-${String(index + 1).padStart(2, '0')}.html`)
          await writeFile(singleHtml, buildCardsHtml({
            cards: [cards[index]],
            css,
            title: `${title} #${index + 1}`,
            mathjax: useMath,
            ankiBase: useBase,
          }), 'utf8')
          const singlePng = await renderPng(singleHtml, singleHtml.replace(/\.html$/, '.png'), {
            width: 1100,
            height: 1400,
            ...edgeOptions,
          })
          if (singlePng) files.push(singlePng)
        }
      }

      let pdfFile = null
      let pdfNote = ''
      if (args.pdf) {
        const schemePrint = scheme?.output?.print ?? {}
        const layout = args.pdfStyle ?? schemePrint.style ?? 'qa'
        let cssPath = args.pdfCss ?? schemePrint.css
        if (!cssPath && scheme) {
          const own = join(store.root, 'schemes', scheme.id, 'print.css')
          if (existsSync(own)) cssPath = own
        }
        let extraCss = ''
        if (cssPath) {
          const candidates = existsSync(cssPath)
            ? [cssPath]
            : [join(ASSETS, 'print', cssPath), join(store.root, 'print', cssPath)]
          const found = candidates.find((path) => existsSync(path))
          if (found) {
            extraCss = readFileSync(found, 'utf8')
            pdfNote = `；打印样式 ${found.split(/[\\/]/).pop()}`
          } else {
            pdfNote = `；打印样式未找到：${cssPath}`
          }
        }
        const printHtml = join(dir, `print-${stamp}.html`)
        await writeFile(printHtml, buildPrintHtml({
          cards,
          css,
          title: `${title}（打印版）`,
          ankiBase: useBase,
          mathjax: useMath,
          layout,
          extraCss,
        }), 'utf8')
        pdfFile = await renderPdf(printHtml, join(dir, `print-${stamp}.pdf`), edgeOptions)
        if (pdfFile) files.push(pdfFile)
        pdfNote = `；版式 ${layout}${pdfNote}`
      }

      let layoutNote = ''
      if (args.png && args.measure !== false) {
        const measured = await measureOverflow(file, edgeOptions)
        if (measured) {
          const bad = measured.filter((entry) => entry.bad?.length)
          layoutNote = bad.length
            ? `；溢出：${bad.map((entry) => `#${entry.card} ${entry.bad.join('/')}`).join('，')}`
            : '；无横向溢出'
        } else {
          layoutNote = '；溢出检测未返回'
        }
      }

      if (args.open) openFile(file)
      const extraNote = files.length > 1 ? `；另存 ${files.length - (pngFile ? 1 : 0)} 个文件` : ''
      return {
        file,
        ...(pngFile ? { png: pngFile } : {}),
        ...(files.length ? { files } : {}),
        cards: cards.length,
        text: `已生成 ${cards.length} 张卡的预览：${file}${pngNote}${layoutNote}${pdfNote}${extraNote}${args.open ? '（已用浏览器打开）' : ''}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
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

  ctx.skills.registerProvider(() => skillProvider)

  ctx.systemPrompt.section({
    name: 'anki-assistant',
    order: 90,
    text: () => {
      const index = schemeIndexSync(settings.dataDir)
      return [
        '## 工具与方案约定',
        '可用工具：scheme（方案）、practice（实践）、batch（批次）、materials（资料与行号）、card_write（plan/commit/verify）、card_preview（离线渲染与打印）。',
        '有现成方案先用现成的：scheme list → scheme get（正文、模板、实践、目录文件清单）；方案没写的部分由任务决定。',
        '想试新方法：scheme save 先存 draft，可只有正文；做几张真卡后把样卡与判据写进方案目录，scheme test 验证，确认后再 active。',
        '任务收尾时主动检查：这次的做法若值得复用，就存成 draft 方案并说明理由，不必等用户要求；没有产出的一次性任务不建方案。',
        '遇到 cloze:BRACE 先用 batch fix（默认只报告，apply=true 才写回），再 validate；同类修复也可写进方案 scripts/。',
        '资料定位用 materials，返回的 p页:L行 可直接写进定位字段。',
        '写入先 card_write plan 给用户看，确认后 commit；commit 可 open=true 在 Anki 里打开，card_preview 可渲染预览或出 PDF。',
        '渲染后把文件交给用户：HTML/PNG/PDF 用 present 呈现，不要只说「已生成」。',
        '验收分两层：测试通过只是工程层；每次改动后至少从真实笔记渲染一张卡 present 给用户看，才算用户层。Anki 没开就说明，并用最近一次渲染代替。',
        '看图或 measure 发现问题：改字段 → 重新 plan/commit → 重新 card_preview，再呈现修正后的版本；不要只解释错误。',
        '改了草稿、方案版本或目标，旧计划自动作废，需要重新 plan。',
        '删除要谨慎：scheme / practice / card_write 都需 confirm=true；active 方案需 force=true；批次仍钉着方案时拒绝删除。',
        index.length ? `现有方案：\n${index.slice(0, 15).join('\n')}` : '现有方案：无（用 scheme save 建档）',
      ].join('\n')
    },
  })
}

export const name = 'anki-assistant'
export const inject = ['tools', 'skills', 'systemPrompt']

export { AnkiError, WriteError, batchFile }
