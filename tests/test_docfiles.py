"""Knowledge documents as files. Every test reads or writes real file bytes: a Word file is built and read back,
a PDF is parsed with the real reader, and unsafe markup is cleaned by the real cleaner."""

from __future__ import annotations

import io
import zipfile

import pytest

from triage_agent import docfiles

RICH = ('<h1>Escalation process</h1><p>Call the <strong>on-call lead</strong> first, then <em>post</em> in the <u>team space</u>. '
        'See <a href="https://example.com/runbook">the runbook</a>.</p><h2>Who to call</h2>'
        "<ul><li>Comms lead</li><li>Legal</li></ul><ol><li>Check the post</li><li>Size it</li></ol>"
        "<table><tbody><tr><td>Tag</td><td>Owner</td></tr><tr><td>Privacy</td><td>Legal</td></tr></tbody></table>")


def pdf_with(text: str) -> bytes:
    """A one-page PDF holding `text`, written out by hand with its cross-reference table."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
               b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    return out + f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


def test_a_word_file_written_from_a_document_reads_back_with_its_formatting():
    data = docfiles.to_docx("Escalation process", RICH)
    assert zipfile.ZipFile(io.BytesIO(data)).testzip() is None and data[:2] == b"PK"
    title, back = docfiles.from_upload("Escalation_process.docx", data)
    assert title == "Escalation process"
    assert back.startswith("<h1>Escalation process</h1>\n<p>Call the"), "a document that opens with its title is not given a second one"
    untitled = docfiles.from_docx(docfiles.to_docx("KOF handling", "<p>A KOF alert is URGENT.</p>"))
    assert untitled == "<h1>KOF handling</h1>\n<p>A KOF alert is URGENT.</p>", "one with no heading gets its title at the top"
    for piece in ("<strong>on-call lead</strong>", "<em>post</em>", "<u>team space</u>", '<a href="https://example.com/runbook">the runbook</a>',
                  "<h2>Who to call</h2>", "<ul>\n<li>Comms lead</li>\n<li>Legal</li>\n</ul>", "<ol>\n<li>Check the post</li>\n<li>Size it</li>\n</ol>",
                  "<table><tbody><tr><td>Tag</td><td>Owner</td></tr><tr><td>Privacy</td><td>Legal</td></tr></tbody></table>"):
        assert piece in back, piece


def test_markup_that_could_run_code_never_survives():
    dirty = ('<p onclick="steal()">Hello <script>alert(1)</script><img src=x onerror=alert(2)>world</p><style>p{color:red}</style>'
             '<a href="javascript:alert(3)">bad</a> <a href="https://example.com/ok" target="_blank">good</a><iframe src="https://x.example"></iframe>')
    clean = docfiles.clean_html(dirty)
    assert clean == '<p>Hello world</p><a>bad</a> <a href="https://example.com/ok">good</a>'


def test_text_and_markdown_become_paragraphs_headings_and_lists():
    assert docfiles.from_text("First line\nsecond line\n\nNext <para>") == "<p>First line<br>second line</p>\n<p>Next &lt;para&gt;</p>"
    md = "# Title\n\nSome **bold** and *soft* words with [a link](https://example.com/a).\n\n- one\n- two\n\n1. first\n2. second\n"
    assert docfiles.from_markdown(md) == ('<h1>Title</h1>\n<p>Some <strong>bold</strong> and <em>soft</em> words with <a href="https://example.com/a">a link</a>.</p>\n'
                                          "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>")


def test_a_pdf_is_read_and_a_file_that_cannot_be_used_says_why():
    title, content = docfiles.from_upload("Collection requirements.pdf", pdf_with("Alerts need a post link"))
    assert title == "Collection requirements" and content == "<p>Alerts need a post link</p>"
    for name, data, why in (("notes.xlsx", b"x", "Upload a Word document"), ("empty.txt", b"", "empty"), ("broken.docx", b"not a zip", "not a Word document"),
                            ("blank.html", b"<script>1</script>", "No text was found")):
        with pytest.raises(ValueError, match=why):
            docfiles.from_upload(name, data)


def test_a_document_exports_as_word_a_web_page_or_text_and_many_as_one_zip():
    data, media, name = docfiles.export("Escalation: process / v2", RICH, "html")
    assert name == "Escalation process  v2.html" and media.startswith("text/html") and b"<h2>Who to call</h2>" in data and b"<script" not in data
    text, _, name = docfiles.export("Notes", "<p>One</p><p>Two</p>", "txt")
    assert name == "Notes.txt" and text.decode() == "Notes\n\nOne\n\nTwo\n"
    with pytest.raises(ValueError, match="Choose Word"):
        docfiles.export("Notes", "<p>One</p>", "rtf")
    z = zipfile.ZipFile(io.BytesIO(docfiles.zip_of([("Notes.txt", b"a"), ("Notes.txt", b"b"), ("Other.txt", b"c")])))
    assert z.namelist() == ["Notes.txt", "Notes (2).txt", "Other.txt"] and z.read("Notes (2).txt") == b"b"


# ---------------------------------------------------------------------------------------------------------------
# On the Knowledge page: upload, edit in the editor, export one or all (the real routes and the real store)
# ---------------------------------------------------------------------------------------------------------------

from test_platform import ADMIN, IM, LEAD, client, iap  # noqa: E402,F401 - fixtures and identities


def upload(client, name: str, data: bytes, user: str = LEAD, **params: str):
    return client.post("/api/knowledge/upload", params={"filename": name, **params}, content=data,
                       headers={**iap(user), "Content-Type": "application/octet-stream"})


def test_a_document_is_uploaded_edited_in_the_editor_and_searched(ctx, client):
    assert upload(client, "Escalation process.docx", docfiles.to_docx("Escalation process", RICH), user=IM).status_code == 403
    made = upload(client, "Escalation process.docx", docfiles.to_docx("Escalation process", RICH), covers="Who to call")
    assert made.status_code == 200, made.text
    doc = made.json()["doc"]
    assert (doc["title"], doc["status"], doc["rich"], doc["file_name"], doc["covers"]) == ("Escalation process", "ready", True, "Escalation process.docx", "Who to call")
    got = client.get(f"/api/knowledge/{doc['doc_id']}", headers=iap(IM)).json()
    assert "<h2>Who to call</h2>" in got["html"] and "Call the on-call lead first" in got["text"] and got["editable"] is True
    found = client.post("/api/knowledge/search", json={"query": "who do I call first on-call lead"}, headers=iap(IM)).json()["passages"]
    assert found and found[0]["doc_id"] == doc["doc_id"]

    edited = got["html"].replace("on-call lead", "duty manager") + '<p onclick="x()">Added in the editor.<script>bad()</script></p>'
    saved = client.post("/api/knowledge", json={"doc_id": doc["doc_id"], "title": doc["title"], "html": edited, "covers": doc["covers"]}, headers=iap(LEAD))
    assert saved.status_code == 200 and saved.json()["doc"]["version"] == doc["version"] + 1
    again = client.get(f"/api/knowledge/{doc['doc_id']}", headers=iap(IM)).json()
    assert "duty manager" in again["html"] and "<p>Added in the editor.</p>" in again["html"] and "script" not in again["html"] and "onclick" not in again["html"]
    assert "duty manager" in again["text"]
    entry = client.get("/api/audit", params={"action": "knowledge."}, headers=iap(ADMIN)).json()["entries"][0]
    assert entry["action"] == "knowledge.save" and entry["actor"] == LEAD


def test_an_upload_that_cannot_be_used_is_refused_with_the_reason(ctx, client):
    assert "Upload a Word document" in upload(client, "sheet.xlsx", b"x").json()["error"]
    assert "not a Word document" in upload(client, "broken.docx", b"nope").json()["error"]
    ctx.config.platform.knowledge.max_upload_mb = 1
    big = upload(client, "big.txt", b"a" * (1024 * 1024 + 1))
    assert big.status_code == 413 and "1 MB" in big.json()["error"]
    assert client.get("/api/knowledge", headers=iap(IM)).json()["docs"] == []


def test_one_document_or_the_whole_knowledge_base_is_exported(ctx, client):
    a = upload(client, "Escalation process.docx", docfiles.to_docx("Escalation process", RICH)).json()["doc"]
    b = client.post("/api/knowledge", json={"title": "KOF handling", "text": "A KOF alert is URGENT.\n\nCheck the list first."}, headers=iap(LEAD)).json()["doc"]
    word = client.get(f"/api/knowledge/{a['doc_id']}/export", params={"format": "docx"}, headers=iap(IM))
    assert word.status_code == 200 and 'filename="Escalation process.docx"' in word.headers["content-disposition"]
    assert "<h2>Who to call</h2>" in docfiles.from_docx(word.content), "the Word file opens and holds the document"
    text = client.get(f"/api/knowledge/{b['doc_id']}/export", params={"format": "txt"}, headers=iap(IM))
    assert text.text == "KOF handling\n\nA KOF alert is URGENT.\n\nCheck the list first.\n"
    assert client.get(f"/api/knowledge/{b['doc_id']}/export", params={"format": "rtf"}, headers=iap(IM)).status_code == 422
    everything = client.get("/api/knowledge-export", params={"format": "docx"}, headers=iap(IM))
    names = zipfile.ZipFile(io.BytesIO(everything.content)).namelist()
    assert sorted(names) == ["Escalation process.docx", "KOF handling.docx"] and 'filename="knowledge-base.zip"' in everything.headers["content-disposition"]
    actions = [e["action"] for e in client.get("/api/audit", params={"action": "knowledge.export"}, headers=iap(ADMIN)).json()["entries"]]
    assert len(actions) == 3, "each export is on the record"
