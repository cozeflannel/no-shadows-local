"""X posts' words from X's public embed data (triage_agent/xposts.py, a port of tempcheck-app/lib/xposts.js).

The token for a post id is checked against the values the temp check app's own code gives for the same ids. X's
endpoint can't be reached from this workspace, so it is stood in for at the HTTP call with bodies in its shape.
"""

from __future__ import annotations

from typing import Any

from triage_agent import xposts

# tempcheck-app/lib/xposts.js embedToken(id) for these ids, as Node computes them
APP_TOKENS = {
    "20": "6dq1a2xwd93", "99999": "om9oka699g", "1845123456789012345": "4hmjoi5f1d", "1234567890123456789": "2zqic77uqyk",
    "1700000000000000000": "44cpgxmyurn", "1989999999999999999": "4tnrp481eua", "1000000000000000": "353i5ab8p5f",
    "1111111111111111111": "2oynpf5u2p5", "1853612345678901248": "4hram85fjpe", "1800000000000000001": "4d2v7cbm2xj",
}


class Answer:
    def __init__(self, body: Any, status: int = 200):
        self.body, self.status_code = body, status

    def json(self) -> Any:
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


def test_the_token_for_a_post_is_the_one_xs_own_embed_code_computes():
    assert {i: xposts.embed_token(i) for i in APP_TOKENS} == APP_TOKENS


def test_a_post_is_read_from_the_embed_data_with_its_words_author_link_and_counters():
    post = xposts.from_embed({"id_str": "1845123456789012345", "text": "Gmail is down &amp; I can&#39;t log in &lt;sigh&gt; ",
                              "user": {"screen_name": "techwatcher"}, "favorite_count": 2000, "conversation_count": 300})
    assert post == {"author": "techwatcher", "text": "Gmail is down & I can&#39;t log in <sigh>", "url": "https://x.com/techwatcher/status/1845123456789012345",
                    "likes": 2000, "replies": 300, "from": "X embed data"}
    assert xposts.from_embed({"text": "no id"}) is None and xposts.from_embed(None) is None
    assert len(xposts.from_embed({"id_str": "1", "text": "x" * 5000})["text"]) == 1200


def test_posts_x_will_not_serve_are_left_out_and_nothing_is_raised(monkeypatch):
    asked: list[tuple[str, dict[str, str]]] = []

    def get(url: str, headers: dict[str, str] | None = None, timeout: float | None = None) -> Answer:
        asked.append((url, headers or {}))
        if "id=1000000000000000&" in url:
            return Answer({}, 404)
        if "id=1111111111111111111&" in url:
            raise OSError("connection reset")
        if "id=1234567890123456789&" in url:
            return Answer(ValueError("not JSON"))
        post_id = url.split("id=")[1].split("&")[0]
        return Answer({"id_str": post_id, "text": f"post {post_id}", "user": {"screen_name": "a"}, "favorite_count": 1, "conversation_count": 2})

    monkeypatch.setattr("requests.get", get)
    found = xposts.lookup(["1845123456789012345", "1000000000000000", "1111111111111111111", "1234567890123456789", "not-an-id", "1845123456789012345"])
    assert set(found) == {"1845123456789012345"} and found["1845123456789012345"]["text"] == "post 1845123456789012345"
    assert len(asked) == 4, "each id once; what is not a post id is never asked"
    url, headers = next(a for a in asked if "id=1845123456789012345&" in a[0])
    assert url == "https://cdn.syndication.twimg.com/tweet-result?id=1845123456789012345&lang=en&token=4hmjoi5f1d"
    assert headers["User-Agent"].startswith("Mozilla/5.0")
    assert xposts.lookup([]) == {}
