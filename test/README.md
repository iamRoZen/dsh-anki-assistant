# 测试

`npm test` 跑 `*.test.js`：单元与集成，全部用假 Anki / 临时数据目录，不碰真实库。

手动脚本（不在 `npm test` 里）：

| 脚本 | 用途 |
|---|---|
| `import.prompt.mjs` | 导入一条自然语言提示词，验证存档与版本回看 |
| `integration.smoke.mjs` | 真机写入联调；需 `ANKI_SMOKE=1`，跑完清理 |
| `parity.weigh.mjs` | JS 字当量与 Python 口径对齐 |

`temp.js` 是测试用的临时目录登记与清理。
方案自带的测试在 `examples/schemes/<id>/test/`，由方案自己维护。
