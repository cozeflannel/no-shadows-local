"""The Social Alert email as the team sends it: the HTML template, what it is filled with, and what is kept of an edit.

A port of the sheet-based bot's template (apps-script-chat-bot/Email.gs socialAlertHtml_ / emailValues_ /
socialAlertText_), so the email composed in the Console looks the same as one drafted from the sheet:

    values(ctx, case, ...)        every value the template shows, read from the alert's fields. Nothing is computed by
                                  a model: the engagement count, level and colour come from the alert and the settings.
    social_alert_html(v, ...)     the email: the coloured SOCIAL ALERT header (its colour follows the engagement level),
                                  the summary, the buttons, Alert Details, the Emoji Key and the footer
    clean_email_html(markup)      an edited email with anything that could run or load code taken out
    html_to_text(markup)          the plain-text copy Gmail keeps beside the HTML

The kinds of email are the template's variants: a new alert, an update on an ongoing issue (a reply on its thread), and
the owned-post note that is added when the exposure tag says the post is Google's own.
"""

from __future__ import annotations

import html
import re
from html.parser import HTMLParser
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from .. import render
from ..models import Case
from . import drafting

if TYPE_CHECKING:  # pragma: no cover
    from ..context import AgentContext

LINKS = {
    "learn_more": "https://sites.google.com/corp/google.com/247-social-listening-site/slrr-alerts",
    "all_alerts": "https://lookerstudio.google.com/c/u/0/reporting/f3b19d3c-e8d9-401c-b384-f730c4d66af4/page/p_ath6l398kd/",
    "digest": "http://go/slrr-digest",
    "feedback": "https://slrr-tooling-1028310913761.us-central1.run.app/feedback",
    "logo": "https://services.google.com/fh/files/newsletters/brandsafetylogo2.png",
    "icon": "https://services.google.com/fh/files/newsletters/brandsafetylogo.png",
}
HEADER_COLORS = {"VERY LOW": "#d2d4d8", "LOW": "#e1aa26", "MODERATE": "#de7525", "HIGH": "#e6392d"}
DEFAULT_HEADER = "#FFA500"
OWNED_TAG = "Content - Negative reaction to owned social post"
ONGOING = "Ongoing Issue"
TEMPLATES = {"social_alert": "Social Alert (new issue)", "ongoing_update": "Update on an ongoing issue"}


def _list(value: Any) -> list[str]:
    if value in (None, "", []):
        return []
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v).strip()]
    return [p.strip() for p in re.split(r"[,;|\n]", str(value)) if p.strip()]


def _int(value: Any) -> int:
    try:
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return 0


def values(ctx: "AgentContext", case: Case, *, summary: str | None = None, tns_submitted: bool = False,
           send_id: str = "") -> dict[str, Any]:
    """What the template shows for this alert. `summary`: the analyst's own words in the summary's place."""
    f = drafting.alert_fields(case)
    a = drafting.assessment_of(case)
    is_kof = bool((a.is_kof if a else None) or f.get("kof"))
    total = a.engagement_total if a and a.engagement_total is not None else f.get("total_engagement")
    count = _int(total)
    level = str((a.engagement_level if a else None) or f.get("engagement_level") or "N/A").upper()
    primary = str((a.product if a else None) or f.get("product") or "Google")
    others = [str(o) for o in ((a.secondary_products if a and a.secondary_products else None) or _list(f.get("other_products"))) if o]
    products = ", ".join(dict.fromkeys([primary, *others]))
    issue = str((a.issue_name if a else None) or f.get("issue_name") or drafting.alert_name(case).split(" / ")[0] or "Alert")
    ongoing = str((a.issue_status if a else None) or f.get("issue_status") or "").upper().startswith("ONGOING")
    lists = _list(f.get("kof_lists"))
    tag = str((a.exposure_tag if a else None) or f.get("exposure_tag") or "-")
    risk = ", ".join(dict.fromkeys([*((a.sensitive_topics if a else None) or []), *_list(f.get("risk_tags"))])) or "-"
    link = str(f.get("post_url") or "")
    return {
        "product": products, "primary_product": primary, "issue": issue, "network": str((a.platform if a else None) or f.get("social_network") or "-"),
        "count": count, "level": level, "square": drafting._engagement_square(level, count, is_kof),
        "name": f"{issue} / {ONGOING if ongoing else 'New'}", "ongoing": ongoing, "tag": tag, "risk": risk,
        "kof": ("Yes" + (f" ({', '.join(lists)})" if lists else "")) if is_kof else "No",
        "ts": "Yes" if tns_submitted else "No",  # whether the incident was submitted to T&S, never why it was flagged
        "summary": (summary if summary is not None else str(f.get("summary") or f.get("post_content") or issue)).strip() or "-",
        "link": link, "date": str(f.get("post_date") or "-"), "owned": tag == OWNED_TAG,
        "code": str(f.get("code") or f"{tag},{count},{f.get('author') or ''},{risk},{products},{ONGOING if ongoing else 'New'}"),
        "stamp": str((a.video_timestamp if a else None) or f.get("video_timestamp") or "").strip(), "send_id": send_id,
    }


