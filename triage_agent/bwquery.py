"""A Brandwatch Boolean query as a search of the team's own BigQuery tables, by fixed rules.

This is the temp check app's lib/bwquery.js, rule for rule and word for word. tests/test_bwquery_parity.py asks this
module and the app's own code the same queries and expects the same reading, plan, report, SQL and matches.
Nothing here guesses and nothing calls a model: the same query always converts the same way, and the report says,
clause by clause, what was converted exactly, what was approximated, and what was left out and why.

    parse(text, warnings)    -> Read(tree, implicit, mixed, hoisted)   the query as a tree
    convert(text)            -> Conversion(ok, plan, report, error)    the query as a plan our tables can answer
    to_sql(plan, cols, p)    -> a BigQuery condition; its values are added to `p` as named parameters
    evaluate(plan, post)     -> the same plan run on one post in memory
    prune(plan, has)         -> (the plan without the parts a table has no column for, the fields removed)
    fields_of(plan)          -> the fields a plan asks about
    from_filters(filters)    -> the filter form as a Boolean query (so there is one path)
    show(node, max_chars)    -> a part of the tree written back as a query, for the report

Operators: AND, OR, NOT, brackets, "phrases", wildcards (* and ?), NEAR/n and NEAR/nf, "two words"~n,
{Case Sensitive}, <<<comments>>>, and title:, raw:, guid:, url:, links:, site:, subreddit:, author:, language:,
hashtags:, at_mentions:, authorFollowers:[a TO b].

What our tables cannot answer is left out of the query, and the report says so: engagingWith…:, parentPostId:,
rootPostId: and engagementType: pick out reposts of and replies to particular posts, which our tables do not hold.
A clause left out of an OR makes the result narrower; one left out of an AND makes it wider.

Plan nodes: {k: 'and' | 'or', kids}, {k: 'not', kid}, {k: 'rx', f: 'text' | 'author' | 'url', rx, cs},
{k: 'xid', v: [X post ids]}, {k: 'in', f: 'platform', v}, {k: 'num', f: 'followers', min, max},
{k: 'eq', f: 'language', v}.

The patterns are the ones the app sends to BigQuery (RE2). To run one in memory, Python reads the app's word class
as \\w, its white space as JavaScript's, and `$` as the very end of the text, as JavaScript does.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable

W = r"[\p{L}\p{N}_]"       # a word character
NW = r"[^\p{L}\p{N}_]"     # anything else
B0 = f"(?:^|{NW})"         # where a word starts
B1 = f"(?:$|{NW})"         # where a word ends
MAX_NEAR = 30
MAX_RX_CHARS = 30000        # a longer NEAR pattern is approximated as AND instead
MAX_QUERY_CHARS = 60000

SITE_PLATFORM = {"twitter.com": "x", "x.com": "x", "reddit.com": "reddit", "instagram.com": "instagram",
                 "facebook.com": "facebook", "bsky.app": "bluesky", "youtube.com": "youtube", "tiktok.com": "tiktok",
                 "threads.net": "threads", "threads.com": "threads", "linkedin.com": "linkedin", "tumblr.com": "tumblr"}
PLATFORM_SITE = {"x": "twitter.com", "reddit": "reddit.com", "instagram": "instagram.com", "facebook": "facebook.com",
                 "bluesky": "bsky.app", "youtube": "youtube.com", "tiktok": "tiktok.com", "threads": "threads.net",
                 "linkedin": "linkedin.com"}

# Operators by what becomes of them (names lowercased; Brandwatch reads them in any case)
TEXT_FIELDS = {"title", "raw"}
MAPPED_FIELDS = {"guid", "url", "links", "link", "site", "subreddit", "author", "language", "hashtags", "at_mentions",
                 "authorfollowers"}
# "constructor" and "__proto__" are here because the app looks an operator's name up in a plain JavaScript object,
# where those two names always find something: it reads them as operators of this kind, so this does too.
NOT_IN_OUR_DATA = {"engagingwith", "engagingwithguid", "engagingwithguids", "engagingwithurl", "parentpostid",
                   "rootpostid", "engagementtype", "threadentrytype", "constructor", "__proto__"}
NO_COLUMN = {"country", "continent", "region", "city", "state", "section", "brandids", "authorverified", "authorgender",
             "accounttype", "bio", "authorbio", "authorname", "channelid", "minuteofday", "latitude", "longitude",
             "publishersubtype", "pagetype", "blogname", "forumname", "entityid", "imagetype", "interest", "profession",
             "timezone", "authorlocation"}
KNOWN = TEXT_FIELDS | MAPPED_FIELDS | NOT_IN_OUR_DATA | NO_COLUMN

# White space as JavaScript's \s and trim() have it (Python's own differs by a few rare characters).
_WS = "\t\n\x0b\x0c\r \xa0                　﻿"
_SPACE = re.compile(f"[{_WS}]")
_SPACES = re.compile(f"[{_WS}]+")
_TRAILING = re.compile(r"[,;:!.]+\Z")
_RANGE = re.compile(rf"[{_WS}]*([0-9]+|\*)[{_WS}]+TO[{_WS}]+([0-9]+|\*)[{_WS}]*", re.IGNORECASE | re.ASCII)
_EMPTY_POST = {"text": "", "author": "", "url": "", "platform": "", "followers": None, "language": ""}


@dataclass
class Read:
    """A query as a tree, with what the reader noticed about how it was written."""

    tree: dict[str, Any] | None
    implicit: bool = False  # two terms side by side with no operator
    mixed: bool = False     # AND and OR at one level with no brackets
    hoisted: bool = False   # a NOT after a list of ORs


@dataclass
class Conversion:
    ok: bool
    plan: dict[str, Any] | None = None
    report: dict[str, Any] = field(default_factory=dict)
    error: str = ""


def _trim(text: str) -> str:
    return text.strip(_WS)


def _units(text: str) -> int:
    """A text's length as JavaScript counts it (a character outside the basic plane counts two)."""
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)


