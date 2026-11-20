/**
 * medical-qac-2026 的入口级测试：真实调用 batch validate 与 card_write plan，
 * 用临时数据 + 模拟 Anki，不连真实库、不写 Anki。
 *
 * 由仓库根的 test 调用（见 test/scheme-induction.test.js），也可单独：
 *   ANKI_ASSISTANT_PACKAGE=<插件包根> node assets/schemes/medical-qac-2026/test/entry.mjs
 *
 * 依赖：Python 3.10+（或 ANKI_ASSISTANT_PYTHON）。
 */
import { rmSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'

const tempDirs = []
function trackDir(dir) { tempDirs.push(dir); return dir }
process.once('exit', () => {
  for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 被占用就留给系统 */ } }
})
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const schemeDir = join(here, '..')
const packageRoot = process.env.ANKI_ASSISTANT_PACKAGE ?? join(here, '..', '..', '..', '..')

const schemeRecord = JSON.parse(await readFile(join(schemeDir, 'scheme.json'), 'utf8'))
const failSample = JSON.parse(await readFile(join(schemeDir, 'samples', 'fail.json'), 'utf8'))
const expectedChecks = schemeRecord.quality?.legacy?.checks ?? []

const load = async (relative) => import(pathToFileURL(join(packageRoot, relative)).href)
const { apply } = await load('index.js')
const { loadPlan } = await load('lib/write.js')

function fakeContext() {
  const tools = new Map()
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
    skills: { registerProvider() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
  }
  return { ctx, tools }
}

function fakeAnki() {
  return {
    async version() { return 6 },
    async modelFields() { return ['问题', '章节定位', '要点数', '答案', '笔记', '引用'] },
    async findNotes() { return [] },
    async notesInfo(ids) { return (ids ?? []).map(() => null) },
    async addNotes() { return [] },
    async addNote() { return null },
    async createDeck() { return 1 },
  }
}

function legacyCodes(issues = []) {
  return issues
    .filter((issue) => String(issue.ruleId ?? '').startsWith('legacy:'))
    .map((issue) => String(issue.ruleId).slice('legacy:'.length))
}

async function mount({ python } = {}) {
  const dataDir = trackDir(await mkdtemp(join(tmpdir(), 'anki-as-entry-')))
  const { ctx, tools } = fakeContext()
  apply(ctx, {
    dataDir,
    ankiClient: fakeAnki(),
    ...(python ? { python } : {}),
  })
  const imported = await tools.get('scheme').execute({ action: 'import', path: schemeDir, changeWhy: '入口测试' }, {})
  return { dataDir, tools, saved: imported.scheme }
}

async function openBatch(tools, saved, dataDir) {
  await tools.get('batch').execute({
    action: 'open',
    batch: 'entry-test',
    scheme: saved.id,
    schemeVersion: saved.version,
    deck: 'EntryTest',
    model: saved.output.model,
  }, {})
  await tools.get('batch').execute({
    action: 'put',
    batch: 'entry-test',
    items: [{ id: 'bad-1', ref: failSample.fields['章节定位'], fields: failSample.fields }],
  }, {})
  return dataDir
}

export async function runEntryTests({ python, brokenPython = 'definitely-not-python-xyz' } = {}) {
  // 1) batch validate：真实调用，反例应命中旧检查码
  const first = await mount({ python })
  await openBatch(first.tools, first.saved, first.dataDir)
  const validated = await first.tools.get('batch').execute({ action: 'validate', batch: 'entry-test' }, {})
  const validateCodes = legacyCodes(validated.items?.[0]?.issues)

  // 2) card_write plan：真实调用，同一反例同样命中，且计划落盘
  const planned = await first.tools.get('card_write').execute({ action: 'plan', batch: 'entry-test' }, {})
  const plan = await loadPlan(first.dataDir, planned.plan)
  const planCodes = legacyCodes(plan?.items?.[0]?.issues)

  // 3) Python 不可用：两个入口都必须明确报错。正向流程用正常 Python，
  //    缺解释器只在这段反向验证里出现，避免异常在进入捕获前就抛出。
  const broken = await mount({ python: brokenPython })
  await openBatch(broken.tools, broken.saved, broken.dataDir)
  let missingMessage = ''
  try {
    await broken.tools.get('batch').execute({ action: 'validate', batch: 'entry-test' }, {})
  } catch (error) {
    missingMessage = error.message
  }
  let planErrorMessage = ''
  try {
    await broken.tools.get('card_write').execute({ action: 'plan', batch: 'entry-test' }, {})
  } catch (error) {
    planErrorMessage = error.message
  }

  return {
    expectedChecks,
    validate: {
      codes: validateCodes,
      status: validated.items?.[0]?.status,
      warnings: validated.warnings ?? [],
    },
    plan: {
      id: planned.plan,
      codes: planCodes,
      blocked: plan?.items?.[0]?.status,
      legacySuite: plan?.legacy?.suite ?? null,
      source: plan?.legacySource?.status ?? null,
    },
    missingPython: {
      validateRejected: /旧判据未执行/.test(missingMessage) || /检测器缺失/.test(missingMessage),
      message: missingMessage,
      planRejected: /旧判据未执行|检测器缺失/.test(planErrorMessage),
      planMessage: planErrorMessage,
    },
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await runEntryTests()
  console.log(JSON.stringify(result, null, 2))
}
