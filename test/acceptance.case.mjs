/**
 * 真实制卡案例：药理学（第10版）p120 哌唑嗪 → 3 张卡。
 *
 * 这是产品验收用的完整链路：取原文与行号 → 问题集 → 答案 → 样卡 → 记忆提示 → 写入 → 回读。
 * 只写新建的验收牌组，不触碰任何已有牌组。
 *
 *   node test/acceptance.case.mjs            # 默认只预览（plan）
 *   $env:WRITE="1"; node test/acceptance.case.mjs   # 真正写入
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

import { createStore } from '../lib/store.js'
import { getScheme, seedSchemes } from '../lib/scheme.js'
import { createAnki } from '../lib/anki.js'
import { createBatch, upsertItems, saveBatch, loadBatch, summarize } from '../lib/batch.js'
import { buildPlan, commitPlan, verifyWritten } from '../lib/write.js'
import { readFileSync } from 'node:fs'

const DATA = process.env.DATA_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'anki-assistant')
const DECK = 'AnkiAssistant::验收-哌唑嗪'
const MODEL = 'QAC 问答挖空 v4（国标引用）'
const SCHEME = 'qac-memory'
const SOURCE = '药理学（第10版）'
const write = process.env.WRITE === '1'

const anki = createAnki({})

// ── 1. 原文与行号（来自 materials 对 p120 的行还原） ──────────────
const evidence = {
  admin: 'p120:L6-9',    // 【临床应用】给药方式与剂量
  adverse: 'p120:L10-11', // 【不良反应】发生率排序
}

// ── 2. 问题集 → 3. 答案（按原文，不合成原文没有的结论） ─────────
const items = [
  {
    id: 'q1',
    ref: evidence.admin,
    fields: {
      问题: '哌唑嗪首次给药为什么安排在睡前？',
      章节定位: `${SOURCE} || 第十一章 肾上腺素受体阻断药 || 哌唑嗪`,
      答案: '{{c1::<b>1.</b> 首剂易致晕厥，多为直立性低血压<br><b>2.</b> 给药：初始 0.5mg，睡前服，保持卧床数小时<br><b>3.</b> 目的：降低首次给药后的晕厥风险}}',
      笔记: '先想"为什么要防"：首剂 → 血压骤降 → 晕厥；再记 0.5mg／睡前／卧床三个动作',
      引用: `${SOURCE}, 人民卫生出版社 ‖ ${evidence.admin}`,
    },
  },
  {
    id: 'q2',
    ref: evidence.admin,
    fields: {
      问题: '哌唑嗪治疗高血压的剂量如何调整，何时观察到最大疗效？',
      章节定位: `${SOURCE} || 第十一章 肾上腺素受体阻断药 || 哌唑嗪`,
      答案: '{{c1::<b>1.</b> 起始 0.5mg，睡前服<br><b>2.</b> 按血压逐渐加量<br><b>3.</b> 总剂量 20mg 时达最大疗效<br><b>4.</b> 降压作用可维持 7～10 小时}}',
      笔记: '两个数字一串记：0.5 起、20 到顶；7～10 小时是"能管多久"',
      引用: `${SOURCE}, 人民卫生出版社 ‖ ${evidence.admin}`,
    },
  },
  {
    id: 'q3',
    ref: evidence.adverse,
    fields: {
      问题: '哌唑嗪的不良反应有哪些，发生顺序如何？',
      章节定位: `${SOURCE} || 第十一章 肾上腺素受体阻断药 || 哌唑嗪`,
      答案: '{{c1::<b>1.</b> 晕厥：多由直立性低血压引起<br><b>2.</b> 发生率由高到低：眩晕、头痛、嗜睡、精神差、心悸、恶心<br><b>3.</b> 多发生在服药初期，可耐受}}',
      笔记: '晕厥单独挂机制；排序记成一条下坡路：眩晕→头痛→嗜睡→精神差→心悸→恶心',
      引用: `${SOURCE}, 人民卫生出版社 ‖ ${evidence.adverse}`,
    },
  },
]

// 要点数 = 去掉挖空标记与 HTML 标签后的可见字符数，不手填
function visibleLength(html) {
  return [...String(html)
    .replace(/\{\{c\d+::/g, '')
    .replace(/\}\}/g, '')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]+>/g, '')].length
}

for (const item of items) {
  item.fields.要点数 = `${visibleLength(item.fields.答案)}字`
}

const store = createStore(DATA)
await store.init()
await seedSchemes(DATA, JSON.parse(readFileSync(new URL('../assets/schemes/seed.json', import.meta.url), 'utf8')))
const scheme = await getScheme(DATA, SCHEME)
if (!scheme) throw new Error(`没有方案 ${SCHEME}`)

await anki.version().catch(() => {
  throw new Error('连不上 Anki：请先启动 Anki 并确认 AnkiConnect 已安装')
})

const batchId = 'accept-prazosin'
const existing = await loadBatch(DATA, batchId)
const batch = existing ?? createBatch({ id: batchId, title: '药理学 p120 哌唑嗪', scheme, target: { deck: DECK, model: MODEL } })
// 每次运行都把批次改绑到当前方案版本（等价于 batch open 的改绑行为）
batch.scheme = { id: scheme.id, version: scheme.version }
batch.target = { deck: DECK, model: MODEL }
batch.fields = scheme.output.fields.map((field) => field.name)
upsertItems(batch, items)
await saveBatch(DATA, batch)

const { plan, blocked } = await buildPlan({ root: DATA, batch, scheme, anki })
const ready = plan.items.filter((item) => item.status === 'ready').length

console.log('=== 计划预览 ===')
console.log(`方案 ${scheme.id}@${scheme.version} → ${DECK} / ${MODEL}`)
console.log(`可写 ${ready} 张，受阻 ${blocked.length} 张`)
for (const item of plan.items) {
  const mark = item.status === 'ready' ? '✓' : '✗'
  console.log(`${mark} ${item.id}：${item.key}`)
  for (const issue of item.issues) console.log(`    - ${issue.field}：${issue.message}`)
}
if (plan.modelIssues.length) {
  for (const issue of plan.modelIssues) console.log(`模型问题：${issue.message}`)
}

if (!write) {
  console.log('\n（预览模式：设置 WRITE=1 才真正写入）')
  process.exit(0)
}

if (plan.modelIssues.length) throw new Error('方案与模型字段不一致，先修正再写')

await anki.createDeck(DECK).catch(() => null)
const outcomes = await commitPlan({ root: DATA, batch, plan, anki })
await saveBatch(DATA, batch)
const ok = outcomes.filter((entry) => entry.ok).length
console.log(`\n=== 写入 ===\n成功 ${ok}，失败 ${outcomes.length - ok}`)
for (const entry of outcomes.filter((entry) => !entry.ok)) console.log(`✗ ${entry.id}：${entry.error}`)

const reloaded = await loadBatch(DATA, batchId)
const verify = await verifyWritten({ plan, batch: reloaded, anki })
console.log(`\n=== 回读 ===\n核对 ${verify.checked} 张，字段不一致 ${verify.mismatches.length} 处`)
for (const mismatch of verify.mismatches) console.log(`✗ ${mismatch.id} 字段 ${mismatch.field}`)
console.log('批次状态：', JSON.stringify(summarize(reloaded).counts))
console.log('数据目录：', DATA)
