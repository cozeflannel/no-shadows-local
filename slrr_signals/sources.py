"""The five source tables, read-only, as one shape (raw_mentions' columns).

Every source reads only the team's networks (settings.networks), English only, never Grok's posts, from the last 72
hours, with its own floor. Two kinds of place:
- window sources (sonar, comments) read (since, until]: the window after the last one read;
- watermark sources (tubular, bwm, owned) read what they first had after their watermark (Tubular's first sighting,
  Brandwatch's first load, Sprinklr's load time); bwm and owned are read only when their table changed.
The SQL never contains a value from a person or a post: everything variable is a query parameter.
"""

from __future__ import annotations

from dataclasses import dataclass

# Scripts other than Latin: a post mostly in one of them isn't English (the bot's NON_ENGLISH_SCRIPT_SQL_CLASS_)
_NON_LATIN = (r"[\p{Hangul}\p{Han}\p{Hiragana}\p{Katakana}\p{Arabic}\p{Cyrillic}\p{Devanagari}\p{Thai}\p{Hebrew}"
              r"\p{Bengali}\p{Tamil}\p{Telugu}]")
# Sonar's positive smart tags (en dash) and its use-case tag: not a risk (the bot's BQ_BSIP_POSITIVE_TAG_RX_)
_POSITIVE_TAG = (r"^(?:brand|product)\s*(?:–|-\s*(?:passion point alignment|google praise|lifestyle imagery|"
                 r"use case amplification|fan query|feature spotlight|comparison win|experience share))")

COLUMNS = ("source_id, post_url, platform, author, author_followers, engagement, views, text, title, summary, language, "
           "sentiment, posted_at, source_seen_at, products, source_tags, kof_lists, reason, extra")

OWNED_TAG = "Content - Negative reaction to owned social post"


def net_sql(expr: str) -> str:
    """A network as Sonar names it ("X" -> twitter, facebook_public -> facebook)."""
    v = f"REGEXP_REPLACE(LOWER(IFNULL({expr}, '')), r'[^a-z]', '')"
    return (f"CASE {v} WHEN 'x' THEN 'twitter' WHEN 'xtwitter' THEN 'twitter' WHEN 'twitterx' THEN 'twitter' "
            f"WHEN 'ig' THEN 'instagram' WHEN 'fb' THEN 'facebook' WHEN 'yt' THEN 'youtube' "
            f"WHEN 'facebookpublic' THEN 'facebook' WHEN 'instagrampublic' THEN 'instagram' ELSE {v} END")


def english_sql(expr: str) -> str:
    v = f"LOWER(TRIM(IFNULL({expr}, '')))"
    return f"({v} IN ('', 'en', 'eng', 'english', 'und', 'zxx') OR STARTS_WITH({v}, 'en-') OR STARTS_WITH({v}, 'en_'))"


def non_english_sql(expr: str) -> str:
    return (f"(REGEXP_CONTAINS({expr}, r'{_NON_LATIN}{{3,}}') AND ARRAY_LENGTH(REGEXP_EXTRACT_ALL({expr}, r'{_NON_LATIN}')) * 5 >= "
            f"ARRAY_LENGTH(REGEXP_EXTRACT_ALL(REGEXP_REPLACE({expr}, r'https?://\\S+', ' '), r'\\p{{L}}')))")


def not_grok_sql(url: str, author: str) -> str:
    return (f"NOT (REGEXP_CONTAINS(LOWER(TRIM(IFNULL({url}, ''))), r'^https?://(?:www\\.|m\\.|mobile\\.)?(?:x|twitter)\\.com/grok/') "
            f"OR LOWER(TRIM(IFNULL({author}, ''))) IN ('@grok', 'grok'))")


def tables_sql(table: str) -> str:
    """When a table last changed, from its dataset's __TABLES__ (free)."""
    i = table.rfind(".")
    return (f"SELECT TIMESTAMP_MILLIS(last_modified_time) AS modified FROM `{table[:i]}.__TABLES__` "
            "WHERE table_id = @table_id")


@dataclass(frozen=True)
class Source:
    key: str
    kind: str  # window | watermark
    gated: bool  # read only when the table changed