def subject(v: dict[str, Any]) -> str:
    """<square>SOCIAL ALERT<square>: products | issue | network | N Engagements (Email.gs socialAlertSubject_)."""
    return render.truncate(f"{v['square']}SOCIAL ALERT{v['square']}: {v['product']} | {v['issue']} | {v['network']} | {v['count']} Engagements", 250)


def social_alert_html(v: dict[str, Any]) -> str:
    """The email body. Every style is written on its element, as mail clients need."""
    e = html.escape
    color = HEADER_COLORS.get(str(v["level"]).upper(), DEFAULT_HEADER)
    campaign = quote(re.sub(r"\s+", "_", str(v["primary_product"]).strip()).lower()) or "social_alert"
    learn = (f"{LINKS['learn_more']}?utm_source=social_alert&utm_medium=email&utm_campaign={campaign}"
             f"&utm_content=header_learn_more&utm_term={quote(str(v['code']).strip()) or 'none'}")
    link = v["link"] or "#"
    send_id = quote(str(v.get("send_id") or ""))

    def sq(c: str) -> str:
        return f'<span style="display: inline-block; width: 12px; height: 12px; vertical-align: middle; border: 1px solid #ccc; background-color: {c};"></span>'

    def button(href: str, label: str) -> str:
        return ('<td align="center"><table border="0" cellpadding="0" cellspacing="0" role="presentation"><tr>'
                f'<td align="center" bgcolor="#007BFF" style="border-radius: 5px;"><a href="{e(href)}" target="_blank" style="font-size: 14px; '
                'font-family: Arial, sans-serif; color: #ffffff; text-decoration: none; padding: 10px 15px; border-radius: 5px; display: inline-block;">'
                f"{label}</a></td></tr></table></td>")

    def vote(direction: str, emoji: str, label: str) -> str:
        return ('<td align="center" bgcolor="#ffffff" style="border: 1px solid #dadce0; border-radius: 6px;">'
                f'<a href="{LINKS["feedback"]}?send_id={send_id}&amp;vote={direction}" target="_blank" style="font-size: 15px; font-family: Arial, sans-serif; '
                f'color: #3c4043; text-decoration: none; padding: 8px 16px; display: inline-block;"><span style="font-size: 18px;">{emoji}</span> {label}</a></td>')

    def row(label: str, value: Any) -> str:
        return ('<tr><td style="padding: 8px; border: 1px solid #ddd; font-size: 14px; font-weight: bold; color: #555555; width: 30%;">'
                f'{label}</td><td style="padding: 8px; border: 1px solid #ddd; font-size: 14px;">{e(str(value))}</td></tr>')

    def key(mark: str, text: str) -> str:
        return f'<tr style="vertical-align: top;"><td style="padding: 2px 0; width: 25px;">{mark}:</td><td style="padding: 2px 0;">{text}</td></tr>'

    parts = [
        '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Social Alert</title></head>',
        '<body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">',
        '<div style="width: 100%; max-width: 680px; margin: 0 auto; background-color: #ffffff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">',
        f'<div style="background-color: {color}; color: #ffffff; padding: 15px 20px; font-size: 24px; font-weight: bold; text-align: center; line-height: 30px;">',
        f'<a href="{e(learn)}" target="_blank" style="float: right; background-color: #ffffff; color: #202124; font-size: 11px; font-weight: bold; '
        'text-decoration: none; padding: 4px 8px; border-radius: 4px; white-space: nowrap; margin-top: 3px; line-height: normal;">Learn more</a>',
        f'<img src="{LINKS["logo"]}" alt="Logo" style="width: 30px; height: auto; vertical-align: middle; margin-right: 15px;">SOCIAL ALERT'
        f'<img src="{LINKS["logo"]}" alt="Logo" style="width: 30px; height: auto; vertical-align: middle; margin-left: 15px;"></div>',
        '<div style="padding: 20px;">',
        '<div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; font-size: 14px; line-height: 1.6; margin-top: 20px;">',
        f'<p style="margin-top: 0; margin-bottom: 15px; white-space: pre-wrap;">{e(str(v["summary"]))}</p>',
        f'<p style="margin-top: 0; margin-bottom: 15px;">Timestamp in the video: {e(v["stamp"])}</p>' if v.get("stamp") else "",
        ("<p style=\"margin-top: 0; margin-bottom: 15px; font-style: italic;\">*We're now sharing owned social alerts once sentiment reaches "
         "40% negativity.</p>") if v.get("owned") else "",
        '<table border="0" cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin: 0 auto;"><tr>',
        button(link, "View Post"), '<td style="width: 10px;"> </td>', button(LINKS["all_alerts"], "View All Alerts"),
        '<td style="width: 10px;"> </td>', button(LINKS["digest"], "Create Custom Alerts Digest"), "</tr></table>",
        '<table border="0" cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin: 20px auto 0 auto; border-top: 1px solid #e0e0e0; padding-top: 14px; width: 100%;">',
        '<tr><td align="center" style="font-size: 13px; font-weight: 500; color: #555555; padding-bottom: 8px;">Was this alert useful?</td></tr>',
        '<tr><td align="center"><table border="0" cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin: 0 auto;"><tr>',
        vote("up", "&#x1F44D;", "Yes"), '<td style="width: 12px;"></td>', vote("down", "&#x1F44E;", "No"), "</tr></table></td></tr></table>",
        "</div>",
        '<div style="margin-top: 20px; margin-bottom: 20px;">',
        f'<div style="font-size: 18px; font-weight: bold; color: #333333; margin-bottom: 10px; border-bottom: 2px solid {color}; padding-bottom: 5px;">'
        f'<img src="{LINKS["icon"]}" alt="Alert Icon" style="height: 20px; width: auto; vertical-align: middle; margin-right: 8px;">Alert Details</div>',
        '<table style="width: 100%; border-collapse: collapse;">',
        row("Name", v["name"]), row("Engagement", f"{v['level']} ({v['count']} engagements)"), row("Product", v["product"]),
        row("Social Network", v["network"]), row("Exposure Tag", v["tag"]), row("Risk Tag", v["risk"]), row("KOF", v["kof"]), row("T&amp;S", v["ts"]),
        "</table></div>",
        '<div style="background-color: #f4f4f4; padding: 15px; font-size: 12px; color: #666666;">',
        '<div style="margin-bottom: 20px; padding: 10px; background-color: #e9e9e9; border-radius: 5px;">',
        '<p style="margin-top: 0; margin-bottom: 8px; font-weight: bold; color: #333333;">Emoji Key</p>',
        '<table style="width: 100%; border-collapse: collapse; font-size: 12px; color: #666666;">',
        key("⬛", "Post being flagged has &lt;200 engagements"), key(sq("#FFD700"), "Post being flagged has 200-499 engagements"),
        key(sq("#FFA500"), "Post being flagged has 500-1,999 engagements"), key(sq("#DC143C"), "Post being flagged 2,000+ engagements"),
        key("⭐", "Post being flagged is from a Viral KOF (separate emoji because we often see these posts to eventually have high "
                  "engagement, even if they have low engagement when we alert originally)"),
        "</table></div>",
        '<p style="margin: 5px 0;">As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.</p>',
        "<p style=\"margin: 5px 0;\">Note: Brand-Social-Sends@ and SLRR-updates@ includes xWF vendors that support Brand Social's 24/7 "
        "Social Listening &amp; Rapid Response. Please consider removing these aliases in NTK replies.</p>",
        f'<p style="margin: 5px 0;">Code: {e(str(v["code"]))}</p>',
        f'<p style="margin: 5px 0;">Link: <a href="{e(link)}" style="color: #007bff; text-decoration: underline;">{e(v["link"] or "Link not available")}</a></p>',
        "</div></div></div></body></html>",
    ]
    return "\n".join(p for p in parts if p)