def _is_word_char(ch: str) -> bool:
    return ch == "_" or unicodedata.category(ch)[0] in ("L", "N")


# ---------------------------------------------------------------------------------------------------------------
# Reading the query: tokens, then a tree
# ---------------------------------------------------------------------------------------------------------------

def _tokenize(text: Any, warnings: list[str]) -> list[dict[str, Any]]:
    s = re.sub("[“”„‟]", '"', str(text or "")).replace(" ", " ")
    toks: list[dict[str, Any]] = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in _WS:
            i += 1
            continue
        if s.startswith("<<<", i):  # a comment
            end = s.find(">>>", i + 3)
            i = n if end < 0 else end + 3
            continue
        if c in "()":
            toks.append({"t": c})
            i += 1
            continue
        if c == '"':
            end = s.find('"', i + 1)
            if end < 0:
                warnings.append("A quote is never closed: it was read to the end of the query.")
            stop = n if end < 0 else end
            body = s[i + 1:stop]
            i = min(n, stop + 1)
            m = re.match(r"~([0-9]{1,3})", s[i:i + 5])
            if m:
                i += len(m.group(0))
            toks.append({"t": "phrase", "text": body, "slop": int(m.group(1)) if m else 0})
            continue
        if c == "{":
            end = s.find("}", i + 1)
            stop = n if end < 0 else end
            toks.append({"t": "phrase", "text": s[i + 1:stop], "slop": 0, "cs": True})
            i = min(n, stop + 1)
            continue
        if c == "[" and toks and toks[-1]["t"] == "field":  # a range: [1000 TO 50000]
            end = s.find("]", i + 1)
            stop = n if end < 0 else end
            toks.append({"t": "range", "text": s[i + 1:stop]})
            i = min(n, stop + 1)
            continue
        j = i
        while j < n and s[j] not in _WS and s[j] not in '()"':
            j += 1
        word = s[i:j]
        fm = re.match(r"([A-Za-z_]{2,40}):(?!//)", word)
        if fm and fm.group(1).lower() not in ("http", "https"):
            name = fm.group(1).lower()
            after = i + len(fm.group(0))
            attached = len(word) > len(fm.group(0)) or (after < n and s[after] in '("')
            if name in KNOWN or attached:  # an operator: the value follows (after a space too, for one this app knows)
                toks.append({"t": "field", "name": name, "as": fm.group(1)})
                i = after
                continue
        i = j
        if word in ("AND", "OR", "NOT"):
            toks.append({"t": word})
            continue
        near = re.fullmatch(r"NEAR/([0-9]{1,3})(f?)", word)
        if near:
            toks.append({"t": "NEAR", "n": min(MAX_NEAR, int(near.group(1))), "ordered": near.group(2) == "f"})
            continue
        if word in ("and", "or", "not"):
            warnings.append(f'"{word}" in lowercase is read as a word, as Brandwatch reads it. Operators are AND, OR, NOT in capitals.')
        clean = _TRAILING.sub("", word)
        if clean:
            toks.append({"t": "word", "text": clean})
    return toks


