# 执行 Agent 手册

给"拿到这个项目就要干活"的 Agent。三分钟读完，照着做。

## 0. 你在哪一层

- 这是 **DSH 插件**，不是 Anki 插件，也不是 MCP。
- 工具只在 **Preset「Anki Assistant」** 的会话里出现；其他会话看不到。
- 你写卡，AnkiConnect 落卡；方案决定方法，工具只做确定性的事。
- 数据目录：`%USERPROFILE%\.dsh\anki-assistant`（下称 `<dataDir>`），与安装包严格分开。

## 1. 开工检查

1. `card_preview` 或任何 Anki 调用能否连通？连不上先确认 Anki 已启动、AnkiConnect 已装。
2. `scheme list` 看有没有现成方案；有就 `scheme get`，别自己发明。
3. 要读资料就 `materials`；PDF 需要 `pdfjs-dist`，没装就提示用户。

## 2. 工具契约

| 工具 | 动作 | 关键参数 | 返回/语义 |
|---|---|---|---|
| `scheme` | list / get / save / import / test / delete | get/save: `id`；save: `scheme` + `body` + 可选 `files`；test: `id`；delete: `confirm`（active 需 `force`） | save 永远出新版本；delete 被批次钉住时拒绝 |
| `practice` | list / get / save / delete | save: `id`、`body`、`scheme`、`schemeVersion`、`modules`、`tags`；delete: `confirm` | 实践是真实运行记录，不是方案 |
| `batch` | open / put / validate / fix / next / mark / status | open: `batch`、`scheme`、`deck`、`model`；put: `items`；fix: `apply` | 批次台账在 `<dataDir>/batches` |
| `materials` | read / find | 文件路径；find 关键词 | 返回 `p页:L行`，可直接写进定位字段 |
| `card_write` | plan / commit / verify / delete | plan: `batch`、`mode`；commit: `plan`、`open`；delete: `notes`、`confirm` | 只写 ready；commit 幂等；verify 对照快照 |
| `card_preview` | 渲染 | `batch`/`plan`/`notes`；`png`、`split`、`pdf`、`pdfStyle`、`measure`、`open` | 产出 HTML/PNG/PDF；`measure` 报横向溢出 |

## 3. 一次任务的默认路径

- **单张卡 / 小改**：`scheme get` → 写字段 → `card_write plan` → 给用户看 → `commit` → `verify`。
- **一批卡**：`batch open` → `put` → `validate` → 修到 0 issue → `plan`（给用户看）→ `commit` → `verify` → `card_preview` 呈现。
- **只交文档**（问题集 / 答案 / 记忆指导）：不用 batch，按方案正文产出，`practice save` 记录一次运行。

## 4. 批次状态机

```
queued → ready → written
   ↓        ↓
blocked  failed/parked
```

- `validate` 只处理非 `written` 的题；命中问题记 `issues` 并保持非 ready。
- `plan` 只为 `ready` 的题出可写项；`blocked` 不写，并说明原因。
- `fix` 可把挖空内部的 `}}` 改成 `} }`；默认只报告，`apply=true` 才写回。
- 中断后重跑 `commit` 是安全的：先按标签找回已写的卡，再补剩下的。

## 5. 写入纪律

1. 写前必须 `plan`，把预览给用户；确认后再 `commit`。
2. 草稿、方案版本、目标牌组任何一处变了，旧计划作废，重新 `plan`。
3. `verify` 用提交快照比对，不以"现在应该长什么样"为准。
4. 删除要显式 `confirm=true`；Anki 删卡不可恢复，删前删后各读一次。
5. 判重键是方案的首字段；宁可停下问，也不要改名绕过。

## 6. 失败手册

| 现象 | 处理 |
|---|---|
| 连不上 Anki | 让用户启动 Anki / 装 AnkiConnect；只读功能仍可用 |
| Python 缺失（`旧判据未执行`） | 该方案的 Python 判据跑不了，明确报告，不降级为 JS 通过 |
| 没有 Edge | `card_preview` 只出 HTML，不出 PNG/PDF |
| 模型字段对不上 | `plan` 会报缺哪个字段，先建模型或换模型 |
| `cloze:BRACE` / `cloze:TAIL` | `batch fix` → `apply=true` → 重新 `validate` |
| 计划失效 | 重新 `plan`，不要手改 plan 文件 |
| 输出太长 | 只给摘要 + 文件路径，细节放预览里 |

## 7. 产物与呈现

- 预览落在 `<dataDir>/previews/`；渲染后把文件交给用户（`present`），不要只说"已生成"。
- 验收分两层：测试通过是工程层；给用户看真实卡是用户层，缺一不可。
- Anki 没开时说明取不到，并用最近一次真实渲染代替，不拿示意图冒充。

## 8. 不要做

- 不要手改 `<dataDir>` 里的批次 / 计划 / 审计文件；用工具。
- 不要跳过 `plan` 直接 `commit`；不要为通过检查改断言。
- 不要把"生成成功 / 校验通过 / 写入成功"当成学习效果成立。
- 不要把用户数据塞进安装包或提交进 git。

## 9. 版本

- 插件 `0.7.2`；DSH `0.2.2-rc.3`；Node `>=22.19`。
- 方案格式见 [SCHEME-FORMAT.md](SCHEME-FORMAT.md)，设计取舍见 [DETAIL.md](DETAIL.md)。
