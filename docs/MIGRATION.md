# 迁移旧方案

## 先体检（只读）

```bash
node scripts/audit-schemes.mjs                    # 默认 ~/.dsh/anki-assistant
node scripts/audit-schemes.mjs <别的 dataDir>      # 迁移前先看另一份数据
```

输出每个方案的版本、状态、交付物、字段/规则、附件与问题清单。旧版本仍可读取。新保存或导入的版本会把正文、样卡和判据一起归档。

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
3. 把外部正文、校验器、样式和样卡存为新版本的附件。旧版本继续读取原有附件。
4. 外部记录未指定状态时默认为 `draft`。已有批次和项目继续使用所钉版本。
5. 用户审阅脚本后，把相应 `id@version` 加到 `trustedSchemeVersions`，重启 DSH 再跑 `scheme test`。

不加 `upgrade=true` 时，同名方案直接拒绝，避免误覆盖。

## 在新窗口迁移

1. 新开一个 Anki Assistant 会话；
2. 先跑一次体检，把有问题的方案列出来；
3. 逐个 `scheme get` 看正文，按上表改；
4. 每个方案 `scheme save` 新版本 + `scheme test`；
5. 全部通过后再把状态转 `active`，观察一次真实任务；
6. 确认没有批次需要旧版本后，`scheme prune id=<id> confirm=true` 清掉半成品版本
   （保留当前版本及被批次或项目引用的版本）。

旧版未提交的写入计划需要重新 `plan`。已有提交回执可继续 `verify`。
