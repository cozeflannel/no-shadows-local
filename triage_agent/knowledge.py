"""Knowledge docs and retrieval (RAG) for the agent, the Chat answers and the in-Console chat agent.

Carries over the chat bot's Resources tab: each document has a name, a link, what it covers, and whether an external
space may see it; the bot keeps the text itself so an alert never waits on Drive. Order of authority is unchanged:
guidance outranks documents, documents outrank the built-in playbook (the Collection Requirements and protocols in
Settings), and exact product, tag and topic names always come from the taxonomy.

Sources: text pasted in the Console, a public web page, or a Drive file (Docs, Slides, Sheets, and text files).
Retrieval is keyword scoring (BM25), blended with embedding similarity when an embedding model is set in
Settings → Knowledge. Every passage handed to Gemini is named, so answers and assessments can cite it.
"""

from __future__ import annotations

import hashlib
import html
import ipaddress
import logging
import math
import re
import socket
import threading
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import parse_qs, urlparse

from pydantic import BaseModel, Field

from .events import PlatformEvent

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

DOCS = "knowledge_docs"
CHUNKS = "knowledge_chunks"
TEXT = "knowledge_text"
STAMP_KEY = "knowledge:stamp"
TEXT_PART_CHARS = 200_000
SourceType = Literal["text", "url", "drive"]

_WORD = re.compile(r"[a-z0-9][a-z0-9&'+-]*")
_STOP = frozenset("""a an and are as at be but by for from has have i if in into is it its of on or our that the their them
there these they this to was we were what when where which who will with you your not no can do does did so than then
about any all also been more most other some such only over under up down out very just should would could may""".split())


class KnowledgeDoc(BaseModel):
    doc_id: str
    title: str
    source_type: SourceType = "text"
    link: str = ""
    covers: str = ""
    kind: Literal["document", "guidance"] = "document"  # guidance outranks documents
    tags: list[str] = Field(default_factory=list)
    classes: list[str] = Field(default_factory=list)  # classification labels it applies to; empty = every alert
    external_ok: bool = False  # may be used in answers to a space outside the company
    enabled: bool = True
    status: Literal["pending", "ready", "error"] = "pending"
    status_detail: str = ""
    chars: int = 0
    chunks: int = 0
    embedded: bool = False
    content_hash: str = ""
    version: int = 0
    fetched_at: datetime | None = None
    updated_at: datetime | None = None
    updated_by: str = ""


class Passage(BaseModel):
    ref: str  # label Gemini cites, e.g. "KD-4f2a" or "Case TRG-1042"
    doc_id: str
    title: str
    link: str = ""
    kind: str = "document"
    chunk: int = 0
    text: str
    score: float = 0.0


