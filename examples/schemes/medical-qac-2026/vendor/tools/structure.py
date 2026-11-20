"""结构解析：把卡面 HTML 拆成有地址的片段。

只回答「这里有没有序号、分了几段、第几行第几列」，不回答「这样分对不对」。
序号是否连续、格内该不该再拆，都是方案自己的判断。

【来源】逐字复制自 dsh-anki-cards 0.5.0 的 vendor/anki-cards/tools/structure.py
【改动】仅此一行注释；函数体未改。原文件路径与取证时间见同目录 ../PROVENANCE.md
【位置】随 medical-qac-2026 方案分发，不属于插件通用层
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

ORD_RE = re.compile(r"<b>(\d+(?:\.\d+)*)[.、]?</b>")
CLOZE_RE = re.compile(r"\{\{c(\d+)::")
BLOCK_END = re.compile(r"</(?:div|td|tr|th|p|li|h\d)>|<br\s*/?>", re.I)


def ordinals(html: str) -> list[tuple[int, ...]]:
    """Return every `<b>1.</b>` / `<b>1.1</b>` / `<b>1.1.1</b>` at a block start.

    锚定很重要：卡1 正文里有「起病3～6小时」，那三个数字不在块首，不能当序号。
    块首 = 字段开头，或上一个 `>` 之后只剩空白。层数不限。
    """
    found: list[tuple[int, ...]] = []
    for m in ORD_RE.finditer(html):
        before = html[: m.start()]
        tail = before[before.rfind(">") + 1 :] if ">" in before else before
        if tail.strip():
            continue
        found.append(tuple(int(x) for x in m.group(1).split(".")))
    return found


def format_ord(item: tuple[int, ...]) -> str:
    return ".".join(str(x) for x in item) + ("" if len(item) > 1 else ".")


def segments(answer: str) -> list[tuple[str, str]]:
    """按块首序号切段，返回 [(序号, 段内文本)]。"""
    marks: list[tuple[int, int, str]] = []
    for m in ORD_RE.finditer(answer):
        before = answer[: m.start()]
        tail = before[before.rfind(">") + 1 :] if ">" in before else before
        if tail.strip():
            continue
        marks.append((m.start(), m.end(), m.group(1)))
    out: list[tuple[str, str]] = []
    for i, (_, end, num) in enumerate(marks):
        stop = marks[i + 1][0] if i + 1 < len(marks) else len(answer)
        out.append((num, answer[end:stop]))
    return out


def table_cells(answer: str) -> list[tuple[int, int, str]]:
    """返回 [(行号, 列号, 单元格 html)]，只含 `<td>`，行号列号从 1 起。

    注意：行号把表头 `<tr>` 也算作第 1 行。答案树里的 `rN` 从数据行起算，
    两者相差表头行数——统一口径时要改一处。
    """
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", answer, re.S | re.I)
    out: list[tuple[int, int, str]] = []
    for ri, row in enumerate(rows, 1):
        for ci, cell in enumerate(re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I), 1):
            out.append((ri, ci, cell))
    return out


def cloze_issues(answer: str) -> list[str]:
    """c1 包裹的结构性错误。

    最隐蔽的一种：`}}` 出现在中间，后面还挂着一截 HTML。卡能正常显示（Anki 只取第一个
    cloze 段），但那截尾巴既不显示也不报错，静默丢失。
    """
    issues: list[str] = []
    text = answer.strip()
    if not text.startswith("{{c1::"):
        issues.append("答案不以 {{c1:: 开头")
    if not text.endswith("}}"):
        issues.append("答案不以 }} 结尾")
    first = text.find("}}")
    if first != -1:
        tail = text[first + 2 :].strip()
        if tail:
            issues.append("}} 之后还有 %d 字符：%s" % (len(tail), tail[:40]))
    return issues


# ---------------------------------------------------------------- HTML 结构

INLINE = {"b", "br", "sub", "sup", "anki-mathjax"}
BLOCK = {"div", "table", "thead", "tbody", "tr", "th", "td", "ol", "li"}


class TreeError(ValueError):
    def __init__(self, message, address=None):
        super().__init__(message)
        self.address = address


@dataclass
class Element:
    tag: str
    attrs: dict[str, str | None] = field(default_factory=dict)
    parts: list["Element | str"] = field(default_factory=list)


class AnswerHTML(HTMLParser):
    """只认答案里允许出现的标签和属性，遇到别的就报错。"""

    def __init__(self):
        super().__init__()
        self.stack = [Element("root")]

    def handle_starttag(self, tag, attrs):
        if tag not in INLINE | BLOCK:
            raise TreeError(f"答案中出现未支持的标签 <{tag}>")
        allowed = {"div": {"style"}, "b": {"class"}, "table": {"class"}, "anki-mathjax": {"block"}}
        if any(key not in allowed.get(tag, ()) for key, _ in attrs):
            raise TreeError(f"<{tag}> 有未支持的属性")
        node = Element(tag, dict(attrs))
        self.stack[-1].parts.append(node)
        if tag != "br":
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        if tag != "br":
            raise TreeError(f"<{tag}> 需要独立的结束标签")
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if len(self.stack) == 1 or self.stack[-1].tag != tag:
            raise TreeError(f"HTML 闭合顺序有误，遇到 </{tag}>")
        self.stack.pop()

    def handle_data(self, data):
        self.stack[-1].parts.append(data)


def parse_html(body: str) -> Element:
    parser = AnswerHTML()
    parser.feed(body)
    parser.close()
    if len(parser.stack) != 1:
        raise TreeError(f"<{parser.stack[-1].tag}> 没有闭合")
    return parser.stack[0]


def parts(element: Element) -> list:
    return [part for part in element.parts if isinstance(part, Element) or part.strip()]


def inline_text(parts_, address=None) -> str:
    chunks = []
    for part in parts_:
        if isinstance(part, str):
            chunks.append(part)
        elif part.tag == "br":
            chunks.append("\n")
        elif part.tag in INLINE:
            chunks.append(inline_text(part.parts, address))
        else:
            raise TreeError(f"要点内出现块标签 <{part.tag}>", address)
    return "".join(chunks)


def steps_of(ol: Element) -> list[str]:
    """`<ol><li>` 一条一步，返回每一步的文本。结构不对就报错。"""
    texts: list[str] = []
    for index, item in enumerate(parts(ol), 1):
        address = "s%d" % index
        if isinstance(item, str):
            if item.strip():
                raise TreeError("推导卡须由 <ol><li> 构成", address)
            continue
        if item.tag != "li":
            raise TreeError("推导卡须由 <ol><li> 构成", address)
        if any(isinstance(part, Element) and part.tag in {"ol", "div", "table"} for part in item.parts):
            raise TreeError("步骤内不要再嵌层级；一步只写一次变形", address)
        text = inline_text(item.parts, address).strip()
        if not text:
            raise TreeError("步骤为空", address)
        texts.append(text)
    return texts


def parse_steps(body: str) -> list[str]:
    """从整段答案 HTML 解析推导步骤。只接受单个 `<ol>`。"""
    root = parse_html(body)
    blocks = parts(root)
    if len(blocks) == 1 and isinstance(blocks[0], Element) and blocks[0].tag == "ol":
        return steps_of(blocks[0])
    raise TreeError("推导卡须由 <ol><li> 构成")
