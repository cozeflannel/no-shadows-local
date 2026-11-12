# Open-World Low-Tier Early Detection Pipeline (`brand-social-central-data.early_detection`)

> **Archived / orphaned in the bot (Nov 2026):** `apps-script-chat-bot` no longer reads `vw_chatbot_pending_early_alerts` or this BigQuery pipeline. Row 19 ("Early wave & velocity check") is now produced directly inside Apps Script by `EarlyWaveSource.gs`. The SQL files here are kept only for reference (and any live scheduled query `sp_run_early_detection_pipeline` in BigQuery must be disabled in the BigQuery UI if no longer wanted).

Replaces the legacy high-engagement Sonar early-wave / CacheService rising-post heuristic with two **topic-agnostic, open-world** BigQuery capabilities that cast a wide net across landed mention-level data and surface unknown build-ups before anyone knows what the issue is.

## Capabilities

1. **Wide-net low-tier ingestion** (`01_setup_and_config.sql`, `02_low_tier_ingestion.sql` → `sp_ingest_low_tier_mentions`)
   - `source_feed_registry` maps each landed table to a common shape:
     - `BMIE_GOOGLE_FEEDS`: Google-scoped Brandwatch feeds in `social_alerts_dataset.all_sundar_mentions` (Chrome, Android, Search, Gemini, Google spikes, execs, policy, ...), **no keyword gate**, so build-ups with no brand keyword still get through.
     - `BMIE_BROAD_FEEDS`: the broad feeds in the same table (AI digests, APAC/market listening, KOF chatter, developer AI), **only when the post itself names Google or a Google product**. Sports, culture, brand-fit and competitor-only feeds (the list `BigQuery.gs` `BQ_NON_GOOGLE_SOURCES_RX_` uses) are never read.
     - `SPRINKLR_OWNED_COMMENTS`: comments on Google's own posts (`reporting_data.sprinklr_inbound_comments`). The comment text alone is embedded, so comments cluster by what they claim.
     - `BRANDWATCH_EXPORTS` (`brandwatch_automated_exports.raw_brandwatch_exports`), `REDDIT_PULSE` (`reddit_pulse.reddit_items_raw`), and `SONAR_US_STAGE` (disabled until the cross-region copy below exists).
   - Low-tier subset: at most 5,000 followers, under 500 engagements, not a KOF, not positive. The quality gates drop short or low-information posts, astrology/fashion homonyms, and copy-paste spam rings. Reposts by the same author within 24h are dropped, and so are posts already in the SLRR alert log.
   - Each run re-reads every source back to `last cutoff − ingest_overlap_minutes` (6h), so rows that reach their source table late are still picked up. `MERGE` on `mention_id` keeps them unique.
   - Time columns: `posted_at` (when the post was published; drives the evaluation windows), `ingested_at` (when this pipeline landed the row; drives incremental processing and partitioning), `source_ingested_at` (the source's own timestamp; used for freshness).
2. **Capability 1: embedding clustering** (`03_capability_1_embedding_clustering.sql` → `sp_embed_and_cluster_low_tier`)
   - 768-d `text-embedding-005` vectors from `early_detection.text_embedding_model` (`AI.GENERATE_EMBEDDING`, `CLUSTERING` task type). The model runs through the existing `us.gem-connection`, the same endpoint as `DSD.text_embedding_model`.
   - Vectors are cached in `embedding_cache` by `content_hash`. Mentions closer than 0.20 to a `DSD.evergreen_vectors` topic are suppressed as evergreen noise.
   - Two-stage incremental `VECTOR_SEARCH`: new mentions join an existing centroid (`EXISTING_CENTROID`), and the rest seed new clusters (`NEW_ANCHOR_GRAPH`). Tuning telemetry goes to `cluster_run_metrics`.
   - A cluster becomes an alert when, within 180 minutes, it has ≥ 5 distinct low-tier authors (4 when ≥ 2 platforms corroborate) and spans ≥ 2 distinct posts/links (`min_cluster_distinct_urls`), so a pile-up of comments on one post never alerts. Each cluster has a 6h cooldown, which it skips if its author count doubles.
   - Copy-paste rings are not promoted: see [Cost & spike guardrails](#cost--spike-guardrails). At most `max_alerts_per_run` cluster alerts are queued per run, each with up to 8 representative posts.
   - One story, one alert: a cluster that tells a story already alerted in the last 24h is held back unless it materially grew. See [Same-story dedup](#same-story-dedup).
3. **Capability 2: multi-grain velocity** (`04_capability_2_low_tier_velocity.sql` → `sp_detect_low_tier_velocity`)
   - Hourly rollups (`low_tier_hourly_rollup`) for three grains: `CLUSTER` (dynamically discovered clusters), `RISK_TERM_GROUP` (`risk_term_taxonomy`), and `PRIORITY_TOPIC`.
   - The baseline is the smoothed larger of two values: the same-hour-of-day mean over the last 7 days (averaged over the days of history that actually exist) and 0.5 × the trailing 6h mean, plus a Laplace floor.
   - **Cold start:** no velocity alert is written until the rollup has `velocity_warmup_hours` (24h) of history. Cluster alerts (Capability 1) start immediately.
   - At most `max_alerts_per_run` velocity alerts are queued per run (P0 first, then the highest velocity ratio), each with up to 8 representative posts.

All thresholds and cost ceilings live in `early_detection_config` (profile `prod`). Change them there instead of in code.

## Deployment Order

Execute scripts `01` through `05` in order in `US` location on `brand-social-central-data` (all idempotent; `01` re-seeds the pipeline-owned registry and taxonomy tables):

```bash
for f in analytics/early_detection/0*.sql; do
  bq query --project_id=brand-social-central-data --location=US --use_legacy_sql=false \
    --label datacloud:antigravity --label app:slrr-triage-agent < "$f"
done
```

## Scheduling (Every 15 Minutes)

Schedule the single orchestration procedure as a BigQuery scheduled query (`US`, no destination table):

```sql
CALL `brand-social-central-data.early_detection.sp_run_early_detection_pipeline`('prod');
```

A run reads about 0.1–0.8 GB and takes about 2 minutes. `vw_early_detection_monitoring` shows source lag, cache hit rate, singleton ratio, cluster size percentiles, and alerts in the last 24h.

## Cost & spike guardrails

Every run is bounded by hard ceilings in `early_detection_config` (profile `prod`), so the pipeline can't spike BigQuery or Vertex AI spend, however much data arrives or however long it was paused. The guardrail columns are nullable. Every procedure reads them as `COALESCE(column, default)`, so a `NULL` never breaks a run. Re-running `01` only fills values that are still `NULL`, so a value you tuned (or an engaged kill switch) is never overwritten.

| Column | Default | What it bounds |
| --- | --- | --- |
| `pipeline_enabled` | `TRUE` | Kill switch. `FALSE`: every scheduled run logs `SKIPPED` after one tiny config read and exits. |
| `max_backfill_hours` | `12` | Ingestion (and the embed step) never read further back than this, even when the watermark is days old after a pause or outage. |
| `max_ingest_rows_per_run` | `20,000` | New `low_tier_mentions` rows landed per run, newest first. Rows over the cap are picked up by the next run's 6h overlap re-read. |
| `max_new_embeddings_per_run` | `3,000` | `AI.GENERATE_EMBEDDING` rows (Vertex calls) per run. |
| `max_new_embeddings_per_day` | `30,000` | Vertex embedding rows per UTC day, counted from `embedding_cache.created_at`. Each run embeds at most `LEAST(per-run cap, per-day cap − embedded today)` hashes, the ones shared by the most authors first. A zero budget makes no Vertex call. Hashes over budget are skipped (not clustered) and counted in `cluster_run_metrics.embeddings_skipped_budget`. |
| `embedding_cache_reuse_days` | `2` | Every `embedding_cache` read scans only the last N days of partitions instead of the whole 90-day cache (3–4 reads per run). A text last embedded before that is embedded again (about $0.000005 a text). Clustering looks back 26h at most, so 2 days is enough; at 7 days the scans would grow to ~1.5–2 GB a run within a week, close to the daily bytes breaker. |
| `max_cluster_pool` | `15,000` | Stage B brute-force `VECTOR_SEARCH` pool (pool × pool comparisons), newest mentions first. |
| `max_alerts_per_run` | `8` | Cluster alerts per run and velocity alerts per run, each (P0 → P1 → P2, then the most authors / the highest velocity). Alerts over the cap get no cooldown stamp, so they can alert on the next run. |
| `max_bytes_billed_per_run` | `5 GiB` | Per-run circuit breaker. `@@script.bytes_billed` is checked after ingestion and after clustering. Over the cap, the remaining stages are skipped and the run is logged `STOPPED_BYTES_CAP`. |
| `max_bytes_billed_per_day` | `200 GiB` | Daily circuit breaker (UTC day, summed from `pipeline_run_log`). Once reached, every run is logged `SKIPPED` until midnight UTC. |
| `cluster_retention_days` | `3` | `active_clusters` rows whose `last_seen_at` is older are deleted every run (never inside the 24h active horizon). `velocity_alert_cooldowns` rows older than 14 days are deleted too. |
| `run_lock_minutes` | `30` | A run is logged `SKIPPED` while another run of the same profile that started within this many minutes is still `RUNNING`. |

**Worst case per day, with every cap hit:**

- BigQuery: ≤ 200 GiB billed (plus at most the one run that crosses the line), about $1.22/day at on-demand $6.25/TiB.
- Vertex AI: ≤ 30,000 embeddings × ≤ 1,500 characters = 45M characters, about $1.13/day at $0.000025 per 1,000 characters (`text-embedding-005`, online).
- Chatbot queue: ≤ 2 × 8 × 96 = 1,536 alerts/day.

**Copy-paste ring gate.** A cluster is not promoted when it is mostly identical copies from many small accounts that never name Google or a Google product: distinct texts (`content_hash`) × 3 ≤ unique authors, and no post matches the same entity regex `02` uses. For example, 6 throwaway X accounts posting the identical "Hi ,who are tHi , why tHi are so famou ?? 👀" are dropped. These clusters are counted in `cluster_run_metrics.copy_ring_suppressed`. A ring that does name Google is still promoted, and Gemini judges it during triage.

## Same-story dedup

The same story often surfaces as several clusters (two phrasings of one lawsuit, one complaint in Portuguese and English), or as the same cluster again a few hours later. Each would otherwise be its own alert. The pipeline lets one alert through per story per day, plus an update when the story materially grows.

- **Cluster alerts (`03`).** A candidate whose centroid is within `story_dedup_max_cosine_distance` (cosine) of a cluster that alerted in the last `story_dedup_hours` is the same story. "Alerted" means any signal type, using that cluster's latest alert in `early_detection_alert_queue`. A repeat is queued only as an update of that alert, when one of these holds:
  - its authors reached `story_update_min_growth` × that alert's, and at least `story_update_min_new_authors` more;
  - it reached a platform that alert didn't have.

  The update carries `update_of_alert_id` and `update_of_authors`. Otherwise the candidate is held back and counted in `cluster_run_metrics.story_dup_suppressed`. A held-back cluster gets no cooldown stamp, so it can still go out as an update once it grows. When two candidates of one story arrive in the same run, the one with more authors is kept. The same cluster alerting again is distance 0, so it follows the same rule, on top of its 6h cooldown.
- **Velocity alerts (`04`).** A `CLUSTER`-grain spike is held back when that story already alerted in the last `story_dedup_hours`, meaning the same cluster or a centroid within the same distance. It goes out only when its authors reached `story_update_min_growth` × the most that story's alerts reported, and at least `story_update_min_new_authors` more. This replaces the old 30-minute same-cluster check. `RISK_TERM_GROUP` and `PRIORITY_TOPIC` keep their 180-minute cooldown.
- **The chatbot** applies the same rule again against the cards it actually posted (see the bot README, row 19), and posts an update in the earlier card's thread.

| Column | Default | What it does |
| --- | --- | --- |
| `story_dedup_max_cosine_distance` | `0.14` | Centroids this close are the same story. Calibrated on live alerts: same-story pairs measured 0.00–0.11, different stories ≥ 0.18. |
| `story_dedup_hours` | `24` | How long an alerted story holds back its repeats. |
| `story_update_min_growth` | `2.0` | A repeat becomes an update only at this multiple of the last alert's authors ... |
| `story_update_min_new_authors` | `3` | ... and at least this many more authors (or a new platform). |

`vw_early_detection_cost_guard` shows `story_repeats_held_back_today` and `story_updates_today`.

### Kill switch

```sql
UPDATE `brand-social-central-data.early_detection.early_detection_config`
SET pipeline_enabled = FALSE, updated_at = CURRENT_TIMESTAMP()
WHERE config_profile = 'prod';
```

Set it back to `TRUE` to resume. The next run catches up from its watermarks, at most `max_backfill_hours` back. To stop runs entirely (not even the config read), disable the scheduled query "[SLRR] Early detection pipeline (every 15 min)" instead: BigQuery console → Scheduled queries → the query → Disable.

### Usage vs ceilings

```sql
SELECT * FROM `brand-social-central-data.early_detection.vw_early_detection_cost_guard`;
```

It returns one row with:

- the kill switch
- bytes billed today vs `max_bytes_billed_per_day` (`pct_daily_bytes_cap_used`, `est_bq_usd_today`)
- runs today and in the last 24h by status, plus the last run (status, start, bytes, note)
- embeddings and characters embedded today vs `max_new_embeddings_per_day` (`pct_daily_embedding_cap_used`, `est_vertex_usd_today`)
- alerts queued today, story updates queued today, and repeats held back today (same-story dedup)
- every cap

"Today" is the UTC day, the same window the daily breaker uses. The view bills about 40 MB per query, so check it ad hoc rather than polling it.

Per-run detail is in the run log:

```sql
SELECT started_at, status, skip_reason, bytes_billed, slot_ms, child_jobs,
       new_mentions, new_embeddings, cluster_alerts, velocity_alerts, error_message
FROM `brand-social-central-data.early_detection.pipeline_run_log`
WHERE started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
ORDER BY started_at DESC;
```

`status` is one of:

- `RUNNING`
- `OK`
- `SKIPPED` (kill switch, lock, or daily cap; see `skip_reason`)
- `STOPPED_BYTES_CAP`
- `FAILED` (see `error_message`; the scheduled run still shows as failed)

A `RUNNING` row older than `run_lock_minutes` means the job died without reaching its exception handler (cancelled or timed out). It stops blocking once the lock window passes, and the view counts it as `runs_stuck_running`.

### Query label

Every child job of the orchestrator carries the labels `app:slrr-early-detection` and `component:pipeline` (`SET @@query_label`), so the pipeline's spend can be isolated in `INFORMATION_SCHEMA.JOBS`:

```sql
SELECT DATE(creation_time) AS day, COUNT(*) AS jobs,
       ROUND(SUM(total_bytes_billed) / POW(1024, 3), 2) AS gib_billed, SUM(total_slot_ms) AS slot_ms
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND EXISTS (SELECT 1 FROM UNNEST(labels) l WHERE l.key = 'app' AND l.value = 'slrr-early-detection')
GROUP BY day
ORDER BY day DESC;
```

(Use `JOBS_BY_USER` if you lack `bigquery.jobs.listAll`; the scheduled query runs as its owner.)

## Cross-Region Sonar Sync (`us-central1` → `US`)

`bsip-s-bsip-gg-26-2cf3.google_bg.sonar_post_aggregates_7d_materialized` is in `us-central1`, but the `brand-social-central-data` datasets are in `US`. To use it:

1. Configure a BigQuery Data Transfer cross-region table copy (or a 15-minute GCS export/load) into `brand-social-central-data.early_detection.stg_sonar_mentions_us`.
2. Set `SONAR_US_STAGE.enabled = TRUE` in `early_detection.source_feed_registry`.

## Standalone Apps Script Chatbot Integration (Zero Watcher Reuse)

- Controlled by `Control` tab **Row 19** (`Early wave & velocity check`), which defaults to `'OFF'`.
- Explicitly **does not** reuse the targeted campaign Watcher modules (`ProactiveWatch.gs` / `WatchAlerts.gs` / `OtherAlerts.gs`).
- When Row 19 is `'ON'`, `earlyWaveCheck_` in `apps-script-chat-bot/BigQuery.gs` reads `vw_chatbot_pending_early_alerts` at most every 15 minutes.
  - It reads every alert created since 20 minutes before its previous check (never less than the `B31` lookback, never more than the view's 3h window).
  - It queues new signals for review (up to 5 per check, 40 per day). Nothing is posted at that point.
  - Same-story dedup is applied first. A signal is held back without a Gemini review when its story already has a card from the last 24h with nothing materially new. A story matches on the same cluster, the alert BigQuery says it updates (`update_of_alert_id`), or 2+ of the same posts.
- `apps-script-chat-bot/EarlyDetection.gs` (`edDrainQueue_`) reviews each queued signal once with Gemini. It then posts ONE story card (`client-zeda-…`) in the Google-only triage space (`Mirror space B9` or `Test feed B3`), never in `S-F Burson B25` or the `Burson test copy B26`.
  - A signal whose story grew goes in the earlier card's thread as `📈 *Early Detection Update: …*`, with what's new.
  - A review that finds an issue already alerted, with nothing new, posts no card.
  - The review note, `❌` / `👍` marks, and drafts (Social Alert, Temp Check query, T&S intake) all stay behind human review.
