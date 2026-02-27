# Product Hypotheses — Pulso Digest Bot

Ratings: **Complexity** and **Potential** on a 1–5 scale (1 = low, 5 = high). **Quick Win** = can be implemented in 1–2 sprints with measurable impact.

---

## Hypotheses Table

| # | Hypothesis | Complexity | Potential | Quick Win | Impact |
|---|------------|------------|-----------|-----------|--------|
| 1 | Morning digest push with teaser (after post collection) | 3 | 5 | No | Product return, habit formation "morning digest" |
| 2 | Reminder "You haven't opened digest in N days" | 2 | 3 | Yes | Return "dormant" users, reduce churn |
| 3 | Digest export (PDF / links to Readwise/Notion) | 4 | 4 | No | Value for power users, workflow integration |
| 4 | Channel recommendations based on profile interests | 4 | 5 | No | Growth in channels and content relevance |
| 5 | "Later" button / postpone post in digest | 2 | 3 | Yes | User control, less overload feeling |
| 6 | Hide channel in digest without removing from list | 2 | 4 | Yes | Fine-tuning: temporarily hide channel |
| 7 | Multiple profiles (work / hobby / other) | 3 | 4 | No | Different content per context, one bot — multiple "modes" |
| 8 | Filter by content type (news / longreads / polls) | 3 | 3 | No | More precise relevance per task |
| 9 | Configurable digest delivery time (07:00, 08:00…) | 2 | 3 | Yes | Convenience: digest at convenient time |
| 10 | Weekly digest (top posts of the week) | 3 | 4 | No | Different use case: week overview, less daily noise |
| 11 | Trends/topics of the day (frequent topics in posts) | 4 | 4 | No | Discovery, understanding "what people talk about" |
| 12 | Post rating (like/dislike) for ranking improvement | 3 | 5 | No | Personalization based on feedback |
| 13 | Search through digests and posts for a period | 3 | 4 | No | Search through already read content, long-term value |
| 14 | Personal stats (posts read, top channels) | 2 | 3 | Yes | Engagement, gamification, awareness |
| 15 | Minus-words: exclude posts with keywords | 2 | 4 | Yes | Noise reduction (ads, uninteresting topics) |
| 16 | Channel priority (important / normal) in ranking | 2 | 4 | Yes | Channel weight in ranking: important channels higher |
| 17 | Save to Telegram Saved / bookmarks in one tap | 3 | 3 | No | Save to Telegram ecosystem without copying |
| 18 | A/B digest format (short teaser vs expanded) | 2 | 3 | Yes | Optimize conversion to "opened and read" |
| 19 | "Channel introduction" mode (1 post from each new) | 2 | 3 | Yes | Onboarding after adding channels |
| 20 | Group digest (shared channel for team/family) | 5 | 5 | No | B2B and family scenario, virality |

---

## Top Hypotheses (Implementation Priority)

### Top-3 "Quick Wins" (low complexity + measurable impact)

