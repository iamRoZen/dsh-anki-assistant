/**
 * medical-qac-2026 的校验入口：本方案自带，不属于插件通用层。
 *
 * 插件只在方案声明 quality.legacy 时加载本文件；其余方案完全不知道 Python 的存在。
 * 职责：spawn 同目录 vendor/legacy_adapter.py，把字段送进去，把 JSON 结果带出来。
 * 缺 Python / 缺适配器 / 异常退出一律抛错，绝不返回“通过”。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const adapterPath = join(here, 'vendor', 'legacy_adapter.py')
export const defaultPython = process.env.ANKI_ASSISTANT_PYTHON
  ?? (process.platform === 'win32' ? 'python -X utf8' : 'python3')

export class ValidatorUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidatorUnavailableError'
  }
}

/**
 * @param {Record<string,string>} fields
 * @param {{checks?: string[]|null, python?: string, adapter?: string, timeoutMs?: number}} options
 */
export async function validate(fields, {
  checks = null,
  python = defaultPython,
  adapter = adapterPath,
  timeoutMs = 20000,
} = {}) {
  if (!existsSync(adapter)) {
    throw new ValidatorUnavailableError(`检测器缺失：找不到 ${adapter}`)
  }
  const parts = String(python).trim().split(/\s+/)
  const command = parts[0]
  const args = [...parts.slice(1), adapter]

  return await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      reject(new ValidatorUnavailableError(`检测器缺失：无法启动 ${python}（${error.message}）`))
      return
    }

    const outChunks = []
    const errChunks = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new ValidatorUnavailableError(`检测器超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new ValidatorUnavailableError(
        error.code === 'ENOENT'
          ? `检测器缺失：找不到 Python 命令「${command}」`
          : `检测器缺失：${error.message}`,
      ))
    })
    child.stdout.on('data', (chunk) => { outChunks.push(chunk) })
    child.stderr.on('data', (chunk) => { errChunks.push(chunk) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(outChunks).toString('utf8')
      const stderr = Buffer.concat(errChunks).toString('utf8')
      let parsed = null
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        parsed = null
      }
      if (code === 3 || parsed?.error === 'detector-missing') {
        reject(new ValidatorUnavailableError(`检测器缺失：${parsed?.detail ?? stderr.trim() ?? '未知原因'}`))
        return
      }
      if (code !== 0 || parsed === null) {
        reject(new ValidatorUnavailableError(`检测器异常退出（${code}）：${(stderr || stdout).trim().slice(0, 400)}`))
        return
      }
      resolve(parsed)
    })

    child.stdin.end(JSON.stringify({ fields, checks: checks ?? undefined }), 'utf8')
  })
}