class _Reader:
    """The tokens as a tree. Nodes: {t: 'and' | 'or', kids}, {t: 'not', kid}, {t: 'near', a, b, n, ordered},
    {t: 'term', text, cs}, {t: 'phrase', words, slop, cs}, {t: 'field', name, as, value}, {t: 'range', text}."""

    def __init__(self, toks: list[dict[str, Any]], warnings: list[str]):
        self.toks, self.warnings, self.pos = toks, warnings, 0
        self.implicit = self.mixed = self.hoisted = False
        self.excl: list[dict[str, Any]] = []  # what the bracket level being read says NOT to (see group)

    def peek(self) -> dict[str, Any] | None:
        return self.toks[self.pos] if self.pos < len(self.toks) else None

    def is_next(self, kind: str) -> bool:
        t = self.peek()
        return t is not None and t["t"] == kind

    def primary(self) -> dict[str, Any] | None:
        while True:
            t = self.peek()
            if t is None:
                return None
            if t["t"] == "(":
                self.pos += 1
                inner = self.group()
                if self.is_next(")"):
                    self.pos += 1
                else:
                    self.warnings.append("A bracket is never closed: it was closed at the end of the query.")
                if inner:
                    inner["bracketed"] = True
                return inner
            if t["t"] == "word":
                self.pos += 1
                return {"t": "term", "text": t["text"], "cs": False}
            if t["t"] == "phrase":
                self.pos += 1
                words = [w for w in (_TRAILING.sub("", w) for w in _SPACES.split(t["text"])) if w]
                if not words:
                    return None
                if len(words) == 1:
                    return {"t": "term", "text": words[0], "cs": bool(t.get("cs"))}
                return {"t": "phrase", "words": words, "slop": t.get("slop") or 0, "cs": bool(t.get("cs"))}
            if t["t"] == "field":
                self.pos += 1
                v = self.peek()
                value = None
                if v and v["t"] == "range":
                    self.pos += 1
                    value = {"t": "range", "text": v["text"]}
                elif v and v["t"] in ("(", "word", "phrase"):
                    value = self.primary()
                return {"t": "field", "name": t["name"], "as": t["as"], "value": value}
            self.pos += 1  # something out of place (a stray operator or bracket): skipped
            self.warnings.append(f'"{t["t"]}" is out of place and was skipped.')

    def near_expr(self) -> dict[str, Any] | None:
        left = self.primary()
        while self.is_next("NEAR"):
            op = self.toks[self.pos]
            self.pos += 1
            right = self.primary()
            if not left or not right:
                break
            left = {"t": "near", "a": left, "b": right, "n": op["n"], "ordered": op["ordered"]}
        return left

    def not_expr(self) -> dict[str, Any] | None:
        if self.is_next("NOT"):
            self.pos += 1
            kid = self.not_expr()
            return {"t": "not", "kid": kid} if kid else None
        return self.near_expr()

    def and_expr(self) -> dict[str, Any] | None:
        kids: list[dict[str, Any]] = []
        first = self.not_expr()
        if first:
            kids.append(first)
        while True:
            t = self.peek()
            if t and t["t"] == "AND":
                self.pos += 1
                first = self.not_expr()
                if first:
                    kids.append(first)
                continue
            if t and t["t"] == "NOT":  # "… NOT b": b is excluded from this whole bracket level (group)
                self.pos += 1
                first = self.not_expr()
                if first:
                    self.excl.append(first)
                continue
            if t and t["t"] in ("(", "word", "phrase", "field"):
                self.implicit = True
                first = self.not_expr()
                if first:
                    kids.append(first)
                continue
            break
        return {"t": "and", "kids": kids} if len(kids) > 1 else (kids[0] if kids else None)

    def or_expr(self) -> dict[str, Any] | None:
        kids: list[dict[str, Any]] = []
        k = self.and_expr()
        if k:
            kids.append(k)
        while self.is_next("OR"):
            self.pos += 1
            k = self.and_expr()
            if k:
                kids.append(k)
        if len(kids) > 1 and any(x["t"] == "and" and not x.get("bracketed") for x in kids):
            self.mixed = True
        return {"t": "or", "kids": kids} if len(kids) > 1 else (kids[0] if kids else None)

    def group(self) -> dict[str, Any] | None:
        """One bracket level (or the whole query). A NOT that follows a term without AND excludes from everything at
        its level, as Brandwatch reads it: "a OR b OR c NOT d" is "(a OR b OR c) NOT d", which is how the team writes
        exclusions at the end of a query."""
        outer, self.excl = self.excl, []
        node = self.or_expr()
        mine, self.excl = self.excl, outer
        if not mine:
            return node
        if node and node["t"] == "or":
            self.hoisted = True
        nots: list[dict[str, Any]] = [{"t": "not", "kid": kid} for kid in mine]
        if not node:
            return {"t": "and", "kids": nots} if len(nots) > 1 else nots[0]
        return {"t": "and", "kids": [node, *nots], "bracketed": True}


def parse(text: Any, warnings: list[str]) -> Read:
    r = _Reader(_tokenize(text, warnings), warnings)
    tree = r.group()
    while r.pos < len(r.toks):  # what is left after a stray ")"
        before = r.pos
        if r.toks[r.pos]["t"] == ")":
            warnings.append("A closing bracket has no opening one: it was skipped.")
            r.pos += 1
            continue
        op = "or" if r.toks[r.pos]["t"] == "OR" else "and"  # the operator written after the stray bracket, AND when none
        if r.toks[r.pos]["t"] in ("OR", "AND"):
            r.pos += 1
        more = r.group()
        if more:
            warnings.append(f"Part of the query sits after a stray bracket: it was joined with {op.upper()}.")
            tree = {"t": op, "kids": [tree, more]} if tree else more
        if r.pos == before:
            r.pos += 1
    return Read(tree, r.implicit, r.mixed, r.hoisted)


def show(node: dict[str, Any] | None, max_chars: int = 110) -> str:
    """A node written back as a query, shortened to `max_chars` characters: for the report."""

    def one(n: dict[str, Any] | None) -> str:
        if not n:
            return ""
        t = n["t"]
        if t == "term":
            return "{" + n["text"] + "}" if n.get("cs") else n["text"]
        if t == "phrase":
            words = " ".join(n["words"])
            return ("{" + words + "}" if n.get("cs") else f'"{words}"') + (f"~{n['slop']}" if n.get("slop") else "")
        if t == "not":
            return f"NOT {one(n['kid'])}"
        if t == "near":
            return f"{one(n['a'])} NEAR/{n['n']}{'f' if n['ordered'] else ''} {one(n['b'])}"
        if t == "field":
            return f"{n.get('as') or n['name']}:{one(n.get('value'))}"
        if t == "range":
            return f"[{n['text']}]"
        return "(" + (" AND " if t == "and" else " OR ").join(one(k) for k in n["kids"]) + ")"

    s = one(node)
    limit = max_chars or 110
    if _units(s) <= limit:
        return s
    kept, used = [], 0
    for ch in s:  # cut where JavaScript cuts, never through a character
        used += 2 if ord(ch) > 0xFFFF else 1
        if used > limit - 1:
            break
        kept.append(ch)
    return "".join(kept) + "…"