# -- text helpers ----------------------------------------------------------------------------------------------
def _stem(word: str) -> str:
    for suffix in ("ations", "ation", "ments", "ment", "ions", "ion", "ing", "ies", "ed", "es", "s"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            return word[: -len(suffix)]
    return word


def tokenize(text: str | None) -> list[str]:
    return [_stem(w) for w in _WORD.findall((text or "").lower()) if w not in _STOP and len(w) > 1]


def chunk_text(text: str, size: int, overlap: int) -> list[str]:
    """Split on paragraph, then sentence boundaries, into pieces of about `size` characters."""
    text = re.sub(r"\r\n?", "\n", text or "").strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    pieces: list[str] = []
    for para in paragraphs:
        if len(para) <= size:
            pieces.append(para)
            continue
        current = ""
        for sentence in re.split(r"(?<=[.!?])\s+|\n", para):
            while len(sentence) > size:  # a single run longer than a chunk (a table row, a long URL list)
                head, sentence = sentence[:size], sentence[size:]
                if current:
                    pieces.append(current)
                    current = ""
                pieces.append(head)
            if current and len(current) + 1 + len(sentence) > size:
                pieces.append(current)
                current = sentence
            else:
                current = f"{current} {sentence}".strip()
        if current:
            pieces.append(current)
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if current and len(current) + 2 + len(piece) > size:
            chunks.append(current)
            tail = current[-overlap:] if overlap else ""
            current = f"{tail}\n\n{piece}" if tail else piece
        else:
            current = f"{current}\n\n{piece}" if current else piece
    if current:
        chunks.append(current)
    return chunks


def html_to_text(markup: str) -> str:
    markup = re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", markup)
    markup = re.sub(r"(?i)<(br|/p|/div|/li|/tr|/h[1-6])\s*/?>", "\n", markup)
    markup = re.sub(r"(?s)<[^>]+>", " ", markup)
    text = html.unescape(markup)
    text = re.sub(r"[ \t\f\v]+", " ", text)
    return re.sub(r"\n\s*\n\s*", "\n\n", text).strip()


# -- fetching ----------------------------------------------------------------------------------------------------
class FetchError(RuntimeError):
    """A document could not be read; the message says what to do instead."""


def _assert_public(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise FetchError("Only http and https links can be read. Paste the full link.")
    host = parsed.hostname.lower()
    if host in ("metadata.google.internal", "metadata", "localhost") or host.endswith(".internal"):
        raise FetchError("That address is not a public web page.")
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise FetchError(f"The page's address could not be found ({host}).") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise FetchError("That address is not a public web page.")


def fetch_url(url: str, max_chars: int) -> str:
    import requests

    if re.match(r"(?i)^https?://go/|^go/", url.strip()):
        raise FetchError("go/ links can't be read: paste the full link.")
    current = url
    for _ in range(4):  # follow redirects by hand so each hop is checked
        _assert_public(current)
        resp = requests.get(current, timeout=20, allow_redirects=False, headers={"User-Agent": "triage-agent-knowledge/1"})
        if resp.is_redirect or resp.status_code in (301, 302, 303, 307, 308):
            current = requests.compat.urljoin(current, resp.headers.get("Location", ""))
            continue
        break
    else:
        raise FetchError("The page redirects too many times.")
    if resp.status_code in (401, 403):
        raise FetchError("The page is behind a sign-in. Paste its text instead.")
    if resp.status_code >= 400:
        raise FetchError(f"The page answered {resp.status_code}.")
    ctype = resp.headers.get("Content-Type", "").lower()
    if "pdf" in ctype or current.lower().endswith(".pdf"):
        raise FetchError("PDFs can't be read: save it as a Google Doc first, or paste its text.")
    body = resp.text
    text = html_to_text(body) if ("html" in ctype or "<html" in body[:2000].lower()) else body
    return text[:max_chars]


_DRIVE_ID = re.compile(r"/(?:document|spreadsheets|presentation|file)/(?:u/\d+/)?d/([\w-]{20,})")


def drive_file_id(link: str) -> tuple[str | None, str | None]:
    """(file id, sheet gid) from a Docs / Sheets / Slides / Drive link."""
    m = _DRIVE_ID.search(link)
    file_id = m.group(1) if m else None
    if not file_id:
        q = parse_qs(urlparse(link).query)
        file_id = (q.get("id") or [None])[0]
    gid = None
    m = re.search(r"[#?&]gid=(\d+)", link)
    if m:
        gid = m.group(1)
    return file_id, gid


def fetch_drive(link: str, max_chars: int) -> tuple[str, str]:
    """(text, what was read) for a Drive file, read with the service's own account (needs Viewer on the file)."""
    import google.auth
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    if "/folders/" in link:
        raise FetchError("Folders can't be read: link each document.")
    file_id, gid = drive_file_id(link)
    if not file_id:
        raise FetchError("That doesn't look like a Docs, Sheets, Slides or Drive link.")
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/drive.readonly",
                                           "https://www.googleapis.com/auth/spreadsheets.readonly"])
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    try:
        meta = drive.files().get(fileId=file_id, fields="id,name,mimeType,modifiedTime", supportsAllDrives=True).execute()
    except HttpError as exc:
        if exc.resp.status in (403, 404):
            raise FetchError("The agent's account can't open this file: share it with that account (Viewer is enough).") from exc
        raise FetchError(f"Drive answered {exc.resp.status}.") from exc
    mime = meta.get("mimeType", "")
    try:
        if mime == "application/vnd.google-apps.document":
            data = drive.files().export(fileId=file_id, mimeType="text/plain").execute()
            return data.decode("utf-8", "replace")[:max_chars], "Google Doc"
        if mime == "application/vnd.google-apps.presentation":
            data = drive.files().export(fileId=file_id, mimeType="text/plain").execute()
            return data.decode("utf-8", "replace")[:max_chars], "Google Slides"
        if mime == "application/vnd.google-apps.spreadsheet":
            sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
            book = sheets.spreadsheets().get(spreadsheetId=file_id, fields="sheets.properties").execute()
            tabs = [s["properties"] for s in book.get("sheets", [])]
            if gid is not None:
                tabs = [t for t in tabs if str(t.get("sheetId")) == gid]
                if not tabs:
                    raise FetchError("The link names a tab that is no longer in the spreadsheet.")
            parts, total = [], 0
            for tab in tabs:
                values = sheets.spreadsheets().values().get(spreadsheetId=file_id, range=f"'{tab['title']}'").execute().get("values", [])
                body = "\n".join("\t".join(str(c) for c in row) for row in values)
                parts.append(f"# {tab['title']}\n{body}")
                total += len(body)
                if total >= max_chars:
                    break
            label = f'Google Sheet, tab "{tabs[0]["title"]}"' if gid is not None else f"Google Sheet, {len(parts)} tab(s)"
            return "\n\n".join(parts)[:max_chars], label
        if mime.startswith("text/") or mime in ("application/json", "application/xml"):
            data = drive.files().get_media(fileId=file_id, supportsAllDrives=True).execute()
            text = data.decode("utf-8", "replace")
            return (html_to_text(text) if "html" in mime else text)[:max_chars], "Drive file"
    except HttpError as exc:
        raise FetchError(f"Drive answered {exc.resp.status} reading the file.") from exc
    raise FetchError("This file type can't be read (PDF, Word, Excel, PowerPoint): save it as a Google Doc, Sheet or Slides first.")


