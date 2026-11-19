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
dsh plugin install --profile desktop .     # 或在 GUI 插件管理里安装本目录
```

- 链接安装：改源码后**重启 Desktop** 才加载新代码，不用重装。
- 自检四步：`npm test` 应 104/104；新会话能选「Anki Assistant」；`scheme list` 看得到种子方案；`card_preview` 能出图。
- preset 不出现时依次查：profile `package.json` 里有没有 `link:`；`node_modules` 是不是 junction；`package.json` 是否带 UTF-8 BOM。

## 2. 开工检查

1. `card_preview` 或任何 Anki 调用能否连通？连不上先确认 Anki 已启动、AnkiConnect 已装。
2. `scheme list` 看有没有现成方案；有就 `scheme get`，别自己发明。
3. 要读资料就 `materials`；PDF 需要 `pdfjs-dist`，没装就提示用户。

## 2. 工具契约

下面的 `scheme get id=…` 是**简写**；真实参数是对象，例如 `{ action: 'get', id: 'qac-memory' }`，`card_preview` 没有 action，靠参数组合。

| 工具 | 动作 | 关键参数 | 返回/语义 |
|---|---|---|---|
| `scheme` | list / get / save / import / test / delete | get/save: `id`；save: `scheme` + `body` + 可选 `files`；test: `id`；delete: `confirm`（active 需 `force`） | save 永远出新版本；delete 被批次钉住时拒绝 |
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
| 连不上 Anki | 让用户启动 Anki / 装 AnkiConnect；只读功能仍可用 |
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
- 不要跳过 `plan` 直接 `commit`；不要为通过检查改断言。
- 不要把"生成成功 / 校验通过 / 写入成功"当成学习效果成立。
- 不要把用户数据塞进安装包或提交进 git。

## 9. 并发与所有权

**结论：不是并发安全的。** 单个文件是原子写（临时文件 + 改名），但"读 → 改 → 写"没有锁，两个写入者会互相覆盖。

| 链路 | 能否并发 | 说明 |
|---|---|---|
| `scheme list/get` | ✅ | 只读 |
| `scheme save` | ⚠️ 部分 | 版本号用独占创建，两个保存会得到 vN 与 vN+1，都保留；`active.json` 指针后写者胜 |
| `scheme delete` | ❌ | 与 `batch open` 存在竞态：删除前会查批次，但查完到删除之间别人可能新建批次 |
| `batch open/put/validate/fix/mark` | ❌ | 读改写同一 JSON，后写覆盖前写 |
| `card_write plan` | ✅ | 计划 id 唯一；批次变了旧计划会自动失效 |
| `card_write commit` | ⚠️ 同批次串行 | 同一批次加提交锁：第二个会等锁，且旧计划会因批次变化失效；不同批次可并行 |
| `practice save/delete` | ❌ | 索引是读改写，会丢条目 |
| `card_preview` | ✅ | 每次独立 Edge profile + 唯一文件名 |
| `materials` | ✅ | 只读 |
| `audit` 追加 | ✅ 基本安全 | 单行追加，交错时行不会混在一起 |

必须遵守的规则：

1. **一个数据目录同一时间只允许一个写入者**；分发时按批次或方案划分归属。
2. **不要两个 Agent 同时 commit 同一批次**。
3. 删除方案前确认没有 Agent 正在 `batch open`。
4. 需要并行时：只读操作（get/list/notesInfo/preview）可并行，写入串行。

## 10. 子 Agent 协作

已验证：子 Agent 继承父会话的**同一套工具与 persona**（`scheme`、`materials`、`card_write` 都有）。所以能力不是问题，"谁写"才是问题。

适用：多章 / >20 张 / 顺序做要一小时以上。按节拆，3–4 个并行。

派发时必须写清：

- 方案 `id@version`、本节页码范围、字段规范（或让它 `scheme get`）；
- 只交候选卡：字段 + 出处 `p页:L行` + 不确定的点；
- **禁止** `batch` / `card_write` / `scheme save|delete`，不要写 Anki；
- 主 Agent 收口：合并去重 → `batch put` → `validate` → `plan` → `commit` → `verify` → `present`。

子 Agent 继承工具也意味着它**能**误写。协议靠提示词，没有硬隔离；如果以后要硬隔离，得给子 Agent 单独挂收窄的 preset。

## 11. 版本

- 插件 `0.8.1`；DSH `>=0.2.2-rc.3 <0.3.0`；Node `>=22.19`；`npm test` 104/104。
- 方案格式见 [SCHEME-FORMAT.md](SCHEME-FORMAT.md)，设计取舍见 [DETAIL.md](DETAIL.md)。