1. **Minus-words** (#15) — complexity 2, potential 4. Quickly reduces noise and increases satisfaction without changing ranking.
2. **Channel priority** (#16) — complexity 2, potential 4. Minimal changes in prompt/ranking logic, strong effect on relevance.
3. **Hide channel in digest** (#6) — complexity 2, potential 4. Simple flag in DB and filter on output; gives control without losing subscription.

### Top-3 by Potential (Strategic)

1. **Morning digest push with teaser** (#1) — forms habit and product return; critical for retention.
2. **Post rating (like/dislike)** (#12) — basis for long-term personalization and model improvement.
3. **Channel recommendations by profile** (#4) — content growth and digest quality; strengthens profile value.

### Recommended Order for Next Quarters

- **Now:** #15 (minus-words), #16 (channel priority), #6 (hide channel) — quick wins with high impact.
- **Next:** #9 (delivery time), #2 (reminder), #14 (personal stats) — strengthen retention and habits.
- **Later:** #1 (morning push), #12 (like/dislike), #10 (weekly digest) — strategic retention and personalization steps.

---

## 15 Additional Hypotheses (Product Manager View)

Ratings: **Complexity** and **Potential** on 1–5 scale. **Quick Win** = implement in 1–2 sprints with measurable impact. **Need** = how much hypothesis closes real user pain/desire (1–5).

| # | Hypothesis | Complexity | Potential | Quick Win | Need |
|---|------------|------------|-----------|-----------|------|
| 21 | "No weekends" — disable morning digest on Sat/Sun by setting | 1 | 3 | Yes | 4 — info vacation on weekends |
| 22 | "Headlines only" mode — compact digest: title + link, no summary/action | 2 | 3 | Yes | 4 — quick 30-sec scan |
| 23 | Push about "hot" post — if post with abnormally high engagement appears in 2–4h, notify | 3 | 4 | No | 3 — don't miss important |
| 24 | Post repeat in digest — if post wasn't opened in N days, show again with "reminding" note | 3 | 3 | No | 3 — return valuable content |
| 25 | Channel blacklist — "never show posts from this channel" (full exclusion) | 2 | 4 | Yes | 4 — remove noisy channels without deleting from list |
| 26 | Thematic digests by button — "tech only", "career only" by profile topics | 3 | 4 | No | 4 — content per mood |
| 27 | Max 1 post per channel in top-N — source diversity in digest | 2 | 4 | Yes | 4 — less dominance of one channel |
| 28 | "Open all in browser" link — one read-only page with all digest posts | 4 | 3 | No | 3 — convenient from desktop |
| 29 | Whole digest rating — "useful / so-so / irrelevant" in one tap | 2 | 4 | Yes | 4 — quick feedback for model |
| 30 | "Didn't open digest" reminder — at 12:00 or 18:00: "Show today's digest?" | 2 | 4 | Yes | 4 — increase opens and habits |
| 31 | "Remind about post" — set date/time reminder for specific post | 3 | 3 | No | 3 — delayed reading |
| 32 | Incremental digest — "only new since last open" (posts after last /digest) | 3 | 4 | No | 4 — for frequent users |
| 33 | Widget "main points of the day in one paragraph" — super-short summary for sharing or catch-up | 3 | 3 | No | 3 — social, quick overview |
| 34 | Plus-words (keyword subscription) — show posts with these words even outside top | 3 | 5 | No | 5 — catch needed topics on request |
| 35 | "Silence" mode for N days — disable all pushes (morning, reminders) without unsubscribing | 2 | 3 | Yes | 4 — vacation/focus without losing settings |

---

## Best of 15 New Hypotheses (Selection)

### Top Quick Wins (low complexity + high need)

1. **"No weekends"** (#21) — complexity 1, need 4. One setting in DB + day check in cron. Strongly reduces irritation and unsubscribes.
2. **Whole digest rating** (#29) — complexity 2, potential and need 4. Inline buttons after digest, save to DB. Gives signal for ranking improvement without per-post likes.
3. **"Didn't open digest" reminder** (#30) — complexity 2, potential and need 4. Cron at 12:00/18:00 + "opened today" flag. Direct open metrics growth.
4. **Max 1 post per channel in top** (#27) — complexity 2, potential and need 4. Output logic change after ranking. Improves diversity without model change.
5. **Channel blacklist** (#25) — complexity 2, need 4. Separate "blocked" flag in channel settings, filter on output. Complements "hide in digest".

### Top by Strategic Potential

1. **Plus-words** (#34) — complexity 3, potential and need 5. Complement to minus-words: "show posts where X, Y, Z appear". Strongly increases "bot knows what I need" feeling.
2. **Thematic digests** (#26) — complexity 3, potential and need 4. Different output "modes" by profile topics. Increases usage frequency and value.
3. **Incremental digest** (#32) — complexity 3, potential and need 4. For power users: "what's new since last time". Active user retention.

### Final Implementation Priority (New Hypotheses)

- **First:** #21 (weekends), #29 (digest rating), #30 (reminder didn't open), #27 (1 post per channel).
- **Second:** #25 (blacklist), #22 (headlines only mode), #35 (silence mode).
- **Strategically:** #34 (plus-words), #26 (thematic digests), #32 (incremental digest).

---

## Digest Format Assessment (Product Manager View)

### Current Block Structure

- **Emoji + Summary** — what the material is about.
- **⚡ Action** — quick win, what to do in 5–15 minutes.
- **💡 Potential** — why watch, how it helps move forward.
- **Why in digest** — why post appeared in digest (profile/goals connection).
- **↗ Links** to channel.

### Problem: "Why" Duplication

"Why in digest" and **💡 Potential** blocks overlap in meaning: both explain relevance to reader. Result:

- Some blocks have "Why in digest", some don't (only for single-post blocks with reason in ranking) — inconsistent UX.
- "Why in digest: Problem of guilt over 'useless' rest is relevant for Senior developer..." essentially repeats what's already in **💡** (why watch).
- Extra volume and cognitive load: user scans digest quickly, duplicate explanation doesn't add decision value but takes attention.

**Conclusion:** From product perspective, "Why in digest" line is redundant in current format and should be removed or made optional (setting/"brief digest" mode).

---

## Digest Output Format Hypotheses

| # | Hypothesis | Complexity | Potential | Quick Win | Status |
|---|------------|------------|-----------|-----------|--------|
| 36 | **Remove "Why in digest"** from block — leave summary, action, potential, links only | 1 | 4 | Yes | ✅ Implemented |
| 37 | "Compact digest" mode: summary + link only (no action/potential) | 2 | 3 | Yes | ✅ Implemented: `digest_format` setting, `/digest_format` command |
| 38 | Show "Why in digest" only via "More" button / collapsible block | 2 | 2 | Yes | ✅ Implemented: "📌 Подробнее" button, callback `why:postId` |

### Status of Hypotheses #36–#38

- **#36:** "Why in digest" removed from main block text. Reason saved to DB (`rankings.reason`).
- **#37:** "Compact" mode — `digest_format` field in users table (full | compact). `/digest_format` command and buttons in profile. In compact mode, block: emoji + summary + link only.
- **#38:** Blocks with single post and filled reason have "📌 Подробнее" button; tapping sends message "Why in digest" with ranking text.