def social_alert_text(v: dict[str, Any]) -> str:
    """The plain-text copy (Email.gs socialAlertText_)."""
    stamp = f"\nTimestamp in the video: {v['stamp']}" if v.get("stamp") else ""
    return (f"SOCIAL ALERT\n\n{v['summary']}\n\nLink: {v['link'] or '#'}{stamp}\n\n--- Alert Details ---\nName: {v['name']}\n"
            f"Engagement: {v['level']} ({v['count']} engagements)\nProduct: {v['product']}\nSocial Network: {v['network']}\n"
            f"Exposure Tag: {v['tag']}\nRisk Tag: {v['risk']}\nKOF: {v['kof']}\nT&S: {v['ts']}\nCode: {v['code']}")


# ---------------------------------------------------------------------------------------------------------------
# What is kept of an email a person edited
# ---------------------------------------------------------------------------------------------------------------

_TAGS = frozenset("""html head body title div span p br hr a img table thead tbody tfoot tr td th ul ol li b strong i em u s sub sup
                     h1 h2 h3 h4 h5 h6 blockquote pre font center small""".split())
_DROP = frozenset({"script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "link", "base", "svg", "math",
                   "noscript", "frame", "frameset", "applet", "audio", "video", "source"})
_VOID = frozenset({"br", "hr", "img", "meta"})
_DROP_VOID = frozenset({"link", "base", "input", "source", "embed"})  # dropped, and they never have an end tag
_ATTRS = frozenset({"style", "href", "src", "alt", "title", "align", "valign", "width", "height", "border", "cellpadding", "cellspacing", "bgcolor",
                    "color", "role", "target", "colspan", "rowspan", "lang", "dir", "face", "size"})
