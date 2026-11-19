# 方案的结构

方案不是一段提示词，而是一个**目录 + 一份记录**。记录给机器读，目录里的文件给人读、给 Agent 按需读、给校验器执行。

## 最小方案

```
<scheme-id>/
  scheme.json     必须。机器读：字段、模型、规则、校验器
  body.md         必须。主文档：什么时候用、怎么做、正反例
```

两个文件就能用。其余都是可选的加固。

## 完整目录约定

```
<scheme-id>/
  scheme.json         必须。方案记录
  body.md             必须。做法正文；scheme get 原样返回
  evidence.md         建议。依据台账：每条规则从哪来、哪里依据不足
  checks.md           建议。判据对照：检查码 ↔ 实现 ↔ 证据
  samples/
    pass.json         建议。合格样卡（能通过全部检查）
    fail.json         建议。反例（必须被预期检查码拦住）
    render/           可选。渲染截图或 HTML，供人看观感
  test/
    run.mjs           建议。一条命令跑完样卡与反例
    entry.mjs         可选。真实调用插件入口的测试
  validate.mjs        可选。方案自带校验器（JS 或转调 Python）
  scripts/            可选。方案专用脚本（统计、批量导出、对比）
  vendor/             可选。原码与依赖（如医学方案的 Python 判据）
  notes/              可选。经验、设计假设、哲学、案例、实验日志
  print.css           可选。该方案的打印样式
  body.v<N>.md        自动生成。历史正文快照，不要手改
```

## 哪些是承重的

| 内容 | 谁读 | 缺失时 |
|---|---|---|
| `scheme.json` | 插件：字段、模型、规则、校验器 | 无法登记 |
| `body.md` | `scheme get` 返回给 Agent | 能跑，但没有方法可依 |
| `validate.mjs` | 插件按 `quality.validator.module` 加载 | 明确报错，不退回 JS |
| `print.css` | `card_preview` 打印时自动叠加 | 用内置版式 |
| 其余文件 | 人和 Agent 按需读 | 不影响执行 |

**自由内容**（`notes/`、`evidence.md`、`scripts/`、`samples/`、`vendor/`）不会被自动加载。`scheme get` 会返回目录清单（路径 + 大小），由 Agent 判断要不要读。

## scheme.json 的关键字段

```json
{
  "id": "gaoshu-steps",
  "title": "数学推导·一步一动作",
  "status": "draft",
  "revision": 1,
  "deliverable": "cards",
  "appliesTo": { "cardTypes": ["定理与公式", "推导"], "subjects": ["高等数学"] },
  "inputs": [{ "kind": "textbook", "required": true }],
  "output": {
    "model": "QAC 问答挖空 v4（国标引用）",
    "template": "qac-v4",
    "fields": [{ "name": "问题", "role": "content", "spec": "……", "required": true }],
    "print": { "style": "answer" }
  },
  "quality": {
    "rules": [{ "id": "cite-required", "field": "引用", "kind": "required" }],
    "validator": { "suite": "gaoshu-steps", "module": "validate.mjs", "checks": ["CLOZE", "STEPS"] },
    "rubric": "条件与限定语不得省略；一步只做一次变形"
  },
  "acceptance": { "criteria": "先出 2–3 张样卡确认写法" },
  "limits": ["未接管字当量"],
  "origin": { "kind": "induced", "ref": "某次会话" }
}
```

## 三条硬约定

1. **只增不改**：`scheme save` 永远生成新版本，旧版本与旧正文（`body.v<N>.md`）保留。
2. **批次钉版本**：批次记录 `{id, version}`，改方案不影响正在跑的批次。
3. **判据随方案**：`validate.mjs` 与 `vendor/` 放在方案目录里，换掉方案，判据一起消失。

## 写一个新方案的顺序

1. 想清三件事：这张卡要回忆什么、答案是什么结构、什么算错。
2. 写 `body.md`：适用场景、步骤、硬性要求、正例、反例、什么时候停。
3. 填 `scheme.json`：卡片模型、字段与角色、能用规则表达的检查。
4. 做两张样卡：一张能过、一张该被拦（`samples/pass.json`、`fail.json`）。
5. 能形式化的检查写进 `validate.mjs`；不能的写进 `quality.rubric` 由人判断。
6. 跑 `node <方案目录>/test/run.mjs`，确认样卡通过、反例被拦。
7. `scheme save`（可带 `files` 写附件），状态先 `draft`。
8. 用 2–3 张真实内容验证写法，确认后再批量；用户认可后转 `active`。

## 分享

把整个方案目录拷给别人即可（`scheme.json` + 正文 + 样卡 + 判据 + 样式）。

- 想成为所有人的默认内容：放进 `assets/schemes/`，提交发版；
- 只想给某个人：让对方把目录放进自己的 `<dataDir>/schemes/`；
- 目前没有一键导入命令，手工拷贝即可。
