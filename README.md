# Anki Assistant

方案驱动的 Anki 制卡助手。工具只做确定性的事：存方案、排队、校验、写入、回读。
判断（怎么取原文、怎么拆卡、怎么写记忆提示）留给 Agent 与本 skill。

## 工具

| 工具 | 作用 |
|---|---|
| `scheme` | 方案库：`list` / `get`（含正文与实践反查） / `save`（永远写新版本） |
| `practice` | 实践库：`list` 按方案/模块/标签筛选，`get` 读全文 |
| `batch` | 批次：`open`（同名再调用=改绑方案版本） / `put` / `validate` / `next` / `mark` / `status` |
| `materials` | 读资料并给出行号：PDF 按页重建行，可给关键词只取命中行 |
| `card_write` | 写入闸门：`plan`（add/update 预览） / `commit`（幂等） / `verify`（按提交快照回读） |

## 作用范围

安装后不会改变其他会话：工具、skill 与提示词都挂在 Agent Preset **Anki Assistant** 下，
只有选了该 preset 的会话才看得到。

## 依赖

| 依赖 | 必需 | 缺失时 |
|---|---|---|
| Anki + AnkiConnect | 写入必需 | 方案、批次、校验、预览仍可用；`commit` 与 `verify` 报错 |
| `pdfjs-dist`（可选依赖） | 读 PDF 必需 | `.txt` / `.md` 仍可读；读 PDF 时提示安装或先转换 |
| Python 3.10+ | 仅带旧判据的方案需要（如 `medical-qac-2026`） | 报「旧判据未执行」，不会退化成 JS 规则通过 |

方案专用的判据随方案目录分发（`assets/schemes/<id>/vendor/`，原码 + `PROVENANCE.md`），
插件只按 `quality.legacy.module` 加载方案自带的 `validate.mjs`；换掉这个方案，判据一起消失。
配置 `python:` 可指定解释器，默认 Windows 用 `python -X utf8`。

通用能力（方案、批次、资料读取、写入闸门）不需要 Python，也不需要本机脚本或 MCP 配置；只有**声明了旧判据的方案**（如 `medical-qac-2026`）需要 Python 3.10+ 来运行随包原实现。

## 配置

```yaml
- id: anki-assistant
  name: dsh-anki-assistant
  config:
    dataDir: "C:/Users/you/.dsh/anki-assistant"   # 数据目录，默认在 DSH 主目录下
    ankiUrl: "http://127.0.0.1:8765"              # AnkiConnect 端口
```

## 数据

```
<dataDir>/
  meta.json          数据版本
  schemes/<id>/      方案，一版本一文件，active.json 指向当前版本
  batches/<id>.json  批次台账
  plans/<id>.json    写入计划
  audit/anki.jsonl   写操作审计
```

数据目录与包目录严格分开；`npm pack` 的 `files` 白名单不含数据。

## 写入为什么不会重复

AnkiConnect 的批量写入在不同版本上行为不同（可能整批失败、也可能只报错不回滚）。
`commit` 不等返回值下结论：

1. 提交前用批次标签 `findNotes` 把已经写进去的卡找回来，先标记为已写；
2. 剩余的按块写入，整块失败就逐条重写，把原因落到具体题上；
3. `verify` 用 `notesInfo` 回读字段，和计划逐字比对。

因此中断后重跑 `commit` 是安全的。