_BAD_STYLE = re.compile(r"expression\s*\(|url\s*\(|@import|behavior\s*:|-moz-binding|javascript:", re.I)
_OK_HREF = re.compile(r"^(https?://|mailto:|#)", re.I)
_OK_SRC = re.compile(r"^(https://|cid:)", re.I)
MAX_HTML = 400_000


class _Cleaner(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _DROP:
            self.skip += 0 if tag in _DROP_VOID else 1
            return
        if self.skip:
            return
        if tag == "meta":
            if any(k == "charset" for k, _ in attrs):
                self.out.append('<meta charset="UTF-8">')
            return
        if tag not in _TAGS:
            return
        kept = []
        for name, raw in attrs:
            value = (raw or "").strip()
            if name not in _ATTRS or name.startswith("on"):
                continue
            if name == "style" and _BAD_STYLE.search(value):
                continue
            if name == "href" and not _OK_HREF.match(value):
                continue
            if name == "src" and not _OK_SRC.match(value):
                continue
            kept.append(f' {name}="{html.escape(value, quote=True)}"')
        if tag == "a":
            kept.append(' rel="noopener noreferrer"')
        self.out.append(f"<{tag}{''.join(kept)}>")

    def handle_endtag(self, tag: str) -> None:
        if tag in _DROP:
            self.skip = self.skip if tag in _DROP_VOID else max(0, self.skip - 1)
        elif not self.skip and tag in _TAGS and tag not in _VOID:
            self.out.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.out.append(html.escape(data, quote=False))


def clean_email_html(markup: str) -> str:
    """The email as edited, with scripts, forms, embedded pages, event handlers and non-https pictures taken out."""
    parser = _Cleaner()
    parser.feed((markup or "")[:MAX_HTML])
    parser.close()
    body = "".join(parser.out).strip()
    return body if body.lower().startswith("<html") or "<body" in body.lower() else f'<html lang="en"><head><meta charset="UTF-8"></head><body>{body}</body></html>'


def html_to_text(markup: str) -> str:
    """The plain-text copy of an edited email: its words, one block a line."""
    text = re.sub(r"(?is)<(script|style|head|title)\b.*?</\1>", "", markup or "")
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>|</h[1-6]>", "\n", text)
    text = re.sub(r"(?i)</t[dh]>", "  ", text)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
