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
  scheme.json 与附件作为一个版本快照由插件存入 versions/<version>/
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
    "rules": [{ "id": "cite-required", "field": "问题", "kind": "required" }],
    "validator": { "suite": "gaoshu-steps", "module": "validate.mjs", "checks": ["CLOZE", "STEPS"] },
    "rubric": "条件与限定语不得省略；一步只做一次变形"
  },
  "acceptance": { "criteria": "先出 2–3 张样卡确认写法" },
  "limits": ["未接管字当量"],
  "origin": { "kind": "induced", "ref": "某次会话" }
}
```

## 方案不是先写出来的

读到一篇文章、一个策略，先不要把它打扮成方案。按产出量分三级：

1. **素材**：原文、链接、摘录，原样放着，要引用时再说。
2. **方法草稿**（`deliverable: "method"`）：只给 id、title 和正文，不需要字段、规则、样卡。
   它就是一张"我觉得可以这么做"的便条，零成本；`scheme list` 会标成「方法草稿」。
3. **卡片方案**（`deliverable: "cards"`）：已经用它做过 2–3 张真卡，样卡进了 `samples/`，
   规则写成 `quality.rules` 或 `validate.mjs`。

升级的门槛只有一个：**有没有真实产出**。没有卡片的草稿不升 cards，也不假装自己是方案。
这样读文章不会变成表面工程，方案也总是带着证据。

## 三条硬约定

1. **默认只增不改**。`scheme save` 先写齐该版附件，再切换当前版本。`scheme prune` 保留当前及被批次、项目引用的版本，需 `confirm=true`。
2. **钉住版本**。批次和项目记录 `{id, version}`。工具按同一版本读取正文、样卡、样式和判据。
3. **判据随方案**：`validate.mjs` 与 `vendor/` 放在方案目录里，换掉方案，判据一起消失。

## 模块边界（v1 定稿）

方案模块只做三件事：**存、取、测**。边界内的不变量：

1. 方案 = 不可变版本记录 + 目录附件；id 规范化；状态 `draft` / `active` / `deprecated`。
2. 两种形态：`method`（知识，可只有正文）与 `cards`（生产契约，必须有模型与字段）。
3. 机器只读四样：`scheme.json`、`body.md`、校验器模块、`print.css`；其余文件自由。
4. 批次钉 `{id, version}`；改方案不影响在跑批次。
5. 校验器契约为 `validate(fields, options) → { suite, ok, issues, source }`。外部或旧版脚本需由用户在 `trustedSchemeVersions` 中授权对应版本。
6. 测试契约：优先 `test/run.mjs`，否则 `validate.mjs` + `samples/`；都没有时如实报「无测试」。
7. 系统提示词只放索引（`id@version title 类型`），正文按需 `scheme get`，不整段塞进上下文。

不在方案模块里：任务流程与阶段（Agent 决定）、判重与写入（`batch` / `card_write`）、学习效果验证（只能靠真实复习反馈）。

升级路径：素材 → `method` 草稿 → 真卡 + 样卡 + 判据 → `scheme test` 通过 → `cards` + `active`。

## 检查与修复

- 内置：`cloze:BRACE` 可用 `batch fix` 自动把挖空内部的 `}}` 改写成 `} }`；默认只报告，`apply=true` 才写回，改完重跑 `validate`。
- 挖空字段由方案决定：优先 `role: "content"` 且不是「问题」的字段，其次名为「答案」，再看 `spec` 是否写了「挖空」；不写死字段名。
- 方案可自带检查/修复脚本（`scripts/`），例如台账对账、重算要点数、批量改写；由 Agent 调用，插件不自动执行。
- 能用确定性脚本修的，就不要留给用户手工改；修完必须重新校验并重新呈现。

## 写一个新方案的顺序

1. 想清三件事：这张卡要回忆什么、答案是什么结构、什么算错。
2. 写 `body.md`：适用场景、步骤、硬性要求、正例、反例、什么时候停。
3. 填 `scheme.json`：卡片模型、字段与角色、能用规则表达的检查。
4. 做两张样卡：一张能过、一张该被拦（`samples/pass.json`、`fail.json`）。
5. 能形式化的检查写进 `validate.mjs`；不能的写进 `quality.rubric` 由人判断。
6. `scheme test id=…`：优先跑方案目录的 `test/run.mjs`，否则用 `validate.mjs` 跑 `samples/` 的样卡与反例；不通过不算完成。
7. `scheme save`（可带 `files` 写附件），状态先 `draft`。
8. 用 2–3 张真实内容验证写法，确认后再批量；用户认可后转 `active`。

## 样卡渲染

方案不能只有 JSON 样卡。保存后用真实模型渲染一张：

```
card_preview scheme=<id> sample=pass png=true
```

- 模板与 CSS 来自 Anki 的 note type（`output.model`），**方案目录不放卡片模板文件**；
- 渲染结果按版本放到方案的 `samples/render/v<N>/`，例如 `pass.png` 和 `pass.html`。
- 没有这张图，方案交付不算完成。

## 从外部文件起一个方案

```bash
scheme derive id=gaoshu-from-articles title="从两篇文章来的数学卡方案" \
  sources=["notes/a.md", "notes/b.md"]
```

把外部文本按「来源标题 + 原文」拼成正文骨架，存成 `method` 草稿。它**只做汇总，不做提炼**；
随后用 `scheme save` 出新版本，把真正可执行的部分写清楚，补样卡、判据与字段。

## 从项目提炼

项目（`project` 工具）是一次任务的现场：目标、资料、批次、决策记录、认可的样卡。
跑通之后用 `project to-scheme` 把 `notes/` 与 `samples/` 提炼成 `draft` 方案，再补：

1. `output.model` / `output.fields`；
2. 把规则整理进 `quality.rules` 或 `validate.mjs`；
3. 一张能过、一张该被拦的样卡，`scheme test` 通过后转 `cards` + `active`。

不要跳过项目直接写方案：没有真卡与决策记录，方案容易变成空壳。

## 分享

把整个方案目录拷给别人即可（`scheme.json` + 正文 + 样卡 + 判据 + 样式）。

- 仓库示例放 `examples/schemes/`，**不随包分发**；用户按需 `scheme import`；
- 给某个人：让对方用 `scheme import path=<目录>` 导入，插件会：
  1. 读 `scheme.json`，把 id 规范成可当目录名的形式（小写、空格与标点变连字符，保留中英文）；
  2. 正文及附件保存到 `<dataDir>/schemes/<id>/versions/<version>/`。
  3. 缺省状态为 `draft`。`scheme get` 返回附件目录和清单。脚本在宿主用户按版本授权后启用。
- 同名方案可用 `upgrade=true` 导入新版本。分享已保存的方案时，使用 `scheme get` 返回的 `assetDir`。