SOURCES = {
    "sonar": Source("sonar", "window", False),
    "comments": Source("comments", "window", False),
    "bwm": Source("bwm", "watermark", True),
    "owned": Source("owned", "watermark", True),
    "tubular": Source("tubular", "watermark", False),
}
# fastest first: a run that runs out of time has read what matters most for speed
ORDER = ["sonar", "comments", "bwm", "owned", "tubular"]


def sonar_sql(table: str) -> str:
    risk_tag = "LOWER(IFNULL(smart_tag, ''))"
    eng = "IFNULL(engagement_likes, 0) + IFNULL(engagement_comments, 0) + IFNULL(engagement_shares, 0)"
    j = lambda p: f"JSON_VALUE(payload, '$.detail.{p}')"  # noqa: E731
    ja = lambda p: f"JSON_VALUE_ARRAY(payload, '$.detail.classification.{p}')"  # noqa: E731
    return f"""
WITH win AS (
  SELECT post_url,
    MIN(received_at) AS seen,
    ANY_VALUE({net_sql('platform')}) AS platform,
    SAFE_CAST(MAX(IFNULL(follower_count, 0)) AS INT64) AS followers,
    SAFE_CAST(MAX({eng}) AS INT64) AS eng,
    MIN(SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%S', SUBSTR(post_timestamp, 1, 19))) AS posted,
    LOGICAL_OR(NOT (REGEXP_CONTAINS({risk_tag}, r"{_POSITIVE_TAG}") OR {risk_tag} IN ('functional use case', ''))) AS risk_tag,
    ANY_VALUE({j('channel.username')}) AS author,
    ANY_VALUE({j('classification.issue_name')}) AS issue,
    ANY_VALUE({j('classification.summary')}) AS summary,
    STRING_AGG(DISTINCT SUBSTR({j('post.snippet.text')}, 1, 2000), ' | ' LIMIT 2) AS text,
    ANY_VALUE({j('post.language')}) AS language,
    ARRAY_AGG(STRUCT({ja('brand_classification_names')} AS p, {j('classification.smart_tag_name')} AS t,
      {ja('secondary_tag_names')} AS s, {ja('influencer_list_names')} AS k) ORDER BY received_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS cls
  FROM `{table}`
  WHERE received_at > @since AND received_at <= @until AND post_url IS NOT NULL
    AND {net_sql('platform')} IN UNNEST(@networks)
    AND {english_sql(j('post.language'))}
  GROUP BY post_url
)
SELECT post_url AS source_id, post_url, platform, author, followers AS author_followers, eng AS engagement,
  CAST(NULL AS INT64) AS views, text, CAST(NULL AS STRING) AS title, summary, language, CAST(NULL AS STRING) AS sentiment,
  posted AS posted_at, seen AS source_seen_at, IFNULL(cls.p, []) AS products,
  ARRAY_CONCAT(IF(cls.t IS NULL, CAST([] AS ARRAY<STRING>), [cls.t]), IFNULL(cls.s, [])) AS source_tags,
  IFNULL(cls.k, []) AS kof_lists, 'new' AS reason, TO_JSON_STRING(STRUCT(issue AS issue)) AS extra
FROM win
WHERE risk_tag AND (followers >= @min_followers OR eng >= @min_engagement)
  AND (posted IS NULL OR posted >= TIMESTAMP_SUB(@until, INTERVAL 72 HOUR))
  AND NOT {non_english_sql("IFNULL(text, '')")}
  AND {not_grok_sql('post_url', 'author')}
ORDER BY followers DESC
LIMIT @max_rows"""


