/**
 * card_write 工具：两段式写入（plan / commit / verify / delete）。
 */
import { loadBatch, saveBatch } from '../batch.js'
import { getScheme } from '../scheme.js'
import { buildPlan, commitPlan, loadCommit, loadPlan, verifyCommitted } from '../write.js'

export function register(runtime) {
  const { store, anki, boot, text, legacyValidatorFor } = runtime

  runtime.ctx.tools.register(runtime.defineTool({
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
}
