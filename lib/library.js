/**
 * 方案正文与实践库：随包分发，首次运行复制进数据目录，之后以数据目录为准。
 *
 * 方案记录（JSON）是给程序读的骨架；正文（Markdown）是给人读、也是给 Agent 读的权威规则。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
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

/** 新建或更新一条实践记录：写正文，并把索引项放进去。 */
export function upsertPracticeSync(root, entry) {
  const dir = join(root, 'practices')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, entry.doc), String(entry.body ?? ''), 'utf8')
  const indexPath = join(dir, 'index.json')
  const current = readJsonSafe(indexPath, null)
  const list = (Array.isArray(current) ? current : listPracticesSync(root))
    .filter((item) => item.id !== entry.id)
  list.push({ ...entry, body: undefined })
  list.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
  writeFileSync(indexPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8')
  return entry
}

/** 删除一条实践记录；返回是否真的删掉了。 */
export function deletePracticeSync(root, id) {
  const entry = getPracticeSync(root, id)
  if (!entry) return false
  const dir = join(root, 'practices')
  try { rmSync(join(dir, entry.doc), { force: true }) } catch { return false }
  const indexPath = join(dir, 'index.json')
  const current = readJsonSafe(indexPath, null)
  if (Array.isArray(current)) {
    writeFileSync(indexPath, `${JSON.stringify(current.filter((item) => item.id !== entry.id), null, 2)}\n`, 'utf8')
  }
  return true
}
