"""医学 QAC 判据：旧实现的逐字摘录（只删与本套判据无关的代码，函数体未改）。

【来源】dsh-anki-cards 0.5.0 的 vendor/anki-cards/schemes/medical_qac/check.py
【版本】0.5.0（2026-11-18 取证）；路径与行号见同目录 ../PROVENANCE.md
【位置】随 medical-qac-2026 方案分发，不属于插件通用层
【复制范围】下列函数与常量逐字复制，仅调整 import；未复制的部分（refdb 覆盖率、math 汇总、
`inspect()` / `_evaluate()` / CLI）与这六个判据无关。

行号对照（旧 check.py）：
  36 WEIGHT_SOFT_LIMIT ｜ 37 LINE_LIMIT ｜ 41-44 PARALLEL_MARKS / INFERENCE_MARKS
  50-74 ordinal_issues
  93-95 TD_RE / LI_RE / LI_BODY_RE
  98-118 visual_lines / per_line
  121-128 _is_single_term
  131-163 needs_next_leaf
  211 UNIT_SLASH_RE ｜ 214-220 clause_profile ｜ 223-225 _ok_item ｜ 228-234 _split_items
  281-282 long_lines ｜ 285-301 point_count ｜ 304-306 weight_limit

依赖：同目录 tools.measure.weigh、tools.structure
"""

from __future__ import annotations

import re

from tools.measure import weigh
from tools.structure import cloze_issues, format_ord, ordinals, segments, table_cells

WEIGHT_SOFT_LIMIT = 180   # 硬上限，不随点数放宽
LINE_LIMIT = 25           # 列举卡单个叶子行的上限；超了说明还没拆到「一个判断」

PARALLEL_MARKS = ("、", "；", ";", "：", ":", "/", "／", "①", "②", "③", "④", "⑤", "⑥",
                  "或", "分别是", "包括", "分为", "如下")
INFERENCE_MARKS = ("→", "⇒", "因此", "从而", "所以", "导致", "引起", "进而",
                   "故", "遂", "造成", "形成", "使得", "继发于", "提示")


def ordinal_issues(html: str) -> list[str]:
    found = ordinals(html)
    if not found:
        return []
    issues: list[str] = []

    seen: set[tuple[int, ...]] = set()
    for item in found:
        if item in seen:
            issues.append("序号重复：%s" % format_ord(item))
        seen.add(item)

    siblings: dict[tuple[int, ...], set[int]] = {}
    for item in found:
        siblings.setdefault(item[:-1], set()).add(item[-1])

    for parent in siblings:
        if parent and parent not in seen:
            issues.append("父号 %s 不存在" % ".".join(str(x) for x in parent))

    for parent, kids in siblings.items():
        if sorted(kids) != list(range(1, max(kids) + 1)):
            name = "顶层" if not parent else "%s 的子号" % ".".join(str(x) for x in parent)
            issues.append("%s缺号：%s" % (name, sorted(kids)))
    return issues


TD_RE = re.compile(r"<td[^>]*>", re.I)
LI_RE = re.compile(r"<li[^>]*>", re.I)
LI_BODY_RE = re.compile(r"<li[^>]*>(.*?)</li>", re.S)


def visual_lines(answer: str) -> list[tuple[str, int]]:
    """每一「眼」一行：序号行一行，每个 `<li>` 各一行。

    列表项既然单独成项，就得单独算分、单独量字数——否则「一行 25 字」会把
    四个列表项当成一行，LONGLINE 就失效了。
    """
    out: list[tuple[str, int]] = []
    if "<table" in answer.lower():
        return out
    for num, seg in segments(answer):
        items = LI_BODY_RE.findall(seg)
        head = LI_BODY_RE.sub("", seg).replace("</ul>", "").replace("<ul>", "")
        if head.strip():
            out.append((num, weigh(head)["value"]))
        for i, item in enumerate(items, 1):
            out.append(("%s-%d" % (num, i), weigh(item)["value"]))
    return out


def per_line(answer: str) -> list[tuple[str, int]]:
    return visual_lines(answer)


