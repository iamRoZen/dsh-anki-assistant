/**
 * 激活测试：不启动 DSH，直接 apply 一遍，确认四个工具、skill 与提示词段都注册成功。
 * 依赖本地 node_modules 里的 dsh-tools 形状桩（不进发布包）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
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
  const dataDir = await mkdtemp(join(tmpdir(), 'anki-as-activation-'))
  apply(ctx, { dataDir })
  return { ctx, tools, dataDir }
}

test('注册四个工具，名字稳定', async () => {
  const { tools } = await mount()
  assert.deepEqual([...tools.keys()].sort(), ['batch', 'card_write', 'materials', 'scheme'])
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

test('skill 提供正文，且正文包含字段与写入要点', async () => {
  const { ctx } = await mount()
  const candidates = await ctx.skills.provider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'anki-assistant')
  const skill = await ctx.skills.provider.get(candidates[0])
  assert.match(skill.content, /记忆提示是卡的一个字段/)
  assert.match(skill.content, /card_write/)
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