# -- storage -----------------------------------------------------------------------------------------------------
def _bump(ctx: "AgentContext") -> None:
    ctx.store.put_kv(STAMP_KEY, {"at": ctx.now().isoformat(), "nonce": uuid.uuid4().hex[:8]})


def list_docs(ctx: "AgentContext") -> list[KnowledgeDoc]:
    docs = [KnowledgeDoc.model_validate(r) for r in ctx.store.list_docs(DOCS, limit=2000)]
    docs.sort(key=lambda d: (d.kind != "guidance", d.title.lower()))
    return docs


def get_doc(ctx: "AgentContext", doc_id: str) -> KnowledgeDoc | None:
    row = ctx.store.get_doc(DOCS, doc_id)
    return KnowledgeDoc.model_validate(row) if row else None


def get_text(ctx: "AgentContext", doc_id: str) -> str:
    parts = ctx.store.list_docs(TEXT, where={"doc_id": doc_id}, limit=200)
    parts.sort(key=lambda p: p.get("part", 0))
    return "".join(p.get("text", "") for p in parts)


def _replace_parts(ctx: "AgentContext", collection: str, doc_id: str, rows: list[dict[str, Any]], key: str) -> None:
    old = ctx.store.list_docs(collection, where={"doc_id": doc_id}, limit=5000)
    keep = set()
    for row in rows:
        rid = f"{doc_id}:{row[key]:05d}"
        keep.add(rid)
        ctx.store.put_doc(collection, rid, row)
    for row in old:
        rid = f"{doc_id}:{int(row.get(key, 0)):05d}"
        if rid not in keep:
            ctx.store.delete_doc(collection, rid)


def embed(ctx: "AgentContext", texts: list[str]) -> list[list[float]] | None:
    """Embeddings for `texts`, or None when no embedding model is set or the model can't be reached."""
    cfg = ctx.config.platform.knowledge
    if not cfg.embedding_model or not texts:
        return None
    embedder = getattr(ctx.llm, "embed", None)
    if not callable(embedder):
        return None
    try:
        return embedder(texts=texts, model=cfg.embedding_model, dimensions=cfg.embedding_dimensions or None,
                        location=cfg.embedding_location or None)
    except Exception as exc:  # noqa: BLE001 - keyword retrieval still works
        log.warning("embedding unavailable (%s): keyword retrieval only", exc)
        return None


