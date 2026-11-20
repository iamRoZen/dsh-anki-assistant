# 执行 Agent 手册

给"拿到这个项目就要干活"的 Agent。三分钟读完，照着做。

## 0. 你在哪一层

- 这是 **DSH 插件**，不是 Anki 插件，也不是 MCP。
- 工具只在 **Preset「Anki Assistant」** 的会话里出现；其他会话看不到。
- 你写卡，AnkiConnect 落卡；方案决定方法，工具只做确定性的事。
- 数据目录：`%USERPROFILE%\.dsh\anki-assistant`（下称 `<dataDir>`），与安装包严格分开。

## 1. 安装与自检（新机器）

```bash
npm install --omit=dev
dsh plugin --profile desktop add .         # 或在 GUI 插件管理里安装本目录
```

- 链接安装：改源码后**重启 Desktop** 才加载新代码，不用重装。
- 自检四步：`npm test` 全部通过；新会话能选「Anki Assistant」；`scheme list` 能列出方案（数据目录为空属正常）；`card_preview` 能出图。
- 示例不随包：需要时 `scheme import path=<repo>/examples/schemes/<id>`。
- preset 不出现时依次查：profile `package.json` 里有没有 `link:`；`node_modules` 是不是 junction；`package.json` 是否带 UTF-8 BOM。

## 2. 开工检查

1. `card_preview` 或任何 Anki 调用能否连通？连不上先确认 Anki 已启动、AnkiConnect 已装。
2. `scheme list` 看有没有现成方案；有就 `scheme get`，别自己发明。
3. 要读资料就 `materials`；PDF 需要 `pdfjs-dist`，没装就提示用户。

## 2. 工具契约

下面的 `scheme get id=…` 是**简写**；真实参数是对象，例如 `{ action: 'get', id: 'qac-memory' }`，`card_preview` 没有 action，靠参数组合。

| 工具 | 动作 | 关键参数 | 返回/语义 |
|---|---|---|---|
| `scheme` | list / get / save / import / derive / test / prune / delete | get/save: `id`；save: `scheme` + `body` + 可选 `files`；test: `id`；delete: `confirm`（active 需 `force`） | save 永远出新版本；delete 被批次钉住时拒绝 |
| `project` | open / list / get / update / close / to-scheme / delete | `id` 选择项目，可用 `scheme` 与 `schemeVersion` 钉版本 | `to-scheme` 保存新草稿 |
| `practice` | list / get / save / delete | save: `id`、`body`、`scheme`、`schemeVersion`、`modules`、`tags`；delete: `confirm` | 实践是真实运行记录，不是方案 |
| `batch` | open / put / validate / fix / next / mark / status | open: `batch`、`scheme`、`deck`、`model`；put: `items`；fix: `apply` | 批次台账在 `<dataDir>/batches` |
| `materials` | **没有 action**：给 `path` 读，给 `keyword` 只返回命中行 | `path`、`pages`、`keyword` | 返回 `p页:L行`，可直接写进定位字段 |
| `card_write` | plan / commit / verify / delete | plan: `batch`、`mode`；commit: `plan`、`open`；delete: `notes`、`confirm` | 只写 ready；commit 幂等；verify 对照快照 |
| `card_preview` | **没有 action**：参数组合 | `batch`/`plan`/`notes`；`png`、`split`、`pdf`、`pdfStyle`、`measure`、`open` | 产出 HTML/PNG/PDF；`measure` 报横向溢出 |

## 3. 一次任务的默认路径

- **单张卡 / 小改**：也要先建一个只放 1 题的批次（`plan` 必须有批次，这是硬要求）：
  `batch open` → `batch put` → `card_write plan` → 给用户看 → `commit` → `verify`。
- **一批卡**：`batch open` → `put` → `validate` → 修到 0 issue → `plan`（给用户看）→ `commit` → `verify` → `card_preview` 呈现。
- **只交文档**（问题集 / 答案 / 记忆指导）：不用 batch，按方案正文产出，`practice save` 记录一次运行。

## 4. 一次真实演练（参数是对象，不是命令行）

以 `qac-memory` 为例（模型与牌组来自 `scheme get` 的返回和用户环境；这里假设模型是 `QAC 问答挖空 v4（国标引用）`）：

```
scheme get    { action:'get', id:'qac-memory' }
  → 六字段（问题/章节定位/要点数/答案/笔记/引用）+ 模型名 + 模板 + 实践

batch open    { action:'open', batch:'demo', scheme:'qac-memory', deck:'药理学', model:'QAC 问答挖空 v4（国标引用）' }
batch put     { action:'put', batch:'demo', items:[{ id:'d1', fields:{
                问题:'哌唑嗪首剂为什么安排在睡前？',
                章节定位:'药理学（第10版） ‖ 第五章 ‖ 哌唑嗪',
                要点数:'30字',            // 答案可见字数，按实际内容算；示例答案实算为 30 字
                答案:'{{c1::首剂晕厥（直立性低血压）→ 0.5mg 睡前 + 卧床数小时}}',
                笔记:'0.5mg / 睡前 / 卧床',
                引用:'药理学（第10版） ‖ p120:L6-9'
              }}] }
batch validate { action:'validate', batch:'demo' }        → ready 1 / blocked 0
card_write plan   { action:'plan', batch:'demo', mode:'add' }   → 计划 p-xxxx
card_write commit { action:'commit', plan:'p-xxxx' }            → 成功 1 / 失败 0
card_write verify { action:'verify', plan:'p-xxxx' }            → 回读 1 张，异常 0 处
card_preview      { batch:'demo', png:true, measure:true }      → PNG 路径 + 「无横向溢出」
present（把 PNG/HTML 交给用户）
```

