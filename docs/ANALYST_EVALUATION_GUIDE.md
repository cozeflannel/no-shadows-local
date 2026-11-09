# How to Evaluate the Chatbot (Analyst Guide)

Use the **Analysis** tab in the `slrr-agentic-assistant` Google Sheet to compare the chatbot's work side-by-side against our team's actual Chat actions and Social Alert calls. Everything here is read-only for Burson—nothing you filter or type posts to any Chat space or sends any email.

---

### Step 1: Open the Sidepanel & Set Your View
1. Open the **`Analysis`** tab in the `slrr-agentic-assistant` Google Sheet. Row 1 is the column header, giving you the full screen to read alerts starting on Row 2.
2. In the top menu bar, click **`📊 Bot Analysis` → `Open Sidepanel`**. Use the three subtabs on the right:
   - **`Overview`:** Shows the last update time, what is compared, and how many **Resources** docs, **Guidance** rules, and past precedents are active.
   - **`Controls`:** Pick your **`Lookback window`** (`24 hours`, `3 days`, `7 days`, `14 days`), choose **`Focus`** (`All items`, `Disagreements only`, `With Chat replies / Q&A`, `QA mistakes caught`, `Social Alerts only`, or `Thread Q&A only`), or type a keyword in **`Search filter`**, then click **`Apply Filters`** (or **`Refresh Now`**). The table updates within 1 minute.
   - **`Scorecard`:** Shows the window's Social Alert alignment rate (`IM-only` vs. `Bot-only` disagreements), Burson mistakes caught, live Chat/Q&A counts, and verdicts recorded.

---

### Step 2: Review Each Row Left to Right (`Columns E–I`)
Each row is one alert or one Chat question:
- **Col E — `Chatbot's Response`:** Whether the chatbot called for a Social Alert, how fast it sent, which teams/T&S it routed to, what Burson mistakes it fixed, its Chat emojis, and any Chat Q&A answer it gave.
- **Col F — `Google Analyst's Response`:** What our team actually did on the same item—the IM's Social Alert call/subject, our Chat emojis (`📦`, `📰`, `💬`, `⚖️`, `✍️`), and our Chat thread replies.
- **Col G — `Alignment`:** Shows at a glance whether the chatbot and our team matched (`✓ Aligned`) or differed (`⚠️ Disagreement`).
- **Col H — `Bot's Logic`:** Why the chatbot made its call—the priority rule or threshold triggered, why it rewrote a field, why it picked specific teams/T&S, and any active **Guidance** rule or precedent it followed.
- **Col I — `Knowledge Base Snippet`:** The exact document name and passage from our **Resources** reference docs that the chatbot relied on.

---

### Step 3: Grade the Row (`Columns J & K`)
1. In **Column J (`Analyst Verdict`)**, pick one option from the dropdown:
   - **`Bot right`** — The chatbot made the right call and followed our rules.
   - **`Analyst right`** — Our analyst/IM made the right call; the chatbot missed or over-escalated.
   - **`Both acceptable`** — Judgment call where either action is reasonable.
   - **`Update Guidance`** — Needs a current lead instruction or temporary rule.
   - **`Update Resources`** — One of our reference docs is unclear, outdated, or missing this rule.
   - **`Needs bug fix`** — Something behaved unexpectedly and needs technical review.
2. In **Column K (`Analyst Notes`)**, write one short sentence explaining what should have happened if the chatbot was off. *(Your verdicts and notes stay saved even when you change filters in the Sidepanel.)*

---

### Step 4: Turn Findings into Fixes
- **Picked `Update Guidance`:** Add a one-line rule on the **`Guidance`** tab (with the product/topic in *Applies to* and an optional *Until* date). The chatbot applies it on its next run.
- **Picked `Update Resources`:** Update the reference Google Doc/Sheet listed on the **`Resources`** tab. The chatbot re-reads updated docs automatically within 15 minutes.
- **Picked `Needs bug fix`:** Leave your note in **Column K**—the owner reviews rows marked `Needs bug fix` directly from the sheet.