def index_doc(ctx: "AgentContext", doc: KnowledgeDoc, text: str, actor: str) -> KnowledgeDoc:
    """Store `text` as the document's content: text parts, chunks and (when set up) embeddings."""
    cfg = ctx.config.platform.knowledge
    text = (text or "")[: cfg.max_doc_chars]
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    pieces = chunk_text(text, cfg.chunk_chars, cfg.chunk_overlap)
    vectors = embed(ctx, pieces) if pieces else None
    _replace_parts(ctx, TEXT, doc.doc_id, [
        {"doc_id": doc.doc_id, "part": i, "text": text[o:o + TEXT_PART_CHARS]}
        for i, o in enumerate(range(0, len(text), TEXT_PART_CHARS))], "part")
    _replace_parts(ctx, CHUNKS, doc.doc_id, [
        {"doc_id": doc.doc_id, "n": i, "text": piece, "embedding": (vectors[i] if vectors else None)}
        for i, piece in enumerate(pieces)], "n")
    changed = digest != doc.content_hash
    doc.chars, doc.chunks, doc.embedded = len(text), len(pieces), bool(vectors)
    doc.content_hash, doc.fetched_at = digest, ctx.now()
    doc.status, doc.status_detail = ("ready", doc.status_detail if doc.status_detail and not changed else "") if text else ("error", "The document is empty.")
    if changed:
        doc.version += 1
    doc.updated_at, doc.updated_by = ctx.now(), actor
    ctx.store.put_doc(DOCS, doc.doc_id, doc.model_dump(mode="json"))
    _bump(ctx)
    ctx.emit(PlatformEvent.KNOWLEDGE_INDEXED, actor=actor, payload={"doc_id": doc.doc_id, "chars": doc.chars, "chunks": doc.chunks,
                                                                   "embedded": doc.embedded, "changed": changed})
    return doc


def refresh_doc(ctx: "AgentContext", doc: KnowledgeDoc, actor: str = "agent") -> KnowledgeDoc:
    """Read a linked document again and re-index it when its text changed."""
    cfg = ctx.config.platform.knowledge
    if doc.source_type == "text":
        return doc
    try:
        if doc.source_type == "url":
            text, label = fetch_url(doc.link, cfg.max_doc_chars), "Web page"
        else:
            text, label = fetch_drive(doc.link, cfg.max_doc_chars)
    except FetchError as exc:
        doc.status, doc.status_detail, doc.fetched_at = "error", str(exc), ctx.now()
        ctx.store.put_doc(DOCS, doc.doc_id, doc.model_dump(mode="json"))
        return doc
    except Exception as exc:  # noqa: BLE001 - tried again on the next refresh
        doc.status, doc.status_detail, doc.fetched_at = "error", f"Could not be read: {exc}"[:300], ctx.now()
        ctx.store.put_doc(DOCS, doc.doc_id, doc.model_dump(mode="json"))
        return doc
    doc.status_detail = label
    if hashlib.sha256(text[: cfg.max_doc_chars].encode("utf-8")).hexdigest() == doc.content_hash and doc.status == "ready":
        doc.fetched_at = ctx.now()
        ctx.store.put_doc(DOCS, doc.doc_id, doc.model_dump(mode="json"))
        return doc
    doc = index_doc(ctx, doc, text, actor)
    doc.status_detail = label
    ctx.store.put_doc(DOCS, doc.doc_id, doc.model_dump(mode="json"))
    return doc


def save_doc(ctx: "AgentContext", *, actor: str, doc_id: str | None = None, title: str, source_type: SourceType = "text",
             link: str = "", text: str | None = None, covers: str = "", kind: str = "document", tags: list[str] | None = None,
             classes: list[str] | None = None, external_ok: bool = False, enabled: bool = True) -> KnowledgeDoc:
    from . import audit

    existing = get_doc(ctx, doc_id) if doc_id else None
    doc = existing or KnowledgeDoc(doc_id=f"KD-{uuid.uuid4().hex[:8]}", title=title)
    relinked = existing is not None and (existing.link != link or existing.source_type != source_type)
    doc.title, doc.source_type, doc.link, doc.covers = title.strip(), source_type, link.strip(), covers.strip()
    doc.kind = kind if kind in ("document", "guidance") else "document"  # type: ignore[assignment]
    doc.tags = sorted({t.strip() for t in (tags or []) if t.strip()})
    doc.classes = sorted({c.strip() for c in (classes or []) if c.strip()})
    doc.external_ok, doc.enabled = bool(external_ok), bool(enabled)
    doc.updated_at, doc.updated_by = ctx.now(), actor
    ctx.store.put_doc(DOCS, doc.doc_id, doc.model_dump(mode="json"))
    if source_type == "text":
        if text is not None:
            doc = index_doc(ctx, doc, text, actor)
    elif existing is None or relinked or doc.status != "ready":
        doc.content_hash = "" if relinked else doc.content_hash
        doc = refresh_doc(ctx, doc, actor)
    _bump(ctx)
    ctx.emit(PlatformEvent.KNOWLEDGE_DOC_SAVED, actor=actor, payload={"doc_id": doc.doc_id, "title": doc.title, "kind": doc.kind,
                                                                     "new": existing is None})
    audit.record(ctx, actor=actor, action="knowledge.save", surface="console", target_type="knowledge", target_id=doc.doc_id,
                 summary=f"{'Added' if existing is None else 'Updated'} knowledge doc “{doc.title}” ({doc.status})")
    return doc


