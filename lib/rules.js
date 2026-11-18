/**
 * 规则引擎：只做"字段是否符合方案规范"的机械判断。
 *
 * 语义对错不在这里判——那是 Agent 与方案的 rubric 的事。
 */

const KINDS = {
  required: {
    message: '不能为空',
    test: (value) => value !== undefined && value !== null && String(value).trim() !== '',
  },
  maxLength: {
    message: (rule) => `不能超过 ${rule.value} 字`,
    test: (value, rule) => [...String(value ?? '')].length <= Number(rule.value),
  },
  startsWith: {
    message: (rule) => `应以「${rule.value}」开头`,
    test: (value, rule) => String(value ?? '').startsWith(String(rule.value)),
  },
  endsWith: {
    message: (rule) => `应以「${rule.value}」结尾`,
    test: (value, rule) => String(value ?? '').endsWith(String(rule.value)),
  },
  matches: {
    message: (rule) => `应匹配 /${rule.value}/`,
    test: (value, rule) => new RegExp(String(rule.value), 'u').test(String(value ?? '')),
  },
  forbids: {
    message: (rule) => `不应出现 /${rule.value}/`,
    test: (value, rule) => !new RegExp(String(rule.value), 'u').test(String(value ?? '')),
  },
  oneOf: {
    message: (rule) => `应为 ${(rule.value ?? []).join(' / ')} 之一`,
    test: (value, rule) => (rule.value ?? []).includes(String(value ?? '')),
  },
}

function targets(rule) {
  if (rule.field) return [rule.field]
  return Array.isArray(rule.fields) ? rule.fields : [rule.fields]
}

/**
 * 对一个 item 的字段求值。
 * @returns {{ ruleId: string, field: string, message: string }[]}
 */
export function evaluate(fields, rules = []) {
  const issues = []
  for (const rule of rules) {
    const kind = KINDS[rule.kind]
    if (!kind) continue
    for (const field of targets(rule)) {
      const value = fields?.[field]
      if (kind.test(value, rule)) continue
      const message = typeof kind.message === 'function' ? kind.message(rule) : kind.message
      issues.push({ ruleId: rule.id, field, message })
    }
  }
  return issues
}

/** 方案字段与目标笔记模型的字段是否对得上（顺序也管，判重键取第一个）。 */
export function compareFields(schemeFields, modelFields) {
  const issues = []
  const declared = schemeFields.map((field) => field.name)
  const missing = declared.filter((name) => !(modelFields ?? []).includes(name))
  if (missing.length > 0) {
    issues.push({ kind: 'model-fields', message: `笔记模型缺字段：${missing.join('、')}` })
  }
  if (modelFields && modelFields.length > 0 && declared[0] !== modelFields[0]) {
    issues.push({
      kind: 'dedupe-key',
      message: `方案首个字段「${declared[0]}」不是模型首字段「${modelFields[0]}」，判重键不一致`,
    })
  }
  return issues
}

export function ruleKinds() {
  return Object.keys(KINDS)
}