def _is_single_term(seg: str) -> bool:
    """整行就是一个词（无标点、≤8 字）——这种行没有「别的可标」，豁免。"""
    plain = re.sub(r"<[^>]+>", "", seg).strip()
    if not plain:
        return False
    if any(c in plain for c in "：:，,、（）()；;"):
        return False
    return weigh(plain)["value"] <= 8


def needs_next_leaf(answer: str, dots: int = 2) -> list[tuple[int, int, int, bool]]:
    """表格单元格里也判并列——格子不是避难所。

    一格塞「激素无效、耐药、禁忌」三项，和大纲行塞三项一样数不清；
    但表格不走序号，所以要求的是**格内再起一层叶子**（`<ol><li>`），
    不是再开一个序号。返回 [(行, 列, 并列标记数)]。
    """
    if "<table" not in answer.lower():
        return []
    out: list[tuple[int, int, int, bool]] = []
    for ri, ci, cell in table_cells(answer):
        if "<li" in cell.lower():          # 已经是列表，叶子有了
            continue
        par, inf = clause_profile(cell)
        if inf:
            continue
        items = _split_items(cell)
        if len(items) < 3:
            continue                       # 两项不算并列，留在一格
        # 表格格不看项的长短，只看有没有 OR——「≥4.0mg/dl 或升 2 倍 或开始 RRT」
        # 三项都很短，但它们是三个可选项，挤一格就数不清
        # 有「或／斜杠」这类**择一**标记才算真并列；「IgG、C3 沉积于系膜区及血管壁」
        # 是一句描述里的顿号，不分
        plain_cell = UNIT_SLASH_RE.sub('X', re.sub(r'<[^>]+>', '', cell))
        alt = plain_cell.count('或') + plain_cell.count('/') + plain_cell.count('／')
        if alt < 1:
            continue
        # 已经断行或已经是列表的，交给人工判断；没结构的就报出来
        if '<br' not in cell.lower():
            out.append((ri, ci, len(items), True))
        if weigh(cell)["value"] <= 4:
            continue
    return out


UNIT_SLASH_RE = re.compile(r"[A-Za-z0-9%)·]+/[A-Za-z0-9(]+")


def clause_profile(text: str) -> tuple[int, int]:
    """返回 (并列标记数, 推导标记数)。单位里的斜杠不算并列（mg/d、ml/kg、B/T/NK）。"""
    plain = re.sub(r"<[^>]+>", "", text)
    plain = UNIT_SLASH_RE.sub("X", plain)
    par = sum(plain.count(m) for m in PARALLEL_MARKS)
    inf = sum(plain.count(m) for m in INFERENCE_MARKS)
    return par, inf


def _ok_item(items: list[str]) -> int:
    """并列项里「像一句话」的（≥4 字）有几个。"""
    return sum(1 for s in items if weigh(s)["value"] >= 4)


def _split_items(text: str) -> list[str]:
    plain = re.sub(r"<[^>]+>", "", text)
    plain = UNIT_SLASH_RE.sub("X", plain)
    plain = re.sub(r"^[\s:：]*", "", plain)
    for m in ("、", "/", "／", "；", ";", "，", ",", "或"):
        plain = plain.replace(m, "|")
    return [s.strip() for s in plain.split("|") if s.strip()]


def long_lines(answer: str, limit: int = LINE_LIMIT) -> list[tuple[str, int]]:
    return [(o, n) for o, n in per_line(answer) if n > limit]


def point_count(answer: str) -> int:
    """判分点数。

    表格：每个格子取 max(1, `<li>` 数)——格子是地址，格内项是判分点。
    非表格：每个序号行取 max(1, `<li>` 数)——有列表项就按项算，没有就算这一行本身。
    """
    if "<table" in answer.lower():
        total = 0
        for chunk in TD_RE.split(answer)[1:]:
            cell = chunk.split("</td>")[0]
            total += max(1, len(LI_RE.findall(cell)))
        if total:
            return total
    segs = segments(answer)
    if not segs:
        return 1 if answer.strip() else 0
    return sum(max(1, len(LI_BODY_RE.findall(seg))) for _, seg in segs)


def weight_limit(points: int) -> int:
    """字数上限是平的，不按点数放大——放大等于放宽标准而不是解决啰嗦。"""
    return WEIGHT_SOFT_LIMIT
