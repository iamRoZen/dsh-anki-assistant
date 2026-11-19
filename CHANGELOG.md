# Changelog

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
