/**
 * 用 DSH 执行链验证七个工具的输入、输出、渲染与落盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tempDir, tempDirSync } from './temp.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mountTools } from './tool-host.js'

async function mount(config = {}) {
  const dataDir = await tempDir('anki-as-activation-')
  return { ...mountTools({ dataDir, autoLaunchAnki: false, ...config }), dataDir }
}

/** 测试用基础方案：包内不再播种，用例自己建。 */
async function demo(tools, id = 'demo') {
  await tools.get('scheme').execute({
    action: 'save',
    id,
    scheme: {
      id,
      title: '演示方案',
      status: 'active',
      deliverable: 'cards',
      output: {
        model: 'M',
        fields: [{ name: '问题', spec: '问句' }, { name: '答案', spec: '答案' }],
      },
    },
    body: '# 演示\n\n什么时候用：测试。',
    changeWhy: '测试基线',
  }, {})
}

test('注册七个工具，名字稳定', async () => {
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

test('card_preview 按方案样卡渲染并落到 samples/render', async () => {
  const fakeAnki = {
    modelFields: async () => ['问题', '答案'],
    modelStyling: async () => ({ css: '.card{}' }),
    modelTemplates: async () => ({ 第一张: { Front: '<div>{{问题}}</div>', Back: '<div>{{答案}}</div>' } }),
    notesInfo: async () => [],
    version: async () => '6',
  }
  const { tools, dataDir } = await mount({ ankiClient: fakeAnki })
  await tools.get('scheme').execute({
    action: 'save',
    id: 'render-test',
    scheme: {
      id: 'render-test',
      title: '渲染',
      status: 'draft',
      deliverable: 'cards',
      output: {
        model: 'M',
        fields: [{ name: '问题', spec: '问句' }, { name: '答案', spec: '答句' }],
      },
    },
    body: '# 正文',
    changeWhy: '测试渲染',
    files: [{ path: 'samples/pass.json', content: JSON.stringify({ fields: { 问题: 'Q', 答案: 'A' } }) }],
  }, {})
  const out = await tools.get('card_preview').execute({ scheme: 'render-test', sample: 'pass' }, {})
  assert.ok(out.file)
  assert.equal(existsSync(join(dataDir, 'schemes', 'render-test', 'samples', 'render', 'v1', 'pass.html')), true)
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

test('scheme prune 只留 active 版本，需 confirm', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  const base = {
    id: 'prune-test',
    title: '修剪',
    status: 'draft',
    deliverable: 'cards',
    output: { model: 'M', fields: [{ name: '问题', spec: '问句' }] },
  }
  for (const [version, body] of [[1, 'v1'], [2, 'v2'], [3, 'v3']]) {
    await scheme.execute({ action: 'save', id: 'prune-test', scheme: base, body, changeWhy: `第 ${version} 版` }, {})
  }
  await assert.rejects(() => scheme.execute({ action: 'prune', id: 'prune-test' }, {}), /confirm=true/)
  const result = await scheme.execute({ action: 'prune', id: 'prune-test', confirm: true }, {})
  assert.deepEqual(result.pruned.deleted, [1, 2])
  await assert.rejects(() => scheme.execute({ action: 'get', id: 'prune-test', version: 1 }, {}), /没有方案/)
})

test('scheme prune 保留 active 与被批次钉住的版本', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  const base = {
    id: 'pin-test',
    title: '钉住',
    status: 'draft',
    deliverable: 'cards',
    output: { model: 'M', fields: [{ name: '问题', spec: '问句' }] },
  }
  await scheme.execute({ action: 'save', id: 'pin-test', scheme: base, body: 'v1', changeWhy: '一' }, {})
  await tools.get('batch').execute({ action: 'open', batch: 'bp', scheme: 'pin-test', schemeVersion: 1, deck: 'D', model: 'M' }, {})
  await scheme.execute({ action: 'save', id: 'pin-test', scheme: base, body: 'v2', changeWhy: '二' }, {})
  const result = await scheme.execute({ action: 'prune', id: 'pin-test', confirm: true }, {})
  assert.deepEqual(result.pruned.kept, [1, 2])
  assert.deepEqual(result.pruned.deleted, [])
  const old = await scheme.execute({ action: 'get', id: 'pin-test', version: 1 }, {})
  assert.equal(old.scheme.version, 1)
})

test('scheme derive 从外部文件起一个方案草稿', async () => {
  const { tools } = await mount()
  const dir = tempDirSync('anki-as-derive-')
  writeFileSync(join(dir, 'a.md'), '# 文章 A\n\n规则一', 'utf8')
  writeFileSync(join(dir, 'b.md'), '# 文章 B\n\n规则二', 'utf8')
  const scheme = tools.get('scheme')
  const out = await scheme.execute({
    action: 'derive',
    id: 'derived-test',
    title: '从文章起方案',
    sources: [join(dir, 'a.md'), join(dir, 'b.md')],
  }, {})
  assert.equal(out.scheme.deliverable, 'method')
  const got = await scheme.execute({ action: 'get', id: 'derived-test' }, {})
  assert.match(got.scheme.body, /规则一/)
  assert.match(got.scheme.body, /规则二/)
})

test('scheme test 预检 requirements.txt，缺依赖明确报错', async () => {
  const { tools } = await mount()
  await tools.get('scheme').execute({
    action: 'save',
    id: 'deps-test',
    scheme: { id: 'deps-test', title: '依赖预检', status: 'draft', deliverable: 'method' },
    body: '# 方法',
    changeWhy: '测试依赖预检',
    files: [{ path: 'requirements.txt', content: 'definitely-not-installed-xyz>=1\n' }],
  }, {})
  await assert.rejects(
    () => tools.get('scheme').execute({ action: 'test', id: 'deps-test' }, {}),
    /缺少 Python 依赖/,
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

test('提示词段列出方案索引', async () => {
  const { ctx, tools } = await mount()
  await demo(tools)
  const text = ctx.systemPrompt.section.text()
  assert.match(text, /现有方案/)
  assert.match(text, /demo/)
})

test('scheme list 读出数据目录里的方案', async () => {
  const { tools } = await mount()
  await demo(tools, 'listed')
  const value = await tools.get('scheme').execute({ action: 'list' }, {})
  const ids = value.schemes.map((scheme) => scheme.id)
  assert.equal(ids.includes('listed'), true)
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
  await demo(tools)
  const batch = tools.get('batch')
  await batch.execute({
    action: 'open',
    batch: 'b1',
    scheme: 'demo',
    deck: '旧牌组',
    model: 'QAC 问答挖空 v4（国标引用）',
    items: [{ id: 'i1', fields: { 问题: '这是什么？', 答案: '{{c1::答案}}' } }],
  }, {})
  const again = await batch.execute({
    action: 'open',
    batch: 'b1',
    scheme: 'demo',
    deck: '新牌组',
    model: 'QAC 问答挖空 v4（国标引用）',
  }, {})
  assert.equal(again.summary.deck, '新牌组')
  assert.equal(again.summary.total, 1)
  assert.match((again.warnings ?? []).join(''), /改绑/)
})

test('scheme get 带回正文与实践反查', async () => {
  const { tools } = await mount()
  await demo(tools)
  await tools.get('practice').execute({
    action: 'save',
    id: 'p-demo',
    body: '# 原始请求\n\np120:L6-9',
    scheme: 'demo',
    modules: ['制作卡片'],
  }, {})
  const value = await tools.get('scheme').execute({ action: 'get', id: 'demo' }, {})
  assert.match(value.scheme.body, /什么时候用/)
  assert.equal(Array.isArray(value.scheme.practices), true)
  assert.equal(value.scheme.practices[0].id, 'p-demo')
})

test('practice 列出并读出全文', async () => {
  const { tools } = await mount()
  await demo(tools)
  await tools.get('practice').execute({
    action: 'save',
    id: 'p-demo',
    body: '# 原始请求\n\np120:L6-9',
    scheme: 'demo',
    modules: ['制作卡片'],
  }, {})
  const list = await tools.get('practice').execute({ action: 'list' }, {})
  assert.equal(list.cases.length, 1)
  assert.equal(list.cases[0].scheme.id, 'demo')
  const one = await tools.get('practice').execute({ action: 'get', id: 'p-demo' }, {})
  assert.match(one.case.body, /原始请求/)
  assert.match(one.case.body, /p120:L6-9/)
})

test('practice 可按模块与方案过滤', async () => {
  const { tools } = await mount()
  await demo(tools)
  await tools.get('practice').execute({
    action: 'save',
    id: 'p-demo',
    body: '# 记录',
    scheme: 'demo',
    modules: ['制作卡片'],
  }, {})
  const byModule = await tools.get('practice').execute({ action: 'list', module: '制作卡片' }, {})
  assert.equal(byModule.cases.length, 1)
  const none = await tools.get('practice').execute({ action: 'list', scheme: 'missing' }, {})
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

test('升级隔离已加载的校验器，外部版本由宿主配置启用', async () => {
  const { tools, dataDir } = await mount()
  const form = { id: 'versioned', title: '两版', status: 'draft', output: { model: 'M', fields: [{ name: 'Q', spec: '问题' }] },
    quality: { validator: { module: 'validate.mjs' } } }
  const validator = (code) => 'export function validate() { return { ok: false, issues: [{ code: ' + JSON.stringify(code) + ' }] } }'
  const sample = JSON.stringify({ fields: { Q: '题' }, expect: ['v1'] })
  const scheme = tools.get('scheme')
  await scheme.execute({ action: 'save', scheme: form, changeWhy: '第一版',
    files: [{ path: 'validate.mjs', content: validator('v1') }, { path: 'samples/fail.json', content: sample }] })
  const first = await scheme.execute({ action: 'test', id: form.id, version: 1 })
  assert.deepEqual(first.test.cases[0].codes, ['v1'])

  const source = await tempDir('anki-as-version-source-')
  writeFileSync(join(source, 'scheme.json'), JSON.stringify({ ...form, codeTrusted: true }))
  writeFileSync(join(source, 'validate.mjs'), validator('v2'))
  mkdirSync(join(source, 'samples'))
  writeFileSync(join(source, 'samples', 'fail.json'), JSON.stringify({ fields: { Q: '题' }, expect: ['v2'] }))
  const upgraded = await scheme.execute({ action: 'import', path: source, upgrade: true })
  assert.equal(upgraded.upgraded, true)
  await assert.rejects(() => scheme.execute({ action: 'test', id: form.id, version: 2 }), /脚本尚未启用/)
  const trusted = mountTools({ dataDir, trustedSchemeVersions: ['versioned@2'] }).tools.get('scheme')
  const next = await trusted.execute({ action: 'test', id: form.id, version: 2 })
  const original = await trusted.execute({ action: 'test', id: form.id, version: 1 })
  assert.deepEqual(next.test.cases[0].codes, ['v2'])
  assert.deepEqual(original.test.cases[0].codes, ['v1'])
})

test('保存失败保留当前版本，prune 保留项目钉住的旧版', async () => {
  const { tools } = await mount()
  const scheme = tools.get('scheme')
  await demo(tools)
  await tools.get('project').execute({ action: 'open', id: 'study', scheme: 'demo' })
  const { scheme: input } = await scheme.execute({ action: 'get', id: 'demo' })
  await assert.rejects(() => scheme.execute({
    action: 'save', scheme: input, changeWhy: '附件缺失', files: [{ path: 'notes/study.md' }],
  }), /path 与 content/)
  assert.equal((await scheme.execute({ action: 'get', id: 'demo' })).scheme.version, 1)
  await demo(tools)
  await demo(tools)
  const result = await scheme.execute({ action: 'prune', id: 'demo', confirm: true })
  assert.deepEqual(result.pruned.kept, [1, 3])
  assert.deepEqual(result.pruned.deleted, [2])
  assert.equal((await scheme.execute({ action: 'get', id: 'demo', version: 1 })).scheme.version, 1)
})

test('计划预览展示当时批准的草稿，并拒绝提交已挂起的题', async () => {
  const ankiClient = {
    modelFields: async () => ['问题', '答案'],
    modelTemplates: async () => ({ Card: { Front: '{{问题}}', Back: '{{答案}}' } }),
    modelStyling: async () => ({ css: '' }),
    findNotes: async () => [],
  }
  const { tools } = await mount({ ankiClient })
  await demo(tools)
  const batch = tools.get('batch')
  const write = tools.get('card_write')
  await batch.execute({ action: 'open', batch: 'preview', scheme: 'demo', model: 'M', deck: 'D',
    items: [{ id: 'one', fields: { 问题: '题目', 答案: '当时草稿' } }] })
  const first = await write.execute({ action: 'plan', batch: 'preview' })
  await batch.execute({ action: 'put', batch: 'preview', items: [{ id: 'one', fields: { 答案: '后改草稿' } }] })
  const preview = await tools.get('card_preview').execute({ plan: first.plan, mathjax: false })
  const html = readFileSync(preview.file, 'utf8')
  assert.match(html, /当时草稿/)
  assert.doesNotMatch(html, /后改草稿/)

  const second = await write.execute({ action: 'plan', batch: 'preview' })
  await batch.execute({ action: 'mark', batch: 'preview', item: 'one', status: 'parked' })
  await assert.rejects(() => write.execute({ action: 'commit', plan: second.plan }), /状态或 noteId/)
})

test('同一批次在 Anki 返回前等待，仍保留后续草稿', async () => {
  const added = Promise.withResolvers()
  const resume = Promise.withResolvers()
  let published
  const ankiClient = {
    modelFields: async () => ['问题', '答案'],
    findNotes: async () => [],
    async addNotes([note]) {
      published = note
      added.resolve()
      await resume.promise
      return [101]
    },
    notesInfo: async () => [{
      noteId: 101, modelName: 'M', cards: [501], tags: published.tags,
      fields: Object.fromEntries(Object.entries(published.fields).map(([name, value]) => [name, { value }])),
    }],
    cardsInfo: async () => [{ cardId: 501, deckName: 'D' }],
  }
  const { tools, dataDir } = await mount({ ankiClient })
  await demo(tools)
  const batch = tools.get('batch')
  const write = tools.get('card_write')
  await batch.execute({ action: 'open', batch: 'overlap', scheme: 'demo', model: 'M', deck: 'D',
    items: [{ id: 'one', fields: { 问题: '题目', 答案: '提交草稿' } }] })
  const plan = await write.execute({ action: 'plan', batch: 'overlap' })
  const commit = write.execute({ action: 'commit', plan: plan.plan })
  await Promise.race([added.promise, commit])
  assert.ok(published)
  const edit = batch.execute({ action: 'put', batch: 'overlap', items: [{ id: 'one', fields: { 答案: '后改草稿' } }] })
  resume.resolve()
  const [result] = await Promise.all([commit, edit])
  assert.equal(result.ready, 1)
  const record = JSON.parse(readFileSync(join(dataDir, 'batches', 'overlap.json'), 'utf8'))
  assert.equal(record.items[0].fields.答案, '后改草稿')
  assert.equal(record.items[0].noteId, 101)
})

test('Anki 用空对象表示已删除笔记时，删除核对正确', async () => {
  let exists = true
  const ankiClient = {
    modelFields: async () => [],
    notesInfo: async (ids) => ids.map((noteId) => (exists && noteId === 101 ? { noteId } : {})),
    async deleteNotes(ids) {
      assert.deepEqual(ids, [101])
      exists = false
    },
  }
  const { tools } = await mount({ ankiClient })
  const result = await tools.get('card_write').execute({ action: 'delete', notes: [101, 102], confirm: true })
  assert.match(result.text, /删除前存在 1 张，已核对全部不存在/)
})
