/**
 * 导入一条网上拿到的自然语言制卡提示词，验证它能原样存、能检索、能按版本回看。
 *
 *   node test/import.prompt.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const PROMPT = `# 一张卡只考一个点（三段式）

来源：某社区帖（作者未署名，仅学习用）

## 怎么做
1. 先写下这张卡要解决的**困惑**，困惑写成问句。
2. 答案只写**一句**，多一句就拆卡。
3. 末尾补一句"为什么"，说明它和已知知识的连接。

## 不要
- 不要一张卡里塞两个问号。
- 不要用"以上都是"这类选项残留。
`

const tools = new Map()
const ctx = {
  tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
  skills: { registerProvider() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
}
const dataDir = await mkdtemp(join(tmpdir(), 'anki-as-import-'))
apply(ctx, { dataDir })

const scheme = tools.get('scheme')
const saved = await scheme.execute({
  action: 'save',
  scheme: {
    id: 'one-point-three-steps',
    title: '一张卡一个点（三段式）',
    status: 'draft',
    origin: { kind: 'imported', note: '网上提示词，未署名' },
  },
  body: PROMPT,
  changeWhy: '导入外部自然语言提示词',
}, {})

console.log('交付物推断：', saved.scheme.deliverable)
console.log('模型/字段：', JSON.stringify(saved.scheme.output))
console.log('方法条数：', saved.scheme.methods.length)

const got = await scheme.execute({ action: 'get', id: saved.scheme.id }, {})
console.log('正文原样保留：', got.scheme.body === PROMPT)
console.log('按正文关键词能搜到：', (await scheme.execute({ action: 'list', includeDrafts: true, query: '困惑' }, {})).schemes.length)

await scheme.execute({
  action: 'save',
  scheme: { id: saved.scheme.id, title: saved.scheme.title, status: 'draft', origin: saved.scheme.origin },
  body: `${PROMPT}\n## 补充\n4. 连续三张都不满意就停下来问。\n`,
  changeWhy: '补一条止损条件',
}, {})
const v1 = await scheme.execute({ action: 'get', id: saved.scheme.id, version: 1 }, {})
const v2 = await scheme.execute({ action: 'get', id: saved.scheme.id, version: 2 }, {})
console.log('v1 无补充：', !v1.scheme.body.includes('停下来问'), '；v2 有补充：', v2.scheme.body.includes('停下来问'))
console.log('数据目录：', dataDir)
