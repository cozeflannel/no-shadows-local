"""Burson's live alerts label the product line "[Product(s)]:"; the parser must read it as the product.

The live layout's fixed lines (its title, its automated-message note, "Do Not Forward", the Collection Requirements
line, the words of its link to the post) are no part of the summary, and a line of the summary that starts
"Google products:" is words of the summary, never the product.
"""

from triage_agent.config import load_config
from triage_agent.qa.parser import parse

CFG = load_config()

PARAGRAPH = "Instagram user exampleteacher (5.8K followers) criticized Google's push for AI adoption in education."

LIVE = """Automated Alert via Burson (beta)
Note: This is an automated message, all alerts can be found in Brand Safety Tracking (go/Brand-Safety-Tracking)
Do Not Forward - NTK only

This alert does not meet the defined Collection Requirements

🟨SOCIAL ALERT🟨: {header} | "No to Big Tech in Our Schools" Protest | Instagram | 373 Engagements
[Name]:  "No to Big Tech in Our Schools" Protest / Ongoing Issue
[Engagement]: LOW (373 engagement)
{product_line}
[Social Network]: Instagram
[Exposure Tag]: Brand - Consumer boycotts & protests
[Sensitive Topic]: Child Safety
[KOF]: No

{summary}

[Link]: https://www.instagram.com/p/DPq1aBcDeFg/

As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.

[Time/Date Post Went Live]:  11/14/2026,7:51 PM

[Code]: Brand - Consumer boycotts & protests,373,exampleteacher,Child Safety,Brand,Ongoing Issue

Click here for link to post
"""


def live(header="Brand", product_line="[Product(s)]: Brand", summary=PARAGRAPH):
    return LIVE.format(header=header, product_line=product_line, summary=summary)


def test_product_s_label_is_the_product():
    for line in ("[Product(s)]: Search", "Product(s): Search", "[Google Product(s)]: Search", "[Product]: Search"):
        # the header names another product, so the answer can only come from the labelled line
        p = parse(CFG, live(product_line=line))
        assert p.fields["product"] == "Search", line


def test_product_s_label_with_several_products():
    p = parse(CFG, live(header="Brand, Google for Education, Search",
                        product_line="[Product(s)]: Brand, Google for Education, Search"))
    assert p.fields["product"] == "Brand"
    assert p.fields["other_products"] == ["Google for Education", "Search"]


def test_the_bare_plurals_are_not_product_labels():
    labels = next(f.labels for f in CFG.alert_template.fields if f.name == "product")
    assert labels == ["Product", "Google Product", "Product(s)", "Google Product(s)"]
    # a boycott list in the summary: its lines are words of the summary, and the product is the labelled line's
    listing = "\n".join(["Instagram user exampleteacher (5.8K followers) shared a boycott list:",
                         "Google products: Gmail, Maps, YouTube", "Amazon products: Alexa, Ring"])
    p = parse(CFG, live(summary=listing))
    assert p.fields["product"] == "Brand"
    assert not p.fields.get("other_products")
    assert p.fields["summary"] == listing
    # a summary line that starts "Products:" doesn't join the product either
    p = parse(CFG, live(header="Gems", product_line="[Product(s)]: Gems",
                        summary=PARAGRAPH + "\nProducts: Gems and Chromebooks are named in the caption."))
    assert p.fields["product"] == "Gems"


def test_the_live_layouts_fixed_lines_are_no_part_of_the_summary():
    p = parse(CFG, live())
    assert p.fields["summary"] == PARAGRAPH
    assert p.fields["code"] == "Brand - Consumer boycotts & protests,373,exampleteacher,Child Safety,Brand,Ongoing Issue"
    # with no blank lines between its parts, as some arrive
    tight = "\n".join(line for line in live().splitlines() if line.strip())
    p = parse(CFG, tight)
    assert p.fields["summary"] == PARAGRAPH
    assert p.fields["code"] == "Brand - Consumer boycotts & protests,373,exampleteacher,Child Safety,Brand,Ongoing Issue"
    # a line that only starts like one of them is words of a summary
    words = "Noted: This is an automated message from a bot account, the user claims."
    assert parse(CFG, live(summary=words)).fields["summary"] == words
