import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'

export function pathSegment(value, label = '文件名') {
  if (typeof value !== 'string' || !value || /[<>:"/\\|?*\x00-\x1f]|[. ]$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value)) {
    throw new Error(label + '必须是有效的单个路径名称')
  }
  return value
}

export function relativeParts(value) {
  if (typeof value !== 'string') throw new Error('需要相对文件路径')
  return value.split(/[\\/]/u).map((part) => pathSegment(part, '路径段'))
}

// dataDir is chosen by the operator. Reject links below it, including Windows junctions.
export function dataPath(root, ...parts) {
  let current = resolve(root)
  for (const part of parts) {
    current = resolve(current, pathSegment(part))
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('数据目录下不支持文件链接：' + current)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return current
}