def tubular_sql(table: str) -> str:
    return f"""
SELECT video_url AS source_id, video_url AS post_url, platform, creator AS author, followers AS author_followers,
  eng AS engagement, views, title AS text, title, CAST(NULL AS STRING) AS summary, 'en' AS language,
  CAST(NULL AS STRING) AS sentiment, posted AS posted_at, first_seen AS source_seen_at, CAST([] AS ARRAY<STRING>) AS products,
  IF(IFNULL(topics, '') = '', CAST([] AS ARRAY<STRING>), ARRAY(SELECT TRIM(x) FROM UNNEST(SPLIT(topics, ',')) x WHERE TRIM(x) != '')) AS source_tags,
  CAST([] AS ARRAY<STRING>) AS kof_lists, 'new' AS reason, TO_JSON_STRING(STRUCT(views AS views)) AS extra
FROM (
  SELECT video_url, ANY_VALUE({net_sql('platform')}) AS platform, ANY_VALUE(creator) AS creator,
    SAFE_CAST(MAX(creator_followers_or_subscribers) AS INT64) AS followers, SAFE_CAST(MAX(total_engagements) AS INT64) AS eng,
    SAFE_CAST(MAX(views) AS INT64) AS views, MIN(published_at_utc) AS posted, MIN(first_seen_at_utc) AS first_seen,
    ANY_VALUE(video_title) AS title, ANY_VALUE(COALESCE(NULLIF(topics, ''), NULLIF(youtube_topics, ''), categories)) AS topics
  FROM `{table}`
  WHERE snapshot_date >= DATE_SUB(DATE(@since), INTERVAL 2 DAY) AND video_url IS NOT NULL
    AND {net_sql('platform')} IN UNNEST(@networks)
  GROUP BY video_url
)
WHERE first_seen > @since AND first_seen <= @until
  AND (posted IS NULL OR posted >= TIMESTAMP_SUB(@until, INTERVAL 72 HOUR))
  AND (IFNULL(followers, 0) >= @min_followers OR IFNULL(eng, 0) >= @min_engagement OR IFNULL(views, 0) >= @min_views)
  AND NOT {non_english_sql("IFNULL(title, '')")}
ORDER BY IFNULL(views, 0) + 20 * IFNULL(eng, 0) DESC
LIMIT @max_rows"""


def bwm_sql(table: str) -> str:
    eng = " + ".join(f"IFNULL({c}, 0)" for c in ("like_count", "retweet_count", "reply_count", "comment_count", "share_count"))
    return f"""
SELECT mention_id AS source_id, post_url, platform, NULLIF(author, '') AS author, followers AS author_followers,
  eng AS engagement, CAST(NULL AS INT64) AS views, body AS text, NULLIF(title, '') AS title, CAST(NULL AS STRING) AS summary,
  'en' AS language, 'negative' AS sentiment, posted AS posted_at, first_seen AS source_seen_at, configs AS products,
  ARRAY(SELECT DISTINCT x FROM UNNEST(tags) x ORDER BY x LIMIT 6) AS source_tags, CAST([] AS ARRAY<STRING>) AS kof_lists,
  'negative' AS reason, TO_JSON_STRING(STRUCT(mention_id AS mention_id)) AS extra
FROM (
  SELECT mention_id, MIN(load_timestamp) AS first_seen, ANY_VALUE(post_url) AS post_url, ANY_VALUE(net) AS platform,
    ANY_VALUE(TRIM(IFNULL(author, ''))) AS author, SAFE_CAST(MAX(reachEstimate) AS INT64) AS followers,
    SAFE_CAST(MAX({eng}) AS INT64) AS eng, MIN(published_timestamp) AS posted,
    ARRAY_AGG(DISTINCT product_config_name IGNORE NULLS LIMIT 3) AS configs,
    ANY_VALUE(TRIM(IFNULL(snippet, ''))) AS body, ANY_VALUE(TRIM(IFNULL(title, ''))) AS title,
    ARRAY_CONCAT_AGG(xtags) AS tags
  FROM (
    SELECT *, {net_sql('platform')} AS net,
      ARRAY(SELECT c.name FROM UNNEST(categories) c WHERE c.parent_name = @exposure_group AND c.name IS NOT NULL) AS xtags
    FROM `{table}`
    WHERE report_date >= DATE_SUB(DATE(@until), INTERVAL 3 DAY)
      AND product_config_name IN UNNEST(@configs) AND language = 'en'
      AND LOWER(IFNULL(sentiment, '')) = 'negative' AND LOWER(IFNULL(thread_entry_type, '')) != 'share'
      AND {net_sql('platform')} IN UNNEST(@bwm_networks)
      AND load_timestamp <= @until AND post_url IS NOT NULL
  )
  GROUP BY mention_id
  HAVING MIN(load_timestamp) > @since AND ARRAY_LENGTH(ARRAY_CONCAT_AGG(xtags)) > 0
)
WHERE body != '' AND (IFNULL(followers, 0) >= @min_followers OR IFNULL(eng, 0) >= @min_engagement)
  AND (posted IS NULL OR posted >= TIMESTAMP_SUB(@until, INTERVAL 72 HOUR))
  AND NOT {non_english_sql('body')}
  AND {not_grok_sql('post_url', 'author')}
ORDER BY IFNULL(followers, 0) + 10 * IFNULL(eng, 0) DESC
LIMIT @max_rows"""


