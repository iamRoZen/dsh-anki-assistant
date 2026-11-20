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
4. **保留证据**：旧方案的 `body.v*.md`、实践记录不要删，迁移后它们仍是依据。

## 在新窗口迁移

1. 新开一个 Anki Assistant 会话；
2. 先跑一次体检，把有问题的方案列出来；
3. 逐个 `scheme get` 看正文，按上表改；
4. 每个方案 `scheme save` 新版本 + `scheme test`；
5. 全部通过后再把状态转 `active`，观察一次真实任务。
