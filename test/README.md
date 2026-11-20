# 测试

`npm test` 使用模拟 Anki 和临时数据目录。工具集成用例经过 DSH 的执行与返回值校验。

手动脚本（不在 `npm test` 里）：

| 脚本 | 用途 |
|---|---|
| `import.prompt.mjs` | 导入一条自然语言提示词，验证存档与版本回看 |
| `integration.smoke.mjs` | 实际 `plan → commit → retry → verify`。仅 `ANKI_SMOKE=1` 时运行，使用唯一临时牌组。`ANKI_SMOKE_MODEL` 可指定本机已有模型 |
| `parity.weigh.mjs` | JS 字当量与 Python 口径对齐 |

`temp.js` 是测试用的临时目录登记与清理。
方案自带的测试在 `examples/schemes/<id>/test/`，由方案自己维护。
