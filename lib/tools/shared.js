/**
 * 工具层共享的辅助：跑方案自带脚本、方案目录清单、文本结果。
 *
 * 由 index.js 装进 runtime，工具定义只从 runtime 取，不直接依赖这里的实现。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 跑方案自带的测试脚本：node <script>，收 stdout/stderr，超时杀掉。 */
export function runNodeScript(script, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd, windowsHide: true })
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { out += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, out: `${out}\n[超时 ${timeoutMs}ms]` })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(error.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/** 方案目录文件清单：让 Agent 知道除了正文还有什么（脚本、样卡、截图、笔记）。 */
export function schemeFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (base, prefix) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(base, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relative)
      else if (entry.isFile()) out.push({ path: relative, size: statSync(full).size })
    }
  }
  walk(dir, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function text(value) {
  return [{ type: 'text', text: value }]
}