def delete_doc(ctx: "AgentContext", doc_id: str, actor: str) -> bool:
    from . import audit

    doc = get_doc(ctx, doc_id)
    if doc is None:
        return False
    _replace_parts(ctx, TEXT, doc_id, [], "part")
    _replace_parts(ctx, CHUNKS, doc_id, [], "n")
    ctx.store.delete_doc(DOCS, doc_id)
    _bump(ctx)
    ctx.emit(PlatformEvent.KNOWLEDGE_DOC_REMOVED, actor=actor, payload={"doc_id": doc_id, "title": doc.title})
    audit.record(ctx, actor=actor, action="knowledge.delete", surface="console", target_type="knowledge", target_id=doc_id,
                 summary=f"Removed knowledge doc “{doc.title}”")
    return True


def refresh_due(ctx: "AgentContext", force: bool = False) -> dict[str, int]:
    """Re-read linked documents that are due: Drive files every refresh_minutes, web pages every
    web_refresh_hours, a document that failed every 30 minutes (as the chat bot did)."""
    cfg = ctx.config.platform.knowledge
    now = ctx.now()
    counts = {"checked": 0, "changed": 0, "failed": 0}
    for doc in list_docs(ctx):
        if doc.source_type == "text" or not doc.enabled:
            continue
        if doc.status == "error":
            wait = timedelta(minutes=30)
        elif doc.source_type == "url":
            wait = timedelta(hours=cfg.web_refresh_hours)
        else:
            wait = timedelta(minutes=cfg.refresh_minutes)
        if not force and doc.fetched_at and now - doc.fetched_at < wait:
            continue
        before = doc.content_hash
        doc = refresh_doc(ctx, doc)
        counts["checked"] += 1
        counts["changed"] += 1 if doc.content_hash != before else 0
        counts["failed"] += 1 if doc.status == "error" else 0
    return counts


# -- retrieval -----------------------------------------------------------------------------------------------------
class _Index:
    def __init__(self, docs: dict[str, KnowledgeDoc], chunks: list[dict[str, Any]]):
        self.docs = docs
        self.chunks = chunks
        self.tokens = [tokenize(c["text"]) for c in chunks]
        self.df: dict[str, int] = {}
        for toks in self.tokens:
            for t in set(toks):
                self.df[t] = self.df.get(t, 0) + 1
        self.avg_len = (sum(len(t) for t in self.tokens) / len(self.tokens)) if self.tokens else 0.0
        self.total_chars = sum(len(c["text"]) for c in chunks)


_INDEX_LOCK = threading.Lock()
_INDEX_CACHE: dict[int, tuple[Any, _Index]] = {}


def _index(ctx: "AgentContext") -> _Index:
    stamp = ctx.store.get_kv(STAMP_KEY)
    key = id(ctx.store)
    with _INDEX_LOCK:
        hit = _INDEX_CACHE.get(key)
        if hit and hit[0] == stamp:
            return hit[1]
    docs = {d.doc_id: d for d in list_docs(ctx) if d.enabled and d.status == "ready"}
    chunks = [c for c in ctx.store.list_docs(CHUNKS, limit=50000) if c.get("doc_id") in docs]
    chunks.sort(key=lambda c: (c["doc_id"], c.get("n", 0)))
    built = _Index(docs, chunks)
    with _INDEX_LOCK:
        _INDEX_CACHE[key] = (stamp, built)
    return built