# ---------------------------------------------------------------------------------------------------------------
# Words as patterns
# ---------------------------------------------------------------------------------------------------------------

def _esc_lit(ch: str) -> str:
    return "\\" + ch if ch in "\\^$.*+?()[]{}|" else ch


def _word_body(word: str, cs: bool) -> str:
    """One word as a pattern: * is any run of word characters, ? is one; an apostrophe matches any kind of apostrophe
    or none (can't, can’t, cant); a hyphen matches a hyphen, a space or nothing (e-mail, e mail, email). Lowercased
    unless `cs` (case sensitive)."""
    out = []
    for ch in (str(word) if cs else str(word).lower()):
        if ch == "*":
            out.append(f"{W}*")
        elif ch == "?":
            out.append(W)
        elif ch in "'’‘`":
            out.append("['’‘`]?")
        elif ch in "-‐‑–":
            out.append("[-‐‑– ]?")
        else:
            out.append(_esc_lit(ch))
    return "".join(out)


def _bounded(body: str, text: str) -> str:
    """`body` held to whole words: a word edge is asked for only where the term itself starts or ends in a word character."""
    def edge(ch: str) -> bool:
        return ch in "*?" or _is_word_char(ch)

    return (B0 if edge(text[0]) else "") + body + (B1 if edge(text[-1]) else "")


def _near_body(n: dict[str, Any] | None) -> str | None:
    """A term or phrase (or an OR / NEAR of them) as a pattern with no edges, for use inside NEAR; None when it can't be one."""
    if not n:
        return None
    t = n["t"]
    if t == "term":
        return _word_body(n["text"], False)
    if t == "phrase" and not n.get("slop"):
        return f"{NW}+".join(_word_body(w, False) for w in n["words"])
    if t == "or":
        parts = [_near_body(k) for k in n["kids"]]
        return "(?:" + "|".join(p for p in parts if p is not None) + ")" if all(p is not None for p in parts) else None
    if t == "near":
        a, b = _near_body(n["a"]), _near_body(n["b"])
        if a is None or b is None:
            return None
        gap = f"(?:{NW}+{W}+){{0,{n['n']}}}{NW}+"
        return f"(?:{a}{gap}{b})" if n["ordered"] else f"(?:{a}{gap}{b}|{b}{gap}{a})"
    return None


def _has_case(n: dict[str, Any] | None) -> bool:
    if not n:
        return False
    if n["t"] in ("term", "phrase"):
        return bool(n.get("cs"))
    if n["t"] in ("or", "and"):
        return any(_has_case(k) for k in n["kids"])
    if n["t"] == "near":
        return _has_case(n["a"]) or _has_case(n["b"])
    return False


# ---------------------------------------------------------------------------------------------------------------
# The tree as a plan our tables can answer
# ---------------------------------------------------------------------------------------------------------------

def _blank() -> dict[str, int]:
    return {"terms": 0, "phrases": 0, "near": 0, "caseSensitive": 0, "wildcards": 0}


def _term(text: str, cs: bool) -> dict[str, Any]:
    return {"t": "term", "text": text, "cs": cs}


