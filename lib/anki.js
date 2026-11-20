/**
 * AnkiConnect 薄客户端。
 *
 * 只依赖 Anki 自带的本地 HTTP 接口，不依赖任何 MCP 配置或本机脚本路径，
 * 换一台电脑装上 AnkiConnect 就能用。所有写操作都在本地留一份审计。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class AnkiError extends Error {
  constructor(action, message) {
    super(`AnkiConnect ${action}：${message}`)
    this.name = 'AnkiError'
    this.action = action
  }
}

const WRITE_ACTIONS = new Set([
  'addNote',
  'addNotes',
  'updateNoteFields',
  'createDeck',
  'createModel',
  'addTags',
  'suspend',
  'deleteNotes',
])

function summarize(value) {
  if (Array.isArray(value)) return { count: value.length, first: value[0] }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    return { keys: keys.slice(0, 8), count: keys.length }
  }
  return value
}

/** 找 Anki 可执行文件：显式配置 > PATH > 环境变量 > 各盘常见安装位置。 */
export function resolveAnkiExe(explicit) {
  if (explicit && existsSync(explicit)) return explicit
  try {
    const found = execFileSync('where', ['anki'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && existsSync(line))
    if (found) return found
  } catch {
    // where 不可用或没找到，继续按路径探测
  }
  const candidates = [
    process.env.ANKI_EXE,
    'C:/Program Files/Anki/anki.exe',
    'C:/Program Files/Anki/Anki.exe',
    'C:/Program Files (x86)/Anki/anki.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs/Anki/anki.exe') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Anki/anki.exe') : null,
  ]
  // 用户可能把 Anki 装在别的盘
  for (const drive of ['C', 'D', 'E', 'F']) {
    candidates.push(`${drive}:/Program Files/Anki/anki.exe`, `${drive}:/Program Files (x86)/Anki/anki.exe`)
  }
  return candidates.find((path) => path && existsSync(path)) ?? null
}

export function createAnki({
  url = 'http://127.0.0.1:8765',
  auditFile = null,
  timeoutMs = 30000,
  ankiExe = null,
  autoLaunch = true,
  launchWaitMs = 20000,
} = {}) {
  let auditReady = false
  let launched = false

  async function audit(entry) {
    if (!auditFile) return
    try {
      if (!auditReady) {
        await mkdir(dirname(auditFile), { recursive: true })
        auditReady = true
      }
      await appendFile(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
    } catch {
      // 审计失败不能影响主流程
    }
  }

  async function request(action, params = {}, signal, { auditFailure = true } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, version: 6, params }),
        signal: composed,
      })
    } catch (error) {
      const hint = error?.name === 'TimeoutError'
        ? '请求超时，Anki 可能无响应'
        : '连不上 Anki，请确认 Anki 已启动且 AnkiConnect 已安装'
      if (auditFailure) await audit({ action, ok: false, error: hint })
      throw new AnkiError(action, hint)
    }
    const payload = await response.json().catch(() => null)
    if (payload === null) {
      if (auditFailure) await audit({ action, ok: false, error: 'invalid-json' })
      throw new AnkiError(action, '返回了非 JSON 内容，端口可能被其他程序占用')
    }
    if (payload.error) {
      if (auditFailure) await audit({ action, ok: false, error: String(payload.error).slice(0, 500) })
      throw new AnkiError(action, String(payload.error))
    }
    if (WRITE_ACTIONS.has(action)) {
      await audit({ action, ok: true, result: summarize(payload.result) })
    }
    return payload.result
  }

  /** Anki 没开时拉起它，并等 AnkiConnect 可用。 */
  async function ensureLaunched() {
    const exe = resolveAnkiExe(ankiExe)
    if (!exe) return false
    await audit({ action: 'launch-anki', ok: true, exe })
    try {
      spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    } catch (error) {
      await audit({ action: 'launch-anki', ok: false, error: error.message })
      return false
    }
    const deadline = Date.now() + launchWaitMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        await request('version', {}, undefined, { auditFailure: false })
        return true
      } catch {
        // 还没起来，继续等
      }
    }
    return false
  }

  async function invoke(action, params = {}, signal) {
    try {
      return await request(action, params, signal)
    } catch (error) {
      if (!autoLaunch || launched) throw error
      launched = true
      const started = await ensureLaunched()
      if (!started) throw error
      return await request(action, params, signal)
    }
  }

  return {
    url,
    invoke,
    version: () => invoke('version'),
    decks: () => invoke('deckNames'),
    models: () => invoke('modelNames'),
    modelFields: (model) => invoke('modelFieldNames', { modelName: model }),
    modelTemplates: (model) => invoke('modelTemplates', { modelName: model }),
    modelStyling: (model) => invoke('modelStyling', { modelName: model }),
    guiBrowse: (query) => invoke('guiBrowse', { query }),
    guiCurrentCard: () => invoke('guiCurrentCard'),
    guiShowAnswer: () => invoke('guiShowAnswer'),
    guiShowQuestion: () => invoke('guiShowQuestion'),
    findNotes: (query) => invoke('findNotes', { query }),
    notesInfo: (notes) => invoke('notesInfo', { notes }),
    addNotes: (notes) => invoke('addNotes', { notes }),
    addNote: (note) => invoke('addNote', { note }),
    createDeck: (deck) => invoke('createDeck', { deck }),
    createModel: (spec) => invoke('createModel', spec),
    addTags: (notes, tags) => invoke('addTags', { notes, tags }),
    suspend: (cards) => invoke('suspend', { cards }),
    updateNoteFields: (note) => invoke('updateNoteFields', { note }),
    deleteNotes: (notes) => invoke('deleteNotes', { notes }),
    async cardIdsOf(noteIds) {
      const info = await invoke('notesInfo', { notes: noteIds })
      return (info ?? []).flatMap((note) => note?.cards ?? [])
    },
  }
}
