"""Mine live Burson Google Chat history (burson_live_history.csv) + BigQuery ground-truth emoji outcomes into Golden Precedents and Vertex SFT training data.

Usage:
    .venv/bin/python -m scripts.mine_burson_history --bq-emoji-json PATH

PATH is a saved BigQuery query result (JSON with `schema.fields` and `rows`) that has the columns
`url` and `google_emoji_1` .. `google_emoji_5`. The script rewrites config/precedents.json, which the
bot is built from, so it stops before writing anything when that file is missing or cannot be read.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from triage_agent.config import load_config

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / "burson_live_history.csv"
PRECEDENTS_OUT = ROOT / "config" / "precedents.json"
SFT_OUT = ROOT / "data" / "vertex_sft_burson.jsonl"

FIELD_RE = re.compile(r"^\s*[\*\[]*([A-Za-z][A-Za-z0-9 /&()_-]+?)[\*\]]*\s*:\s*(.+)$", re.M)
SUMMARY_RE = re.compile(
    r"(?:\[KOF\][^\n]*\n+|\*KOF\*[^\n]*\n+)(.+?)(?=\n+\s*(?:View Post|\[?Time/Date|\[?Code\]?:))",
    re.S | re.I,
)
URL_RE = re.compile(r"https?://\S+")
MENTION_RE = re.compile(r"@[A-Za-z]+(?: [A-Za-z]+)?(?:\s*\(xWF\))?")


def norm_url(u: str) -> str:
    s = (u or "").strip().rstrip(")>]/")
    s = re.sub(r"^https?://(?:www\.)?twitter\.com/", "https://x.com/", s, flags=re.I)
    s = re.sub(r"\?.*$", "", s)
    return s.lower()


def parse_alert(text: str) -> dict[str, str]:
    d: dict[str, str] = {}
    for m in FIELD_RE.finditer(text):
        k = m.group(1).strip().lower()
        v = m.group(2).strip().lstrip("*").rstrip("*").strip()
        d[k] = v
    m_sum = SUMMARY_RE.search(text)
    if m_sum:
        d["summary"] = re.sub(r"\s+", " ", m_sum.group(1)).strip()
    m_url = URL_RE.search(text)
    if m_url:
        d["url"] = m_url.group(0).rstrip(")>]")
    return d


def clean_note(text: str) -> str:
    s = MENTION_RE.sub("", text)
    s = re.sub(r"https?://\S+", "", s)
    s = re.sub(r"\[Attachment:[^\]]+\]", "", s)
    s = re.sub(r"\b(?:brand-social-sends|slrr-updates|wd-triage|watchdog)\b", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip(" -|,.:;")
    return s


class BqEmojiFileError(Exception):
    """The BigQuery emoji export is missing or is not the expected query result."""


def load_bq_emojis(path: Path) -> dict[str, list[str]]:
    """Normalized post URL -> final emojis, from a saved BigQuery query result.

    Raises BqEmojiFileError rather than returning nothing: the emojis change the precedent scores.
    """
    if not path.is_file():
        raise BqEmojiFileError(f"BigQuery emoji export not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        cols = [f["name"] for f in data["schema"]["fields"]]
        if "url" not in cols or not any(c.startswith("google_emoji_") for c in cols):
            raise BqEmojiFileError(
                f"BigQuery emoji export {path} has no url / google_emoji_N columns (found: {cols})"
            )
        by_url: dict[str, list[str]] = {}
        for r in data.get("rows", []):
            vals = {cols[i]: r["f"][i]["v"] for i in range(len(cols))}
            u = norm_url(vals.get("url") or "")
            if not u:
                continue
            emojis = [
                vals.get(f"google_emoji_{k}").strip()
                for k in range(1, 6)
                if vals.get(f"google_emoji_{k}") and str(vals.get(f"google_emoji_{k}")).strip()
            ]
            if emojis:
                by_url[u] = emojis
        return by_url
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError) as exc:
        raise BqEmojiFileError(
            f"BigQuery emoji export {path} is not a readable query result ({type(exc).__name__}: {exc})"
        ) from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Mine burson_live_history.csv and BigQuery emoji outcomes into config/precedents.json "
        "and data/vertex_sft_burson.jsonl."
    )
    parser.add_argument(
        "--bq-emoji-json",
        required=True,
        type=Path,
        metavar="PATH",
        help="saved BigQuery query result (JSON: schema.fields + rows) with url and google_emoji_1..5",
    )
    args = parser.parse_args(argv)
    try:
        bq_emojis = load_bq_emojis(args.bq_emoji_json)
    except BqEmojiFileError as exc:
        print(f"error: {exc}. Nothing was written.", file=sys.stderr)
        return 2

    if not CSV_PATH.exists():
        print(f"CSV not found at {CSV_PATH}; skipping mining.")
        return 0

    cfg = load_config()
    col, dist = cfg.collection, cfg.distribution

    tag_map: dict[str, str] = {}
    for t in col.exposure_tags:
        tag_map[t.name.lower()] = t.name
        for a in t.aliases:
            tag_map[a.lower()] = t.name

    prod_map: dict[str, str] = {}
    for p in dist.products:
        target = p.redirect_to[0] if (p.deprecated and len(p.redirect_to) == 1) else p.name
        prod_map[p.name.lower()] = target
        for a in p.aliases:
            prod_map[a.lower()] = target

    def canon_tag(t: str) -> str:
        tl = re.sub(r"\s*[-–—]\s*", " - ", (t or "").strip().lower())
        return tag_map.get(tl, (t or "").strip())

    def canon_prod(p: str) -> str:
        pl = (p or "").strip().lower()
        return prod_map.get(pl, (p or "").strip())

    with CSV_PATH.open(encoding="utf-8", errors="replace") as f:
        rows = list(csv.DictReader(f))

    threads: dict[str, list[dict[str, str]]] = defaultdict(list)
    for r in rows:
        threads[r["THREAD_ID"]].append(r)
    for tid in threads:
        threads[tid].sort(key=lambda x: x["CREATED_TIME"])

    by_url: dict[str, list[tuple[str, str, dict[str, str], list[dict[str, str]]]]] = defaultdict(list)
    for tid, msgs in threads.items():
        first = msgs[0]
        if first["SENDER_TYPE"] == "BOT" and "SOCIAL ALERT" in first["MESSAGE_TEXT"]:
            p = parse_alert(first["MESSAGE_TEXT"])
            url = p.get("url", "")
            if url:
                by_url[norm_url(url)].append((first["CREATED_TIME"], tid, p, msgs))

    fix_candidates: list[dict[str, Any]] = []
    sft_rows: list[dict[str, Any]] = []

    for u_key, items in by_url.items():
        if len(items) < 2:
            continue
        items.sort(key=lambda x: x[0])
        _, _, p1, msgs1 = items[0]
        _, _, p2, _ = items[-1]
        human_notes = [clean_note(m["MESSAGE_TEXT"]) for m in msgs1[1:] if m["SENDER_TYPE"] != "BOT"]
        human_notes = [
            n
            for n in human_notes
            if len(n) > 18
            and not re.match(
                r"^(ty|thank|done|updated|will do|sure|no problem|checking|noted|request you to retrigger|retriggering|code error)",
                n,
                re.I,
            )
        ]
        if not human_notes:
            continue

        t1, t2 = (
            canon_tag(p1.get("exposure tag", "")),
            canon_tag(p2.get("exposure tag", "")),
        )
        pr1, pr2 = canon_prod(p1.get("product", "")), canon_prod(p2.get("product", ""))
        n1 = p1.get("name", "").split(" / ")[0].strip()
        n2 = p2.get("name", "").split(" / ")[0].strip()
        s1, s2 = p1.get("summary", ""), p2.get("summary", "")

        if any(x.startswith("[") or x == "/" for x in (t1, t2, pr1, pr2, n1, n2)):
            continue

        fixes: list[str] = []
        score = 0
        if t1 and t2 and t1 != t2 and t2 in tag_map.values() and t1 in tag_map.values():
            fixes.append(f"exposure_tag='{t2}' (was '{t1}')")
            score += 4
        if pr1 and pr2 and pr1 != pr2 and pr2 in prod_map.values() and pr1 in prod_map.values():
            fixes.append(f"product='{pr2}' (was '{pr1}')")
            score += 4
        if n1 and n2 and n1.lower() != n2.lower():
            fixes.append(f"issue_name='{n2}' (was '{n1}')")
            score += 2

        if not fixes:
            continue

        best_note = human_notes[0]
        for hn in human_notes:
            if re.search(
                r"\b(update|change|exposure|product|title|issue name|because|since|should be|re-?trigger)\b",
                hn,
                re.I,
            ):
                best_note = hn
                score += 2
                break

        emojis = bq_emojis.get(u_key, [])
        emoji_suffix = f" [Final emojis: {', '.join(emojis)}]" if emojis else ""
        if emojis:
            score += 2

        note_str = best_note[:160]
        entry = {
            "kind": "fix",
            "product": pr2 or pr1,
            "tag": t2 or t1,
            "name": n2 or n1,
            "summary": (s2 or s1)[:180],
            "lesson": f"Analyst correction ({'; '.join(fixes)}): {note_str}{emoji_suffix}",
            "_score": score,
        }
        fix_candidates.append(entry)
        sft_rows.append(
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": f"Product: {pr1}\nExposure Tag: {t1}\nIssue Name: {n1}\nSummary: {s1}"}
                        ],
                    },
                    {
                        "role": "model",
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "fixes": fixes,
                                        "warranted": True,
                                        "emojis": emojis,
                                        "analyst_note": note_str,
                                    },
                                    ensure_ascii=False,
                                )
                            }
                        ],
                    },
                ]
            }
        )

    xout_candidates: list[dict[str, Any]] = []
    for tid, msgs in threads.items():
        first = msgs[0]
        if first["SENDER_TYPE"] != "BOT" or "SOCIAL ALERT" not in first["MESSAGE_TEXT"]:
            continue
        p = parse_alert(first["MESSAGE_TEXT"])
        pr = canon_prod(p.get("product", ""))
        tg = canon_tag(p.get("exposure tag", ""))
        nm = p.get("name", "").split(" / ")[0].strip()
        sm = p.get("summary", "")
        u_key = norm_url(p.get("url", ""))
        if not pr or not tg or not sm or pr.startswith("[") or tg.startswith("["):
            continue
        for m in msgs[1:]:
            if m["SENDER_TYPE"] == "BOT":
                continue
            note = clean_note(m["MESSAGE_TEXT"])
            if (
                re.search(
                    r"\bx['’-]?ing\b|\bx this\b|\bx out\b|\bx'd\b|\bnot sharing\b|\bnot escalat",
                    note,
                    re.I,
                )
                and len(note) > 25
            ):
                has_why = bool(
                    re.search(
                        r"\b(because|bc|as|since|due to|not negative|neutral|verb|threshold|replicate|unverifiable|sarcasm|joke|meme|positive)\b",
                        note,
                        re.I,
                    )
                )
                xout_candidates.append(
                    {
                        "kind": "no_action",
                        "product": pr,
                        "tag": tg,
                        "name": nm,
                        "summary": sm[:180],
                        "lesson": f"No Social Alert (warranted=false / ❌): {note[:180]}",
                        "_score": (5 if has_why else 2) + (2 if u_key in bq_emojis else 0),
                    }
                )
                sft_rows.append(
                    {
                        "contents": [
                            {
                                "role": "user",
                                "parts": [
                                    {
                                        "text": f"Product: {pr}\nExposure Tag: {tg}\nIssue Name: {nm}\nSummary: {sm}"
                                    }
                                ],
                            },
                            {
                                "role": "model",
                                "parts": [
                                    {
                                        "text": json.dumps(
                                            {
                                                "fixes": [],
                                                "warranted": False,
                                                "emojis": ["❌ No action taken"],
                                                "analyst_note": note[:180],
                                            },
                                            ensure_ascii=False,
                                        )
                                    }
                                ],
                            },
                        ]
                    }
                )
                break

    fix_candidates.sort(key=lambda x: (-x["_score"], len(x["lesson"])))
    xout_candidates.sort(key=lambda x: (-x["_score"], len(x["lesson"])))

    selected: list[dict[str, Any]] = []
    seen_summaries: set[str] = set()
    seen_names: dict[str, int] = defaultdict(int)
    prod_counts: dict[str, int] = defaultdict(int)

    for pool, limit, max_per_prod in (
        (fix_candidates, 120, 7),
        (xout_candidates, 65, 6),
    ):
        count = 0
        for item in pool:
            if count >= limit:
                break
            key = item["summary"][:80].lower()
            name_key = f"{item['kind']}:{item['name'].lower()}"
            if not key or key in seen_summaries or seen_names[name_key] >= 1:
                continue
            p = item["product"]
            if prod_counts[f"{item['kind']}:{p}"] >= max_per_prod:
                continue
            seen_summaries.add(key)
            seen_names[name_key] += 1
            prod_counts[f"{item['kind']}:{p}"] += 1
            clean_item = {k: v for k, v in item.items() if not k.startswith("_")}
            selected.append(clean_item)
            count += 1

    PRECEDENTS_OUT.parent.mkdir(parents=True, exist_ok=True)
    PRECEDENTS_OUT.write_text(json.dumps(selected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    SFT_OUT.parent.mkdir(parents=True, exist_ok=True)
    with SFT_OUT.open("w", encoding="utf-8") as f:
        for row in sft_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(
        f"Wrote {len(selected)} golden precedents to {PRECEDENTS_OUT.relative_to(ROOT)} (BQ emoji URLs loaded: {len(bq_emojis)})"
    )
    print(f"Wrote {len(sft_rows)} Vertex SFT examples to {SFT_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
