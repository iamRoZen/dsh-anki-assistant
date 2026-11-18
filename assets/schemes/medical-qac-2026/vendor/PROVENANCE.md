# 方案自带判据：出处与版本

本目录是 `medical-qac-2026` 方案私有的判据与适配层，**不属于插件通用层**。
插件只在方案声明 `quality.legacy.module` 时，加载方案目录里的 `validate.mjs`，
再由它调用本目录的 Python。换掉本方案，本目录可以整体删除。

## 来源

| 文件 | 上游路径 | 上游版本 | 取证时间 |
|---|---|---|---|
| `vendor/tools/measure.py` | `dsh-anki-cards/vendor/anki-cards/tools/measure.py` | dsh-anki-cards 0.5.0 | 2026-11-18 |
| `vendor/tools/structure.py` | `dsh-anki-cards/vendor/anki-cards/tools/structure.py` | dsh-anki-cards 0.5.0 | 2026-11-18 |
| `vendor/legacy_qac.py` | `dsh-anki-cards/vendor/anki-cards/schemes/medical_qac/check.py`（摘录） | dsh-anki-cards 0.5.0 | 2026-11-18 |
| `vendor/legacy_adapter.py` | 本次新增的薄适配层（不属于上游） | — | 2026-11-18 |
| `vendor/tools/__init__.py` | 新增空包文件（上游是隐式命名空间包） | — | 2026-11-18 |

上游绝对路径（本机取证用，**运行时不需要**）：
`D:\Users\lsz\Documents\ChatGPT\Anki制卡\dsh-anki-cards\vendor\anki-cards\`

## 改动清单

1. `measure.py` / `structure.py`：**函数体逐字未改**，只在文件头加了出处注释。
2. `legacy_qac.py`：从 `check.py` 摘录本套判据用到的常量与函数（行号对照见文件头），
   函数体逐字未改；未复制 `ref_issues`、`inspect()`、CLI 等与六个判据无关的部分。
3. `legacy_adapter.py`：新增的薄适配层，只做字段取值、按码调用、结果封装，并固定 UTF-8。
4. `tools/__init__.py`：新增空文件，让 `from tools.measure import …` 可解析。

**没有做**：没有计算 sha256（不允许执行命令），没有重新格式化，没有改阈值，
没有把 Python 逻辑翻写成 JavaScript 作为替代路径。

## 重新同步上游

| 常量/函数 | check.py 行号 |
|---|---|
| `WEIGHT_SOFT_LIMIT` / `LINE_LIMIT` | 36 / 37 |
| `PARALLEL_MARKS` / `INFERENCE_MARKS` | 41-44 |
| `ordinal_issues` | 50-74 |
| `TD_RE` / `LI_RE` / `LI_BODY_RE` | 93-95 |
| `visual_lines` / `per_line` | 98-118 |
| `_is_single_term` | 121-128 |
| `needs_next_leaf` | 131-163 |
| `UNIT_SLASH_RE` / `clause_profile` / `_ok_item` / `_split_items` | 211 / 214-220 / 223-225 / 228-234 |
| `long_lines` / `point_count` / `weight_limit` | 281-282 / 285-301 / 304-306 |

## 许可与分发

上游作者为本仓库用户本人；随方案分发不引入新的第三方许可。
`legacy_adapter.py` 为本次新增，同样随本方案分发。
