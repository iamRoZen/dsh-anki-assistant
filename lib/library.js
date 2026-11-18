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

  // 卡片模板：与方案分开，多套方案可以共用同一份模板
  const templatesAssets = join(assetsDir, 'templates')
  const templatesRoot = join(root, 'templates')
  mkdirSync(templatesRoot, { recursive: true })
  try {
    for (const file of readdirSync(templatesAssets)) {
      const target = join(templatesRoot, file)
      if (existsSync(target)) continue
      copyFileSync(join(templatesAssets, file), target)
      added.push(`template:${file}`)
    }
  } catch {
    // 随包没有模板目录也可以
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

/** 把 assets/schemes/<dir>/ 整个目录搬进数据目录（含 samples），不覆盖已有文件。 */
export function seedSchemeDirsSync(root, assetsDir) {
  const base = join(assetsDir, 'schemes')
  let dirs = []
  try {
    dirs = readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  const copied = []
  const walk = (from, to, prefix) => {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name)
      const target = join(to, entry.name)
      if (entry.isDirectory()) walk(source, target, `${prefix}/${entry.name}`)
      else if (!existsSync(target)) {
        copyFileSync(source, target)
        copied.push(`${prefix}/${entry.name}`)
      }
    }
  }
  for (const name of dirs) walk(join(base, name), join(root, 'schemes', name), name)
  return copied
}

/** 目录式方案自带的记录（scheme.json），没有就是普通正文目录。 */
export function readAssetSchemeJson(root, id) {
  const file = join(root, 'schemes', id, 'scheme.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 方案正文：优先取该版本的快照，退回当前正文。 */
export function readSchemeBody(root, id, version) {  if (version) {
    const snapshot = join(root, 'schemes', id, `body.v${version}.md`)
    if (existsSync(snapshot)) return readFileSync(snapshot, 'utf8')
  }
  const file = join(root, 'schemes', id, 'body.md')
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

export function schemeBodyPath(root, id) {
  return join(root, 'schemes', id, 'body.md')
}

/** 卡片模板正文：按方案里的 output.template 取，没写就没有。 */
export function readTemplate(root, id) {
  if (!id) return null
  const file = join(root, 'templates', `${id}.md`)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
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
