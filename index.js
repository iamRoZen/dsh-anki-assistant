/**
 * Anki Assistant：方案驱动的制卡助手。
 *
 * 这一层只做两件事：把数据层的确定性操作暴露成工具，并把"什么时候该用哪一层"
 * 写进提示词。它不产出步骤序列——顺序由 Agent 决定。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { createStore, readJson } from './lib/store.js'
import { getScheme, listSchemes, saveScheme, seedSchemes, seedSchemesSync } from './lib/scheme.js'
import { createAnki, AnkiError } from './lib/anki.js'
import {
  batchFile, createBatch, loadBatch, nextItem, saveBatch, setStatus, summarize, upsertItems, view,
} from './lib/batch.js'
import { buildPlan, commitPlan, loadCommit, loadPlan, verifyCommitted, WriteError } from './lib/write.js'
import { findLines, readMaterial } from './lib/materials.js'
import { getPracticeSync, listPracticesSync, practicesForScheme, readSchemeBody, schemeBodyPath, seedLibrarySync } from './lib/library.js'
import { evaluate } from './lib/rules.js'

const PROVIDER = 'anki-assistant'
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
  }

  const store = createStore(settings.dataDir)
  const anki = createAnki({
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
  } catch (error) {
    // 播种失败不阻塞加载；工具调用时 boot() 会再试一次并给出错误
  }

  ctx.tools.register(defineTool({
    name: 'scheme',
    description:
      '制卡方案的读写。方案是数据不是代码：适用场景、所需输入、各阶段方法、输出字段规范、'
      + '质量规则、验收标准、已知局限。list 返回摘要，get 返回全文，save 永远写新版本（旧版本保留）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'get', 'save'] },
      id: { type: 'string', description: '方案 id（get/save 必填）' },
      version: { type: 'integer', description: '版本号，缺省取当前 active' },
      scheme: { type: 'object', additionalProperties: true, description: 'save 时的完整方案对象' },
      changeWhy: { type: 'string', description: 'save 时说明这次改了什么、为什么' },
      includeDrafts: { type: 'boolean', description: 'list 时是否包含 draft 方案，默认 false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemes: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          scheme: { type: 'object', additionalProperties: true, properties: {} },
        },
      },
      render(_args, value) {
        if (value.scheme) {
          const scheme = value.scheme
          const lines = [
            `${scheme.id}@${scheme.version} ${scheme.title}（${scheme.status}）`,
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
          if (scheme.quality?.rubric) lines.push(`人工判据：${scheme.quality.rubric}`)
          if (scheme.acceptance?.criteria) lines.push(`验收：${scheme.acceptance.criteria}`)
          for (const limit of scheme.limits ?? []) lines.push(`局限：${limit}`)
          if (value.scheme.practices?.length) {
            lines.push(`用过它的实践：${value.scheme.practices.map((entry) => `${entry.id}（v${entry.version}）`).join('、')}`)
          }
          if (value.scheme.body) {
            lines.push('', '--- 方案正文 ---', String(value.scheme.body).slice(0, 12000))
          }
          return text(lines.join('\n'))
        }
        return text((value.schemes ?? [])
          .map((entry) => `${entry.id}@${entry.version}｜${entry.title}｜${(entry.appliesTo?.cardTypes ?? []).join('/')}｜${entry.status}`)
          .join('\n') || '还没有方案，用 save 建档')
      },
    },
    async execute(args) {
      await boot()
      if (args.action === 'list') {
        return { schemes: await listSchemes(store.root, { includeDrafts: Boolean(args.includeDrafts) }) }
      }
      if (args.action === 'get') {
        if (!args.id) throw new Error('get 需要 id')
        const scheme = await getScheme(store.root, args.id, args.version)
        if (!scheme) throw new Error(`没有方案 ${args.id}${args.version ? `@${args.version}` : ''}`)
        const body = readSchemeBody(store.root, scheme.id)
        return {
          scheme: {
            ...scheme,
            body,
            bodyPath: schemeBodyPath(store.root, scheme.id),
            practices: practicesForScheme(store.root, scheme.id),
          },
        }
      }
      if (!args.scheme) throw new Error('save 需要 scheme 对象')
      if (!args.scheme.id) throw new Error('save 需要 scheme.id')
      if (!args.changeWhy) throw new Error('save 需要 changeWhy：这次改了什么、为什么')
      const saved = await saveScheme(store.root, { ...args.scheme, changeWhy: args.changeWhy })
      return { scheme: saved }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'batch',
    description:
      '一批待生产的题。open 建批，put 录入或补字段，validate 跑方案规则并查重（判重问 Anki），'
      + 'next 取下一道待办，mark 记结果，status 看全批。台账在数据目录，不进包也不进 Anki。',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'put', 'validate', 'next', 'mark', 'status'] },
      batch: { type: 'string', required: true, description: '批次 id（字母数字-_）' },
      title: { type: 'string', description: 'open 时的说明' },
      scheme: { type: 'string', description: 'open 时的方案 id' },
      schemeVersion: { type: 'integer', description: 'open 时钉住方案版本' },
      deck: { type: 'string', description: 'open 时的目标牌组' },
      model: { type: 'string', description: 'open 时的目标笔记模型' },
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
        for (const item of batch.items) {
          if (item.status === 'written') continue
          const fields = Object.fromEntries(
            scheme.output.fields.map((field) => [field.name, item.fields?.[field.name] ?? '']),
          )
          const issues = evaluate(fields, scheme.quality?.rules)
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
          warnings: ankiUp ? [] : ['Anki 连不上：本次只跑了方案规则，没有查重'],
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
      action: { type: 'string', required: true, enum: ['plan', 'commit', 'verify'] },
      batch: { type: 'string', description: 'plan/verify 时的批次 id' },
      plan: { type: 'string', description: 'commit/verify 时的计划 id' },
      mode: { type: 'string', enum: ['add', 'update'], description: 'plan 时：add 新建卡（默认），update 改已有卡（题上需有 noteId）' },
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
      if (args.action === 'plan') {
        if (!args.batch) throw new Error('plan 需要 batch')
        const batch = await loadBatch(store.root, args.batch)
        if (!batch) throw new Error(`没有批次 ${args.batch}`)
        const scheme = await getScheme(store.root, batch.scheme.id, batch.scheme.version)
        if (!scheme) throw new Error(`批次钉住的方案 ${batch.scheme.id}@${batch.scheme.version} 读不到`)
        const { plan, blocked } = await buildPlan({ root: store.root, batch, scheme, anki, mode: args.mode ?? 'add' })
        const ready = plan.items.filter((item) => item.status === 'ready').length
        const lines = [
          `计划 ${plan.id}｜${plan.mode === 'update' ? '改卡' : '新增'}｜${plan.deck} / ${plan.model}｜可写 ${ready} 张，受阻 ${blocked.length} 张`,
        ]
        if (plan.modelIssues.length) {
          for (const issue of plan.modelIssues) lines.push(`✗ ${issue.message}`)
        }
        for (const item of plan.items) {
          const head = `${item.status === 'ready' ? '✓' : '✗'} ${item.id}`
          lines.push(`${head}：${item.key || '（空判重键）'}`)
          for (const issue of item.issues) lines.push(`   - ${issue.field}：${issue.message}`)
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
    name: 'practice',
    description:
      '实践库：每次真实制卡留下的记录。list 给摘要，可按方案、模块或标签筛选；'
      + 'get 读全文——原始请求、用了哪些模块、方案版本、关键取舍、产物与核查结果。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'get'] },
      id: { type: 'string', description: 'get 时的实践 id（文件名去掉 .md）' },
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
        '## Anki Assistant',
        '制卡四步：取原文 → 问题集 → 答案 → 卡片；记忆提示写进卡的 memory 字段。',
        '单张卡或一次小改直接用工具做完；一批卡用 batch；要留可检查的中间文档或跨会话继续，才当项目推进。',
        '动手前先 scheme list，选中后 scheme get 会带回完整正文——正文里的字段写法、检查标准、正反例就是权威规则。',
        '想学某套方案实际怎么跑：practice list 按方案筛，practice get 读全文。',
        '取原文按【小节标题】检索，返回的 p页:L行 直接写进定位字段。',
        '批量写入前先 card_write plan，把预览给用户看；确认后再 commit，随后 verify 按提交快照回读。',
        '改了草稿、方案版本或目标牌组，旧计划就作废，必须重新 plan。',
        '用户从一次改卡里体现出新方法时，先记成 draft 方案并说明，经用户确认再 active。',
        index.length ? `现有方案：\n${index.slice(0, 15).join('\n')}` : '现有方案：无（用 scheme save 建档）',
      ].join('\n')
    },
  })
}

export const name = 'anki-assistant'
export const inject = ['tools', 'skills', 'systemPrompt']

export { AnkiError, WriteError, batchFile }
