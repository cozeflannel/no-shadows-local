---
name: slrr-relay-ops
description: >-
  Operates, inspects, and troubleshoots the 2-way Chat bridge between S-F Burson (B25),
  the Google-only Mirror space (B9), the Burson test copy (B26), the Relay/Relay names tabs,
  and the Burson outbox tab (Rows 22 & 24). Use whenever inspecting relayed messages,
  unmapped Relay names, blocked outbox rows, or tuning the single-space analyst workflow.
---

# SLRR 2-Way S-F Burson <-> Mirror Space Relay & Outbox Runbook

Use this skill whenever managing or diagnosing how live `[S-F] Burson Automated Alerts V3` messages appear in the Google-only test/Mirror space and how Google analysts' replies and reactions flow back out.

## 1. Fast Live Inspection via `slrr-live-ops` MCP
1. Call `slrr_get_control_status` to check:
   - `B9` (`Mirror space`): Google-only workspace where analysts and the bot sit (`outbounds blocked` for direct bot writes).
   - `B25` (`S-F Burson space`): Live external-allowed `[S-F] Burson Automated Alerts V3` space.
   - `B26` (`Burson test copy`): Optional Google-only test router space. While `B26` is populated or `Safety valve` (`Row 29`) is `ON`, the bot is in **Testing** mode (analysts' relayed messages go to `B26`, never `B25`).
   - `Row 22` (`Relay with S-F Burson`) & `Row 24` (`Post in S-F Burson`).
2. Call `slrr_inspect_relay_and_outbox` to inspect:
   - **`Relay names` (`unmapped_people`):** Chat user IDs (`users/...`) missing a human `name` or `org` (`Google` vs `Burson`). Fill these in once so relayed messages show clean attribution.
   - **`Burson outbox` (`pending_or_send_rows`):** Pending, Blocked, or Failed outbound rows when operating in LIVE mode.
   - **`Relay` (`direction_status_counts`):** Inbound (`From S-F Burson`) vs outbound (`To S-F Burson` / `To the Burson test copy`) counts and any stuck/retried messages.

## 2. Guardrails & Leak Prevention (`Outbox.gs` & `Relay.gs`)
- Messages starting with `internal:` or `[internal]` stay strictly inside the `Mirror space` (`B9`), along with all replies in that internal thread.
- Candidate outbound messages are checked by `outboxGuardHits_()` (blocking mentions of `mirror`, `relay`, `slrr`, `the bot`, `auto-correct`, `outbox tab`, `zapier`, `stand-in`, or internal space names/IDs), and by the first words of the bot's notes under cards (`OUTBOX_NOTE_PATTERNS_`: `flagged by the watch`, `Part of a story`, `Alert requirements`, `Same story: N more posts`), so an analyst's relayed message holding one of them is held with `not sent: it mentions …` (the README's row 22 lists the exact shapes).
- Use `slrr_test_leak_guard` from `slrr-dev-pipeline` to dry-run any text or emoji against the same guard functions (`outboxGuardHits_()`, `outboxEmojiProblem_()`), loaded from the local `.gs` files. The tool doesn't know the real names and ids of the internal spaces, which production also blocks (`outboxGuard_()` reads them from the Control tab and the script properties): pass them in `internal_space_terms`. Without them, a pass covers the fixed patterns only.
