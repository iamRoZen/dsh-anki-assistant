/**
 * Anki Assistant：方案驱动的制卡助手。
 *
 * 这一层只做两件事：把数据层的确定性操作暴露成工具，并把"什么时候该用哪一层"
 * 写进提示词。它不产出步骤序列——顺序由 Agent 决定。
 */

import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { createStore } from './lib/store.js'
import { getScheme, saveScheme, seedSchemes, seedSchemesSync } from './lib/scheme.js'
import { createAnki, AnkiError } from './lib/anki.js'
import { batchFile } from './lib/batch.js'
import { WriteError } from './lib/write.js'
import { readPackageSchemeRecord, refreshSchemeAssets, seedLibrarySync, seedSchemeDirsSync } from './lib/library.js'
import { runNodeScript, schemeFiles, text } from './lib/tools/shared.js'
import { register as registerScheme } from './lib/tools/scheme.js'
import { register as registerProject } from './lib/tools/project.js'
import { register as registerPractice } from './lib/tools/practice.js'
import { register as registerBatch } from './lib/tools/batch.js'
import { register as registerMaterials } from './lib/tools/materials.js'
import { register as registerCardWrite } from './lib/tools/card-write.js'
import { register as registerCardPreview } from './lib/tools/card-preview.js'

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

