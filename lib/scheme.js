/**
 * 制卡方案：只增不改的版本化记录。
 *
 * 七项（适用场景/所需输入/各阶段方法/输出与字段/质量/验收/局限）各占一个字段，
 * 校验在这里做，写入前先过一遍。
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { dataPath, pathSegment, relativeParts } from './paths.js'
import { listDirs, readJson, withStoreLock, writeJson } from './store.js'

const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,40}$/u
const STATUS = ['draft', 'active', 'deprecated']
const DELIVERABLES = ['cards', 'question-set', 'answers', 'guidance', 'method']
const RULE_KINDS = ['required', 'maxLength', 'startsWith', 'endsWith', 'matches', 'forbids', 'oneOf', 'lengthOf',
  'weightOf', 'weight', 'ordinal', 'lineLimit', 'tableCells', 'clozeShape']

/** 把任意名字收成可当目录名的 id：小写、空格与标点变连字符、保留中英文与数字、41 位以内。 */
export function normalizeSchemeId(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
}

export class SchemeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SchemeError'
  }
}

function fail(path, message) {
  throw new SchemeError(`方案字段 ${path}：${message}`)
}

function checkString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(path, '应为字符串')
  if (!allowEmpty && value.trim() === '') fail(path, '不能为空')
}

function checkArray(value, path, { min = 0 } = {}) {
  if (!Array.isArray(value)) fail(path, '应为数组')
  if (value.length < min) fail(path, `至少需要 ${min} 项`)
}

/** 方案完整校验；抛出的消息要能直接告诉作者改哪一项。 */
export function validateScheme(scheme) {
  if (scheme === null || typeof scheme !== 'object') throw new SchemeError('方案应为对象')

  scheme.id = normalizeSchemeId(scheme.id)
  if (!ID_PATTERN.test(scheme.id)) fail('id', '规范化后仍不合法：只允许中英文、数字与连字符，41 位以内')
  checkString(scheme.title, 'title')
  if (!STATUS.includes(scheme.status)) fail('status', `应为 ${STATUS.join(' / ')}`)
  const version = scheme.version
  if (!Number.isSafeInteger(version) || version < 1) fail('version', '应为正整数')

  // 薄信封：除 id/title/status/version 外都可省略。
  // 从网上拿来的自然语言提示词，只给 body 也能存成 deliverable=method 的方案。
  const deliverable = scheme.deliverable ?? (scheme.output ? 'cards' : 'method')
  if (!DELIVERABLES.includes(deliverable)) {
    fail('deliverable', `应为 ${DELIVERABLES.join(' / ')}`)
  }

  const appliesTo = scheme.appliesTo ?? {}
  if (appliesTo === null || typeof appliesTo !== 'object') fail('appliesTo', '应为对象')
  for (const key of ['cardTypes', 'subjects', 'materials']) {
    if (!Array.isArray(appliesTo[key] ?? [])) fail(`appliesTo.${key}`, '应为字符串数组')
  }

  checkArray(scheme.inputs ?? [], 'inputs')
  for (const [index, item] of (scheme.inputs ?? []).entries()) {
    checkString(item?.kind, `inputs[${index}].kind`)
    if (typeof item?.required !== 'boolean') fail(`inputs[${index}].required`, '应为布尔值')
  }

  checkArray(scheme.methods ?? [], 'methods')
  for (const [index, step] of (scheme.methods ?? []).entries()) {
    checkString(step?.stage, `methods[${index}].stage`)
    checkString(step?.how, `methods[${index}].how`)
  }

  const output = scheme.output ?? { model: '', fields: [] }
  if (output === null || typeof output !== 'object') fail('output', '应为对象')
  checkString(output.model, 'output.model', { allowEmpty: deliverable !== 'cards' })
  checkArray(output.fields ?? [], 'output.fields', { min: deliverable === 'cards' ? 1 : 0 })
  const names = new Set()
  for (const [index, field] of (output.fields ?? []).entries()) {
    checkString(field?.name, `output.fields[${index}].name`)
    if (names.has(field.name)) fail(`output.fields[${index}].name`, `重复：${field.name}`)
    names.add(field.name)
    checkString(field?.spec, `output.fields[${index}].spec`)
    if (field.role !== undefined && !['content', 'memory', 'locator', 'meta'].includes(field.role)) {
      fail(`output.fields[${index}].role`, '应为 content / memory / locator / meta')
    }
  }
  if (names.size === 0 && (scheme.quality?.rules ?? []).length > 0) {
    fail('quality.rules', '没有字段的方案不要写字段规则；把要求写进 rubric 或正文')
  }

  checkArray(scheme.quality?.rules ?? [], 'quality.rules')
  for (const [index, rule] of (scheme.quality?.rules ?? []).entries()) {
    checkString(rule?.id, `quality.rules[${index}].id`)
    if (!RULE_KINDS.includes(rule.kind)) {
      fail(`quality.rules[${index}].kind`, `应为 ${RULE_KINDS.join(' / ')}`)
    }
    const targets = rule.field ? [rule.field] : rule.fields
    if (!Array.isArray(targets) && typeof targets !== 'string') {
      fail(`quality.rules[${index}].field`, '需要 field 或 fields')
    }
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      if (!names.has(target)) fail(`quality.rules[${index}]`, `字段 ${target} 不在 output.fields 里`)
    }
    if (['maxLength', 'oneOf'].includes(rule.kind) && rule.value === undefined) {
      fail(`quality.rules[${index}].value`, `${rule.kind} 需要 value`)
    }
    if (rule.kind === 'lengthOf') {
      checkString(rule.sourceField ?? '', `quality.rules[${index}].sourceField`)
      if (!names.has(rule.sourceField)) {
        fail(`quality.rules[${index}].sourceField`, `字段 ${rule.sourceField} 不在 output.fields 里`)
      }
    }
    if (['startsWith', 'endsWith', 'matches', 'forbids'].includes(rule.kind)) {
      checkString(String(rule.value ?? ''), `quality.rules[${index}].value`)
    }
    if (['matches', 'forbids'].includes(rule.kind)) {
      try {
        new RegExp(String(rule.value), 'u')
      } catch {
        fail(`quality.rules[${index}].value`, '正则无效')
      }
    }
  }

  checkString(scheme.quality?.rubric ?? '', 'quality.rubric', { allowEmpty: true })
  if (!Array.isArray(scheme.limits ?? [])) fail('limits', '应为数组')
  if (scheme.origin !== undefined && (scheme.origin === null || typeof scheme.origin !== 'object')) {
    fail('origin', '应为对象')
  }
  return scheme
}