def _bm25(index: _Index, query_tokens: list[str]) -> list[float]:
    n = len(index.tokens)
    scores = [0.0] * n
    if not n or not query_tokens:
        return scores
    k1, b = 1.4, 0.75
    for i, toks in enumerate(index.tokens):
        if not toks:
            continue
        counts: dict[str, int] = {}
        for t in toks:
            counts[t] = counts.get(t, 0) + 1
        score = 0.0
        for q in set(query_tokens):
            tf = counts.get(q, 0)
            if not tf:
                continue
            idf = math.log(1 + (n - index.df.get(q, 0) + 0.5) / (index.df.get(q, 0) + 0.5))
            score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(toks) / (index.avg_len or 1)))
        scores[i] = score
    return scores


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def docs_for_class(ctx: "AgentContext", label: str | None) -> set[str] | None:
    """Doc ids a classification maps to (Settings → Knowledge → classification mapping). None = no restriction."""
    if not label:
        return None
    cls = next((c for c in classes(ctx) if c.name.lower() == label.lower()), None)
    wanted_tags = {t.lower() for t in (cls.knowledge_tags if cls else [])}
    fixed = set(cls.knowledge_docs if cls else [])
    out = set(fixed)
    for doc in list_docs(ctx):
        if label.lower() in {c.lower() for c in doc.classes} or (wanted_tags & {t.lower() for t in doc.tags}):
            out.add(doc.doc_id)
        elif not doc.classes and not wanted_tags and not fixed:
            out.add(doc.doc_id)  # an unmapped class reads documents that are not tied to another class
    return out or None


def classes(ctx: "AgentContext") -> list[Any]:
    """The classes of the classification layer: Settings, else one per exposure tag category."""
    from .config import ClassDef

    configured = ctx.config.platform.classification.classes
    if configured:
        return list(configured)
    seen: dict[str, ClassDef] = {}
    for tag in ctx.config.collection.exposure_tags:
        name = (getattr(tag, "category", "") or "").strip()
        if name and name not in seen:
            seen[name] = ClassDef(name=name, description=f"Alerts whose exposure tag is in the {name} category.")
    return list(seen.values())


def retrieve(ctx: "AgentContext", query: str, *, label: str | None = None, external: bool = False, top_k: int | None = None,
             budget_chars: int = 24000, include_cases: bool = False, exclude_case_id: str | None = None) -> list[Passage]:
    """Passages for `query`, best first. Guidance comes before documents.

    All of the allowed knowledge is returned when it fits `budget_chars` (as the chat bot handed Gemini every
    document when they fit); otherwise the best-scoring passages. `external` keeps only documents marked safe for
    an external space."""
    cfg = ctx.config.platform.knowledge
    k = top_k or cfg.top_k
    index = _index(ctx)
    allowed = docs_for_class(ctx, label)
    candidates = []
    for i, chunk in enumerate(index.chunks):
        doc = index.docs[chunk["doc_id"]]
        if external and not doc.external_ok:
            continue
        if allowed is not None and doc.doc_id not in allowed and doc.kind != "guidance":
            continue
        candidates.append(i)
    passages: list[Passage] = []
    if candidates:
        total = sum(len(index.chunks[i]["text"]) for i in candidates)
        if total <= budget_chars:
            chosen = [(i, 1.0) for i in candidates]
        else:
            lexical = _bm25(index, tokenize(query))
            top = max((lexical[i] for i in candidates), default=0.0) or 1.0
            scores = {i: lexical[i] / top for i in candidates}
            if any(index.chunks[i].get("embedding") for i in candidates):
                qv = embed(ctx, [query[:8000]])
                if qv:
                    for i in candidates:
                        vec = index.chunks[i].get("embedding")
                        if vec:
                            scores[i] = 0.5 * scores[i] + 0.5 * max(0.0, _cosine(qv[0], vec))
            ranked = sorted(candidates, key=lambda i: scores[i], reverse=True)
            chosen = [(i, scores[i]) for i in ranked if scores[i] >= cfg.min_score][:k]
            guidance = [(i, max(scores[i], cfg.min_score)) for i in candidates
                        if index.docs[index.chunks[i]["doc_id"]].kind == "guidance" and i not in {c[0] for c in chosen}]
            used = sum(len(index.chunks[i]["text"]) for i, _ in chosen)
            for i, s in guidance:  # guidance always applies while it fits
                if used + len(index.chunks[i]["text"]) > budget_chars:
                    break
                chosen.append((i, s))
                used += len(index.chunks[i]["text"])
        for i, score in chosen:
            chunk = index.chunks[i]
            doc = index.docs[chunk["doc_id"]]
            passages.append(Passage(ref=doc.doc_id, doc_id=doc.doc_id, title=doc.title, link=doc.link, kind=doc.kind,
                                    chunk=int(chunk.get("n", 0)), text=chunk["text"], score=round(float(score), 4)))
    passages.sort(key=lambda p: (p.kind != "guidance", -p.score, p.doc_id, p.chunk))
    if include_cases and not external and cfg.past_cases_days and cfg.past_cases_top_k:
        passages += past_cases(ctx, query, exclude_case_id=exclude_case_id)
    return passages