export function apply(ctx, config = {}) {
  const settings = {
    dataDir: typeof config.dataDir === 'string' && config.dataDir
      ? config.dataDir
      : join(dshHome(), 'anki-assistant'),
    ankiUrl: typeof config.ankiUrl === 'string' && config.ankiUrl
      ? config.ankiUrl
      : 'http://127.0.0.1:8765',
    python: typeof config.python === 'string' && config.python
      ? config.python
      : (process.platform === 'win32' ? 'python -X utf8' : 'python3'),
    ankiExe: typeof config.ankiExe === 'string' && config.ankiExe ? config.ankiExe : null,
    autoLaunchAnki: config.autoLaunchAnki !== false,
  }

  /**
   * 方案自带校验器：优先 quality.validator，兼容 quality.legacy；
   * 只认方案目录里的 module（默认 validate.mjs）。插件不实现判据、也不内置 Python 调用。
   */
  function legacyValidatorFor(scheme) {
    const validatorConfig = scheme?.quality?.validator ?? scheme?.quality?.legacy
    if (!validatorConfig) return null
    const moduleName = validatorConfig.module ?? 'validate.mjs'
    const moduleFile = join(store.root, 'schemes', scheme.id, moduleName)
    return async (fields) => {
      if (!existsSync(moduleFile)) {
        throw new Error(`旧判据缺失：方案 ${scheme.id} 没有 ${moduleName}`)
      }
      let mod
      try {
        mod = await import(pathToFileURL(moduleFile).href)
      } catch (error) {
        throw new Error(`旧判据未加载：${moduleFile}（${error.message}）`)
      }
      if (typeof mod.validate !== 'function') {
        throw new Error(`旧判据无效：${moduleFile} 没有导出 validate(fields)`)
      }
      return mod.validate(fields, {
        checks: validatorConfig.checks ?? null,
        python: settings.python,
      })
    }
  }

  const store = createStore(settings.dataDir)
  // 测试注入点：给一个实现同样方法的对象即可，不必连真实 Anki。
  const anki = config.ankiClient && typeof config.ankiClient.modelFields === 'function'
    ? config.ankiClient
    : createAnki({
      url: settings.ankiUrl,
      auditFile: join(settings.dataDir, 'audit', 'anki.jsonl'),
      ankiExe: settings.ankiExe,
      autoLaunch: settings.autoLaunchAnki,
    })

  let ready = null
  async function boot() {
    if (!ready) {
      ready = (async () => {
        await store.init()
        const seeds = JSON.parse(readFileSync(new URL('./assets/schemes/seed.json', import.meta.url), 'utf8'))
        const added = await seedSchemes(store.root, seeds)
        seedLibrarySync(store.root, ASSETS)
        seedSchemeDirsSync(store.root, ASSETS)
        // 目录式方案：首次登记 v1；随包 revision 更高时追加新版本。
        // 不覆盖旧版本、不改绑已有批次（批次钉的是版本号）。
        for (const entry of readdirSync(new URL('./assets/schemes/', import.meta.url), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          // 读包内资产，不读数据目录里的旧副本——否则升级永远不会发生
          const record = readPackageSchemeRecord(ASSETS, entry.name)
          if (!record) continue
          const stored = await getScheme(store.root, entry.name)
          if (!stored) {
            const saved = await saveScheme(store.root, { ...record, changeWhy: '归纳方案种子 v1' })
            added.push(`${saved.id}@${saved.version}`)
            continue
          }
          const storedRevision = Number(stored.revision ?? 0)
          const assetRevision = Number(record.revision ?? 0)
          if (assetRevision > storedRevision) {
            const dir = join(store.root, 'schemes', entry.name)
            const bodyFile = join(dir, 'body.md')
            const oldSnapshot = join(dir, `body.v${stored.version}.md`)
            // 先把旧正文按版本快照留住，再让包内新版覆盖 body.md
            if (!existsSync(oldSnapshot) && existsSync(bodyFile)) copyFileSync(bodyFile, oldSnapshot)
            refreshSchemeAssets(store.root, ASSETS, entry.name)
            const saved = await saveScheme(store.root, {
              ...record,
              changeWhy: `随包判据升级：revision ${storedRevision} → ${assetRevision}；旧版本与旧正文保留，批次不自动改绑`,
            })
            if (existsSync(bodyFile)) copyFileSync(bodyFile, join(dir, `body.v${saved.version}.md`))
            added.push(`${saved.id}@${saved.version}`)
          }
        }
        return { added }
      })()
    }
    return ready
  }

  // 提示词第一次装配就要看到方案索引，所以播种先同步做一遍。
  try {
    const seeds = JSON.parse(readFileSync(new URL('./assets/schemes/seed.json', import.meta.url), 'utf8'))
    seedSchemesSync(store.root, seeds)
    seedLibrarySync(store.root, ASSETS)
    seedSchemeDirsSync(store.root, ASSETS)
  } catch (error) {
    // 播种失败不阻塞加载；工具调用时 boot() 会再试一次并给出错误
  }

  const runtime = {
    ctx,
    defineTool,
    store,
    anki,
    boot,
    settings,
    text,
    schemeFiles,
    runNodeScript,
    legacyValidatorFor,
    assets: ASSETS,
  }

  // 工具定义在 lib/tools/ 下：这里只接线，按原注册顺序装配，不再内联任何 defineTool。
  registerScheme(runtime)
  registerBatch(runtime)
  registerMaterials(runtime)
  registerCardWrite(runtime)
  registerCardPreview(runtime)
  registerProject(runtime)
  registerPractice(runtime)

  ctx.skills.registerProvider(() => skillProvider)

  ctx.systemPrompt.section({
    name: 'anki-assistant',
    order: 90,
    text: () => {
      const index = schemeIndexSync(settings.dataDir)
      return [
        '## 工具与方案约定',
        '可用工具：project（项目）、scheme（方案）、practice（实践）、batch（批次）、materials（资料与行号）、card_write（plan/commit/verify）、card_preview（离线渲染与打印）。',
        '大任务先 project open 建现场（目标、资料、钉方案），跑通后 project to-scheme 提炼成方案草稿。',
        '方案保存后必须用 card_preview scheme=<id> sample=pass png=true 渲染一张真实样卡并 present；没有渲染不算交付。',
        '不要修改插件安装目录（assets/、lib/、index.js）；方案改数据目录里的副本（scheme save 就是写副本）。',
        '有现成方案先用现成的：scheme list → scheme get（正文、模板、实践、目录文件清单）；方案没写的部分由任务决定。',
        '想试新方法：scheme save 先存 draft，可只有正文；做几张真卡后把样卡与判据写进方案目录，scheme test 验证，确认后再 active。',
        '任务收尾时主动检查：这次的做法若值得复用，就存成 draft 方案并说明理由，不必等用户要求；没有产出的一次性任务不建方案。',
        '资料定位用 materials，返回的 p页:L行 可直接写进定位字段。',
        '写入先 card_write plan 给用户看，确认后 commit；commit 可 open=true 在 Anki 里打开，card_preview 可渲染预览或出 PDF。',
        '渲染后把文件交给用户：HTML/PNG/PDF 用 present 呈现，不要只说「已生成」。',
        '验收分两层：测试通过只是工程层；每次改动后至少从真实笔记渲染一张卡 present 给用户看，才算用户层。Anki 没开就说明，并用最近一次渲染代替。',
        '看图或 measure 发现问题：改字段 → 重新 plan/commit → 重新 card_preview，再呈现修正后的版本；不要只解释错误。',
        '改了草稿、方案版本或目标，旧计划自动作废，需要重新 plan。',
        '大任务可按节拆子 Agent 直接执行：一个批次只归一个子 Agent，不碰别人的批次、不改方案、不删除；主 Agent 预建 deck/model 并负责收口与呈现。',
        '删除要谨慎：scheme / practice / card_write 都需 confirm=true；active 方案需 force=true；批次仍钉着方案时拒绝删除。',
        index.length ? `现有方案：\n${index.slice(0, 15).join('\n')}` : '现有方案：无（用 scheme save 建档）',
      ].join('\n')
    },
  })
}

export const name = 'anki-assistant'
export const inject = ['tools', 'skills', 'systemPrompt']

export { AnkiError, WriteError, batchFile }
