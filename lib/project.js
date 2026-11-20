/**
 * 项目目录：一次任务的现场。
 *
 * 项目不是方案：项目记录目标、资料、关联批次与决策过程；方案是跑通之后提炼出来的复用件。
 * 目录形如 <dataDir>/projects/<id>/{project.json, sources/, notes/, samples/, exports/}。
 */
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readJson, writeJson } from './store.js'
import { normalizeSchemeId } from './scheme.js'
import { dataPath } from './paths.js'

export function projectDir(root, id) {
  return dataPath(root, 'projects', id)
}

export function projectFile(root, id) {
  return dataPath(projectDir(root, id), 'project.json')
}

export async function loadProject(root, id) {
  return readJson(projectFile(root, id))
}

export async function listProjects(root) {
  let names = []
  try {
    names = await readdir(dataPath(root, 'projects'), { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const projects = []
  for (const name of names) {
    const project = await loadProject(root, name)
    if (project) projects.push(project)
  }
  return projects.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

export async function createProject(root, input) {
  const id = normalizeSchemeId(input.id ?? input.title)
  const dir = projectDir(root, id)
  await mkdir(dataPath(root, 'projects'), { recursive: true })
  try {
    await mkdir(dir)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error('项目 ' + id + ' 已存在')
  }
  for (const sub of ['sources', 'notes', 'samples', 'exports']) {
    await mkdir(join(dir, sub), { recursive: true })
  }
  const now = new Date().toISOString()
  const project = {
    id,
    title: input.title ?? id,
    goal: input.goal ?? '',
    status: 'active',
    scheme: input.scheme ?? null,
    deck: input.deck ?? null,
    model: input.model ?? null,
    sources: input.sources ?? [],
    batches: [],
    practices: [],
    summary: '',
    createdAt: now,
    updatedAt: now,
  }
  await writeJson(projectFile(root, id), project)
  return project
}

export async function saveProject(root, project) {
  project.updatedAt = new Date().toISOString()
  await writeJson(projectFile(root, project.id), project)
  return project
}

/** 把 notes/*.md 与结项摘要拼成一份正文，供提炼方案用。 */
export async function composeNotesBody(root, id, project) {
  const dir = dataPath(projectDir(root, id), 'notes')
  const chunks = []
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort()
    for (const name of files) {
      const text = await readFile(dataPath(dir, name), 'utf8')
      if (text.trim()) chunks.push(text.trim())
    }
  } catch {
    // 没有 notes 目录
  }
  if (project?.summary) chunks.push(`## 结项摘要\n\n${project.summary}`)
  return chunks.join('\n\n---\n\n')
}

/** 项目认可的样卡，提炼方案时一并带过去。 */
export async function collectSamples(root, id) {
  const dir = dataPath(projectDir(root, id), 'samples')
  const samples = []
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue
      samples.push({ name, content: await readFile(dataPath(dir, name), 'utf8') })
    }
  } catch {
    // 没有 samples 目录
  }
  return samples
}