def past_cases(ctx: "AgentContext", query: str, *, exclude_case_id: str | None = None) -> list[Passage]:
    """Recent cases most like `query`, as passages: what the alert was, the verdict and what the IMs did."""
    cfg = ctx.config.platform.knowledge
    q = set(tokenize(query))
    if not q:
        return []
    since = ctx.now() - timedelta(days=cfg.past_cases_days)
    scored = []
    for case in ctx.store.list_cases(since=since, limit=500):
        if case.case_id == exclude_case_id or not case.latest:
            continue
        fields = case.latest.result.normalized or {}
        text = " ".join(str(v) for v in (case.alert_name, case.issue_name, fields.get("summary"), fields.get("post_content")) if v)
        toks = set(tokenize(text))
        if not toks:
            continue
        score = len(q & toks) / len(q | toks)
        if score >= 0.12:
            scored.append((score, case))
    scored.sort(key=lambda s: s[0], reverse=True)
    out = []
    for score, case in scored[: cfg.past_cases_top_k]:
        result = case.latest.result
        applied = [f"{c.field}: {c.old} → {c.new}" for c in result.corrections if c.applied and not c.reverted_by][:4]
        actions = ", ".join(dict.fromkeys(a.code for a in case.actions)) or "none"
        review = f" IM review: {case.review.decision}" + (f" ({case.review.reason})" if case.review and case.review.reason else "") if case.review else ""
        text = (f"{case.alert_name or case.issue_name or 'Alert'}\nVerdict: {result.verdict.value}; status: {case.status.value}; "
                f"tag: {case.exposure_tag}; product: {case.product}; track: {case.track or 'none'}.\n"
                f"Corrections applied: {'; '.join(applied) or 'none'}. IM actions: {actions}.{review}"
                + (f"\nIM marked the agent's call wrong ({case.verdict_overridden_by})." if case.verdict_overridden_by else ""))
        out.append(Passage(ref=f"Case {case.case_id}", doc_id=case.case_id, title=case.alert_name or case.case_id, kind="case",
                           text=text, score=round(score, 4)))
    return out


def render_passages(passages: list[Passage], max_chars: int = 24000) -> str:
    """The block handed to Gemini: each passage under the label it must cite."""
    out, used = [], 0
    for p in passages:
        head = f"[{p.ref}] {p.title}" + (" (guidance: overrides documents)" if p.kind == "guidance" else "")
        block = f"{head}\n{p.text.strip()}"
        if used + len(block) > max_chars:
            break
        out.append(block)
        used += len(block)
    return "\n\n".join(out)


def citations(passages: list[Passage], cited_refs: list[str] | None = None) -> list[dict[str, Any]]:
    """One entry per document used (optionally only those Gemini named)."""
    wanted = {r.strip().strip("[]").lower() for r in (cited_refs or []) if r}
    seen: dict[str, dict[str, Any]] = {}
    for p in passages:
        if wanted and p.ref.lower() not in wanted:
            continue
        entry = seen.setdefault(p.ref, {"ref": p.ref, "doc_id": p.doc_id, "title": p.title, "link": p.link, "kind": p.kind,
                                        "score": p.score, "excerpt": p.text[:280]})
        entry["score"] = max(entry["score"], p.score)
    return list(seen.values())
