# Video prefilter — report

## What changed
`src/db.js` — `getVideoCandidates(windowDays, shownIds, userId)`:
- Added `MIN_VIDEO_SECONDS = 300` constant next to the query (used only inside the SQL there; BotService never needs it).
- Duration filter: `p.duration_sec IS NULL OR p.duration_sec >= 300` — applied in the WHERE clause, before the per-channel ranking, so a channel's ineligible short videos never block its eligible ones from winning a slot.
- Per-channel cap, revised mid-task per updated instructions: keep at most **two** videos per channel — the most-viewed and the longest — deduplicated by id when they're the same video. Implemented with two window functions in a subquery:
  - `rn_views = ROW_NUMBER() OVER (PARTITION BY channel ORDER BY views DESC, date DESC, id)`
  - `rn_duration = ROW_NUMBER() OVER (PARTITION BY channel ORDER BY duration_sec DESC, date DESC, id)`
  - Outer query keeps rows where `rn_views = 1 OR rn_duration = 1`.
- Deterministic tiebreaks: `date DESC, id` appended to both orderings.
- NULL duration ordering: SQLite sorts NULL last in `ORDER BY duration_sec DESC` (NULLs are "smallest", so ASC-first/DESC-last), so a NULL-duration video only wins the "longest" slot when it's the only eligible video on its channel — documented as a comment above the function since it isn't obvious from reading the SQL alone.
- 7-day window, `shownIds` filter (applied after the SQL, unchanged), hidden-channel exclusion, and the function signature/return shape are all untouched.

`src/services/BotService.js` — no changes needed. `selectVideosForDigest` calls `getVideoCandidates(VIDEO_WINDOW_DAYS, shown, userId)` exactly as before; the new constant lives entirely in db.js since it's only consumed by the SQL there.

## Where the constant went, and why
`MIN_VIDEO_SECONDS` in `src/db.js`, directly above `getVideoCandidates`. It's baked into the prepared statement as a bind parameter, never read anywhere else — putting it in BotService would mean threading it through a call for no reason.

## Tests added (test/digest-video.test.js)
- three eligible videos on one channel yield exactly two: most-viewed + longest, the third (neither) dropped
- most-viewed == longest on a channel yields one row, not a duplicate
- a channel whose videos are all under 300s contributes nothing, even its most-viewed
- per-channel cap doesn't touch other channels (both channels' single videos kept)
- <300s dropped, 400s kept (duration filter)
- NULL duration kept when it's the only video on a channel; when up against a longer known-duration video, the NULL one survives via views only (not duration) — asserted explicitly, not left implicit
- tie-break stability: identical views AND identical duration on two videos on a channel — repeated calls return the same single id

Existing tests that put multiple same-channel videos in a 7-day window (to test window/shown-set/cap behavior unrelated to per-channel selection) were adjusted to use distinct channels per video, since the new per-channel rule now also applies inside those tests' windows. Touched: "the same video is not offered twice" (fresh2 moved to `yt:@c2`), "more candidates than the daily cap..." (each of the 12 videos given its own channel), "fewer candidates than the daily cap..." (two1/two2 split across `yt:@twochan1`/`yt:@twochan2`).

## Test commands and output
```
npm test
```
Final: `tests 101, pass 101, fail 0`.

## Uncertain / worth flagging
- Two unrelated tests (`test/ai-http.test.js` hanging-endpoint timeout, `test/youtube-client.test.js` 120-ids-as-three-requests) failed transiently on the first full run under load, then passed clean on rerun — pre-existing timing flakiness, not touched by this change.
- Live-data expectation from the task (~235 of 576 candidates) was not independently re-verified against a live DB snapshot; only unit-tested against synthetic rows.