function checkedId(id) {
  const normalized = normalizeSchemeId(id)
  if (!ID_PATTERN.test(normalized)) throw new SchemeError('方案 id 不合法：' + id)
  return pathSegment(normalized, '方案 id')
}

function checkVersion(version) {
  if (!Number.isSafeInteger(version) || version < 1) throw new SchemeError('版本号应为正整数')
  return version
}

export function schemeDir(root, id) {
  return dataPath(root, 'schemes', checkedId(id))
}

function versionFile(root, id, version) {
  return dataPath(schemeDir(root, id), 'v' + checkVersion(version) + '.json')
}

function pointerFile(root, id) {
  return dataPath(schemeDir(root, id), 'active.json')
}

export function schemeAssetDir(root, scheme) {
  const dir = schemeDir(root, scheme.id)
  return scheme.versionedAssets === true
    ? dataPath(dir, 'versions', String(checkVersion(scheme.version)))
    : dir
}

export function schemeAssetFile(root, scheme, file) {
  return dataPath(schemeAssetDir(root, scheme), ...relativeParts(file))
}

export function withSchemeLock(root, id, work) {
  const name = checkedId(id)
  dataPath(root, 'schemes', '.locks', name + '.lock')
  return withStoreLock(dataPath(root, 'schemes', '.locks', name), work)
}

/** 读取指定版，省略版本时读取当前指针。 */
export async function getScheme(root, id, version) {
  const name = checkedId(id)
  const target = version ?? (await readJson(pointerFile(root, name)))?.version
  if (target === undefined) return null
  const record = await readJson(versionFile(root, name, target))
  return record?.id === name && record.version === target ? record : null
}

export async function listSchemes(root, { includeDrafts = false } = {}) {
  const ids = await listDirs(join(root, 'schemes'))
  const schemes = []
  for (const id of ids) {
    if (id.startsWith('.')) continue
    const scheme = await getScheme(root, id)
    if (!scheme) continue
    if (!includeDrafts && scheme.status === 'draft') continue
    schemes.push(scheme)
  }
  return schemes.sort((a, b) => a.id.localeCompare(b.id))
}

function reservedAsset(parts) {
  const [first, second] = parts.map((part) => part.toLowerCase())
  return ['.git', '.locks', 'versions', 'scheme.json', 'active.json'].includes(first)
    || /^(?:v\d+\.json|body\.v\d+\.md)$/u.test(first)
    || (first === 'samples' && second === 'render')
}

async function copyAssets(source, dest, relative = []) {
  const base = dataPath(source, ...relative)
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const name = [...relative, entry.name]
    if (reservedAsset(name) || ['__pycache__', 'node_modules'].includes(entry.name) || entry.name.endsWith('.pyc')) continue
    const to = dataPath(dest, ...name)
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      await copyAssets(source, dest, name)
    } else if (entry.isFile()) {
      await copyFile(dataPath(source, ...name), to)
    } else {
      throw new SchemeError('方案附件应为普通文件或目录：' + name.join('/'))
    }
  }
}

