# Contributing

## 环境

- Node >= 22.19；`npm install`
- 可选：Python 3.10+（只有声明了旧判据的方案需要，如 `medical-qac-2026`）
- 可选：Anki + AnkiConnect（写入与渲染需要）

## 改之前

- 方案怎么写：先读 [docs/SCHEME-FORMAT.md](docs/SCHEME-FORMAT.md)
- 执行流程与边界：先读 [docs/AGENT-BRIEF.md](docs/AGENT-BRIEF.md)
- 设计取舍：读 [docs/DETAIL.md](docs/DETAIL.md)

## 测试

```bash
npm test                                   # 根测试
node assets/schemes/medical-qac-2026/test/run.mjs   # 方案独立复验
```

改代码必须带测试；改方案必须带样卡（一张能过、一张该被拦）。

## 约定

- 不改用户数据格式的语义；要迁移就在 `store.js` 升 `SCHEMA_VERSION` 并写兼容。
- 方案记录只增不改：新版本，不覆盖旧版本。
- 删除类操作必须 `confirm`，涉及 Anki 的删除前后各读一次。
- 不要提交 `<dataDir>` 内容、真实卡片、密钥或个人绝对路径。
- 提交信息用一句话说清"改了什么、为什么"。

## 发布

- 只在构成发布时打标签；中间改动只提交。
- `npm pack --dry-run` 检查包内容；发布 npm 前去掉 `package.json` 的 `"private": true`。
