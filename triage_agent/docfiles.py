"""Knowledge documents as files: read an uploaded file, keep its formatting safely, and write it back out.

In:   Word (.docx), PDF, a web page (.html), Markdown (.md) and plain text (.txt) become one safe HTML form:
      headings, paragraphs, bold, italic, underline, lists, links, tables. Nothing else survives (no scripts, styles,
      images or attributes), so what the editor shows and what is stored can never run code.
Out:  a document is written as Word (.docx), a web page (.html) or plain text (.txt); the whole Knowledge base as a
      .zip of those.

Word files are read and written with the standard library (a .docx is a zip of XML). PDFs are read with pypdf.
"""

from __future__ import annotations

import html
import io
import re
import zipfile
from html.parser import HTMLParser
from typing import Any
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as x

BLOCKS = {"p", "h1", "h2", "h3", "h4", "li", "blockquote", "pre", "td", "th"}
ALLOWED = BLOCKS | {"br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "a", "table", "thead", "tbody", "tr", "hr", "code"}
VOID = {"br", "hr"}
DROPPED = {"script", "style", "noscript", "head", "svg", "iframe", "object", "embed", "form", "title", "template"}
TYPES = {".docx": "Word document", ".pdf": "PDF", ".html": "web page", ".htm": "web page", ".md": "Markdown", ".txt": "plain text"}
FORMATS = {"docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
           "html": ("text/html; charset=utf-8", "html"), "txt": ("text/plain; charset=utf-8", "txt")}
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_LINK = re.compile(r"^(https?://|mailto:)", re.I)


class _Cleaner(HTMLParser):
    """Keeps the allowed tags with no attributes (a link keeps a web or mail address), drops the rest to their text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in DROPPED:
            self.skip += 1
        elif self.skip or tag not in ALLOWED:
            return
        elif tag == "a":
            href = next((v or "" for k, v in attrs if k == "href"), "").strip()
            self.out.append(f'<a href="{html.escape(href, quote=True)}">' if _LINK.match(href) else "<a>")
        else:
            self.out.append(f"<{tag}>")

    def handle_endtag(self, tag: str) -> None:
        if tag in DROPPED:
            self.skip = max(0, self.skip - 1)
        elif not self.skip and tag in ALLOWED and tag not in VOID:
            self.out.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.out.append(html.escape(data, quote=False))


def clean_html(markup: str) -> str:
    """The document's formatting, safe to store and show: only the allowed tags, no attributes but a link's address."""
    parser = _Cleaner()
    parser.feed(markup or "")
    parser.close()
    return re.sub(r"\n{3,}", "\n\n", "".join(parser.out)).strip()


def from_text(text: str) -> str:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", (text or "").replace("\r\n", "\n")) if p.strip()]
    return "\n".join("<p>" + "<br>".join(html.escape(line, quote=False) for line in p.split("\n")) + "</p>" for p in paragraphs)


def _inline_md(text: str) -> str:
    out = html.escape(text, quote=False)
    out = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", lambda m: f'<a href="{html.escape(html.unescape(m.group(2)), quote=True)}">{m.group(1)}</a>', out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    return re.sub(r"(?<![*\w])\*([^*\n]+)\*(?![*\w])", r"<em>\1</em>", out)


def from_markdown(text: str) -> str:
    """Headings, bullet and numbered lists, bold, italic and links; everything else is a paragraph."""
    out: list[str] = []
    para: list[str] = []
    open_list = ""

    def flush() -> None:
        nonlocal open_list
        if para:
            out.append("<p>" + "<br>".join(_inline_md(line) for line in para) + "</p>")
            para.clear()
        if open_list:
            out.append(f"</{open_list}>")
            open_list = ""

    for raw in (text or "").replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        heading = re.match(r"^(#{1,4})\s+(.*)$", line)
        item = re.match(r"^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$", line)
        if heading:
            flush()
            out.append(f"<h{len(heading.group(1))}>{_inline_md(heading.group(2))}</h{len(heading.group(1))}>")
        elif item:
            kind = "ul" if item.group(1) else "ol"
            if para or open_list != kind:
                flush()
                out.append(f"<{kind}>")
                open_list = kind
            out.append(f"<li>{_inline_md(item.group(3))}</li>")
        elif not line.strip():
            flush()
        else:
            if open_list:
                flush()
            para.append(line)
    flush()
    return "\n".join(out)


# -- Word in ------------------------------------------------------------------------------------------------------
def _w(tag: str) -> str:
    return f"{{{W}}}{tag}"


def _runs(node: ET.Element, links: dict[str, str]) -> str:
    """The inline content of a paragraph: text with bold, italic, underline and links."""
    out: list[str] = []
    for child in node:
        if child.tag == _w("hyperlink"):
            href = links.get(child.get(f"{{{R}}}id") or "", "")
            inner = _runs(child, links)
            out.append(f'<a href="{html.escape(href, quote=True)}">{inner}</a>' if _LINK.match(href) else inner)
        elif child.tag == _w("r"):
            props = child.find(_w("rPr"))
            on = lambda name: props is not None and props.find(_w(name)) is not None and props.find(_w(name)).get(_w("val")) not in ("0", "false", "none")  # noqa: E731
            text = "".join("<br>" if t.tag == _w("br") else "\t" if t.tag == _w("tab") else html.escape(t.text or "", quote=False)
                           for t in child if t.tag in (_w("t"), _w("br"), _w("tab")))
            if not text:
                continue
            for name, tag in (("u", "u"), ("i", "em"), ("b", "strong")):
                if on(name):
                    text = f"<{tag}>{text}</{tag}>"
            out.append(text)
    return "".join(out)


def from_docx(data: bytes) -> str:
    """A Word document's headings, paragraphs, lists, links and tables, in the safe HTML form."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        body = ET.fromstring(z.read("word/document.xml")).find(_w("body"))
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
        raise ValueError("This is not a Word document that can be read. Save it as .docx and upload it again.") from exc
    links: dict[str, str] = {}
    if "word/_rels/document.xml.rels" in z.namelist():
        for rel in ET.fromstring(z.read("word/_rels/document.xml.rels")):
            links[rel.get("Id") or ""] = rel.get("Target") or ""
    ordered: dict[str, bool] = {}  # numId -> a numbered list (else bullets)
    if "word/numbering.xml" in z.namelist():
        num = ET.fromstring(z.read("word/numbering.xml"))
        formats = {a.get(_w("abstractNumId")): (a.find(f"{_w('lvl')}/{_w('numFmt')}").get(_w("val")) if a.find(f"{_w('lvl')}/{_w('numFmt')}") is not None else "bullet")
                   for a in num.findall(_w("abstractNum"))}
        for n in num.findall(_w("num")):
            ref = n.find(_w("abstractNumId"))
            ordered[n.get(_w("numId")) or ""] = formats.get(ref.get(_w("val")) if ref is not None else "", "bullet") != "bullet"
    out: list[str] = []
    open_list = ""

    def close_list() -> None:
        nonlocal open_list
        if open_list:
            out.append(f"</{open_list}>")
            open_list = ""

    def paragraph(p: ET.Element) -> tuple[str, str]:
        """(tag, inner html) of one paragraph; tag is h1..h4, li:ul, li:ol or p."""
        props = p.find(_w("pPr"))
        style = (props.find(_w("pStyle")).get(_w("val")) if props is not None and props.find(_w("pStyle")) is not None else "") or ""
        num = props.find(f"{_w('numPr')}/{_w('numId')}") if props is not None else None
        inner = _runs(p, links)
        heading = re.match(r"(?i)^heading\s*([1-6])$", style)
        if style.lower() == "title":
            return "h1", inner
        if heading:
            return f"h{min(int(heading.group(1)), 4)}", inner
        if num is not None and num.get(_w("val")) not in (None, "0"):
            return ("li:ol" if ordered.get(num.get(_w("val")) or "") else "li:ul"), inner
        return "p", inner

    for child in list(body) if body is not None else []:
        if child.tag == _w("p"):
            tag, inner = paragraph(child)
            if tag.startswith("li:"):
                kind = tag[3:]
                if open_list != kind:
                    close_list()
                    out.append(f"<{kind}>")
                    open_list = kind
                out.append(f"<li>{inner}</li>")
            else:
                close_list()
                if inner.strip():
                    out.append(f"<{tag}>{inner}</{tag}>")
        elif child.tag == _w("tbl"):
            close_list()
            rows = []
            for tr in child.findall(_w("tr")):
                cells = ["<br>".join(i for i in (paragraph(p)[1] for p in tc.findall(_w("p"))) if i.strip()) for tc in tr.findall(_w("tc"))]
                rows.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
            out.append("<table><tbody>" + "".join(rows) + "</tbody></table>")
    close_list()
    return clean_html("\n".join(out))


def from_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader

        pages = [page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages]
    except Exception as exc:  # noqa: BLE001 - a scanned or damaged file
        raise ValueError(f"This PDF could not be read: {exc}") from exc
    text = "\n\n".join(p.strip() for p in pages if p.strip())
    if not text:
        raise ValueError("This PDF holds no text (it may be a scan). Upload the document it was made from.")
    return from_text(text)


def from_upload(name: str, data: bytes) -> tuple[str, str]:
    """An uploaded file -> (a title from its name, its content in the safe HTML form)."""
    stem, dot, ext = (name or "document").rpartition(".")
    ext = ("." + ext.lower()) if dot else ""
    if ext not in TYPES:
        raise ValueError("Upload a Word document (.docx), a PDF, a web page (.html), Markdown (.md) or plain text (.txt).")
    if not data:
        raise ValueError("The file is empty.")
    if ext == ".docx":
        content = from_docx(data)
    elif ext == ".pdf":
        content = from_pdf(data)
    else:
        text = data.decode("utf-8-sig", errors="replace")
        content = clean_html(text) if ext in (".html", ".htm") else from_markdown(text) if ext == ".md" else from_text(text)
    if not re.sub(r"<[^>]+>", "", content).strip():
        raise ValueError("No text was found in the file.")
    title = re.sub(r"[_\s]+", " ", (stem or name).rsplit("/", 1)[-1]).strip()[:200] or "Document"
    return title, content


# -- out ----------------------------------------------------------------------------------------------------------
class _Blocks(HTMLParser):
    """The safe HTML as a list of blocks for writing a Word file: (kind, runs) and ("table", rows of cells of runs)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[tuple[str, Any]] = []
        self.runs: list[tuple[str, frozenset[str], str]] | None = None
        self.kind = "p"
        self.marks: list[str] = []
        self.href = ""
        self.lists: list[str] = []
        self.table: list[list[list[tuple[str, frozenset[str], str]]]] | None = None

    def _open(self, kind: str) -> None:
        self._close()
        self.kind, self.runs = kind, []

    def _close(self) -> None:
        if self.runs is not None and any(t.strip() for t, _, _ in self.runs):
            if self.table is not None and self.kind == "cell":
                self.table[-1].append(self.runs)
            else:
                self.blocks.append((self.kind, self.runs))
        elif self.runs is not None and self.table is not None and self.kind == "cell":
            self.table[-1].append([])
        self.runs = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("ul", "ol"):
            self._close()
            self.lists.append(tag)
        elif tag == "table":
            self._close()
            self.table = []
        elif tag == "tr" and self.table is not None:
            self.table.append([])
        elif tag in ("td", "th"):
            self._open("cell")
        elif tag == "li":
            self._open("li:" + (self.lists[-1] if self.lists else "ul"))
        elif tag in ("p", "h1", "h2", "h3", "h4", "blockquote", "pre"):
            if not (self.runs is not None and self.kind in ("cell",) or (self.runs is not None and self.kind.startswith("li:"))):
                self._open(tag)
        elif tag == "br" and self.runs is not None:
            self.runs.append(("\n", frozenset(self.marks), self.href))
        elif tag in ("strong", "b", "em", "i", "u"):
            self.marks.append({"strong": "b", "b": "b", "em": "i", "i": "i", "u": "u"}[tag])
        elif tag == "a":
            self.href = next((v or "" for k, v in attrs if k == "href"), "")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("ul", "ol"):
            self._close()
            if self.lists:
                self.lists.pop()
        elif tag == "table":
            self._close()
            if self.table is not None:
                self.blocks.append(("table", self.table))
            self.table = None
        elif tag in ("td", "th", "li", "p", "h1", "h2", "h3", "h4", "blockquote", "pre"):
            if tag in ("td", "th", "li") or self.kind == tag:
                self._close()
        elif tag in ("strong", "b", "em", "i", "u"):
            mark = {"strong": "b", "b": "b", "em": "i", "i": "i", "u": "u"}[tag]
            if mark in self.marks:
                self.marks.remove(mark)
        elif tag == "a":
            self.href = ""

    def handle_data(self, data: str) -> None:
        if self.runs is None:
            if not data.strip():
                return
            self._open("p")
        assert self.runs is not None
        self.runs.append((data, frozenset(self.marks), self.href))


def _docx_runs(runs: list[tuple[str, frozenset[str], str]], rels: list[str]) -> str:
    out = []
    for text, marks, href in runs:
        props = "".join(f"<w:{m}/>" for m in ("b", "i") if m in marks) + ('<w:u w:val="single"/>' if "u" in marks else "")
        if href:
            props += '<w:rStyle w:val="Hyperlink"/>'
        body = "".join("<w:br/>" if part == "\n" else f'<w:t xml:space="preserve">{x(part)}</w:t>' for part in re.split(r"(\n)", text) if part)
        run = f"<w:r>{f'<w:rPr>{props}</w:rPr>' if props else ''}{body}</w:r>"
        if href:
            rels.append(href)
            run = f'<w:hyperlink r:id="rLink{len(rels)}">{run}</w:hyperlink>'
        out.append(run)
    return "".join(out)


def _titled(title: str, content: str) -> bool:
    """True when the document already opens with its title as a heading, so an export does not print it twice."""
    first = re.match(r"\s*<h1>(.*?)</h1>", content, re.S)
    return bool(first) and re.sub(r"<[^>]+>", "", html.unescape(first.group(1))).strip().lower() == title.strip().lower()


_STYLES = "".join(
    f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{name}"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="{before}" w:after="120"/>'
    f'<w:outlineLvl w:val="{lvl}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{size}"/></w:rPr></w:style>'
    for sid, name, before, lvl, size in (("Heading1", "heading 1", 360, 0, 36), ("Heading2", "heading 2", 280, 1, 30),
                                         ("Heading3", "heading 3", 240, 2, 26), ("Heading4", "heading 4", 200, 3, 24)))


def to_docx(title: str, content: str) -> bytes:
    """The document as a Word file: its title, then its headings, paragraphs, lists, links and tables."""
    content = clean_html(content)
    parser = _Blocks()
    parser.feed(content)
    parser.close()
    parser._close()
    rels: list[str] = []
    body = [] if _titled(title, content) else [f'<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">{x(title)}</w:t></w:r></w:p>']
    for kind, value in parser.blocks:
        if kind == "table":
            rows = "".join("<w:tr>" + "".join(f'<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>{_docx_runs(cell, rels)}</w:p></w:tc>' for cell in row) + "</w:tr>"
                           for row in value if row)
            body.append('<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>'
                        + "".join(f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>' for side in ("top", "left", "bottom", "right", "insideH", "insideV"))
                        + f"</w:tblBorders></w:tblPr>{rows}</w:tbl>")
            continue
        props = ""
        if kind in ("h1", "h2", "h3", "h4"):
            props = f'<w:pStyle w:val="Heading{kind[1]}"/>'
        elif kind.startswith("li:"):
            props = f'<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="{2 if kind == "li:ol" else 1}"/></w:numPr>'
        elif kind == "blockquote":
            props = '<w:ind w:left="720"/>'
        body.append(f"<w:p>{f'<w:pPr>{props}</w:pPr>' if props else ''}{_docx_runs(value, rels)}</w:p>")
    ns = f'xmlns:w="{W}" xmlns:r="{R}"'
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                               '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
                               '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                               '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                               '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                       '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {ns}><w:body>{"".join(body)}'
                             '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
                             "</w:body></w:document>",
        "word/styles.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {ns}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>'
                           '<w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
                           '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
                           '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>'
                           f'{_STYLES}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>'
                           '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1155CC"/><w:u w:val="single"/></w:rPr></w:style>'
                           '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>',
        "word/numbering.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering {ns}>'
                              '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>'
                              '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
                              '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>'
                              '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
                              '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
        "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                                        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                                        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
                                        + "".join(f'<Relationship Id="rLink{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="{x(href, {chr(34): "&quot;"})}" TargetMode="External"/>'
                                                  for i, href in enumerate(rels, 1)) + "</Relationships>",
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)
    return out.getvalue()


def to_html_file(title: str, content: str) -> bytes:
    page = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + html.escape(title) + "</title><style>"
            "body{font:16px/1.6 Arial,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;color:#1f1f1f}"
            "table{border-collapse:collapse}td,th{border:1px solid #999;padding:.3rem .6rem;vertical-align:top}"
            "</style></head><body>" + ("" if _titled(title, clean_html(content)) else "<h1>" + html.escape(title) + "</h1>\n") + clean_html(content) + "\n</body></html>")
    return page.encode("utf-8")


def to_text(content: str) -> str:
    """The document as plain text: a blank line between paragraphs, a dash before each list item, tabs between cells."""
    s = clean_html(content)
    s = re.sub(r"<br>", "\n", s)
    s = re.sub(r"<li>", "- ", s)
    s = re.sub(r"</t[dh]>", "\t", s)
    s = re.sub(r"</(li|tr)>", "\n", s)
    s = re.sub(r"</(p|h[1-4]|blockquote|pre|ul|ol|table)>|<hr>", "\n\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    s = re.sub(r"[ \t]+\n", "\n", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def file_name(title: str, ext: str) -> str:
    stem = re.sub(r"[^\w .()-]+", "", title).strip()[:80] or "document"
    return f"{stem}.{ext}"


def export(title: str, content: str, fmt: str) -> tuple[bytes, str, str]:
    """One document in `fmt` (docx | html | txt): (bytes, media type, file name)."""
    if fmt not in FORMATS:
        raise ValueError("Choose Word (docx), web page (html) or plain text (txt).")
    media, ext = FORMATS[fmt]
    data = to_docx(title, content) if fmt == "docx" else to_html_file(title, content) if fmt == "html" else (("" if _titled(title, clean_html(content)) else title + "\n\n") + to_text(content) + "\n").encode("utf-8")
    return data, media, file_name(title, ext)


def zip_of(files: list[tuple[str, bytes]]) -> bytes:
    """Many documents in one .zip. Two documents with the same title get a number."""
    out = io.BytesIO()
    seen: dict[str, int] = {}
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            n = seen[name] = seen.get(name, 0) + 1
            stem, _, ext = name.rpartition(".")
            z.writestr(name if n == 1 else f"{stem} ({n}).{ext}", data)
    return out.getvalue()
