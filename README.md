# Anki Assistant

DeepSeek Harness（DSH）的一个 Preset：用「方案」批量制作 Anki 卡片。

方案规定怎么出题、答案怎么写、什么算错；工具负责校验、生成计划、写入 Anki、回读核对、渲染预览。所有数据存在本地，中断后可以接着做。

当前版本 0.12.1，MIT 协议。

## 要求

- Node.js >= 22.19
- DeepSeek Harness >= 0.2.2-rc.3 < 0.3.0
- Anki + [AnkiConnect](https://ankiweb.net/shared/info/2055492159)（写入卡片、渲染真实模板时需要）
- Python 3（可选，方案自带校验器时需要）
- Microsoft Edge（可选，导出 PNG / PDF 时需要）

## 安装

```bash
npm install --omit=dev
dsh plugin install --profile desktop .
```

也可以在 DSH 的插件管理里选择本目录安装。

安装后重启 Desktop，新开会话时选择 **Anki Assistant**。只有这个 Preset 的会话能看到下面的工具，其他会话不受影响。

安装后自检：

```bash
npm test                 # 124 个测试
scheme list              # 空数据目录是正常的
```

## 配置

在 profile 的 preset 配置里（`preset-anki-assistant` 下 `anki-assistant` 那一行的 `config`），或者用插件设置界面：

```yaml
dataDir: "C:/Users/you/.dsh/anki-assistant"
ankiUrl: "http://127.0.0.1:8765"
ankiExe: "C:/Program Files/Anki/anki.exe"   # 可选，默认自动查找
autoLaunchAnki: true                        # Anki 没开时自动启动
python: "python -X utf8"                    # 方案脚本需要 Python 时
trustedSchemeVersions:                      # 外部/旧方案脚本需要显式授权
  - medical-qac-2026@5
```

只写需要的项，其余用默认值。改完重启 Desktop。

## 快速开始

先导入一个示例方案（安装包不带方案，示例在仓库 `examples/` 里）：

```bash
scheme import path=<repo>/examples/schemes/qac-memory
scheme get id=qac-memory
```

然后做一批卡：

```bash
batch open batch=demo scheme=qac-memory deck=药理学 model="QAC 问答挖空 v4（国标引用）"
# model 填你 Anki 里实际存在的笔记类型名称
batch put batch=demo items=[{ id:'c1', fields:{ 问题:'…', 答案:'{{c1::…}}' } }]
batch validate batch=demo
card_write plan batch=demo mode=add
card_write commit plan=<计划 id>
card_write verify plan=<计划 id>
card_preview batch=demo png=true
```

从零写自己的方案：

```bash
scheme save id=my-cards status=draft deliverable=method body="…"
scheme test id=my-cards
# 做几张真卡，把样卡和判据放进方案目录后再转 active
```

## 工具

| 工具 | 作用 |
|---|---|
| `scheme` | 方案：`list` / `get` / `save` / `derive` / `import` / `test` / `prune` / `delete` |
| `project` | 项目：`open` / `list` / `get` / `update` / `close` / `to-scheme` / `delete` |
| `practice` | 运行记录：`list` / `get` / `save` / `delete` |
| `batch` | 批次：`open` / `put` / `validate` / `fix` / `next` / `mark` / `status` |
| `materials` | 读资料，返回 `p页:L行` 定位 |
| `card_write` | `plan` / `commit` / `verify` / `delete` |
| `card_preview` | 渲染 HTML / PNG / PDF，检测横向溢出 |

## 数据

默认在 `~/.dsh/anki-assistant`：

```
schemes/<id>/    方案记录、正文、版本化附件
batches/         批次台账
plans/           计划与提交回执
practices/       运行记录
projects/<id>/   项目现场
previews/        预览产物
audit/           Anki 写入审计
```

方案只写数据目录，不会写进插件安装目录。方案被批次或项目引用时不能删除；`scheme prune` 会保留被引用的版本。

## 和 Anki MCP、Skill 的关系

- **Anki MCP** 提供通用的 Anki 读写通道；本插件自带 AnkiConnect 客户端，不需要额外配置 MCP。
- **Skill** 是给 Agent 看的方法说明，本身没有状态；本插件的方案是版本化文件，还带批次、计划、回执和校验。
- 两者可以一起用：Skill 提供经验，MCP 提供通用操作，本插件负责按方案生产并留下记录。

## 项目结构

```
index.js            装配：配置、存储、Anki 客户端、提示词
cordis.patch.yml    Preset 声明
lib/tools/          7 个工具
lib/                方案、批次、写入、渲染、资料、项目等实现
assets/             随包内容：skills/、print/
examples/           示例方案与实践，不随包
docs/               文档
test/               测试
scripts/            体检脚本（audit-schemes、check-workspace、verify-package）
```

## 安装包里有什么

`npm pack` 生成的文件（42 个，压缩约 80 kB）：

```
index.js  lib/  assets/  docs/  scripts/  locale/  icon.svg  cordis.patch.yml
README.md  LICENSE  CHANGELOG.md  CONTRIBUTING.md  package.json
```

不包含：`test/`、`examples/`、`dist/`、`screenshots/`、`__pycache__`。
可以用 `npm run verify:package` 检查包内容。

## 依赖

运行时依赖 `parse5`（预览 HTML 过滤）和 `proper-lockfile`（数据锁）；`pdfjs-dist` 是可选依赖，读取 PDF 时用。

安装需要能访问 npm registry。离线安装请先准备缓存。

## 升级注意

- 0.12 起写入计划格式为 v2，旧计划需要重新 `plan`；已有提交回执仍可 `verify`。
- 旧方案或外部方案的脚本默认不执行，需要在 `trustedSchemeVersions` 里加 `id@version`。
- 方案附件按版本存放（`versions/<n>/`），旧版本不会读到新判据。

## 协议

MIT，见 [LICENSE](LICENSE)。

## 文档

- [执行手册](docs/AGENT-BRIEF.md)
- [方案格式](docs/SCHEME-FORMAT.md)
- [设计说明](docs/DETAIL.md)
- [迁移指南](docs/MIGRATION.md)
- [示例](examples/README.md)
- [变更记录](CHANGELOG.md)