def owned_sql(table: str) -> str:
    return f"""
SELECT Outbound_Post_ID AS source_id, url AS post_url, net AS platform, acct AS author, followers AS author_followers,
  eng AS engagement, CAST(NULL AS INT64) AS views, txt AS text, CAST(NULL AS STRING) AS title,
  CONCAT("Google's own post: ", CAST(IFNULL(neg, 0) AS STRING), ' negative comments of ', CAST(IFNULL(comments, 0) AS STRING),
    ' (', CAST(IFNULL(pct, 0) AS STRING), '%)') AS summary,
  'en' AS language, 'negative' AS sentiment, posted AS posted_at, loaded AS source_seen_at, CAST([] AS ARRAY<STRING>) AS products,
  ['{OWNED_TAG}'] AS source_tags, CAST([] AS ARRAY<STRING>) AS kof_lists, 'negative comments' AS reason,
  TO_JSON_STRING(STRUCT(comments AS comments, neg AS negative, pct AS negative_pct, handle AS handle, country AS country)) AS extra
FROM (
  SELECT Outbound_Post_ID, ANY_VALUE(Post_Permalink) AS url, ANY_VALUE({net_sql('Social_Network')}) AS net,
    ANY_VALUE(Account_Name) AS acct, ANY_VALUE(Account_Screen_Name) AS handle, ANY_VALUE(Country) AS country,
    ANY_VALUE(SUBSTR(Outbound_Post, 1, 2000)) AS txt, SAFE_CAST(MAX(Followers_At_Time_Of_Post) AS INT64) AS followers,
    SAFE_CAST(MAX(Engagements) AS INT64) AS eng, SAFE_CAST(MAX(Comments) AS INT64) AS comments,
    SAFE_CAST(MAX(Negative_Sentiment_Comment_Count) AS INT64) AS neg,
    SAFE_CAST(ROUND(100 * LEAST(MAX(Pct_Negative_Comments), 1)) AS INT64) AS pct,
    MIN(Post_Published_Date_UTC) AS posted, MAX(load_timestamp) AS loaded
  FROM `{table}`
  WHERE Report_Date >= DATE_SUB(DATE(@until), INTERVAL 3 DAY) AND Post_Permalink IS NOT NULL
    AND NOT IFNULL(Is_Deleted, FALSE) AND NOT IFNULL(Is_External, FALSE)
    AND {net_sql('Social_Network')} IN UNNEST(@networks)
  GROUP BY Outbound_Post_ID
)
WHERE loaded > @since AND loaded <= @until AND posted >= TIMESTAMP_SUB(@until, INTERVAL 72 HOUR)
  AND (IFNULL(neg, 0) >= @min_negative OR (IFNULL(comments, 0) >= @min_comments AND IFNULL(pct, 0) >= @min_pct))
  AND NOT {non_english_sql("IFNULL(txt, '')")}
ORDER BY neg DESC, IFNULL(eng, 0) DESC
LIMIT @max_rows"""


