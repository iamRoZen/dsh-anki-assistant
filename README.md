# Anki Assistant

一个**可选的 Agent 环境**（DeepSeek Harness Preset）：用「方案」驱动做 Anki 卡，把资料变成可检查、可续跑、可回查的卡片。

它不替你做判断。工具只做确定性的事——存方案、排队、校验、写入、回读、渲染；怎么取原文、怎么拆卡、怎么写记忆提示，由 Agent 与方案决定。

当前版本 `0.12.1`｜测试 124/124｜MIT

## 这是什么，不是什么

| 它是 | 它不是 |
|---|---|
| DSH 的一个 Preset，只有选中它的会话才看得到这些工具 | Anki 插件，不装进 Anki |
| 方案驱动的制卡工作台：方案、批次、计划、回读 | 通用 Anki 操作通道（那是 MCP 的事） |
| 本地运行，数据在 `~/.dsh/anki-assistant` | 云端服务，不需要上传教材或卡片 |
| 把「方法」存成可版本化、可测试的文件 | 提示词模板合集（那是 Skill 的事） |

### 和 Anki MCP、Skill 的区别

| | Anki MCP | Skill | 本项目 |
|---|---|---|---|
| 本质 | 通用 Anki 读写通道 | 给 Agent 看的方法说明 | 工具 + 状态 + 闸门 |
| 状态 | 无 | 无 | 方案版本、批次台账、计划、回执、审计 |
| 质量保证 | 靠调用方 | 靠模型自觉 | `validate` / `plan` / `commit` / `verify` / 渲染检查 |
| 可复现 | 每次重新讲 | 每次重新读 | `scheme get` 恢复标准，批次断点续跑 |
| 依赖 | 单独配置的 MCP server | 无 | 自带 AnkiConnect 客户端，不依赖 MCP 配置 |

三者可以共存：Skill 提供方法，MCP 提供通用操作，本插件提供"按方案生产"的流水线与记录。只做一次性卡片时，MCP + Skill 就够了；要重复做、要一致、要能过两周接着做，才需要这一层。

## 功能

- **方案**：版本化（`v1.json`、`v2.json`…），正文、样卡、判据、依赖随版本归档；`prune` 清理旧版（保留被批次/项目引用的版本）。
- **项目**：一次任务的现场（目标、资料、批次、决策记录、样卡），跑通后可 `to-scheme` 提炼成方案草稿。
- **批次**：逐题状态机（`queued → ready → blocked/written`），断点续跑。
- **写入闸门**：`plan` 只列可写题 → `commit` 幂等写入并落快照 → `verify` 回读；重试复用回执，不覆盖已有结果。
- **资料定位**：PDF 按页重建行，返回 `p页:L行`，可直接写进定位字段。
- **渲染验收**：按 Anki 模型真实模板 + CSS + MathJax 渲染 HTML/PNG/PDF，检测横向溢出；方案样卡可单独渲染。
- **并发安全**：数据目录加锁，方案版本与批次提交串行化，避免并发覆盖与重复写卡。
- **安全门**：外部/旧版方案脚本需在 `trustedSchemeVersions` 显式授权才会执行；预览 HTML 经过白名单过滤。
- **依赖预检**：方案目录的 `requirements.txt` 在 `scheme test` 时检查，缺包明确报错，不自动安装。
- **子 Agent**：大任务可按节拆分，一个批次一个 owner；主 Agent 预建牌组/模型并收口。

## 项目结构

```
anki-assistant/
  index.js               装配：settings / store / anki / boot / 提示词段
  cordis.patch.yml       Preset 声明：persona、通用工具、本插件
  lib/
    tools/               7 个工具：scheme、project、practice、batch、materials、card_write、card_preview
    store.js             原子 JSON 存储 + 数据锁，损坏文件隔离
    scheme.js            方案：校验、版本、版本化附件、prune、信任门
    batch.js             批次状态机
    write.js             计划、提交、回执、回读（计划格式 v2）
    anki.js              AnkiConnect 客户端 + 自动拉起 Anki
    materials.js         PDF 按页重建行
    preview.js           真实模板渲染 / PNG / PDF / 溢出检测
    project.js           项目目录
    library.js           方案正文、模板、实践库读写
    paths.js             数据目录路径与链接防护
    rules.js / validators.js / cloze.js   机械规则与挖空检查
  assets/                随包：skills/（技能）、print/（打印样式）
  examples/              仓库示例，不打包：schemes/、practices/、templates/
  docs/                  执行手册、方案格式、设计取舍、迁移
  scripts/               体检与清理（audit-schemes、check-workspace、verify-package）
  test/                  根测试；方案自带测试在各自目录
```

## 安装包结构

`npm pack` 产物（当前 42 个文件，压缩约 82 kB）：

```
index.js  lib/  assets/  docs/  scripts/  locale/  icon.svg  cordis.patch.yml
README.md  LICENSE  CHANGELOG.md  CONTRIBUTING.md  package.json
```

**不包含**：`test/`、`examples/`、`dist/`、`screenshots/`、`__pycache__`。`npm run verify:package` 会检查这些边界。

## 安装

要求：Node `>=22.19`，DSH `>=0.2.2-rc.3 <0.3.0`。

```bash
npm install --omit=dev
dsh plugin install --profile desktop .     # 或在 GUI 插件管理里安装本目录
```

- 链接安装：改源码后**重启 Desktop** 生效，不用重装；
- 安装后在**新会话**里选 Preset「Anki Assistant」；
- 自检：`npm test` 应 124/124；`scheme list` 能列出方案（空数据目录属正常）；`card_preview` 能出图。