def _plan(node: dict[str, Any] | None, r: dict[str, Any], ctx: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """A query tree as a plan. A part that can't be converted returns None (it is left out) and is noted in `r`.
    `ctx`: {parent: 'and' | 'or' | '', neg: under an odd number of NOTs}, for saying which way leaving it out leans."""
    if not node:
        return None
    c = ctx or {"parent": "", "neg": False}

    def left_out(why: str) -> None:
        wider = (c["parent"] == "and") != c["neg"]  # out of an AND: wider; out of an OR: narrower; a NOT turns it round
        r["notes"].append({"status": "left out", "clause": show(node), "note": why,
                           "effect": ("wider" if wider else "narrower") if c["parent"] else "nothing left"})

    t = node["t"]
    if t in ("and", "or"):
        kids = [k for k in (_plan(kid, r, {"parent": t, "neg": c["neg"]}) for kid in node["kids"]) if k]
        return {"k": t, "kids": kids} if len(kids) > 1 else (kids[0] if kids else None)
    if t == "not":
        kid = _plan(node["kid"], r, {"parent": c["parent"], "neg": not c["neg"]})
        return {"k": "not", "kid": kid} if kid else None
    if t == "term":
        r["summary"]["terms"] += 1
        if node.get("cs"):
            r["summary"]["caseSensitive"] += 1
        if re.search(r"[*?]", node["text"]):
            r["summary"]["wildcards"] += 1
        return {"k": "rx", "f": "text", "rx": _bounded(_word_body(node["text"], bool(node.get("cs"))), node["text"]), "cs": bool(node.get("cs"))}
    if t == "phrase":
        cs = bool(node.get("cs"))
        first, last = node["words"][0], node["words"][-1]
        if cs:
            r["summary"]["caseSensitive"] += 1
        if not node.get("slop"):
            r["summary"]["phrases"] += 1
            return {"k": "rx", "f": "text", "rx": _bounded(f"{NW}+".join(_word_body(w, cs) for w in node["words"]), first[0] + last[-1]), "cs": cs}
        if len(node["words"]) == 2:  # "two words"~n: within n words of each other, either order
            return _plan({"t": "near", "a": _term(first, cs), "b": _term(last, cs), "n": min(MAX_NEAR, node["slop"]), "ordered": False}, r, c)
        r["notes"].append({"status": "approximated", "clause": show(node), "effect": "wider",
                           "note": "Three or more words within a distance: read as all of the words anywhere in the post."})
        return _plan({"t": "and", "kids": [_term(w, cs) for w in node["words"]]}, r, c)
    if t == "near":
        body = _near_body(node)
        if body is None or _units(body) > MAX_RX_CHARS:
            r["notes"].append({"status": "approximated", "clause": show(node), "effect": "wider",
                               "note": ("NEAR between parts that are more than words and phrases: read as AND (both anywhere in the post)." if body is None
                                        else "This NEAR is too long to check word distances: read as AND (both anywhere in the post).")})
            return _plan({"t": "and", "kids": [node["a"], node["b"]]}, r, c)
        r["summary"]["near"] += 1
        _count_words(node, r["summary"])
        out = {"k": "rx", "f": "text", "rx": f"{B0}{body}{B1}", "cs": False}
        if not _has_case(node):
            return out
        # Case-sensitive terms inside NEAR: the distance is checked in any case, and each side must also match as written
        sides = [s for s in (_plan(side, {"summary": _blank(), "notes": []}, c) for side in (node["a"], node["b"])) if s]
        return {"k": "and", "kids": [out, *sides]}
    if t == "field":
        return _field_plan(node, r, c, left_out)
    left_out("This part could not be read.")
    return None


def _count_words(n: dict[str, Any] | None, summary: dict[str, int]) -> None:
    """Counts the words and phrases inside a NEAR (they become one pattern, so _plan never visits them one by one)."""
    if not n:
        return
    t = n["t"]
    if t == "term":
        summary["terms"] += 1
        if n.get("cs"):
            summary["caseSensitive"] += 1
        if re.search(r"[*?]", n["text"]):
            summary["wildcards"] += 1
    elif t == "phrase":
        summary["phrases"] += 1
        if n.get("cs"):
            summary["caseSensitive"] += 1
    elif t in ("or", "and"):
        for k in n["kids"]:
            _count_words(k, summary)
    elif t == "near":
        _count_words(n["a"], summary)
        _count_words(n["b"], summary)


def _map_value(v: dict[str, Any] | None, leaf: Callable[[str], dict[str, Any]]) -> dict[str, Any] | None:
    """A field's value (a word, a phrase, or a bracketed AND / OR / NOT of them) with `leaf` applied to each word or phrase."""
    if not v:
        return None
    t = v["t"]
    if t == "term":
        return leaf(v["text"])
    if t == "phrase":
        return leaf(" ".join(v["words"]))
    if t in ("and", "or"):
        kids = [k for k in (_map_value(kid, leaf) for kid in v["kids"]) if k]
        return {"k": t, "kids": kids} if len(kids) > 1 else (kids[0] if kids else None)
    if t == "not":
        kid = _map_value(v["kid"], leaf)
        return {"k": "not", "kid": kid} if kid else None
    return None


def _literal(s: str) -> str:
    return "".join("[^\\s]*" if ch == "*" else _esc_lit(ch) for ch in str(s).lower())


def _link(text: str) -> str:
    """A link as it is looked for: without the protocol, www and the trailing slash."""
    bare = re.sub(r"^https?://(www\.)?", "", str(text), count=1, flags=re.IGNORECASE | re.ASCII)
    return re.sub(r"/+\Z", "", re.sub(r"^www\.", "", bare, count=1, flags=re.IGNORECASE | re.ASCII))


def _field_plan(node: dict[str, Any], r: dict[str, Any], c: dict[str, Any], left_out: Callable[[str], None]) -> dict[str, Any] | None:
    name, shown, value = node["name"], node["as"], node.get("value")

    def note(status: str, text: str, effect: str = "") -> None:
        r["notes"].append({"status": status, "clause": show(node), "note": text, "effect": effect})

    def mapped(leaf: Callable[[str], dict[str, Any]], said: tuple[str, str, str] | Callable[[], tuple[str, str, str]], nothing: str = "Nothing to match.") -> dict[str, Any] | None:
        out = _map_value(value, leaf)
        if out:
            note(*(said() if callable(said) else said))
        else:
            left_out(nothing)
        return out

    if not value:
        left_out(f"{shown}: has nothing after it.")
        return None
    if name in NOT_IN_OUR_DATA:
        left_out("It picks out reposts of, or replies to, particular posts or accounts. Our tables hold posts, not who they repost or reply to.")
        return None
    if name in NO_COLUMN:
        left_out("Our tables have no column for it.")
        return None
    if name not in KNOWN:
        left_out(f'"{shown}:" is not an operator this app knows (a typing slip?). To search for it as words, put it in quotes.')
        return None
    if name == "title":
        note("approximated", "Our tables keep a post's words in one piece, with no separate headline: searched in the post's words.", "wider")
        return _plan(value, r, c)
    if name == "raw":
        return mapped(lambda text: {"k": "rx", "f": "text", "rx": "".join(_esc_lit(ch) for ch in text), "cs": True},
                      ("converted", "Matched exactly as written, capitals and punctuation included.", ""))
    if name == "guid":
        seen = {"ids": 0, "other": 0}

        def by_id(text: str) -> dict[str, Any]:
            t = _trim(str(text))
            if re.fullmatch(r"[0-9]{15,20}", t):
                seen["ids"] += 1
                return {"k": "xid", "v": [t]}
            seen["other"] += 1
            return {"k": "rx", "f": "url", "rx": f"(?:^|[^a-z0-9]){_literal(t)}(?:$|[^a-z0-9])"}

        def counted() -> tuple[str, str, str]:
            total = seen["ids"] + seen["other"]
            return ("converted", f"{total} post id{'' if total == 1 else 's'}: matched by the id in the post's link"
                    + (" (an id that is not an X post id is looked for anywhere in the link)" if seen["other"] else "") + ".", "")

        return mapped(by_id, counted, "No post ids to match.")
    if name == "url":
        return mapped(lambda text: {"k": "rx", "f": "url", "rx": _literal(_link(text))}, ("converted", "Matched against the post's link.", ""))
    if name in ("links", "link"):
        return mapped(lambda text: {"k": "rx", "f": "text", "rx": _literal(_link(text))},
                      ("approximated", "Found only when the link is written out in the post's words. X shortens links, so most X posts that link to it are missed.", "narrower"))
    if name == "site":
        def by_site(text: str) -> dict[str, Any]:
            full = re.sub(r"^www\.", "", re.sub(r"^https?://", "", str(text).lower(), count=1), count=1)
            d = re.sub(r"/.*\Z", "", full, count=1, flags=re.DOTALL)
            path = re.sub(r"/+\Z", "", full[len(d):])
            if path:
                return {"k": "rx", "f": "url", "rx": _literal(d + path)}  # a site with a path: the link holds both
            if d in SITE_PLATFORM:
                return {"k": "in", "f": "platform", "v": [SITE_PLATFORM[d]]}
            return {"k": "rx", "f": "url", "rx": f"^https?://(?:[a-z0-9-]+\\.)*{_literal(d)}(?:[/:?#]|$)"}

        return mapped(by_site, ("converted", "A social network is matched by its name; any other site by the post's link.", ""))
    if name == "subreddit":
        return mapped(lambda text: {"k": "rx", "f": "url", "rx": f"reddit\\.com/r/{_literal(re.sub(r'^/?r/', '', str(text), count=1, flags=re.IGNORECASE | re.ASCII))}(?:/|$)"},
                      ("converted", "Matched by the subreddit in the post's link.", ""))
    if name == "author":
        return mapped(lambda text: {"k": "rx", "f": "author", "rx": f"^@?{_word_body(re.sub(r'^@', '', str(text), count=1), False)}$"},
                      ("converted", "Matched against the author's handle.", ""))
    if name in ("hashtags", "at_mentions"):
        mark = "#" if name == "hashtags" else "@"

        def marked(text: str) -> dict[str, Any]:
            t = mark + re.sub(r"^[#@]", "", str(text), count=1)
            return {"k": "rx", "f": "text", "rx": _bounded(_word_body(t, False), t), "cs": False}

        return mapped(marked, ("converted", f"Looked for as {mark}word in the post's words.", ""))
    if name == "language":
        return mapped(lambda text: {"k": "eq", "f": "language", "v": str(text).lower()},
                      ("converted", "Applied where a table has the post's language (Sonar, Brandwatch's stored mentions). The other tables have no language column, so there it is left out.", ""))
    if name == "authorfollowers":
        m = _RANGE.fullmatch(value["text"]) if value["t"] == "range" else None
        if not m:
            left_out("The range could not be read. Write it as authorFollowers:[1000 TO 50000].")
            return None
        note("converted", "Posts whose author's follower count is not known are left out.")
        return {"k": "num", "f": "followers", "min": None if m.group(1) == "*" else int(m.group(1)), "max": None if m.group(2) == "*" else int(m.group(2))}
    left_out("Our tables have no column for it.")
    return None


def _same(node: dict[str, Any]) -> str:
    return json.dumps(node, sort_keys=True, ensure_ascii=False)


def simplify(p: dict[str, Any] | None) -> dict[str, Any] | None:
    """`p` tidied: nested ANDs / ORs flattened, the same condition kept once, X post ids of one OR gathered together."""
    if not p:
        return None
    if p["k"] == "not":
        kid = simplify(p["kid"])
        return {"k": "not", "kid": kid} if kid else None
    if p["k"] not in ("and", "or"):
        return p
    kids: list[dict[str, Any]] = []
    for k in (simplify(kid) for kid in p["kids"]):
        if k:
            kids += k["kids"] if k["k"] == p["k"] else [k]
    if p["k"] == "or":
        ids: list[str] = []
        plats: list[str] = []
        rest = []
        for k in kids:
            if k["k"] == "xid":
                ids += [v for v in k["v"] if v not in ids]
            elif k["k"] == "in":
                plats += [v for v in k["v"] if v not in plats]
            else:
                rest.append(k)
        kids = rest
        if ids:
            kids.append({"k": "xid", "v": list(dict.fromkeys(ids))})
        if plats:
            kids.append({"k": "in", "f": "platform", "v": list(dict.fromkeys(plats))})
    seen: set[str] = set()
    once = []
    for k in kids:
        key = _same(k)
        if key not in seen:
            seen.add(key)
            once.append(k)
    return {"k": p["k"], "kids": once} if len(once) > 1 else (once[0] if once else None)


def convert(text: Any) -> Conversion:
    """A Brandwatch Boolean query as a plan, with the report {summary, notes, warnings}. `error` (and ok False) when
    nothing can be searched: an empty query, one with nothing convertible left, or one that would match every post."""
    warnings: list[str] = []
    report: dict[str, Any] = {"summary": _blank(), "notes": [], "warnings": warnings}
    src = _trim(str(text or ""))
    if not src:
        return Conversion(False, None, report, "There is no query to convert.")
    if _units(src) > MAX_QUERY_CHARS:
        return Conversion(False, None, report, "The query is longer than 60,000 characters.")
    parsed = parse(src, warnings)
    if parsed.implicit:
        warnings.append("Two terms sit side by side with no operator between them: read as AND, as Brandwatch reads them.")
    if parsed.hoisted:
        warnings.append("A NOT after a list of ORs was read as leaving those posts out of the whole list: a OR b NOT c is (a OR b) NOT c.")
    if parsed.mixed:
        warnings.append("AND and OR are mixed without brackets: AND was read first (a AND b OR c is (a AND b) OR c).")
    out = simplify(_plan(parsed.tree, report, {"parent": "", "neg": False}))
    if not out:
        return Conversion(False, None, report, "Nothing in this query can be searched in our tables (see what was left out).")
    if evaluate(out, _EMPTY_POST):
        return Conversion(False, None, report, "This query would match every post (it only says what to leave out). "
                                               "Add at least one word, phrase, author or site to look for.")
    return Conversion(True, out, report)


def _field(p: dict[str, Any]) -> str:
    return "url" if p["k"] == "xid" else p["f"]


def fields_of(p: dict[str, Any] | None) -> set[str]:
    """The fields a plan asks about (text, author, url, platform, followers, language)."""
    if not p:
        return set()
    if p["k"] in ("and", "or"):
        return set().union(*(fields_of(k) for k in p["kids"]))
    if p["k"] == "not":
        return fields_of(p["kid"])
    return {_field(p)}


def prune(p: dict[str, Any] | None, has: set[str]) -> tuple[dict[str, Any] | None, list[str]]:
    """`p` without the conditions on fields a table doesn't have: (plan, the fields removed, in the order met)."""
    removed: list[str] = []

    def go(n: dict[str, Any] | None) -> dict[str, Any] | None:
        if not n:
            return None
        if n["k"] in ("and", "or"):
            kids = [k for k in (go(kid) for kid in n["kids"]) if k]
            return {"k": n["k"], "kids": kids} if len(kids) > 1 else (kids[0] if kids else None)
        if n["k"] == "not":
            kid = go(n["kid"])
            return {"k": "not", "kid": kid} if kid else None
        f = _field(n)
        if f in has:
            return n
        if f not in removed:
            removed.append(f)
        return None

    return go(p), removed


# ---------------------------------------------------------------------------------------------------------------
# The plan as SQL, and the same plan in memory
# ---------------------------------------------------------------------------------------------------------------

def to_sql(p: dict[str, Any], cols: dict[str, str], params: dict[str, Any]) -> str:
    """`p` as a BigQuery condition. `cols` names the columns: {text, text_l (lowercased), author_l, url_l, platform,
    followers, language}. Every value is a named parameter added to `params` (qN, N counting what is already there),
    the same value once; a missing value never matches."""
    by_value: dict[str, str] = {}

    def param(v: Any) -> str:
        key = json.dumps(v, ensure_ascii=False)
        if key not in by_value:
            name = f"q{len(params)}"
            params[name] = v
            by_value[key] = name
        return "@" + by_value[key]

    def go(n: dict[str, Any]) -> str:
        k = n["k"]
        if k == "and":
            return "(" + " AND ".join(go(kid) for kid in n["kids"]) + ")"
        if k == "or":
            return "(" + " OR ".join(go(kid) for kid in n["kids"]) + ")"
        if k == "not":
            return f"(NOT {go(n['kid'])})"
        if k == "rx":
            col = (cols["text"] if n.get("cs") else cols["text_l"]) if n["f"] == "text" else cols["author_l"] if n["f"] == "author" else cols["url_l"]
            return f"IFNULL(REGEXP_CONTAINS({col}, {param(n['rx'])}), FALSE)"
        if k == "xid":
            return f"IFNULL(REGEXP_EXTRACT({cols['url_l']}, r'/status/(\\d+)') IN UNNEST({param(n['v'])}), FALSE)"
        if k == "in":
            return f"IFNULL({cols['platform']} IN UNNEST({param(n['v'])}), FALSE)"
        if k == "eq":
            return f"IFNULL({cols['language']} = {param(n['v'])}, FALSE)"
        if k == "num":
            parts = []
            if n.get("min") is not None:
                parts.append(f"{cols['followers']} >= {param(n['min'])}")
            if n.get("max") is not None:
                parts.append(f"{cols['followers']} <= {param(n['max'])}")
            return f"IFNULL({' AND '.join(parts)}, FALSE)" if parts else f"({cols['followers']} IS NOT NULL)"
        raise ValueError("unknown plan node")

    return go(p)


_RX_CACHE: dict[str, re.Pattern[str]] = {}


def _rx(src: str) -> re.Pattern[str]:
    """One of the converter's patterns as Python reads it, matching what JavaScript and BigQuery match."""
    hit = _RX_CACHE.get(src)
    if hit is None:
        s = src.replace(NW, r"[^\w]").replace(W, r"[\w]").replace(r"[^\s]", f"[^{_WS}]")
        out, i, in_class = [], 0, False
        while i < len(s):
            ch = s[i]
            if ch == "\\":  # an escaped character stays as written
                out.append(s[i:i + 2])
                i += 2
                continue
            if in_class:
                in_class = ch != "]"
            elif ch == "[":
                in_class = True
            elif ch == "$":  # the very end of the text, not also before a last line break
                ch = r"\Z"
            out.append(ch)
            i += 1
        if len(_RX_CACHE) > 5000:
            _RX_CACHE.clear()
        hit = _RX_CACHE[src] = re.compile("".join(out))
    return hit


def evaluate(p: dict[str, Any], post: dict[str, Any]) -> bool:
    """Does `post` ({text, author, url, platform, followers, language}) match plan `p`? The same answer SQL gives."""
    text = str(post.get("text") or "")
    low = {"text": text.lower(), "author": str(post.get("author") or "").lower(), "url": str(post.get("url") or "").lower()}

    def go(n: dict[str, Any]) -> bool:
        k = n["k"]
        if k == "and":
            return all(go(kid) for kid in n["kids"])
        if k == "or":
            return any(go(kid) for kid in n["kids"])
        if k == "not":
            return not go(n["kid"])
        if k == "rx":
            return bool(_rx(n["rx"]).search((text if n.get("cs") else low["text"]) if n["f"] == "text" else low[n["f"]]))
        if k == "xid":
            m = re.search(r"/status/([0-9]+)", low["url"])
            return bool(m) and m.group(1) in n["v"]
        if k == "in":
            return str(post.get("platform") or "").lower() in n["v"]
        if k == "eq":
            return bool(post.get("language")) and str(post["language"]).lower() == n["v"]
        if k == "num":
            followers = post.get("followers")
            if followers is None:
                return False
            return (n.get("min") is None or followers >= n["min"]) and (n.get("max") is None or followers <= n["max"])
        return False

    return go(p)


# ---------------------------------------------------------------------------------------------------------------
# The filter form, as a query
# ---------------------------------------------------------------------------------------------------------------

def _list(v: Any) -> list[str]:
    items = v if isinstance(v, list) else re.split(r"[,\n]", str(v or ""))
    return [t for t in (_trim(str(s)) for s in items) if t]


def _quoted(term: str) -> str:
    t = _trim(str(term).replace('"', ""))
    return f'"{t}"' if _SPACE.search(t) else t


def _number(v: Any) -> float:
    """A typed number as the form gives it: 0 when it is not one."""
    if isinstance(v, bool) or v is None:
        return 0.0
    try:
        n = float(_trim(str(v)) or 0)
    except ValueError:
        return 0.0
    return n if math.isfinite(n) else 0.0


def from_filters(f: dict[str, Any] | None) -> str:
    """The filter form as a Brandwatch query: {all, any, none (words or phrases, comma separated), platforms, authors,
    min_followers}. "" when nothing was filled in."""
    o = f or {}

    def group(terms: list[str], op: str) -> str:
        return "(" + f" {op} ".join(_quoted(t) for t in terms) + ")" if len(terms) > 1 else _quoted(terms[0])

    def listed(values: list[str]) -> str:
        return "(" + " OR ".join(values) + ")" if len(values) > 1 else values[0]

    parts: list[str] = []
    all_of, any_of, none_of = _list(o.get("all")), _list(o.get("any")), _list(o.get("none"))
    sites = [PLATFORM_SITE[p.lower()] for p in _list(o.get("platforms")) if p.lower() in PLATFORM_SITE]
    authors = [re.sub(r"^@", "", a, count=1) for a in _list(o.get("authors"))]
    if all_of:
        parts.append(group(all_of, "AND"))
    if any_of:
        parts.append(group(any_of, "OR"))
    if sites:
        parts.append(f"site:{listed(sites)}")
    if authors:
        parts.append(f"author:{listed(authors)}")
    followers = _number(o.get("min_followers"))
    if followers > 0:
        parts.append(f"authorFollowers:[{math.floor(followers + 0.5)} TO *]")
    out = " AND ".join(parts)
    if none_of and out:
        out += f" NOT {group(none_of, 'OR')}"
    return out
