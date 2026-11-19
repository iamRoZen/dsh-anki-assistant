# Anki Assistant

一个**可选的 Agent 环境**（Preset「Anki Assistant」）：用方案驱动做卡，工具只做确定性的事——
存方案、排队、校验、写入、回读、渲染。判断（怎么取原文、怎么拆卡、怎么写记忆提示）由 Agent 与方案决定。

## 目录

```
anki-assistant/
  index.js               插件入口：6 个工具、提示词段、方案启动登记
  cordis.patch.yml       Preset 声明：persona、通用工具、本项目插件
  lib/
    store.js             原子 JSON 存储，损坏文件隔离
    scheme.js            方案外壳：校验、不可变版本、seed
    library.js           资产播种：方案目录、模板、实践、print
    batch.js             批次状态机
    rules.js             7 种机械规则（JS）
    validators.js        规则实现：字当量、序号、表格、挖空
    cloze.js             挖空截断检查：BRACE / TAIL / UNCLOSED
    write.js             计划、提交、回读
    anki.js              AnkiConnect 薄客户端 + GUI 动作
    materials.js         PDF 按页重建行，返回页与行号
    preview.js           卡面渲染：真实模板 / CSS / MathJax / PNG / PDF
  assets/
    schemes/
      seed.json          两条种子方案记录
      qac-memory.md      种子方案正文（教材驱动）
      qac-exam.md        种子方案正文（题源驱动）
      medical-qac-2026/  自包含方案：记录 + 正文 + 样卡 + 测试 + 自带判据（vendor/）
      gaoshu-steps/      自包含方案：数学推导，纯 JS 校验器
      index.json         短索引，给人看与检索
    templates/qac-v4.md  可复用卡片模板
    practices/           实践库正文
    skills/              技能正文
    print/               打印样式示例（answer-compact.css、qa-serif.css）
  docs/ locale/ test/    说明、文案、测试
```

## 三层数据

| 层 | 位置 | 说明 |
|---|---|---|
| 包内 | `assets/` | 随包分发；首次安装复制到数据目录 |
| 数据 | `<dataDir>/schemes`、`batches`、`plans`、`audit`、`previews`、`practices`、`sources` | 用户资产与运行记录，**不打包** |
| Anki | AnkiConnect | 最终卡片 |

方案升级按 `revision`：包内更高时**追加新版本**，旧记录、旧正文保留，正在跑的批次不被改绑。

## 工具

| 工具 | 作用 |
|---|---|
| `scheme` | 方案库：`list` / `get`（正文、模板、实践、目录文件清单） / `save`（永远写新版本） / `import`（导入外来目录，自动规范 id） / `test`（跑方案自带测试或样卡） / `delete`（需确认；批次钉住时拒绝） |
| `practice` | 实践库：`list` / `get` / `save`（记录一次真实运行） / `delete`（需确认） |
| `batch` | 批次：`open` / `put` / `validate` / `fix`（修复挖空截断） / `next` / `mark` / `status` |
| `materials` | 读资料并给行号：PDF 按页重建行，可按关键词只取命中行 |
| `card_write` | 写入闸门：`plan`（add/update） / `commit`（幂等，可 `open=true` 在 Anki 打开） / `verify`（按快照回读） / `delete`（需确认，删除前后各读一次） |
| `card_preview` | 渲染预览：`png`、`split`（逐张）、`pdf`（A4）、`measure`（溢出检测） |

## 方案接口

方案是数据记录 + 方案目录里的文件，不是插件代码。完整目录约定与写作顺序见 [docs/SCHEME-FORMAT.md](docs/SCHEME-FORMAT.md)；拿到项目就要干活的话，先读 [docs/AGENT-BRIEF.md](docs/AGENT-BRIEF.md)。

- `scheme.json`：`id`、`status`、`deliverable`、`output.model` / `output.fields`、`quality.rules`、`quality.validator|legacy`、`revision`
- `body.md`：做法正文，`scheme get` 原样返回；方案目录里的 `body.v<N>.md` 是历史快照
- `samples/pass.json`、`samples/fail.json`：合格样卡与反例
- `validate.mjs`：方案自带校验器，导出 `validate(fields, options) → { suite, ok, issues, source }`；缺模块或异常都明确报错，不退回 JS 兜底
- `print.css`：该方案的打印样式，自动生效
- `assets/schemes/<id>/vendor/`：方案私有的原码与依赖（如 `medical-qac-2026` 的 Python 判据）

机械检查分两层：插件内置（字段、判重、挖空截断、方案规则）与方案自带（`validate.mjs`）。

## 质量闸门

1. `batch validate` 与 `card_write plan` 都会跑：方案规则 + 内置 cloze 检查 + 方案校验器；
2. 命中问题写进该题的 `issues`，状态标 `blocked`，`commit` 不会写；
3. 校验器缺失或异常 → 报「旧判据未执行」，不通过；
4. 出处核验需要 refdb，未配置时明确标「出处未核」，不当作失败，也不当作通过；
5. 计划绑定内容、方案版本与目标；草稿/版本/牌组任何一处变了，旧计划作废；
6. 方案没有任何校验规则时，`validate` 与 `plan` 都会提示「请人工逐张核对」。

## 渲染与打印

`card_preview` 用模型的真实 Front/Back 模板与 CSS 渲染，支持 MathJax：

- `png=true`：整批一张长图，高度随卡数增长；
- `split=true`：每张单独 PNG，便于 `read_image` 逐张看；
- `pdf=true`：A4 打印版，`pdfStyle` 选 `qa` / `question` / `answer`；
- `pdfCss`：自定义 CSS，文件路径或 `assets/print` 下的文件名；方案目录的 `print.css` 自动生效；
- `measure`：量横向溢出，回报「#3 div越界」这类文本，供 Agent 自动修正。

## 依赖

| 依赖 | 需要 | 缺失时 |
|---|---|---|
| Anki + AnkiConnect | 写入、预览 | 方案、批次、校验仍可用；`commit` / `verify` / `card_preview` 报错 |
| `pdfjs-dist`（可选） | 读 PDF | `.txt` / `.md` 仍可读 |
| Python 3.10+ | 仅声明旧判据的方案（如 `medical-qac-2026`） | 报「旧判据未执行」，不降级 |
| Microsoft Edge | PNG / PDF | 只出 HTML |

## 配置与安装

```yaml
- id: anki-assistant
  name: dsh-anki-assistant
  config:
    dataDir: "C:/Users/you/.dsh/anki-assistant"
    ankiUrl: "http://127.0.0.1:8765"
    python: "python -X utf8"        # 仅带旧判据的方案用到
```

安装后在**新会话**里选 Preset「Anki Assistant」；工具、技能与提示词都挂在 preset 下，其他会话不受影响。

## 测试

```bash
npm test                                   # 根测试：工具、方案、批次、写入、预览、方案入口
node assets/schemes/medical-qac-2026/test/run.mjs   # 方案独立复验
node assets/schemes/medical-qac-2026/test/entry.mjs # 两个入口的真实调用

npm run clean:temp                         # 列出本项目在 %TEMP% 留下的沙箱目录
npm run clean:temp -- --apply --older-than=24       # 删除 24 小时前的
```

测试与模拟脚本会在退出时清掉自建的临时目录；历史残留用 `clean:temp` 处理，只匹配 `anki-*`、`HeadlessEdge*`、`sim-*`。

## 边界

- 不实现语义判据（「答案是否忠于原文」由人或方案负责）；
- 不把用户数据打进 npm 包；
- 预览是模板级近似，不是 Anki 的完整运行时（模板 JS、媒体不执行）。
