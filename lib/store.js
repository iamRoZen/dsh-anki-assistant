/**
 * 数据层：一记录一文件，原子写，损坏隔离。
 *
 * 存储位置由插件配置决定，默认在 DSH 主目录下，绝不出现在包目录里。
 */
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'

const SCHEMA_VERSION = 1

export class StoreError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'StoreError'
    this.cause = cause
  }
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
  return path
}

/** 读取 JSON；文件不存在返回 null，内容损坏则隔离后返回 null。 */
export async function readJson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new StoreError(`读取失败：${file}`, error)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    await quarantine(file)
    return null
  }
}

/** 同步读取，供提示词装配这类不能等待的路径使用。 */
export function readJsonSync(file, readFileSync) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写：先写临时文件再改名，避免半截文件。 */
export async function writeJson(file, value, { exclusive = false } = {}) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    if (exclusive) await link(tmp, file)
    else await rename(tmp, file)
  } finally {
    await unlink(tmp).catch(() => {})
  }
  return file
}

export async function withStoreLock(file, work) {
  await ensureDir(dirname(file))
  let compromised
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: 120_000,
    update: 10_000,
    retries: { retries: 75, minTimeout: 200, maxTimeout: 200 },
    onCompromised(error) { compromised = error },
  })
  const assertLocked = () => {
    if (compromised) throw new StoreError('数据锁已失效，请重新读取再试', compromised)
  }
  try {
    const result = await work(assertLocked)
    assertLocked()
    return result
  } finally {
    if (!compromised) await release()
  }
}

/** 损坏文件改名保留，不删除用户数据。 */
export async function quarantine(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.corrupt-${stamp}`
  try {
    await rename(file, target)
    return target
  } catch {
    return null
  }
}

export async function listDirs(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function createStore(root) {
  const dirs = {
    schemes: join(root, 'schemes'),
    batches: join(root, 'batches'),
    plans: join(root, 'plans'),
    audit: join(root, 'audit'),
    sources: join(root, 'sources'),
  }
  return {
    root,
    dirs,
    meta: join(root, 'meta.json'),
    async init() {
      await ensureDir(root)
      for (const dir of Object.values(dirs)) await ensureDir(dir)
      const meta = await readJson(this.meta)
      if (!meta) {
        await writeJson(this.meta, {
          schemaVersion: SCHEMA_VERSION,
          createdAt: new Date().toISOString(),
        })
        return { schemaVersion: SCHEMA_VERSION }
      }
      if (typeof meta.schemaVersion !== 'number' || meta.schemaVersion > SCHEMA_VERSION) {
        throw new StoreError(
          `数据版本 ${meta.schemaVersion} 高于插件支持的 ${SCHEMA_VERSION}，请升级插件而不是降级数据`,
        )
      }
      return meta
    },
    read: readJson,
    write: writeJson,
  }
}
