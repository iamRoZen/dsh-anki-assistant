/**
 * 方案正文与实践库：随包分发，首次运行复制进数据目录，之后以数据目录为准。
 *
 * 方案记录（JSON）是给程序读的骨架；正文（Markdown）是给人读、也是给 Agent 读的权威规则。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 首次运行把正文与实践复制进来；已存在的不覆盖，用户改过的版本优先。 */
export function seedLibrarySync(root, assetsDir) {
  const added = []
  const schemesAssets = join(assetsDir, 'schemes')
  let files = []
  try {
    files = readdirSync(schemesAssets).filter((name) => name.endsWith('.md'))
  } catch {
    files = []
  }
  for (const file of files) {
    const id = basename(file, '.md')
    const dir = join(root, 'schemes', id)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'body.md')
    if (existsSync(target)) continue
    copyFileSync(join(schemesAssets, file), target)
    added.push(`scheme-body:${id}`)
  }

  const practicesAssets = join(assetsDir, 'practices')
  const practicesRoot = join(root, 'practices')
  mkdirSync(practicesRoot, { recursive: true })
  try {
    for (const file of readdirSync(practicesAssets)) {
      const target = join(practicesRoot, file)
      if (existsSync(target)) continue
      copyFileSync(join(practicesAssets, file), target)
      added.push(`practice:${file}`)
    }
  } catch {
    // 随包没有实践目录也可以
  }

  // 方案索引是随包快照，数据目录里的版本可以覆盖它（用户可能改过说明）
  const indexTarget = join(practicesRoot, 'index.json')
  if (!existsSync(indexTarget)) {
    try {
      copyFileSync(join(practicesAssets, 'index.json'), indexTarget)
    } catch {
      // 没有索引就按目录扫描
    }
  }
  return added
}

export function readSchemeBody(root, id) {
  const file = join(root, 'schemes', id, 'body.md')
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

export function schemeBodyPath(root, id) {
  return join(root, 'schemes', id, 'body.md')
}

export function listPracticesSync(root) {
  const indexPath = join(root, 'practices', 'index.json')
  const index = readJsonSafe(indexPath, null)
  if (Array.isArray(index)) return index
  // 没有索引时按目录扫描，文件名即主题
  try {
    return readdirSync(join(root, 'practices'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({
        id: basename(name, '.md'),
        title: basename(name, '.md'),
        doc: name,
        modules: [],
        tags: [],
        scheme: null,
      }))
  } catch {
    return []
  }
}

export function getPracticeSync(root, id) {
  const entries = listPracticesSync(root)
  const entry = entries.find((item) => item.id === id || item.doc === `${id}.md`)
  if (!entry) return null
  const file = join(root, 'practices', entry.doc)
  if (!existsSync(file) || !statSync(file).isFile()) return null
  return { ...entry, body: readFileSync(file, 'utf8') }
}

/** 反查：哪些实践用过这个方案（按 id 匹配，版本一并列出）。 */
export function practicesForScheme(root, id) {
  return listPracticesSync(root)
    .filter((entry) => entry.scheme?.id === id)
    .map((entry) => ({ id: entry.id, title: entry.title, version: entry.scheme.version, doc: entry.doc }))
}
