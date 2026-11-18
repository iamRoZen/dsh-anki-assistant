#!/usr/bin/env python
"""只读适配层：stdin 收草稿 JSON，调用同目录的旧判据，stdout 回 JSON。

不属于原实现，也不改判据；只做三件事：
  1. 把字段取出来；
  2. 按请求的检查码调用 legacy_qac 里的原函数；
  3. 报告结构结论与出处状态（有 refdb 才可能核出处，这里一律「未核」）。

【位置】随 medical-qac-2026 方案分发，不属于插件通用层

用法：
  python legacy_adapter.py < draft.json
  echo '{"fields":{"答案":"…","要点数":"11字"}}' | python legacy_adapter.py

退出码：0 = 已执行（无论判据通过与否，看 JSON 的 ok）；3 = 检测器缺失/损坏。
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 明确 UTF-8：Windows 默认代码页会把中文字段读错，不能依赖测试环境碰巧设置。
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

ALL_CHECKS = ("CLOZE", "ORDINAL", "LONGLINE", "NEEDNEXT", "TOOBIG", "WEIGHT")

try:
    from legacy_qac import (  # noqa: E402  (先加 sys.path，再导入同目录旧判据)
        LINE_LIMIT,
        WEIGHT_SOFT_LIMIT,
        cloze_issues,
        long_lines,
        needs_next_leaf,
        ordinal_issues,
        weigh,
    )
except Exception as exc:  # 缺依赖、文件损坏、Python 版本不兼容都走这里
    print(json.dumps({
        "suite": "medical_qac",
        "ok": False,
        "error": "detector-missing",
        "detail": f"{type(exc).__name__}: {exc}",
    }, ensure_ascii=False))
    sys.exit(3)


def declared_weight(text: str) -> int | None:
    digits = "".join(ch for ch in str(text or "") if ch.isdigit())
    return int(digits) if digits else None


def main() -> None:
    payload = json.loads(sys.stdin.read() or "{}")
    fields = payload.get("fields") or {}
    checks = payload.get("checks") or list(ALL_CHECKS)
    answer = str(fields.get("答案") or "")
    issues: list[dict] = []

    for code in checks:
        if code == "CLOZE":
            issues += [{"code": code, "message": message} for message in cloze_issues(answer)]
        elif code == "ORDINAL":
            issues += [{"code": code, "message": message} for message in ordinal_issues(answer)]
        elif code == "LONGLINE":
            issues += [
                {"code": code, "message": f"第 {label} 行 {weight} 字当量 > {LINE_LIMIT}"}
                for label, weight in long_lines(answer)
            ]
        elif code == "NEEDNEXT":
            for hit in needs_next_leaf(answer):
                if len(hit) == 4:
                    row, col, items, _ = hit
                    message = f"表格第 {row} 行第 {col} 格并列 {items} 项，格内需再起 <ol><li>"
                else:
                    num, weight, par = hit
                    message = f"第 {num} 行 {weight} 字当量、并列 {par} 处，应再开一级"
                issues.append({"code": code, "message": message})
        elif code == "TOOBIG":
            value = weigh(answer)["value"]
            if value > WEIGHT_SOFT_LIMIT:
                issues.append({"code": code, "message": f"字当量 {value} > {WEIGHT_SOFT_LIMIT}"})
        elif code == "WEIGHT":
            value = weigh(answer)["value"]
            declared = declared_weight(fields.get("要点数"))
            if declared is None:
                issues.append({"code": code, "message": f"要点数应为 {value}字，实际为空"})
            elif declared != value:
                issues.append({"code": code, "message": f"要点数为 {declared}字，按答案实算应为 {value}字"})
        else:
            issues.append({"code": "UNKNOWN_CHECK", "message": f"未知检查码：{code}"})

    print(json.dumps({
        "suite": "medical_qac",
        "ok": not issues,
        "issues": issues,
        "source": {
            "status": "unverified",
            "reason": "未配置 refdb：结构已核，出处未核",
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
