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
import { buildPlan, commitPlan, loadPlan, verifyWritten, WriteError } from './lib/write.js'
import { findLines, readMaterial } from './lib/materials.js'
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
        return { added }
      })()
    }
    return ready
  }

  // 提示词第一次装配就要看到方案索引，所以播种先同步做一遍。
  try {
    const seeds = JSON.parse(readFileSync(new URL('./assets/schemes/seed.json', import.meta.url), 'utf8'))
    seedSchemesSync(store.root, seeds)
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
        return { scheme }
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
        let batch = createBatch({
          id: name,
          title: args.title ?? '',
          scheme,
          target: { deck: args.deck, model: args.model },
        })
        batch.fields = scheme.output.fields.map((field) => field.name)
        const applied = upsertItems(batch, args.items ?? [])
        await saveBatch(store.root, batch)
        return { summary: summarize(batch), items: view(batch), ...applied }
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
        const { plan, blocked } = await buildPlan({ root: store.root, batch, scheme, anki })
        const ready = plan.items.filter((item) => item.status === 'ready').length
        const lines = [
          `计划 ${plan.id}｜${plan.deck} / ${plan.model}｜可写 ${ready} 张，受阻 ${blocked.length} 张`,
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
        const plan = args.plan ? await loadPlan(store.root, args.plan) : null
        const batchId = args.batch ?? plan?.batchId
        if (!batchId) throw new Error('verify 需要 batch 或 plan')
        const batch = await loadBatch(store.root, batchId)
        if (!batch) throw new Error(`没有批次 ${batchId}`)
        const scheme = await getScheme(store.root, batch.scheme.id, batch.scheme.version)
        const result = await verifyWritten({ plan: plan ?? { batchId }, batch, anki })
        const lines = [`回读 ${result.checked} 张，字段不一致 ${result.mismatches.length} 处`]
        for (const mismatch of result.mismatches) {
          lines.push(`✗ ${mismatch.id}（#${mismatch.noteId}）字段 ${mismatch.field}`)
        }
        if (result.mismatches.length === 0 && scheme) lines.push('字段与计划一致')
        return {
          plan: plan?.id ?? '',
          checked: result.checked,
          mismatches: result.mismatches,
          text: lines.join('\n'),
        }
      }

      throw new Error(`未知 action ${args.action}`)
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
        '先判断工作尺度，再动手：单张卡或一次小改直接用工具做完（不要建任务）；一批卡用 batch；',
        '要留可检查的中间文档或跨会话继续，才把它当项目推进。',
        '动手前先 scheme list 看有没有合适方案；方案里写了字段规范和验收规则，照它做，不要另起一套。',
        '取原文按【小节标题】检索，不按概念词；原文页码与行号写进定位字段，方便回查。',
        '记忆指导是卡的一个字段（role=memory），写在卡里，不另发讲解；它是"怎么背"，不是答案的重复。',
        '批量写入前先 card_write plan，把预览给用户看；用户确认后再 commit。',
        '用户从一次改卡里体现出新方法时，先记成 draft 方案并说明，经用户确认再 active。',
        index.length ? `现有方案：\n${index.slice(0, 15).join('\n')}` : '现有方案：无（用 scheme save 建档）',
      ].join('\n')
    },
  })
}

export const name = 'anki-assistant'
export const inject = ['tools', 'skills', 'systemPrompt']

export { AnkiError, WriteError, batchFile }
