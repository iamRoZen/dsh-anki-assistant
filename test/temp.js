/**
 * 测试用临时目录：进程退出时统一删掉，避免往 %TEMP% 里堆沙箱。
 * 之前每个测试、每次模拟都 mkdtemp 一个目录且不回收，几千个目录就这么来的。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { after } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const created = []

function track(dir) {
  created.push(dir)
  return dir
}

async function removeAll() {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 被占用就留给系统清理，不要让测试失败
    }
  }
}

// 测试文件结束时清理；exit 作为兜底。
after(removeAll)
process.once('exit', () => { void removeAll() })

export async function tempDir(prefix = 'anki-as-') {
  return track(await mkdtemp(join(tmpdir(), prefix)))
}

export function tempDirSync(prefix = 'anki-as-') {
  return track(mkdtempSync(join(tmpdir(), prefix)))
}