### 配置

写在 profile 的 preset 配置里（`preset-anki-assistant` 下 `anki-assistant` 那一行的 `config`），或用 GUI 的插件设置：

```yaml
dataDir: "C:/Users/you/.dsh/anki-assistant"
ankiUrl: "http://127.0.0.1:8765"
ankiExe: "C:/Program Files/Anki/anki.exe"   # 可选；不填则探测常见位置
autoLaunchAnki: true                        # Anki 没开时自动拉起
python: "python -X utf8"                    # 方案脚本用到 Python 时
trustedSchemeVersions:                      # 外部/旧版方案脚本的显式授权
  - medical-qac-2026@5
```

改完重启 Desktop。

### 预载示例（可选）

包内不带方案。示例在仓库 `examples/`，需要时导入：

```bash
scheme import path=<repo>/examples/schemes/qac-memory
scheme import path=<repo>/examples/schemes/gaoshu-steps
```

## 使用

### 从零写一个方案

```
scheme save id=my-cards status=draft deliverable=method body=…
# 做几张真卡，把认可的样卡与判据放进方案目录
scheme test id=my-cards
# 通过后转 cards + active
```

### 批量做卡

```
scheme get id=<方案>
batch open batch=<批次> scheme=<id>@<version> deck=<牌组> model=<模型>
batch put batch=<批次> items=[{ id, fields }]
batch validate batch=<批次>
card_write plan batch=<批次> mode=add
card_write commit plan=<计划>
card_write verify plan=<计划>
card_preview batch=<批次> png=true measure=true
```

`present` 把渲染结果交给用户；没有渲染图不算交付。

### 预览与打印

- `card_preview`：整批长图、逐张 PNG、A4 PDF；`measure` 报横向溢出；
- `card_preview scheme=<id> sample=pass`：按方案模型的真实模板渲染样卡，落到 `samples/render/`；
- 预览只接受白名单 HTML 与 `data:` 图片（安全取舍）。

### 升级注意

- 0.12 起计划格式为 v2：**旧计划需要重新 `plan`**；已有提交回执仍可 `verify`；
- 旧方案/外部方案的脚本默认不执行，需在 `trustedSchemeVersions` 加 `id@version`；
- 方案附件按版本归档（`versions/<n>/`），旧版本不会读到新判据。

## 工具

| 工具 | 动作 |
|---|---|
| `scheme` | `list` / `get` / `save` / `derive` / `import` / `test` / `prune` / `delete` |
| `project` | `open` / `list` / `get` / `update` / `close` / `to-scheme` / `delete` |
| `practice` | `list` / `get` / `save` / `delete` |
| `batch` | `open` / `put` / `validate` / `fix` / `next` / `mark` / `status` |
| `materials` | 按 `path` 读、按 `keyword` 只返回命中行 |
| `card_write` | `plan` / `commit` / `verify` / `delete` |
| `card_preview` | 渲染 HTML / PNG / 逐张 / PDF，`measure` 检测溢出 |

## 数据

```
~/.dsh/anki-assistant/
  schemes/<id>/        v1.json、active.json、body.md、versions/<n>/
  batches/             批次台账
  plans/               计划（<plan>.json）与提交回执（<plan>.commit.json）
  audit/anki.jsonl     Anki 写入审计
  previews/            预览产物
  practices/           运行记录
  projects/<id>/       项目现场
```

方案只写数据目录，不写插件安装目录；`scheme delete` / `prune` 都会保留被批次或项目引用的版本。

## 依赖

| 依赖 | 说明 |
|---|---|
| Node `>=22.19` | 运行时 |
| DSH `>=0.2.2-rc.3 <0.3.0` | Host |
| `parse5` | 预览 HTML 白名单过滤 |
| `proper-lockfile` | 数据目录锁 |
| `pdfjs-dist`（可选） | 读取 PDF 时用 |
| Anki + AnkiConnect | 写入与渲染真实模型时 |
| Python（可选） | 方案自带校验器；缺包由 `requirements.txt` 预检 |
| Edge（可选） | PNG/PDF 渲染；没有 Edge 只出 HTML |

安装需要能访问 npm registry；离线环境请先准备缓存或换 vendored 依赖。

## 开源协议

MIT，见 [LICENSE](LICENSE)。

## 发布状态

- 测试 124/124；`npm run verify:package` 通过；
- 真机 `plan → commit → retry → verify` 已通过（临时牌组，跑完清理）；
- 本机 Edge 实测生成 PNG / PDF 并返回溢出检测；
- 发布前还需：去掉 `package.json` 的 `"private": true`（仅当发 npm）、确认包名、把 GitHub 仓库设为 public。

## 文档

- [执行 Agent 手册](docs/AGENT-BRIEF.md)：开工检查、工具契约、批次状态机、失败手册、并发约定
- [方案格式](docs/SCHEME-FORMAT.md)：目录结构、不变量、写作顺序、分享方式、依赖声明
- [设计取舍](docs/DETAIL.md)：为什么这样分层、为什么判据归方案
- [迁移指南](docs/MIGRATION.md)：旧方案升级、信任授权、计划重做
- [示例方案](examples/README.md)｜[贡献指南](CONTRIBUTING.md)｜[变更记录](CHANGELOG.md)

## 边界

- 语义判据（"答案是否忠于原文"）不由插件实现，只能由人或方案负责；
- 不自动安装 Python 包，不替用户改环境；
- 不保证没有 Anki 时的写入，只保证失败明确；
- 预览不是像素级 Anki 渲染，模板 JS 与媒体不执行。