## 5. 批次状态机

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
| 连不上 Anki | 插件会先尝试自动拉起（`ankiExe` 或常见安装路径，最多等 20 秒）；仍连不上再让用户手动启动 / 装 AnkiConnect；只读功能仍可用 |
| Python 缺失（`旧判据未执行`） | 该方案的 Python 判据跑不了，明确报告，不降级为 JS 通过 |
| 没有 Edge | `card_preview` 只出 HTML，不出 PNG/PDF |
| 模型字段对不上 | `plan` 会报缺哪个字段，先建模型或换模型 |
| `cloze:BRACE` | `batch fix` → `apply=true` → 重新 `validate`（只修挖空内部的 `}}`） |
| `cloze:TAIL` / `UNCLOSED` | `batch fix` **不会修**：TAIL 要删掉 `}}` 之后的尾巴，UNCLOSED 要补闭合；手工改完再 `validate` |
| 计划失效 | 重新 `plan`，不要手改 plan 文件 |
| 输出太长 | 只给摘要 + 文件路径，细节放预览里 |

## 7. 产物与呈现

- 预览落在 `<dataDir>/previews/`；渲染后把文件交给用户（`present`），不要只说"已生成"。
- 验收分两层：测试通过是工程层；给用户看真实卡是用户层，缺一不可。
- Anki 没开时说明取不到，并用最近一次真实渲染代替，不拿示意图冒充。

## 8. 不要做

- 不要手改 `<dataDir>` 里的批次 / 计划 / 审计文件；用工具。
- 不要在 `%TEMP%` 建长期沙箱：要用临时目录就自建自删，或直接用 `<dataDir>/previews`。
- **不要写插件安装目录**：`assets/`、`lib/`、`index.js` 是随包分发的，改了会污染仓库、也会被下次升级覆盖。
  方案改数据目录里的副本（`scheme save` 写的就是副本）；预览、导出、脚本产物都放 `<dataDir>`。
- 派子 Agent 时把 `cwd` 指到数据目录或项目目录，不要继承插件仓库。
- 方案保存后必须渲染样卡（`card_preview scheme=<id> sample=pass png=true`）并 `present`；
  产物在 `samples/render/`，没有渲染图不算交付。
- 不要跳过 `plan` 直接 `commit`；不要为通过检查改断言。
- 不要把"生成成功 / 校验通过 / 写入成功"当成学习效果成立。
- 不要把用户数据塞进安装包或提交进 git。

## 9. 并发与所有权

方案的保存、清理和绑定共用方案锁。批次修改和提交共用批次锁，提交在锁内重读台账。

| 链路 | 并发行为 |
|---|---|
| 方案读写 | 完整版本写好后才发布。删除与清理时检查批次和项目引用 |
| 批次及提交 | 同一批次串行，不同批次独立。重试同一个提交会沿用回执 |
| 预览、资料 | 预览使用独立临时浏览器配置与唯一输出文件 |
| 实践和项目 | 更新同一个记录由同一个 Agent 负责 |

## 10. 子 Agent 协作（可直接执行）

已验证：子 Agent 继承父会话的**同一套工具与 persona**（`scheme`、`materials`、`card_write` 都有），可以直接跑完整条链。

分权规则比"只读"更实际：

1. **一个批次一个 owner**：每个子 Agent 用自己的批次 id（如 `gaoshu-§2.1`），只写自己的批次；
2. 子 Agent 不新建/修改/删除方案，不删卡、不删批次；
3. 主 Agent 先建好牌组与模型，把 `deck`、`model`、`scheme@version`、页码范围写进派发提示；
4. 子 Agent 可跑：`batch open/put/validate/fix` → `card_write plan/commit/verify` → `card_preview`；回报批次 id、写入数、verify 结果、预览路径；
5. 主 Agent 收口：汇总、抽查预览、`present`；跨批去重与冲突由主 Agent 处理。

不同批次可以并行。同一批次的更新和提交共用一把锁。子 Agent 继承工具，仍需遵守上面的归属约定。

## 11. 项目目录（一次任务的现场）

大任务先建项目，不要一上来写方案：

```
<dataDir>/projects/<id>/
  project.json   目标、钉住的方案、deck/model、关联批次与实践
  sources/       资料引用
  notes/         设计记录、取舍、踩坑（自由文本，按时间一份）
  samples/       这次认可的样卡（之后提炼进方案）
  exports/       预览图、PDF
```

流程：`project open` → 做卡（批次照常开，`project update batch=<id>` 关联）→
`project update note=…` 记录决策 → `project close summary=…` → `project to-scheme`。

`to-scheme` 会把 `notes/`（含结项摘要）拼成方案正文、把 `samples/` 复制过去，生成一个 `draft` 方案；
方案里还缺的模型/字段/判据，再按 `SCHEME-FORMAT` 补。**项目是现场，方案是复用件，两者不混。**

## 12. 版本

- 插件 `0.11.x`。支持 DSH `>=0.2.2-rc.3 <0.3.0`，Node `>=22.19`。
- 方案格式见 [SCHEME-FORMAT.md](SCHEME-FORMAT.md)，设计取舍见 [DETAIL.md](DETAIL.md)。
