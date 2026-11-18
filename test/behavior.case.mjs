/**
 * 行为验收：方案是否真的决定助手怎么做。
 *
 * A 两套取材/出题不同的方案 → 同一种卡型
 * B 沿用 A 的题目/答案/证据 → 换一种卡型（表格）
 * C 只出问题集的方案 → 没有 Anki 模型也能保存与运行
 * D 改一条方案步骤 → 读新旧正文，再跑，看动作是否变了
 *
 *   node test/behavior.case.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { createStore } from '../lib/store.js'
import { getScheme, saveScheme, seedSchemes } from '../lib/scheme.js'
import { seedLibrarySync, readSchemeBody, readTemplate } from '../lib/library.js'
import { createAnki } from '../lib/anki.js'
import { createBatch, upsertItems, saveBatch } from '../lib/batch.js'
import { buildPlan, commitPlan, verifyCommitted } from '../lib/write.js'
import { visibleLength } from '../lib/rules.js'

const DATA = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'anki-assistant') : join(homedir(), '.dsh', 'anki-assistant')
const ASSETS = new URL('../assets/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DECK = 'AnkiAssistant::方案验收'
const MODEL = 'QAC 问答挖空 v4（国标引用）'
const RUN = `run-${Date.now().toString(36)}`
const OUT = join(DATA, 'artifacts', RUN)

const store = createStore(DATA)
await store.init()
const seeds = JSON.parse(readFileSync(join(ASSETS, 'schemes', 'seed.json'), 'utf8'))
await seedSchemes(DATA, seeds)
seedLibrarySync(DATA, ASSETS)
mkdirSync(OUT, { recursive: true })

const anki = createAnki({})
await anki.version()
await anki.createDeck(DECK).catch(() => null)
// 这是本脚本自己建的验收牌组：每次重跑先清空，保证结果可复现。
const stale = await anki.findNotes(`deck:${DECK}`)
if (stale.length) await anki.deleteNotes(stale)

const log = []
function say(line = '') {
  console.log(line)
  log.push(line)
}
function card(fields) {
  return { ...fields, 要点数: `${visibleLength(fields.答案)}字` }
}

// ── A. 两套方案出同一种卡型 ───────────────────────────────
say('## A. 两套取材方法不同的方案，出同一种卡型（QAC 序号树）')

const textbook = await saveScheme(DATA, { ...seeds.find((s) => s.id === 'qac-memory'), changeWhy: '教材驱动版：先归组再出题' }) // 教材驱动
const exam = await saveScheme(DATA, { ...seeds.find((s) => s.id === 'qac-exam'), changeWhy: '首版' }) // 题源驱动

for (const [scheme, label] of [[textbook, 'qac-memory 教材驱动'], [exam, 'qac-exam 题源驱动']]) {
  say(`- ${label}@${scheme.version} 的动作顺序：${scheme.methods.map((step) => step.stage).join(' → ')}`)
  say(`  第一步：${scheme.methods[0].how}`)
}

// 教材驱动：先归组再出题，答案按原文编号成树
const textbookCard = card({
  问题: '抗高血压药哌唑嗪的不良反应按发生率如何排列？',
  章节定位: '药理学（第10版） ‖ 第十一章 肾上腺素受体阻断药 ‖ 哌唑嗪',
  答案: '{{c1::<b>1.</b> 晕厥：多由直立性低血压引起<br><b>2.</b> 发生率由高到低：眩晕、头痛、嗜睡、精神差、心悸、恶心<br><b>3.</b> 多发生在服药初期，可耐受}}',
  笔记: '晕厥单独挂机制；排序记成一条下坡路',
  引用: '药理学（第10版）, 人民卫生出版社 ‖ p120:L10-11',
})

// 题源驱动：先列题、逐题取证，题源进引用
const examCard = card({
  问题: '哌唑嗪首剂为何要控制在 0.5mg 并卧床数小时？',
  章节定位: '药理学（第10版） ‖ 第十一章 肾上腺素受体阻断药 ‖ 哌唑嗪',
  答案: '{{c1::<b>1.</b> 首剂易致晕厥，多为直立性低血压<br><b>2.</b> 给药：初始 0.5mg，睡前服，保持卧床数小时<br><b>3.</b> 目的：降低首剂晕厥风险}}',
  笔记: '先想"为什么要防"，再记 0.5mg／睡前／卧床',
  引用: '题源：药理学期末题库 第12题；药理学（第10版）, 人民卫生出版社 ‖ p120:L6-9',
})

async function writeBatch(id, scheme, items) {
  const batch = createBatch({ id, scheme, target: { deck: DECK, model: MODEL } })
  batch.fields = scheme.output.fields.map((field) => field.name)
  upsertItems(batch, items)
  await saveBatch(DATA, batch)
  const { plan, blocked } = await buildPlan({ root: DATA, batch, scheme, anki })
  if (blocked.length) throw new Error(`A 阶段有题被拦：${JSON.stringify(blocked.map((entry) => entry.issues))}`)
  const outcomes = await commitPlan({ root: DATA, batch, plan, anki })
  await saveBatch(DATA, batch)
  return { batch, plan, outcomes }
}

const a1 = await writeBatch('behavior-textbook', textbook, [{ id: 't1', ref: 'p120:L10-11', fields: textbookCard }])
const a2 = await writeBatch('behavior-exam', exam, [{ id: 'e1', ref: 'p120:L6-9', fields: examCard }])
say(`  产物：教材驱动 → note ${a1.outcomes[0].noteId}；题源驱动 → note ${a2.outcomes[0].noteId}`)
say(`  差异：教材驱动的问题是"排序"（原文结构生成）；题源驱动的问题是原题（题源决定边界）`)
say()

// ── B. 沿用已有题目/答案/证据，换一种卡型 ───────────────
say('## B. 沿用题源驱动的题目与证据，改成表格卡（同一模型，不同呈现形式）')

const tableAnswer = '{{c1::<table class="pts"><tr><th>环节</th><th>内容</th></tr>'
  + '<tr><td>首剂反应</td><td>晕厥，多为直立性低血压</td></tr>'
  + '<tr><td>给药</td><td>初始 0.5mg，睡前服</td></tr>'
  + '<tr><td>护理</td><td>保持卧床数小时</td></tr></table>}}'

const tableCard = card({
  问题: examCard.问题,                 // 题目沿用
  章节定位: examCard.章节定位,
  答案: tableAnswer,                   // 只换形式
  笔记: examCard.笔记,
  引用: examCard.引用,                 // 证据沿用
})
const b = createBatch({ id: 'behavior-exam-table', scheme: exam, target: { deck: DECK, model: MODEL } })
b.fields = exam.output.fields.map((field) => field.name)
upsertItems(b, [{ id: 'e1-table', ref: 'p120:L6-9', fields: tableCard }])
b.items[0].noteId = a2.outcomes[0].noteId          // 沿用上一张卡，只换呈现形式
b.items[0].status = 'ready'
await saveBatch(DATA, b)
const bPlan = await buildPlan({ root: DATA, batch: b, scheme: exam, anki, mode: 'update' })
const bOutcomes = await commitPlan({ root: DATA, batch: b, plan: bPlan.plan, anki })
await saveBatch(DATA, b)
const bVerify = await verifyCommitted({ root: DATA, planId: bPlan.plan.id, anki })
say(`  产物：note ${bOutcomes[0].noteId}（同一张卡，答案改成表格；改动字段 ${bOutcomes[0].changed?.join('、')}；回读异常 ${bVerify.mismatches.length}）`)
say()

// ── C. 只出问题集：不是方案，是这次只跑两个能力 ───────────
say('## C. 只交问题集：方案库不参与，也不需要 Anki 模型')
say('- 方案按卡型组织；这次只跑「资料整理 + 问题集整理」，不选方案、不建批次')

const questionSet = [
  { id: 'q1', question: '哌唑嗪首剂为什么要睡前服？', type: '机制', source: 'p120:L6-9' },
  { id: 'q2', question: '哌唑嗪治疗高血压的剂量如何递增？', type: '数值', source: 'p120:L6-9' },
  { id: 'q3', question: '哌唑嗪的不良反应按发生率如何排序？', type: '排序', source: 'p120:L10-11' },
]
const qsMd = ['# 问题集：药理学 p120 哌唑嗪', '', '| id | 题干 | 题型 | 来源 |', '|---|---|---|---|',
  ...questionSet.map((row) => `| ${row.id} | ${row.question} | ${row.type} | ${row.source} |`)].join('\n')
const qsPath = join(OUT, 'question-set.md')
writeFileSync(qsPath, `${qsMd}\n`, 'utf8')
say(`  产物：${qsPath}（${questionSet.length} 题；全程未调用分批与写入）`)
say()

// ── D. 改一条方案步骤，读新旧正文，再看动作是否变了 ─────
say('## D. 改一条步骤：qac-exam v1 → v2')

const v1 = await getScheme(DATA, 'qac-exam', 1)
const v2 = await saveScheme(DATA, {
  ...v1,
  methods: v1.methods.map((step) => (step.stage === 'organize'
    ? { ...step, how: '先把题目原样列出并**先查重**（首字段已存在就并入旧卡）；题干不改写' }
    : step)),
  quality: {
    ...v1.quality,
    rules: [...v1.quality.rules, { id: 'cite-source', field: '引用', kind: 'startsWith', value: '题源：' }],
  },
  changeWhy: '出题前先查重；引用必须以"题源："开头',
})

say(`- v1 第一步：${v1.methods[0].how}`)
say(`- v2 第一步：${v2.methods[0].how}`)
say(`- v1 规则：${v1.quality.rules.map((r) => r.id).join(', ')}`)
say(`- v2 规则：${v2.quality.rules.map((r) => r.id).join(', ')}`)

const noSource = {
  ...examCard,
  问题: '哌唑嗪的晕厥不良反应通常发生在服药的什么阶段？',
  引用: '药理学（第10版）, 人民卫生出版社 ‖ p120:L10-11',
}
const batchV1 = createBatch({ id: 'behavior-rule-v1', scheme: v1, target: { deck: DECK, model: MODEL } })
batchV1.fields = v1.output.fields.map((field) => field.name)
upsertItems(batchV1, [{ id: 'r1', fields: noSource }])
const planV1 = await buildPlan({ root: DATA, batch: batchV1, scheme: v1, anki })
say(`  同一份草稿（引用缺题源）：v1 可写 ${planV1.plan.items.filter((i) => i.status === 'ready').length} 张`)

const batchV2 = createBatch({ id: 'behavior-rule-v2', scheme: v2, target: { deck: DECK, model: MODEL } })
batchV2.fields = v2.output.fields.map((field) => field.name)
upsertItems(batchV2, [{ id: 'r1', fields: noSource }])
const planV2 = await buildPlan({ root: DATA, batch: batchV2, scheme: v2, anki })
say(`  v2 可写 ${planV2.plan.items.filter((i) => i.status === 'ready').length} 张；拦截原因：${planV2.plan.items[0].issues.map((i) => `${i.field}:${i.message}`).join('；')}`)

writeFileSync(join(OUT, 'record.md'), `${log.join('\n')}\n`, 'utf8')
say()
say(`记录已写入 ${join(OUT, 'record.md')}`)
