"""Burson's live alerts label the product line "[Product(s)]:"; the parser must read it as the product."""

from triage_agent.config import load_config
from triage_agent.qa.parser import parse

CFG = load_config()

LIVE = """Automated Alert via Burson (beta)

🟨SOCIAL ALERT🟨: {header} | "No to Big Tech in Our Schools" Protest | Instagram | 373 Engagements
[Name]:  "No to Big Tech in Our Schools" Protest / Ongoing Issue
[Engagement]: LOW (373 engagement)
{product_line}
[Social Network]: Instagram
[Exposure Tag]: Brand - Consumer boycotts & protests
[Sensitive Topic]: Child Safety
[KOF]: No

Instagram user exampleteacher (5.8K followers) criticized Google's push for AI adoption in education.

[Link]: https://www.instagram.com/p/DPq1aBcDeFg/
"""


def test_product_s_label_is_the_product():
    for line in ("[Product(s)]: Search", "Product(s): Search", "[Products]: Search", "[Google Product(s)]: Search", "[Product]: Search"):
        # the header names another product, so the answer can only come from the labelled line
        p = parse(CFG, LIVE.format(header="Brand", product_line=line))
        assert p.fields["product"] == "Search", line


def test_product_s_label_with_several_products():
    p = parse(CFG, LIVE.format(header="Brand, Google for Education, Search",
                               product_line="[Product(s)]: Brand, Google for Education, Search"))
    assert p.fields["product"] == "Brand"
    assert p.fields["other_products"] == ["Google for Education", "Search"]
