/**
 * batch 工具：一批待生产的题的台账（open / put / validate / fix / next / mark / status）。
 */
import { createBatch, loadBatch, nextItem, saveBatch, setStatus, summarize, upsertItems, view, withBatchLock } from '../batch.js'
import { getScheme, withSchemeLock } from '../scheme.js'
import { clozeFieldName, fixClozeBraces, scanCloze } from '../cloze.js'
import { evaluate } from '../rules.js'
import { fieldQuery } from '../write.js'

export function register(runtime) {
  const { store, anki, boot, text, legacyValidatorFor } = runtime

  runtime.ctx.tools.register(runtime.defineTool({
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
      const run = (assertLocked) => executeBatch(args, assertLocked)
      if (args.action === 'open') {
        if (!args.scheme) throw new Error('open 需要 scheme')
        return withSchemeLock(store.root, args.scheme, () => withBatchLock(store.root, name, run))
      }
      if (['next', 'status'].includes(args.action)) return executeBatch(args)
      return withBatchLock(store.root, name, run)
    },
  }))

  async function executeBatch(args, assertLocked = () => {}) {
    const name = args.batch
    if (args.action === 'open') {
      const scheme = await getScheme(store.root, args.scheme, args.schemeVersion)
      if (!scheme) throw new Error(`没有方案 ${args.scheme}`)
      if (!scheme.output?.fields?.length) throw new Error('方案没有制卡字段，请先补充模型和字段')
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
      assertLocked()
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
      assertLocked()
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
      if (args.apply && changes.length > 0) {
        assertLocked()
        await saveBatch(store.root, batch)
      }
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
        if (['written', 'parked'].includes(item.status)) continue
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
          if (verdict.ok === false && !verdict.issues?.length) {
            issues.push({ ruleId: 'validator-rejected', field: keyField, message: '方案校验器拒绝了这组字段' })
          }
          if (!sourceNoted && verdict.source?.status === 'unverified') {
            warnings.push(`出处未核：${verdict.source.reason ?? '未配置 refdb'}`)
            sourceNoted = true
          }
        }
        const key = String(fields[keyField] ?? '').trim()
        if (ankiUp && key) {
          const found = await anki.findNotes(fieldQuery(keyField, key))
          if ((found ?? []).length > 0) {
            issues.push({ ruleId: 'duplicate-in-anki', field: keyField, message: `Anki 已有 ${found.length} 条` })
          }
        }
        item.issues = issues
        item.status = issues.length === 0 ? 'ready' : 'queued'
      }
      assertLocked()
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
      assertLocked()
      await saveBatch(store.root, batch)
      return { summary: summarize(batch), items: [{ ...item, issues: item.issues ?? [] }] }
    }

    throw new Error(`未知 action ${args.action}`)
  }
}
