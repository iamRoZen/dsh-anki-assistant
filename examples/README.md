# 示例方案（不随包分发）

插件包不带方案。这里的是仓库示例，需要时由用户的 Agent 显式预载：

```bash
scheme import path=<repo>/examples/schemes/qac-memory
scheme import path=<repo>/examples/schemes/qac-exam
scheme import path=<repo>/examples/schemes/gaoshu-steps
scheme import path=<repo>/examples/schemes/medical-qac-2026
```

| 目录 | 类型 | 依赖 |
|---|---|---|
| `schemes/qac-memory` | 教材驱动·概念关系出题 | 纯规则 |
| `schemes/qac-exam` | 题源驱动·逐题取证 | 纯规则 |
| `schemes/gaoshu-steps` | 数学推导·一步一动作 | 纯 JS 校验器 |
| `schemes/medical-qac-2026` | 医学 QAC 六字段 | Python 3.10+（方案自带 `vendor/`） |

导入后是 `draft` 或示例声明的状态；跑 `scheme test` 再决定是否 `active`。

`practices/` 是实践示例，`templates/` 是卡片模板说明，都不参与导入。
