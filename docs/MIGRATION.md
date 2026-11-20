# 迁移旧方案

## 先体检（只读）

```bash
node scripts/audit-schemes.mjs                    # 默认 ~/.dsh/anki-assistant
node scripts/audit-schemes.mjs <别的 dataDir>      # 迁移前先看另一份数据
```

输出每个方案的版本、状态、交付物、字段/规则、附件与问题清单。**没有问题的方案不需要迁移。**

## 常见不兼容与改法

| 现象 | 改法 |
|---|---|
| 目录名 ≠ `scheme.id` | 用 `scheme import` 重新导入（会规范 id），或手工改名并同步记录 |
| 缺 `body.md` | 从旧说明、`v*.json` 或实践记录补正文，再 `scheme save` |
| `cards` 方案没有模型/字段 | 补 `output.model` 与 `output.fields`；或降为 `method` |
| 规则指向不存在的字段 | 删规则或改字段名；`batch validate` 会直接报 |
| 只有 JS 规则、没有校验器 | 能形式化的迁进方案目录 `validate.mjs`；不能的留 `quality.rubric` |
| 旧版 `quality.legacy` 的 Python 判据 | 把 `vendor/` + `validate.mjs` 放进方案目录，按 `SCHEME-FORMAT` 声明 |

## 迁移原则

1. **不改旧版本**：`scheme save` 出新版本，旧版本与旧正文保留；
2. **分批不动**：已有批次钉的是旧版本，迁移后不要手改批次；
3. **先测后转**：新版本先 `draft`，`scheme test` 或跑 2–3 张真卡，再 `active`；
4. **保留证据**：旧方案的 `body.v*.md`、实践记录不要删，迁移后它们仍是依据；
5. **一次成型**：迁移前先把差异列完（`scheme get`、样卡、判据、目录结构一起看），**一次 save 出新版本**；
   每发现一处就存一版，会把版本历史弄成一串半成品。

## 用外部项目升级已有方案（不是搬方案）

外部项目里已经有一套做法，想把它变成**本项目已有方案的新版本**：

```bash
scheme import path="D:/旧项目/schemes/medical_qac" upgrade=true \
  changeWhy="按旧项目 2026-11 的判据升级"
```

行为：

1. 读外部 `scheme.json`，id 规范后**匹配已有方案**；
2. 给已有 id 出一个新版本（旧版本、旧正文保留）；
3. 复制外部目录的 `body.md`、`validate.mjs`、`print.css`、`samples/`、`vendor/`、`scripts/` 覆盖到当前方案目录；
4. 新版本默认 `draft`，不会自动改绑批次；
5. 先 `scheme test`，再决定是否 `active`。

不加 `upgrade=true` 时，同名方案直接拒绝，避免误覆盖。

## 在新窗口迁移

1. 新开一个 Anki Assistant 会话；
2. 先跑一次体检，把有问题的方案列出来；
3. 逐个 `scheme get` 看正文，按上表改；
4. 每个方案 `scheme save` 新版本 + `scheme test`；
5. 全部通过后再把状态转 `active`，观察一次真实任务。
