# 检查项对照：本方案 ↔ 旧 check.py

**执行方式**：六项结构判据由**本方案目录自带**的 Python 原实现执行
（`validate.mjs` → `vendor/legacy_adapter.py` → `vendor/legacy_qac.py` + `vendor/tools/`），
插件只通过 `quality.legacy.module` 加载它。没有 JS 复刻，也没有「JS 兜底」；
删掉本方案目录，插件不知道 Python 的存在。

| 检查码 | 旧实现位置 | 说明 |
|---|---|---|
| `CLOZE` | `tools/structure.py` `cloze_issues` | 开头、结尾、`}}` 后尾巴 |
| `ORDINAL` | `check.py` `ordinal_issues` | 重复、父号缺失、同级缺号 |
| `LONGLINE` | `check.py` `visual_lines` + `long_lines` | 按序号行与 `<li>` 分别算，表格免检 |
| `NEEDNEXT` | `check.py` `needs_next_leaf` | 表格格内 ≥3 项 + 择一标记，且无 `<br>`/`<li>` |
| `TOOBIG` | `check.py` `WEIGHT_SOFT_LIMIT` + `tools/measure.py` `weigh` | 字当量 > 180 |
| `WEIGHT` | 同上 + 字段 `要点数` | 字段值与字当量不符 |

## 与本插件格式规则的分工

| 规则 | 谁执行 | 为什么 |
|---|---|---|
| `q-ask`、`loc-form`、`cite-locator` | 插件 JS | 纯字符串格式，与旧判据无关 |
| 上述六项 | 随包 Python 原实现 | 旧口径复杂（字当量含公式起价、序号块首锚定），复刻必然漂移 |

## 未接入的旧检查（明确不做，不静默跳过）

| 检查码 | 原因 |
|---|---|
| `REF`（覆盖率） | 需要 refdb 教材库；未配置时旧脚本也会跳过。本方案只报「出处未核」 |
| `NOBOLD` / `WEAKMARK` | 需要判断"是否二级叶子""标的是否主语"，属语义；放进 rubric 由人工判 |
| `MATH` | 数学卡才需要；本方案不覆盖 |
| `FAMILY` | 需要跨卡查询；判重已由批次与 Anki 全局标签承担 |

## 出处状态

适配器固定返回 `source.status = "unverified"`（未配置 refdb）。
`batch validate` 会把它作为 `warnings` 带出；`card_write plan` 会在预览里显示「出处：未核」。
结构通过 ≠ 出处已核，两者在输出里分开。
