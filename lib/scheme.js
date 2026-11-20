/**
 * 制卡方案：只增不改的版本化记录。
 *
 * 七项（适用场景/所需输入/各阶段方法/输出与字段/质量/验收/局限）各占一个字段，
 * 校验在这里做，写入前先过一遍。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listDirs, readJson, writeJson } from './store.js'

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
  if (!Number.isInteger(version) || version < 1) fail('version', '应为正整数')

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
    }    if (['maxLength', 'oneOf'].includes(rule.kind) && rule.value === undefined) {
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

function schemeDir(root, id) {
  return join(root, 'schemes', id)
}

function versionFile(root, id, version) {
  return join(schemeDir(root, id), `v${version}.json`)
}

function pointerFile(root, id) {
  return join(schemeDir(root, id), 'active.json')
}

/** 读取某方案的某一版；缺省读 active 指针。 */
export async function getScheme(root, id, version) {
  const safeId = normalizeSchemeId(id)
  if (!ID_PATTERN.test(safeId)) throw new SchemeError(`方案 id 不合法：${id}`)
  let target = version
  if (!target) {
    const pointer = await readJson(pointerFile(root, safeId))
    if (!pointer) return null
    target = pointer.version
  }
  return readJson(versionFile(root, safeId, target))
}

export async function listSchemes(root, { includeDrafts = false } = {}) {
  const ids = await listDirs(join(root, 'schemes'))
  const schemes = []
  for (const id of ids) {
    const scheme = await getScheme(root, id)
    if (!scheme) continue
    if (!includeDrafts && scheme.status === 'draft') continue
    schemes.push(scheme)
  }
  return schemes.sort((a, b) => a.id.localeCompare(b.id))
}

/** 写新版本：同 id 永不覆盖，只递增版本号。并发保存时用独占创建抢版本号。 */
export async function saveScheme(root, input) {
  const id = normalizeSchemeId(input.id)
  if (!ID_PATTERN.test(id)) throw new SchemeError(`方案 id 不合法：${input.id}`)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const existing = await listVersions(root, id)
    const version = existing.length === 0 ? 1 : Math.max(...existing) + 1
    const previous = existing.length === 0
      ? null
      : await readJson(versionFile(root, id, Math.max(...existing)))
    const scheme = validateScheme({
      ...input,
      // 薄信封的默认值：只给 body 的导入方案也有一条合法记录
      deliverable: input.deliverable ?? (input.output ? 'cards' : 'method'),
      appliesTo: input.appliesTo ?? {},
      inputs: input.inputs ?? [],
      methods: input.methods ?? [],
      limits: input.limits ?? [],
      origin: input.origin ?? { kind: 'authored' },
      quality: input.quality ?? { rules: [], rubric: '' },
      output: input.output ?? { model: '', fields: [] },
      version,
      // 版本历史随记录走：新版本继承旧版本的 changelog，再追加本次。
      changelog: [
        ...(previous?.changelog ?? []),
        { version, at: new Date().toISOString(), why: input.changeWhy ?? '未注明' },
      ],
    })
    try {
      await writeExclusive(versionFile(root, id, version), scheme)
      await writeJson(pointerFile(root, id), { version, updatedAt: new Date().toISOString() })
      return scheme
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // 另一个写入者刚抢到这个版本号，重算后重试
    }
  }
  throw new SchemeError(`方案 ${id} 连续 6 次抢版本号失败，可能写入过于频繁`)
}

/** 独占创建：文件已存在时抛 EEXIST，用于给并发保存分配不同版本号。 */
async function writeExclusive(file, value) {
  const { open } = await import('node:fs/promises')
  await mkdirSyncFor(file)
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

async function mkdirSyncFor(file) {
  const { mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(file), { recursive: true })
}

export async function listVersions(root, id) {
  const { readdir } = await import('node:fs/promises')
  try {
    const files = await readdir(schemeDir(root, id))
    return files
      .map((name) => /^v(\d+)\.json$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}
