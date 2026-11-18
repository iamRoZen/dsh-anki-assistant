"""度量：只算数字，不判断好坏。

这一层的东西换任何方案都不变——字当量、公式识别、汉字与 ASCII 计数。
阈值（180 字上限之类）不属于这里，那是方案自己的政策。

【来源】逐字复制自 dsh-anki-cards 0.5.0 的 vendor/anki-cards/tools/measure.py
【改动】仅此一行注释；函数体未改。原文件路径与取证时间见同目录 ../PROVENANCE.md
【位置】随 medical-qac-2026 方案分发，不属于插件通用层
"""

from __future__ import annotations

import re

CODE_HTML_RE = re.compile(r"<(code|pre)(?:\s[^>]*)?>.*?</\1\s*>", re.I | re.S)
# 行间必须先于行内匹配：`<anki-mathjax block="true">` 会被 `<anki-mathjax>` 吃掉。
MATH_RE = re.compile(
    r"<anki-mathjax block=\"true\">(.*?)</anki-mathjax>"
    r"|\\\[(.*?)\\\]"
    r"|<anki-mathjax>(.*?)</anki-mathjax>"
    r"|\\\((.+?)\\\)",
    re.S,
)
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
ASCII_RUN = re.compile(r"[A-Za-z0-9]+")

WEIGHT_BLOCK = 15         # 行间公式起价
WEIGHT_INLINE = 4         # 行内公式起价
NGRAM_N = 2               # 二元字：实测正确页 62%、相邻页 28%、无关页 0–15%


def mask_code(text: str) -> str:
    """把字面代码替换成等长空白，保留源码偏移以便继续称重。"""
    return CODE_HTML_RE.sub(lambda match: " " * len(match[0]), text)


def weigh(html: str) -> dict:
    """字当量：汉字 + ASCII/2 + Σ max(起价, 源码长/2)。

    起价是「一个公式最少占多少」，上浮项负责长式——一条三连不等式源码 80
    字符，按死 15 算会少一整行。
    """
    text = html.replace("{{c1::", "").replace("}}", "")
    text = re.sub(r"<b>\d+(?:\.\d+)*[.、]?</b>", "", text)  # 手写序号不计
    pieces: list[str] = []
    spans: list[tuple[str, int]] = []
    pos = 0
    for m in MATH_RE.finditer(mask_code(text)):
        pieces.append(text[pos : m.start()])
        groups = m.groups()
        block = groups[0] if groups[0] is not None else groups[1]
        src = re.sub(r"</?anki-mathjax[^>]*>", "", next(g for g in groups if g is not None))
        for delim in ("\\[", "\\]", "\\(", "\\)"):
            src = src.replace(delim, "")
        spans.append(("block" if block is not None else "inline", len(src)))
        pos = m.end()
    pieces.append(text[pos:])

    plain = re.sub(r"<[^>]+>", "", "".join(pieces))
    plain = re.sub(r"\s+", "", plain)
    han = len(CJK_RE.findall(plain))
    ascii_chars = sum(len(run) for run in ASCII_RUN.findall(plain))

    total = han + ascii_chars / 2.0
    for kind, length in spans:
        base = WEIGHT_BLOCK if kind == "block" else WEIGHT_INLINE
        total += max(base, length / 2.0)

    return {
        "value": round(total),
        "han": han,
        "ascii": ascii_chars,
        "block": sum(1 for k, _ in spans if k == "block"),
        "inline": sum(1 for k, _ in spans if k == "inline"),
        "math": bool(spans),
    }


MD_PATTERNS = (
    (re.compile(r"\*\*"), "md_bold"),
    (re.compile(r"~~"), "md_strike"),
    (re.compile(r"`"), "md_code"),
)


def md_issues(text: str) -> list[str]:
    """Find leftover Markdown markers outside literal code."""
    text = mask_code(text)
    return [label for pat, label in MD_PATTERNS if pat.search(text)]


def math_issues(text: str, *, in_cloze: bool = True) -> list[str]:
    """Return human readable problems found in the math spans of `text`."""
    text = mask_code(text)
    issues: list[str] = []
    for match in MATH_RE.finditer(text):
        groups = match.groups()
        block = groups[0] if groups[0] is not None else groups[1]
        body = next(g for g in groups if g is not None)
        delim = "\\[" if block is not None else "\\("
        snippet = body.strip()[:40]
        commands = re.findall(r"\\(?:[A-Za-z]+|[^A-Za-z])", body)
        if r"\oiint" in commands:
            issues.append(r"本项目使用的 Anki MathJax 会把 \oiint 显示成红色命令。闭曲面积分写作 ∯。")
        if r"\arccot" in commands:
            issues.append(r"Anki 默认 MathJax 会把 \arccot 显示成红色命令。可写作 \operatorname{arccot}。")
        if in_cloze and "}}" in body:
            issues.append("%s 内含 `}}`：会提前结束挖空 -> %s" % (delim, snippet))
        if "<" in body or ">" in body:
            issues.append(
                "%s 内含裸 < 或 >：会被 HTML 解析器当成标签，字段会被写坏；"
                "改用 \\lt / \\gt -> %s" % (delim, snippet)
            )
        depth = 0
        for char in body.replace("\\{", "").replace("\\}", ""):
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth < 0:
                    break
        if depth != 0:
            issues.append("%s 花括号不平衡（余 %d）-> %s" % (delim, depth, snippet))
    if text.count("\\(") != text.count("\\)"):
        issues.append("\\( 与 \\) 数量不匹配")
    if text.count("\\[") != text.count("\\]"):
        issues.append("\\[ 与 \\] 数量不匹配")
    for bad, good in (("\\\\(", "\\("), ("\\\\)", "\\)"), ("\\\\[", "\\["), ("\\\\]", "\\]")):
        if bad in text:
            issues.append(
                "出现双反斜杠 `%s`：MathJax 只认 `%s`，整段会当成普通文本渲染" % (bad, good)
            )
    return issues
