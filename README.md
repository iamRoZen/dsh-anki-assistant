# Anki Assistant

方案驱动的 Anki 制卡助手。工具只做确定性的事：存方案、排队、校验、写入、回读。
判断（怎么取原文、怎么拆卡、怎么写记忆提示）留给 Agent 与本 skill。

## 工具

| 工具 | 作用 |
|---|---|
| `scheme` | 方案库：`list` / `get` / `save`（永远写新版本） |
| `batch` | 批次：`open` / `put` / `validate` / `next` / `mark` / `status` |
| `materials` | 读资料并给出行号：PDF 按页重建行，可给关键词只取命中行 |
| `card_write` | 写入闸门：`plan`（只读预览） / `commit`（幂等写入） / `verify`（回读） |

## 依赖

| 依赖 | 必需 | 缺失时 |
|---|---|---|
| Anki + AnkiConnect | 写入必需 | 方案、批次、校验、预览仍可用；`commit` 与 `verify` 报错 |
| `pdfjs-dist`（可选依赖） | 读 PDF 必需 | `.txt` / `.md` 仍可读；读 PDF 时提示安装或先转换 |

不需要 Python，不需要本机脚本，不依赖任何 MCP 配置。

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
