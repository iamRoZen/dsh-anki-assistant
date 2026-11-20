/**
 * 激活测试：不启动 DSH，直接 apply 一遍，确认四个工具、skill 与提示词段都注册成功。
 * 依赖本地 node_modules 里的 dsh-tools 形状桩（不进发布包）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { tempDir, tempDirSync } from './temp.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

async function mount() {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    skills: {
      registerProvider(factory) {
        ctx.skills.provider = factory({ signal: undefined, invalidate() {} })
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        ctx.systemPrompt.section = section
        return () => {}
      },
    },
  }
  const dataDir = await tempDir('anki-as-activation-')
  apply(ctx, { dataDir })
  return { ctx, tools, dataDir }
}

test('注册六个工具，名字稳定', async () => {
  const { tools } = await mount()
  assert.deepEqual([...tools.keys()].sort(), ['batch', 'card_preview', 'card_write', 'materials', 'practice', 'project', 'scheme'])
})

test('project 建项、记录、提炼成方案', async () => {
  const { tools } = await mount()
  const project = tools.get('project')
  await project.execute({ action: 'open', id: 'proj-test', title: '测试项目', goal: '两张卡', deck: 'D', model: 'M' }, {})
  await project.execute({ action: 'update', id: 'proj-test', note: '# 决策\n\n一条规则。' }, {})
  const got = await project.execute({ action: 'get', id: 'proj-test' }, {})
  assert.equal(got.project.id, 'proj-test')
  const out = await project.execute({ action: 'to-scheme', id: 'proj-test' }, {})
  assert.match(out.scheme.id, /proj-test-scheme/)
  const saved = await tools.get('scheme').execute({ action: 'get', id: out.scheme.id }, {})
  assert.match(saved.scheme.body, /一条规则/)
})

test('scheme save 可带附件，scheme get 返回方案目录清单', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  await scheme.execute({
    action: 'save',
    id: 'attach-test',
    scheme: {
      id: 'attach-test',
      title: '附件测试',
      status: 'draft',
      deliverable: 'cards',
      output: { model: 'M', fields: [{ name: '问题', spec: '有主语的问题' }] },
    },
    body: '# 正文',
    changeWhy: '测试附件',
    files: [
      { path: 'samples/pass.json', content: '{}' },
      { path: 'notes/经验.md', content: '# 经验' },
    ],
  }, {})
  const got = await scheme.execute({ action: 'get', id: 'attach-test' }, {})
  const paths = got.scheme.files.map((file) => file.path)
  assert.equal(paths.includes('samples/pass.json'), true)
  assert.equal(paths.includes('notes/经验.md'), true)
  assert.equal(paths.includes('body.md'), true)
})

test('scheme save 拒绝越界附件路径', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  await assert.rejects(() => scheme.execute({
    action: 'save',
    id: 'escape-test',
    scheme: {
      id: 'escape-test',
      title: '越界测试',
      status: 'draft',
      deliverable: 'cards',
      output: { model: 'M', fields: [{ name: '问题', spec: '有主语的问题' }] },
    },
    body: '',
    changeWhy: '测试越界',
    files: [{ path: '../evil.md', content: 'x' }],
  }, {}), /非法附件路径/)
})

test('只有正文的方案算方法草稿，不会被当成卡片方案', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  await scheme.execute({
    action: 'save',
    id: 'note-from-article',
    scheme: { id: 'note-from-article', title: '一篇博文的策略', status: 'draft' },
    body: '# 一句话策略',
    changeWhy: '读到一篇文章，先记下来',
  }, {})
  const got = await scheme.execute({ action: 'get', id: 'note-from-article' }, {})
  assert.equal(got.scheme.deliverable, 'method')
  const shown = scheme.output.render({}, got).map((part) => part.text ?? '').join('')
  const listed = scheme.output.render({}, { schemes: [got.scheme] }).map((part) => part.text ?? '').join('')
  assert.match(shown, /方法草稿/)
  assert.match(listed, /方法草稿/)
})
test('没有测试的方案返回「无测试」而不是报错', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  await scheme.execute({
    action: 'save',
    id: 'no-test-note',
    scheme: { id: 'no-test-note', title: '没有测试的方法草稿', status: 'draft' },
    body: '# 只有正文',
    changeWhy: '测试无测试情况',
  }, {})
  const result = await scheme.execute({ action: 'test', id: 'no-test-note' }, {})
  assert.equal(result.test.ok, false)
  assert.equal(result.test.kind, 'none')
  assert.match(result.test.note, /没有可执行的测试/)
})

test('scheme test 用方案自带的 validate.mjs 跑样本', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  const validator = [
    'export async function validate(fields) {',
    "  const bad = String(fields['答案'] ?? '').includes('坏')",
    "  return { ok: !bad, issues: bad ? [{ code: 'BAD', message: '坏答案' }] : [], source: { status: 'unverified' } }",
    '}',
  ].join('\n')
  await scheme.execute({
    action: 'save',
    id: 'tested-scheme',
    scheme: {
      id: 'tested-scheme',
      title: '可测方案',
      status: 'draft',
      deliverable: 'cards',
      output: { model: 'M', fields: [{ name: '答案', spec: '答案' }] },
    },
    body: '',
    changeWhy: '测试',
    files: [
      { path: 'validate.mjs', content: validator },
      { path: 'samples/pass.json', content: JSON.stringify({ fields: { 答案: '好' } }) },
      { path: 'samples/fail.json', content: JSON.stringify({ fields: { 答案: '坏' }, expect: ['BAD'] }) },
    ],
  }, {})
  const result = await scheme.execute({ action: 'test', id: 'tested-scheme' }, {})
  assert.equal(result.test.ok, true)
  assert.equal(result.test.cases.length, 2)
})

test('practice save 可写、可读、可删', async () => {
  const { tools } = await mount()
  const practice = tools.get('practice')
  await practice.execute({
    action: 'save',
    id: 'p-test',
    title: '测试实践',
    body: '# 实践\n\n一条记录。',
    scheme: 'qac-memory',
    schemeVersion: 2,
    modules: ['制作卡片'],
    tags: ['测试'],
  }, {})
  const list = await practice.execute({ action: 'list', scheme: 'qac-memory' }, {})
  assert.equal(list.cases.some((entry) => entry.id === 'p-test'), true)
  const got = await practice.execute({ action: 'get', id: 'p-test' }, {})
  assert.match(got.case.body, /一条记录/)
  await practice.execute({ action: 'delete', id: 'p-test', confirm: true }, {})
  await assert.rejects(() => practice.execute({ action: 'get', id: 'p-test' }, {}), /没有实践/)
})

test('scheme delete：需确认，删后读不到', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  await scheme.execute({
    action: 'save',
    id: 'del-test',
    scheme: {
      id: 'del-test',
      title: '待删方案',
      status: 'draft',
      deliverable: 'cards',
      output: { model: 'M', fields: [{ name: '问题', spec: '一句问句' }] },
    },
    body: '',
    changeWhy: '测试删除',
  }, {})
  await assert.rejects(() => scheme.execute({ action: 'delete', id: 'del-test' }, {}), /confirm=true/)
  const result = await scheme.execute({ action: 'delete', id: 'del-test', confirm: true }, {})
  assert.equal(result.deleted.id, 'del-test')
  await assert.rejects(() => scheme.execute({ action: 'get', id: 'del-test' }, {}), /没有方案/)
})

test('card_write delete 需要确认', async () => {
  const { tools } = await mount()
  await assert.rejects(
    () => tools.get('card_write').execute({ action: 'delete', notes: [1] }, {}),
    /confirm=true/,
  )
})

test('scheme import upgrade：给已有方案出外部来源的新版本', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  await scheme.execute({
    action: 'save',
    id: 'up-test',
    scheme: {
      id: 'up-test',
      title: '旧标题',
      status: 'draft',
      deliverable: 'cards',
      output: { model: 'M', fields: [{ name: '问题', spec: '问句' }] },
    },
    body: '旧正文',
    changeWhy: '初始',
  }, {})
  const src = tempDirSync('anki-as-upgrade-')
  writeFileSync(join(src, 'scheme.json'), JSON.stringify({
    id: 'up-test',
    title: '外部标题',
    status: 'draft',
    deliverable: 'cards',
    output: { model: 'M', fields: [{ name: '问题', spec: '问句' }] },
  }), 'utf8')
  writeFileSync(join(src, 'body.md'), '# 新正文', 'utf8')

  await assert.rejects(
    () => scheme.execute({ action: 'import', path: src }, {}),
    /upgrade=true/,
  )
  const result = await scheme.execute({ action: 'import', path: src, upgrade: true, changeWhy: '外部升级' }, {})
  assert.equal(result.upgraded, true)
  assert.equal(result.scheme.version, 2)
  const got = await scheme.execute({ action: 'get', id: 'up-test' }, {})
  assert.match(got.scheme.body, /新正文/)
})

test('scheme import 接收外来目录并规范 id', async () => {
  const { tools } = await mount()
  const src = tempDirSync('anki-as-import-')
  writeFileSync(join(src, 'scheme.json'), JSON.stringify({
    id: '数学 推导!!',
    title: '外来方案',
    status: 'draft',
    deliverable: 'cards',
    output: { model: 'M', fields: [{ name: '问题', spec: '有主语的问题' }] },
  }), 'utf8')
  writeFileSync(join(src, 'body.md'), '# 外来正文', 'utf8')
  writeFileSync(join(src, 'notes.md'), '经验', 'utf8')

  const scheme = tools.get('scheme')
  const result = await scheme.execute({ action: 'import', path: src, changeWhy: '测试导入' }, {})
  assert.equal(result.id, '数学-推导')
  const got = await scheme.execute({ action: 'get', id: '数学-推导' }, {})
  assert.match(got.scheme.body, /外来正文/)
  assert.equal(got.scheme.files.some((file) => file.path === 'notes.md'), true)
})

test('每个工具都有参数、输出 schema 与 render', async () => {
  const { tools } = await mount()
  for (const [name, tool] of tools) {
    assert.equal(typeof tool.description, 'string', `${name} 缺描述`)
    assert.ok(tool.description.length > 20, `${name} 描述过短`)
    assert.equal(typeof tool.parameters, 'object', `${name} 缺参数`)
    assert.equal(typeof tool.output.render, 'function', `${name} 缺 render`)
    assert.equal(typeof tool.execute, 'function', `${name} 缺 execute`)
  }
})

test('skill 提供正文：能力目录，而非固定流程', async () => {
  const { ctx } = await mount()
  const candidates = await ctx.skills.provider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'anki-assistant')
  const skill = await ctx.skills.provider.get(candidates[0])
  assert.match(skill.content, /能力目录/)
  assert.match(skill.content, /对象要求 ≠ 呈现形式/)
  assert.match(skill.content, /scheme get/)
  // 通用层不该再规定固定四步或行长
  assert.doesNotMatch(skill.content, /四步/)
  assert.doesNotMatch(skill.content, /25 字|25字/)
})

test('提示词段列出种子方案', async () => {
  const { ctx } = await mount()
  const text = ctx.systemPrompt.section.text()
  assert.match(text, /现有方案/)
  assert.match(text, /qac-memory/)
})

test('scheme list 能读出随包种子', async () => {
  const { tools } = await mount()
  const value = await tools.get('scheme').execute({ action: 'list' }, {})
  assert.equal(value.schemes.length >= 2, true)
  const ids = value.schemes.map((scheme) => scheme.id)
  assert.equal(ids.includes('qac-memory'), true)
})

test('scheme save 需要 changeWhy，否则拒绝', async () => {
  const { tools } = await mount()
  await assert.rejects(
    () => tools.get('scheme').execute({ action: 'save', scheme: { id: 'x' } }, {}),
    /changeWhy/,
  )
})

test('同名再 open 视为改绑：换目标、保留题目', async () => {
  const { tools } = await mount()
  const batch = tools.get('batch')
  await batch.execute({
    action: 'open',
    batch: 'b1',
    scheme: 'qac-memory',
    deck: '旧牌组',
    model: 'QAC 问答挖空 v4（国标引用）',
    items: [{ id: 'i1', fields: { 问题: '这是什么？', 答案: '{{c1::答案}}' } }],
  }, {})
  const again = await batch.execute({
    action: 'open',
    batch: 'b1',
    scheme: 'qac-memory',
    deck: '新牌组',
    model: 'QAC 问答挖空 v4（国标引用）',
  }, {})
  assert.equal(again.summary.deck, '新牌组')
  assert.equal(again.summary.total, 1)
  assert.match((again.warnings ?? []).join(''), /改绑/)
})

test('scheme get 带回正文与实践反查', async () => {
  const { tools } = await mount()
  const value = await tools.get('scheme').execute({ action: 'get', id: 'qac-memory' }, {})
  assert.match(value.scheme.body, /什么时候用/)
  assert.equal(Array.isArray(value.scheme.practices), true)
  assert.equal(value.scheme.practices[0].id, '2026-11-18-药理学-哌唑嗪-三张卡')
})

test('practice 列出并读出全文', async () => {
  const { tools } = await mount()
  const list = await tools.get('practice').execute({ action: 'list' }, {})
  assert.equal(list.cases.length, 1)
  assert.equal(list.cases[0].scheme.id, 'qac-memory')
  const one = await tools.get('practice').execute({ action: 'get', id: '2026-11-18-药理学-哌唑嗪-三张卡' }, {})
  assert.match(one.case.body, /原始请求/)
  assert.match(one.case.body, /p120:L6-9/)
})

test('practice 可按模块与方案过滤', async () => {
  const { tools } = await mount()
  const byModule = await tools.get('practice').execute({ action: 'list', module: '制作卡片' }, {})
  assert.equal(byModule.cases.length, 1)
  const none = await tools.get('practice').execute({ action: 'list', scheme: 'cloze-memory' }, {})
  assert.equal(none.cases.length, 0)
})

test('提示词段约束学科中立：不出现具体病名', async () => {
  const { ctx } = await mount()
  const text = ctx.systemPrompt.section.text()
  assert.doesNotMatch(text, /哌唑嗪|心肌梗死|内科学/)
  assert.match(text, /scheme get/)
})

test('网上拿来的自然语言提示词可原样存成方案，正文按版本快照', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  const prompt = '# 卡片三段式\n\n1. 先问这张卡要解决什么困惑。\n2. 答案只写一句。\n3. 末尾补一句为什么。\n'

  const saved = await scheme.execute({
    action: 'save',
    scheme: { id: 'feynman-cards', title: '费曼三段式', status: 'draft' },
    body: prompt,
    changeWhy: '导入外部提示词',
  }, {})
  // 只有 id/title/status/body 也能存：交付物推断为 method，没有模型与字段
  assert.equal(saved.scheme.deliverable, 'method')
  assert.equal(saved.scheme.output.fields.length, 0)
  assert.equal(saved.scheme.methods.length, 0)

  const got = await scheme.execute({ action: 'get', id: 'feynman-cards' }, {})
  assert.equal(got.scheme.body.trim(), prompt.trim())

  const found = await scheme.execute({ action: 'list', includeDrafts: true, query: '三段式' }, {})
  assert.equal(found.schemes.some((entry) => entry.id === 'feynman-cards'), true)
  const byBody = await scheme.execute({ action: 'list', includeDrafts: true, query: '困惑' }, {})
  assert.equal(byBody.schemes.some((entry) => entry.id === 'feynman-cards'), true)

  // 改正文 → 新版本，旧版正文仍可读
  await scheme.execute({
    action: 'save',
    scheme: { id: 'feynman-cards', title: '费曼三段式', status: 'draft' },
    body: `${prompt}\n4. 别超过三句。\n`,
    changeWhy: '加一条限制',
  }, {})
  const v1 = await scheme.execute({ action: 'get', id: 'feynman-cards', version: 1 }, {})
  const v2 = await scheme.execute({ action: 'get', id: 'feynman-cards', version: 2 }, {})
  assert.doesNotMatch(v1.scheme.body, /别超过三句/)
  assert.match(v2.scheme.body, /别超过三句/)
})

test('batch open 缺参数时报错清楚', async () => {
  const { tools } = await mount()
  await assert.rejects(
    () => tools.get('batch').execute({ action: 'open', batch: 'b1' }, {}),
    /需要 scheme/,
  )
})

test('materials 读文本文件并给出行号', async () => {
  const { tools, dataDir } = await mount()
  const { writeFile } = await import('node:fs/promises')
  const file = join(dataDir, 'note.md')
  await writeFile(file, '第一行\n第二行 key\n', 'utf8')
  const value = await tools.get('materials').execute({ path: file }, {})
  assert.match(value.text, /2\| 第二行 key/)
})
