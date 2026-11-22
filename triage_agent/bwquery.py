"""A Brandwatch Boolean query as a search of the team's own BigQuery tables, by fixed rules.

Port of the temp check app's lib/bwquery.js. Nothing here guesses and nothing calls a model: the same query always
converts the same way, and the report says what was converted, what was approximated and what was left out.

    convert(text)            -> Conversion(ok, plan, report, error)
    to_sql(plan, cols, p)    -> a BigQuery boolean expression with named parameters added to `p`
    evaluate(plan, post)     -> the same plan run on one post in memory
    prune(plan, has)         -> (plan without the parts a table has no column for, what was removed)
    from_filters(filters)    -> the filter form as a Boolean query (one path for both)

Operators: AND, OR, NOT, brackets, "phrases", wildcards (* and ?), NEAR/n and NEAR/nf, "two words"~n,
{Case Sensitive}, <<<comments>>>, and title:, raw:, url:, links:, site:, subreddit:, author:, language:, hashtags:,
at_mentions:, authorFollowers:[a TO b]. Operators the tables cannot answer (engagingWith…:, parentPostId:,
engagementType:, country:, …) are left out and named in the report: a clause left out of an OR makes the result
narrower; one left out of an AND makes it wider.

The patterns use only syntax BigQuery (RE2) accepts; in memory \\p{L}\\p{N}_ is read as \\w.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

W = r"[\p{L}\p{N}_]"
NW = r"[^\p{L}\p{N}_]"
B0 = f"(?:^|{NW})"
B1 = f"(?:$|{NW})"
MAX_NEAR = 30
MAX_RX_CHARS = 30000

SITE_PLATFORM = {"twitter.com": "x", "x.com": "x", "reddit.com": "reddit", "instagram.com": "instagram",
                 "facebook.com": "facebook", "bsky.app": "bluesky", "youtube.com": "youtube", "tiktok.com": "tiktok",
                 "threads.net": "threads", "threads.com": "threads", "linkedin.com": "linkedin", "tumblr.com": "tumblr"}
PLATFORM_SITE = {"x": "twitter.com", "reddit": "reddit.com", "instagram": "instagram.com", "facebook": "facebook.com",
                 "bluesky": "bsky.app", "youtube": "youtube.com", "tiktok": "tiktok.com", "threads": "threads.net",
                 "linkedin": "linkedin.com"}
TEXT_FIELDS = {"title", "raw"}
MAPPED_FIELDS = {"guid", "url", "links", "link", "site", "subreddit", "author", "language", "hashtags", "at_mentions",
                 "authorfollowers"}
NOT_IN_OUR_DATA = {"engagingwith", "engagingwithguid", "engagingwithguids", "engagingwithurl", "parentpostid",
                   "rootpostid", "engagementtype", "threadentrytype"}
NO_COLUMN = {"country", "continent", "region", "city", "state", "section", "brandids", "authorverified", "authorgender",
             "accounttype", "bio", "authorbio", "authorname", "channelid", "minuteofday", "latitude", "longitude",
             "publishersubtype", "pagetype", "blogname", "forumname", "entityid", "imagetype", "interest", "profession",
             "timezone", "authorlocation"}
KNOWN = TEXT_FIELDS | MAPPED_FIELDS | NOT_IN_OUR_DATA | NO_COLUMN
# which column each leaf needs (a table without it has the leaf pruned)
NEEDS = {"rx": "text", "author": "author", "url": "url", "platform": "platform", "followers": "followers", "language": "language"}


@dataclass
class Conversion:
    ok: bool
    plan: dict[str, Any] | None = None
    report: dict[str, Any] = field(default_factory=dict)
    error: str = ""


# -- reading the query -------------------------------------------------------------------------------------------
def _tokenize(text: str, warnings: list[str]) -> list[dict[str, Any]]:
    s = re.sub("[“”„‟]", '"', str(text or "")).replace(" ", " ")
    toks: list[dict[str, Any]] = []
    i = 0
    while i < len(s):
        c = s[i]
        if c.isspace():
            i += 1
            continue
        if s.startswith("<<<", i):
            end = s.find(">>>", i + 3)
            i = len(s) if end < 0 else end + 3
            continue
        if c in "()":
            toks.append({"t": c})
            i += 1
            continue
        if c == '"':
            end = s.find('"', i + 1)
            if end < 0:
                warnings.append("A quote is never closed: it was read to the end of the query.")
            stop = len(s) if end < 0 else end
            body = s[i + 1:stop]
            i = min(len(s), stop + 1)
            m = re.match(r"~(\d{1,3})", s[i:i + 5])
            if m:
                i += len(m.group(0))
            toks.append({"t": "phrase", "text": body, "slop": int(m.group(1)) if m else 0, "cs": False})
            continue
        if c == "{":
            end = s.find("}", i + 1)
            stop = len(s) if end < 0 else end
            toks.append({"t": "phrase", "text": s[i + 1:stop], "slop": 0, "cs": True})
            i = min(len(s), stop + 1)
            continue
        if c == "[" and toks and toks[-1]["t"] == "field":
            end = s.find("]", i + 1)
            stop = len(s) if end < 0 else end
            toks.append({"t": "range", "text": s[i + 1:stop]})
            i = min(len(s), stop + 1)
            continue
        j = i
        while j < len(s) and not (s[j].isspace() or s[j] in '()"'):
            j += 1
        word = s[i:j]
        fm = re.match(r"([A-Za-z_]{2,40}):(?!//)", word)
        if fm and not re.fullmatch(r"https?", fm.group(1), re.IGNORECASE):
            name = fm.group(1).lower()
            nxt = s[i + len(fm.group(0))] if i + len(fm.group(0)) < len(s) else ""
            attached = len(word) > len(fm.group(0)) or nxt in ('(', '"')
            if name in KNOWN or attached:
                toks.append({"t": "field", "name": name, "as": fm.group(1)})
                i += len(fm.group(0))
                continue
        i = j
        if word in ("AND", "OR", "NOT"):
            toks.append({"t": word})
            continue
        near = re.fullmatch(r"NEAR/(\d{1,3})(f?)", word)
        if near:
            toks.append({"t": "NEAR", "n": min(MAX_NEAR, int(near.group(1))), "ordered": near.group(2) == "f"})
            continue
        if word in ("and", "or", "not"):
            warnings.append(f'"{word}" in lowercase is read as a word, as Brandwatch reads it. Operators are AND, OR, NOT in capitals.')
        clean = re.sub(r"[,;:!.]+$", "", word)
        if clean:
            toks.append({"t": "word", "text": clean})
    return toks


class _Parser:
    def __init__(self, toks: list[dict[str, Any]], warnings: list[str]):
        self.toks, self.pos, self.warnings = toks, 0, warnings

    def peek(self) -> dict[str, Any] | None:
        return self.toks[self.pos] if self.pos < len(self.toks) else None

    def take(self) -> dict[str, Any]:
        tok = self.toks[self.pos]
        self.pos += 1
        return tok

    def starts_primary(self) -> bool:
        t = self.peek()
        return bool(t) and t["t"] in ("(", "word", "phrase", "field", "NOT")

    def parse_or(self) -> dict[str, Any] | None:
        kids = [k for k in [self.parse_and()] if k]
        while self.peek() and self.peek()["t"] == "OR":
            self.take()
            kid = self.parse_and()
            if kid:
                kids.append(kid)
        if not kids:
            return None
        return kids[0] if len(kids) == 1 else {"t": "or", "kids": kids}

    def parse_and(self) -> dict[str, Any] | None:
        kids = [k for k in [self.parse_not()] if k]
        while True:
            t = self.peek()
            if t and t["t"] == "AND":
                self.take()
            elif not self.starts_primary():
                break
            kid = self.parse_not()
            if kid:
                kids.append(kid)
            elif not self.peek() or self.peek()["t"] in (")", "OR"):
                break
        if not kids:
            return None
        return kids[0] if len(kids) == 1 else {"t": "and", "kids": kids}

    def parse_not(self) -> dict[str, Any] | None:
        t = self.peek()
        if t and t["t"] == "NOT":
            self.take()
            kid = self.parse_not()
            return {"t": "not", "kid": kid} if kid else None
        return self.parse_near()

    def parse_near(self) -> dict[str, Any] | None:
        left = self.parse_primary()
        while left and self.peek() and self.peek()["t"] == "NEAR":
            op = self.take()
            right = self.parse_primary()
            if right is None:
                self.warnings.append("A NEAR has nothing after it: it was dropped.")
                break
            left = {"t": "near", "a": left, "b": right, "n": op["n"], "ordered": op["ordered"]}
        return left

    def parse_primary(self) -> dict[str, Any] | None:
        t = self.peek()
        if t is None:
            return None
        if t["t"] == "(":
            self.take()
            node = self.parse_or()
            if self.peek() and self.peek()["t"] == ")":
                self.take()
            else:
                self.warnings.append("A bracket is never closed: it was read to the end of the query.")
            return node
        if t["t"] == "word":
            self.take()
            return {"t": "term", "text": t["text"], "cs": False}
        if t["t"] == "phrase":
            self.take()
            words = [w for w in re.split(r"\s+", t["text"].strip()) if w]
            if not words:
                return None
            if len(words) == 1:
                return {"t": "term", "text": words[0], "cs": t["cs"]}
            return {"t": "phrase", "words": words, "slop": t["slop"], "cs": t["cs"]}
        if t["t"] == "field":
            self.take()
            nxt = self.peek()
            if nxt and nxt["t"] == "range":
                self.take()
                return {"t": "field", "name": t["name"], "as": t["as"], "range": nxt["text"]}
            value = self.parse_primary()
            return {"t": "field", "name": t["name"], "as": t["as"], "value": value}
        if t["t"] in (")", "AND", "OR", "NEAR", "range"):
            if t["t"] != ")":
                self.take()
            return None
        return None


def parse(text: str, warnings: list[str]) -> dict[str, Any] | None:
    parser = _Parser(_tokenize(text, warnings), warnings)
    node = parser.parse_or()
    while parser.peek() is not None:  # stray closing brackets and what follows them
        if parser.peek()["t"] == ")":
            parser.take()
            warnings.append("A closing bracket has no opening one: it was ignored.")
            continue
        more = parser.parse_or()
        if more is None:
            break
        node = {"t": "and", "kids": [node, more]} if node else more
    return node


# -- patterns ------------------------------------------------------------------------------------------------------
def _esc(ch: str) -> str:
    return "\\" + ch if ch in r"\^$.*+?()[]{}|" else ch


def _word_body(word: str, cs: bool) -> str:
    out = []
    for ch in (word if cs else word.lower()):
        if ch == "*":
            out.append(f"{W}*")
        elif ch == "?":
            out.append(W)
        else:
            out.append(_esc(ch))
    return "".join(out)


def _bounded(body: str, text: str) -> str:
    first, last = text[:1], text[-1:]
    lead = B0 if (first.isalnum() or first in "_*?") else "(?:^|\\s)"
    tail = B1 if (last.isalnum() or last in "_*?") else "(?:$|\\s)"
    return f"{lead}{body}{tail}"


def _text_body(node: dict[str, Any]) -> tuple[str, str] | None:
    """(pattern body, text for its boundaries) of a term or phrase."""
    if node["t"] == "term":
        return _word_body(node["text"], node.get("cs", False)), node["text"]
    if node["t"] == "phrase" and not node.get("slop"):
        cs = node.get("cs", False)
        return f"{NW}+".join(_word_body(w, cs) for w in node["words"]), node["words"][0][:1] + node["words"][-1][-1:]
    return None


def _has_case(node: dict[str, Any]) -> bool:
    if node["t"] in ("term", "phrase"):
        return bool(node.get("cs"))
    if node["t"] == "near":
        return _has_case(node["a"]) or _has_case(node["b"])
    if node["t"] in ("and", "or"):
        return any(_has_case(k) for k in node["kids"])
    return False


def _near_sides(node: dict[str, Any]) -> list[str] | None:
    """Alternative pattern bodies for one side of a NEAR (terms, phrases and ORs of them)."""
    if node["t"] in ("term", "phrase"):
        body = _text_body(node)
        return [body[0]] if body else None
    if node["t"] == "or":
        out: list[str] = []
        for kid in node["kids"]:
            sides = _near_sides(kid)
            if sides is None:
                return None
            out += sides
        return out
    return None


# -- the plan --------------------------------------------------------------------------------------------------------
class _Report:
    """What became of a query: how much was read, and each part that was approximated or left out (and which way the
    result leans because of it)."""

    def __init__(self) -> None:
        self.exact = 0
        self.warnings: list[str] = []
        self.notes: list[dict[str, str]] = []  # {status: 'approximated' | 'left out', note, effect: 'wider' | 'narrower' | ''}
        self.summary = {"terms": 0, "phrases": 0, "near": 0, "wildcards": 0, "case_sensitive": 0}

    def approx(self, note: str, effect: str = "") -> None:
        self.notes.append({"status": "approximated", "note": note, "effect": effect})

    def left(self, note: str) -> None:
        self.notes.append({"status": "left out", "note": note, "effect": ""})

    def of(self, status: str) -> list[dict[str, str]]:
        return [n for n in self.notes if n["status"] == status]

    def count(self, node: dict[str, Any]) -> None:
        """Count the words and phrases under `node` (a word, a phrase, or a NEAR or OR of them)."""
        t = node.get("t")
        if t == "term":
            self.summary["terms"] += 1
            self.summary["wildcards"] += 1 if re.search(r"[*?]", str(node.get("text") or "")) else 0
            self.summary["case_sensitive"] += 1 if node.get("cs") else 0
        elif t == "phrase":
            self.summary["phrases"] += 1
            self.summary["case_sensitive"] += 1 if node.get("cs") else 0
        elif t == "near":
            self.count(node["a"])
            self.count(node["b"])
        elif t in ("and", "or"):
            for kid in node["kids"]:
                self.count(kid)


def _plan(node: dict[str, Any], r: _Report) -> dict[str, Any] | None:
    t = node["t"]
    if t in ("term", "phrase") and not node.get("slop"):
        body, edge = _text_body(node)  # type: ignore[misc]
        r.exact += 1
        r.count(node)
        return {"t": "rx", "src": _bounded(body, edge), "cs": bool(node.get("cs"))}
    if t == "phrase":  # "two words"~n: the words within n of each other, either order
        words = node["words"]
        pair = {"t": "near", "a": {"t": "term", "text": words[0], "cs": node.get("cs", False)},
                "b": ({"t": "term", "text": words[1], "cs": node.get("cs", False)} if len(words) == 2 else
                      {"t": "phrase", "words": words[1:], "slop": 0, "cs": node.get("cs", False)}),
                "n": min(MAX_NEAR, node["slop"]), "ordered": False}
        return _plan(pair, r)
    if t == "near":
        a, b = _near_sides(node["a"]), _near_sides(node["b"])
        if a is None or b is None:
            r.approx("A NEAR between bracketed clauses was read as AND (both must be in the post, at any distance).", "wider")
            kids = [k for k in (_plan(node["a"], r), _plan(node["b"], r)) if k]
            return {"t": "and", "kids": kids} if len(kids) == 2 else (kids[0] if kids else None)
        gap = f"(?:{NW}+{W}+){{0,{node['n']}}}{NW}+"
        ga, gb = "(?:" + "|".join(a) + ")", "(?:" + "|".join(b) + ")"
        src = f"{B0}{ga}{gap}{gb}{B1}" if node["ordered"] else f"{B0}(?:{ga}{gap}{gb}|{gb}{gap}{ga}){B1}"
        if len(src) > MAX_RX_CHARS:
            r.approx("A NEAR with very many alternatives was read as AND.", "wider")
            kids = [k for k in (_plan(node["a"], r), _plan(node["b"], r)) if k]
            return {"t": "and", "kids": kids} if len(kids) == 2 else (kids[0] if kids else None)
        r.exact += 1
        r.summary["near"] += 1
        r.count(node)
        return {"t": "rx", "src": src, "cs": _has_case(node)}
    if t == "not":
        kid = _plan(node["kid"], r)
        return {"t": "not", "kid": kid} if kid else None
    if t in ("and", "or"):
        kids = []
        for k in node["kids"]:
            before = len(r.of("left out"))
            planned = _plan(k, r)
            if planned is None:
                left = r.of("left out")
                if len(left) > before:
                    left[-1]["effect"] = "narrower" if t == "or" else "wider"
                    left[-1]["note"] += " It was in an OR: the result is narrower." if t == "or" else " It was in an AND: the result is wider."
                continue
            kids.append(planned)
        if not kids:
            return None
        return kids[0] if len(kids) == 1 else {"t": t, "kids": kids}
    if t == "field":
        return _field_plan(node, r)
    return None


def _values(node: dict[str, Any] | None) -> list[str] | None:
    """The plain values under a field operator: a word, a phrase, or an OR of them."""
    if node is None:
        return None
    if node["t"] == "term":
        return [node["text"]]
    if node["t"] == "phrase":
        return [" ".join(node["words"])]
    if node["t"] == "or":
        out: list[str] = []
        for kid in node["kids"]:
            vals = _values(kid)
            if vals is None:
                return None
            out += vals
        return out
    return None


def _literal(value: str) -> str:
    return "".join("[^\\s]*" if ch == "*" else _esc(ch) for ch in value.lower())


def _any(kids: list[dict[str, Any]]) -> dict[str, Any] | None:
    return None if not kids else (kids[0] if len(kids) == 1 else {"t": "or", "kids": kids})


def _field_plan(node: dict[str, Any], r: _Report) -> dict[str, Any] | None:
    name, shown = node["name"], node.get("as", node["name"])
    if name in NOT_IN_OUR_DATA:
        r.left(f"{shown}: picks out reposts of and replies to particular posts, which our tables do not hold.")
        return None
    if name in NO_COLUMN:
        r.left(f"{shown}: our tables have no column for it.")
        return None
    if name in TEXT_FIELDS:
        if node.get("value") is None:
            return None
        if name == "title":
            r.approx("title: was searched in the post's words (our tables keep one text for a post).", "wider")
        return _plan(node["value"], r)
    if name == "authorfollowers":
        m = re.fullmatch(r"\s*(\d+|\*)\s+TO\s+(\d+|\*)\s*", node.get("range") or "", re.IGNORECASE)
        if not m:
            r.left("authorFollowers: needs a range like [1000 TO 50000].")
            return None
        r.exact += 1
        return {"t": "followers", "min": None if m.group(1) == "*" else int(m.group(1)),
                "max": None if m.group(2) == "*" else int(m.group(2))}
    vals = _values(node.get("value"))
    if not vals:
        if name not in KNOWN:
            r.left(f"{shown}: is not an operator this search knows.")
        else:
            r.left(f"{shown}: takes a word, a phrase or a bracketed OR of them.")
        return None
    r.exact += 1
    if name == "site":
        kids = []
        for v in vals:
            host = re.sub(r"^(?:https?://)?(?:www\.)?", "", v.lower()).split("/")[0]
            platform = SITE_PLATFORM.get(host)
            kids.append({"t": "or", "kids": [{"t": "platform", "value": platform}, {"t": "url", "src": _esc_host(host)}]}
                        if platform else {"t": "url", "src": _esc_host(host)})
        return _any(kids)
    if name in ("url", "links", "link"):
        if name != "url":
            r.approx("links: was searched in the post's own link (links inside a post are not kept apart).")
        return _any([{"t": "url", "src": _literal(re.sub(r"^https?://(?:www\.)?", "", v))} for v in vals])
    if name == "guid":
        return _any([{"t": "url", "src": _literal(v.split("_")[-1])} for v in vals])
    if name == "subreddit":
        return _any([{"t": "url", "src": f"reddit\\.com/r/{_literal(v)}(?:/|$)"} for v in vals])
    if name == "author":
        return _any([{"t": "author", "value": v.lower().lstrip("@")} for v in vals])
    if name == "language":
        return _any([{"t": "language", "value": v.lower()} for v in vals])
    if name == "hashtags":
        return _any([{"t": "rx", "src": f"(?:^|[^\\p{{L}}\\p{{N}}_#])#{_literal(v.lstrip('#'))}{B1}", "cs": False} for v in vals])
    if name == "at_mentions":
        return _any([{"t": "rx", "src": f"(?:^|[^\\p{{L}}\\p{{N}}_@])@{_literal(v.lstrip('@'))}{B1}", "cs": False} for v in vals])
    r.left(f"{shown}: is not an operator this search knows.")
    return None


def _esc_host(host: str) -> str:
    return f"(?:^|[/.]){_literal(host)}(?:[/:?#]|$)"


def convert(text: str) -> Conversion:
    """The query as a plan, with a report of what was converted, approximated and left out."""
    r = _Report()
    if not str(text or "").strip():
        return Conversion(ok=False, error="The query is empty.")
    tree = parse(text, r.warnings)
    if tree is None:
        return Conversion(ok=False, error="Nothing in the query could be read.", report={"warnings": r.warnings})
    plan = _plan(tree, r)
    report = {"converted": r.exact, "approximated": [n["note"] for n in r.of("approximated")], "left_out": [n["note"] for n in r.of("left out")],
              "warnings": r.warnings, "summary": r.summary, "notes": r.notes}
    if plan is None:
        return Conversion(ok=False, error="Nothing in the query can be asked of our tables.", report=report)
    if evaluate(plan, {"text": "", "author": "", "url": "", "platform": "", "followers": None, "language": ""}):
        return Conversion(ok=False, plan=plan, report=report,
                          error="The query would match every post (it only says what to leave out). Add what to look for.")
    return Conversion(ok=True, plan=plan, report=report)


# -- pruning for a table ---------------------------------------------------------------------------------------------
def prune(plan: dict[str, Any] | None, has: set[str]) -> tuple[dict[str, Any] | None, list[str]]:
    removed: list[str] = []

    def walk(node: dict[str, Any]) -> dict[str, Any] | None:
        t = node["t"]
        if t in ("and", "or"):
            kids = [k for k in (walk(k) for k in node["kids"]) if k]
            return None if not kids else (kids[0] if len(kids) == 1 else {"t": t, "kids": kids})
        if t == "not":
            kid = walk(node["kid"])
            return {"t": "not", "kid": kid} if kid else None
        need = NEEDS.get(t)
        if need and need not in has:
            removed.append(need)
            return None
        return node

    return (walk(plan) if plan else None), sorted(set(removed))


# -- SQL ---------------------------------------------------------------------------------------------------------------
def to_sql(plan: dict[str, Any], cols: dict[str, str], params: dict[str, Any]) -> str:
    """A BigQuery boolean expression for `plan`. `cols`: text, text_l, author_l, url_l, platform, followers, language."""

    def param(value: Any) -> str:
        name = f"q{len([k for k in params if k.startswith('q')])}"
        params[name] = value
        return f"@{name}"

    def walk(node: dict[str, Any]) -> str:
        t = node["t"]
        if t == "and":
            return "(" + " AND ".join(walk(k) for k in node["kids"]) + ")"
        if t == "or":
            return "(" + " OR ".join(walk(k) for k in node["kids"]) + ")"
        if t == "not":
            return f"NOT IFNULL({walk(node['kid'])}, FALSE)"
        if t == "rx":
            return f"REGEXP_CONTAINS({cols['text'] if node.get('cs') else cols['text_l']}, {param(node['src'])})"
        if t == "url":
            return f"REGEXP_CONTAINS({cols['url_l']}, {param(node['src'])})"
        if t == "author":
            return f"LTRIM({cols['author_l']}, '@') = {param(node['value'])}"
        if t == "platform":
            return f"LOWER({cols['platform']}) = {param(node['value'])}"
        if t == "language":
            return f"LOWER({cols['language']}) = {param(node['value'])}"
        if t == "followers":
            parts = []
            if node.get("min") is not None:
                parts.append(f"{cols['followers']} >= {param(node['min'])}")
            if node.get("max") is not None:
                parts.append(f"{cols['followers']} <= {param(node['max'])}")
            return "(" + (" AND ".join(parts) or "TRUE") + ")"
        raise ValueError(f"unknown plan node: {t}")

    return walk(plan)


# -- in memory -----------------------------------------------------------------------------------------------------------
_RX_CACHE: dict[str, re.Pattern[str]] = {}


def _rx(src: str) -> re.Pattern[str]:
    hit = _RX_CACHE.get(src)
    if hit is None:
        py = src.replace(NW, r"\W").replace(W, r"\w").replace(r"[^\p{L}\p{N}_#]", r"[^\w#]").replace(r"[^\p{L}\p{N}_@]", r"[^\w@]")
        hit = _RX_CACHE[src] = re.compile(py, re.UNICODE)
    return hit


def evaluate(plan: dict[str, Any], post: dict[str, Any]) -> bool:
    """The plan on one post: {text, author, url, platform, followers, language}."""
    t = plan["t"]
    if t == "and":
        return all(evaluate(k, post) for k in plan["kids"])
    if t == "or":
        return any(evaluate(k, post) for k in plan["kids"])
    if t == "not":
        return not evaluate(plan["kid"], post)
    if t == "rx":
        text = str(post.get("text") or "")
        return bool(_rx(plan["src"]).search(text if plan.get("cs") else text.lower()))
    if t == "url":
        return bool(_rx(plan["src"]).search(str(post.get("url") or "").lower()))
    if t == "author":
        return str(post.get("author") or "").lower().lstrip("@") == plan["value"]
    if t == "platform":
        return str(post.get("platform") or "").lower() == plan["value"]
    if t == "language":
        return str(post.get("language") or "").lower() == plan["value"]
    if t == "followers":
        n = post.get("followers")
        if n is None:
            return False
        return (plan.get("min") is None or n >= plan["min"]) and (plan.get("max") is None or n <= plan["max"])
    return False


# -- the filter form -------------------------------------------------------------------------------------------------------
def _list(value: Any) -> list[str]:
    items = value if isinstance(value, list) else re.split(r"[,\n]", str(value or ""))
    return [str(s).strip() for s in items if str(s).strip()]


def _quoted(term: str) -> str:
    return f'"{term}"' if re.search(r"\s", term) and not term.startswith('"') else term


def from_filters(f: dict[str, Any]) -> str:
    """The filter form as a Boolean query: all of / any of / none of, platforms (or sites), accounts, a least number
    of followers, language, hashtags. "" when nothing was filled in."""
    parts: list[str] = []
    all_of, any_of, none_of = _list(f.get("all")), _list(f.get("any")), _list(f.get("none"))
    parts += [_quoted(t) for t in all_of]
    if any_of:
        parts.append("(" + " OR ".join(_quoted(t) for t in any_of) + ")")
    sites = _list(f.get("sites")) + [PLATFORM_SITE[p.lower()] for p in _list(f.get("platforms")) if p.lower() in PLATFORM_SITE]
    lists = {"site": sites, "author": [a.lstrip("@") for a in _list(f.get("authors"))], "language": _list(f.get("languages")),
             "hashtags": _list(f.get("hashtags"))}
    for op, vals in lists.items():
        if vals:
            parts.append(f"{op}:(" + " OR ".join(_quoted(v) for v in dict.fromkeys(vals)) + ")")
    try:
        followers = round(float(f.get("min_followers") or 0))
    except (TypeError, ValueError):
        followers = 0
    if followers > 0:
        parts.append(f"authorFollowers:[{followers} TO *]")
    query = " AND ".join(parts)
    if none_of:
        query = (f"({query}) " if query else "") + "NOT (" + " OR ".join(_quoted(t) for t in none_of) + ")"
    return query.strip()


def show(plan: dict[str, Any] | None, depth: int = 0) -> str:
    """The plan in words, for the page that shows how a query converts."""
    if plan is None:
        return ""
    t = plan["t"]
    pad = "  " * depth
    if t in ("and", "or"):
        return f"{pad}{'ALL of' if t == 'and' else 'ANY of'}:\n" + "\n".join(show(k, depth + 1) for k in plan["kids"])
    if t == "not":
        return f"{pad}NOT:\n{show(plan['kid'], depth + 1)}"
    if t == "rx":
        return f"{pad}words match /{plan['src'][:120]}/" + (" (case sensitive)" if plan.get("cs") else "")
    if t == "url":
        return f"{pad}link matches /{plan['src'][:120]}/"
    if t == "followers":
        return f"{pad}followers between {plan.get('min', '*')} and {plan.get('max', '*')}"
    return f"{pad}{t} is {plan.get('value')}"