def comments_sql(table: str) -> str:
    return f"""
SELECT post_url AS source_id, post_url, net AS platform, acct AS author, top_f AS author_followers, neg AS engagement,
  CAST(NULL AS INT64) AS views, top_neg AS text, caption AS title,
  CONCAT("Comments on Google's post: ", CAST(neg AS STRING), ' negative of ', CAST(n AS STRING), ' in an hour') AS summary,
  'en' AS language, 'negative' AS sentiment, posted AS posted_at, last_at AS source_seen_at, CAST([] AS ARRAY<STRING>) AS products,
  ['{OWNED_TAG}'] AS source_tags, CAST([] AS ARRAY<STRING>) AS kof_lists,
  IF(neg >= @pileup AND neg - neg_win < @pileup, 'pile-on', 'big voice') AS reason,
  TO_JSON_STRING(STRUCT(n AS comments, neg AS negative, top_f AS top_negative_followers)) AS extra
FROM (
  SELECT post_url, ANY_VALUE(account_name) AS acct, ANY_VALUE(net) AS net, ANY_VALUE(SUBSTR(post_caption, 1, 500)) AS caption,
    MIN(post_published_date) AS posted, MAX(_CHANGE_TIMESTAMP) AS last_at, COUNT(DISTINCT comment_id) AS n,
    COUNT(DISTINCT IF(is_neg, comment_id, NULL)) AS neg,
    COUNT(DISTINCT IF(is_neg AND _CHANGE_TIMESTAMP > @since, comment_id, NULL)) AS neg_win,
    SAFE_CAST(MAX(IF(is_neg, author_followers, 0)) AS INT64) AS top_f,
    MAX(IF(is_neg AND _CHANGE_TIMESTAMP > @since, author_followers, 0)) AS top_f_win,
    ARRAY_TO_STRING(ARRAY_AGG(IF(is_neg, SUBSTR(comment_text, 1, 300), NULL) IGNORE NULLS ORDER BY author_followers DESC LIMIT 5), ' | ') AS top_neg
  FROM (
    SELECT *, LOWER(IFNULL(sentiment, '')) = 'negative' AS is_neg, {net_sql('platform')} AS net
    FROM APPENDS(TABLE `{table}`, TIMESTAMP_SUB(@until, INTERVAL 60 MINUTE), @until)
    WHERE post_url IS NOT NULL AND IFNULL(is_brand_post, '') != 'Brand' AND LOWER(IFNULL(is_deleted, '')) != 'true'
      AND LOWER(IFNULL(is_spam, '')) != 'true' AND LOWER(IFNULL(is_hidden, '')) != 'true'
      AND {net_sql('platform')} IN UNNEST(@networks)
      AND NOT {non_english_sql("IFNULL(comment_text, '')")}
  )
  GROUP BY post_url
)
WHERE (neg >= @pileup AND neg - neg_win < @pileup) OR top_f_win >= @big_voice
ORDER BY neg DESC, top_f DESC
LIMIT @max_rows"""


SQL = {"sonar": sonar_sql, "tubular": tubular_sql, "bwm": bwm_sql, "owned": owned_sql, "comments": comments_sql}


def params_for(key: str, cfg: dict, networks: list[str]) -> dict:
    """The source's own query parameters (besides since, until and max_rows)."""
    if key == "sonar":
        return {"networks": networks, "min_followers": int(cfg.get("min_followers", 1000)),
                "min_engagement": int(cfg.get("min_engagement", 100))}
    if key == "tubular":
        return {"networks": networks, "min_followers": int(cfg.get("min_followers", 1000)),
                "min_engagement": int(cfg.get("min_engagement", 100)), "min_views": int(cfg.get("min_views", 10000))}
    if key == "bwm":
        return {"configs": list(cfg.get("configs", [])), "bwm_networks": [str(n).lower() for n in cfg.get("networks", [])],
                "exposure_group": str(cfg.get("exposure_group", "")), "min_followers": int(cfg.get("min_followers", 1000)),
                "min_engagement": int(cfg.get("min_engagement", 100))}
    if key == "owned":
        return {"networks": networks, "min_negative": int(cfg.get("min_negative", 25)),
                "min_comments": int(cfg.get("min_comments", 20)),
                "min_pct": int(round(100 * float(cfg.get("min_negative_share", 0.3))))}
    if key == "comments":
        return {"networks": networks, "pileup": int(cfg.get("pileup_negative", 5)),
                "big_voice": int(cfg.get("big_voice_followers", 100000))}
    raise KeyError(key)