function checkAttachments(files) {
  return files.map((file) => {
    if (typeof file?.content !== 'string') throw new SchemeError('files 每项需要 path 与 content')
    let parts
    try {
      parts = relativeParts(file.path)
    } catch {
      throw new SchemeError('非法附件路径：' + file.path)
    }
    if (reservedAsset(parts)) throw new SchemeError('非法附件路径：' + file.path)
    return { parts, content: file.content }
  })
}

/** 暂存完整附件，再发布不可覆盖的版本记录和当前指针。 */
export async function saveScheme(root, input, { body, files = [], sourceDir, upgrade = false } = {}) {
  const id = checkedId(input.id)
  const attachments = checkAttachments(files)
  return withSchemeLock(root, id, async (assertLocked) => {
    const versions = await listVersions(root, id)
    const pointer = await readJson(pointerFile(root, id))
    const previous = await getScheme(root, id)
    if (sourceDir && previous && !upgrade) {
      throw new SchemeError('已有方案 ' + id + '（v' + previous.version + '）：要出新版本请加 upgrade=true，否则先换名')
    }

    const versionsDir = dataPath(schemeDir(root, id), 'versions')
    await mkdir(versionsDir, { recursive: true })
    const allocated = (await readdir(versionsDir))
      .filter((name) => /^\d+$/u.test(name)).map(Number).filter(Number.isSafeInteger)
    const version = Math.max(0, pointer?.lastVersion ?? 0, ...versions, ...allocated) + 1
    const last = versions.length ? await getScheme(root, id, versions.at(-1)) : null
    const scheme = validateScheme({
      ...input,
      title: sourceDir ? (previous?.title ?? input.title) : input.title,
      status: input.status ?? (sourceDir ? previous?.status ?? 'draft' : undefined),
      deliverable: input.deliverable ?? (input.output ? 'cards' : 'method'),
      appliesTo: input.appliesTo ?? {},
      inputs: input.inputs ?? [],
      methods: input.methods ?? [],
      limits: input.limits ?? [],
      origin: input.origin ?? { kind: sourceDir ? 'imported' : 'authored' },
      quality: input.quality ?? { rules: [], rubric: '' },
      output: input.output ?? { model: '', fields: [] },
      version,
      versionedAssets: true,
      codeTrusted: !sourceDir && (!previous || previous.codeTrusted === true),
      changelog: [
        ...(last?.changelog ?? []),
        { version, at: new Date().toISOString(), why: input.changeWhy ?? '未注明' },
      ],
    })
    const staging = await mkdtemp(join(versionsDir, '.staging-'))
    try {
      if (sourceDir || previous) await copyAssets(sourceDir ? resolve(sourceDir) : schemeAssetDir(root, previous), staging)
      if (previous && !sourceDir && previous.versionedAssets !== true) {
        const legacyBody = dataPath(schemeDir(root, id), 'body.v' + previous.version + '.md')
        if (existsSync(legacyBody)) await copyFile(legacyBody, dataPath(staging, 'body.md'))
      }
      for (const file of attachments) {
        const target = dataPath(staging, ...file.parts)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content, 'utf8')
      }
      if (typeof body === 'string') await writeFile(dataPath(staging, 'body.md'), body, 'utf8')
      const manifest = { ...scheme }
      for (const key of ['version', 'versionedAssets', 'codeTrusted', 'changelog', 'changeWhy']) delete manifest[key]
      await writeJson(dataPath(staging, 'scheme.json'), manifest)
      assertLocked()
      await rename(staging, schemeAssetDir(root, scheme))
      await writeJson(versionFile(root, id, version), scheme, { exclusive: true })
      await writeJson(pointerFile(root, id), { version, lastVersion: version, updatedAt: new Date().toISOString() })
      return scheme
    } finally {
      await rm(dataPath(versionsDir, basename(staging)), { recursive: true, force: true })
    }
  })
}

export async function removeSchemeVersion(root, id, version) {
  const dir = schemeDir(root, id)
  await rm(versionFile(root, id, version), { force: true })
  await rm(dataPath(dir, 'body.v' + version + '.md'), { force: true })
  await rm(dataPath(dir, 'versions', String(version)), { recursive: true, force: true })
}

export async function listVersions(root, id) {
  try {
    const files = await readdir(schemeDir(root, id), { withFileTypes: true })
    return files
      .filter((entry) => entry.isFile())
      .map((entry) => /^v(\d+)\.json$/u.exec(entry.name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
