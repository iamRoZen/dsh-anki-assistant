# Changelog

## 0.10.0

- 结构重构：`index.js` 从 1542 行降到 262 行，只留装配
- 7 个工具拆到 `lib/tools/`，辅助放 `lib/tools/shared.js`
- 行为、文案、参数、注册顺序逐字保持不变；测试 112/112

## 0.9.5

- `card_preview` 支持 `scheme` + `sample`：按方案模型的真实模板渲染样卡，产物落到 `samples/render/`
- 提示词/skill：方案交付必须有渲染图；禁止写插件安装目录；子 Agent 的 cwd 指向数据目录
- `scripts/check-workspace.mjs` + `npm run check:workspace`：检查仓库里是否有不该出现的改动/垃圾

## 0.9.4

- `scheme prune`：清理旧版本，保留 active 与被批次钉住的版本；同时清掉重复的 `scheme.json`
- 已对 `medical-qac-2026` 执行：保留 v2（批次钉住）与 v5（active），删除 v1/v3/v4
- 还原被误改的仓库 assets 方案（测试恢复 111/111）

## 0.9.3

- `scheme derive`：把外部文件（文本）拼成正文骨架，起一个 `method` 草稿方案；只汇总，不假装提炼
- 文档说明三种路径的区别：derive 起新方案 / import 导入外部目录 / import upgrade 给已有方案出新版本

## 0.9.2

- `scheme import upgrade=true`：用外部项目的做法给**已有方案**出新版本（旧版保留、批次不改绑）
- 复制 body / validate / print.css / samples / vendor / scripts；新版本默认 draft
- MIGRATION 增加"用外部项目升级已有方案"

## 0.9.1

- 方案体检脚本 `scripts/audit-schemes.mjs` 与 `docs/MIGRATION.md`
- 提示词去掉已在 skill/方案覆盖的 cloze 修复细节

## 0.9.0

- 新增 `project` 工具：项目目录（目标、资料、批次、决策记录、样卡），
  `open/list/get/update/close/to-scheme/delete`
- `to-scheme`：把 notes 拼成正文、样卡复制过去，生成 draft 方案
- Anki 路径探测放宽：`where anki` + 各盘 Program Files；连不上时自动拉起

## 0.8.5

- Anki 没开时自动拉起：`ankiExe` 可配置，未配置则探测常见安装位置；最多等 20 秒，失败才报错
- 新增 `resolveAnkiExe` 与对应测试

## 0.8.4

- 子 Agent 改为直接执行，按批次分权（一个批次一个 owner）

## 0.8.1

- 公开前收尾：示例实践脱敏、GitHub Actions（npm ci + npm test）、README 名称表
- 标签收敛为发布点（仅保留 v0.8.1）

## 0.8.0

- 分发就绪：MIT LICENSE、repository/homepage/bugs/keywords、`.npmignore`
- `files` 白名单补 `scripts/` 与 LICENSE；包内不再含 `__pycache__`

## 0.7.5

- 同一批次的并发提交串行化：后到的计划失效，不重复写卡

## 0.7.2–0.7.4

- 补齐删除：`scheme delete`（confirm / active 需 force / 批次钉住拒绝）、`practice delete`、`card_write delete`（前后各读一次）
- 并发检查：方案版本独占创建、Edge 每次独立 profile
- `docs/AGENT-BRIEF.md`：安装自检、工具契约、批次状态机、失败手册、并发表

## 0.7.0–0.7.1

- `batch fix`：自动把挖空内的 `}}` 改成 `} }`；默认只报告，`apply=true` 写回
- 挖空字段由方案决定（role=content / 名称 / spec），不再写死「答案」

## 0.6.x

- 方案目录结构定稿（`docs/SCHEME-FORMAT.md`）：记录 + 附件、两种形态、七条不变量
- `scheme import`（规范 id）、`scheme test`（test/run.mjs 或 validate.mjs + samples）
- Persona 收敛为三任务域、六条原则、三层验证

## 0.5.x

- 方案私有判据：`medical-qac-2026` 的 Python 原码随方案目录
- 数学方案 `gaoshu-steps`；`quality.validator` 接口
- 卡面渲染：真实模板 + 模型 CSS + MathJax；PNG / 逐张 / PDF / 溢出检测
- 挖空截断检查（`cloze:BRACE` / `TAIL`）

## 0.1–0.4

- 方案库、批次台账、资料读取（页 + 行号）、写入闸门与回读
- 外部自然语言提示词导入；方案外壳变薄；派生方案与入口级测试
