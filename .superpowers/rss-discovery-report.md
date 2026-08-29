# YouTube RSS discovery — implementation report

Branch: `youtube-rss-discovery` (off `main`).

## Files changed

- `src/youtube/rss.js` (new) — `parseChannelFeed`, `fetchChannelFeed`, `fetchFeeds`.
- `src/youtube/collector.js` — `collectYouTubeVideos`, `backfillChannelActivity`, `syncSubscriptions` rewritten to discover via RSS.
- `src/youtube/client.js` — removed `listUploadPlaylists`, `listPlaylistVideos`, `listLatestPlaylistVideo`; `listVideoDetails` now attaches partial results (`e.partial`) to a thrown error so a mid-batch quota failure doesn't lose earlier batches.
- `test/youtube-rss.test.js` (new) — parser + fetcher tests.
- `test/youtube-client.test.js` — removed the three tests for the deleted playlist methods, added one test for the new `e.partial` behavior on `listVideoDetails`.
- `test/youtube-collector.test.js` — `fakeClient` no longer fakes playlist methods; a `fakeFetchFeeds` helper replaces them; all `external_id`/channel-id test fixtures switched from `UU…` (uploads playlist) to `UC…` (channel id); added a window-filtering test.
- `src/db.js` — untouched. `external_id` is stored and read as an opaque string throughout; nothing in `db.js` assumed it was a playlist id, so no change was needed for it to now hold a channel id.

## What was removed and why it's safe

- `listUploadPlaylists` (a `channels.list` call) — its only purpose was turning a channel id into an uploads-playlist id for `listPlaylistVideos`. RSS discovery needs the channel id directly (which `listSubscriptions` already returns), so the whole lookup — and its quota cost — disappears. `syncSubscriptions` now upserts `s.channelId` straight into `external_id`.
- `listPlaylistVideos` and `listLatestPlaylistVideo` — both did quota-costing `playlistItems.list` calls for per-channel discovery; replaced by `fetchFeeds`/`fetchChannelFeed` in `rss.js`, which cost nothing. Grepped the repo first — nothing outside `client.js`/`collector.js`/their tests referenced any of the three, so they and their tests were deleted rather than left dead.
- No `external_id` migration: confirmed the task's stated fact (prod has zero `source='yt'` rows) — nothing to backfill. New rows will hold channel ids going forward. Did not write migration code.

## Design choices worth flagging

- **QuotaExceededError now surfaces only from `listVideoDetails`** (RSS has no quota). To preserve "keep videos already paid for," `listVideoDetails` attaches whatever it had accumulated (`out`) to the thrown error as `.partial` before rethrowing; the collector reads `e.partial || []` and still stores those. This replaces the old channel-loop-level quota break, since channel-level fetching (RSS) can no longer hit quota.
- **`fetchFeeds` seam**: both `collectYouTubeVideos` and `backfillChannelActivity` take an injectable `fetchFeeds` param (defaulting to the real one from `rss.js`), the same way `client` is injected — this is what the tests fake against instead of client methods.
- **Per-channel error isolation**: `fetchFeeds` returns `{ byChannel, errors }` for the whole batch; the collector maps `errors` back to per-channel messages by channel id and calls `updateChannelActivity(username, {})` for failed channels exactly as before, so a single channel's feed failure is invisible to the others' processing.
- **`syncSubscriptions` upsert condition** changed from "upsert only if `external_id` missing" to "upsert if missing or changed" (`known.get(username).external_id !== s.channelId`) — since getting the channel id is now free (no extra API call), this is a strictly safer check with no added cost, guarding against any id drift instead of only filling gaps.
- **RSS parser** is regex-based (no XML library, per constraint), wrapped in try/catch to return `[]` on anything malformed rather than throw. Entity decoding covers `&amp; &lt; &gt; &quot; &#39;` (the five HTML predefined entities that show up in real YouTube titles/descriptions).
- **`fetchFeeds` concurrency**: a fixed-size worker-pool (`Math.min(concurrency, channelIds.length)` workers pulling from a shared index), not `Promise.all` over all channel ids — verified in the test by measuring the actual max-in-flight count, not just total calls.

## Test commands and output

```
npm test
```

```
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Before: 82 passing. Removed 3 (dead playlist-method tests), added 8 (5 in `youtube-rss.test.js`, 1 quota/`.partial` test in `youtube-client.test.js`, 2 collector tests — window-filtering, plus the pre-existing count adjustments from rewriting fakes). 82 − 3 + 8 = 87, matches.

## Deviations from the spec

- None functionally. The only interpretive call was where `QuotaExceededError` handling now lives (`listVideoDetails` instead of the channel loop) — necessary because RSS has no quota to exceed, and it's the closest equivalent that still "keeps already-fetched videos" on a batched quota failure.

## Uncertain / worth a second look

- `backfillChannelActivity` is not currently called from anywhere in the codebase (checked cron-job.js and grepped for a caller) — it's a manual/ad-hoc tool per its docstring, unchanged in that respect. Confirmed it still compiles and its tests pass with the new `fetchFeeds` seam.
- Real YouTube RSS feeds are Atom XML with a `<media:group>` wrapper around `media:title`/`media:description`/`media:community/media:statistics`; the parser doesn't require that structure explicitly (it just scans the whole `<entry>` block with regex), so it will keep working even if a future feed nests things slightly differently — but this also means it can't distinguish a same-named tag appearing outside the intended element. Low risk given the format's stability, but noting it since I didn't cross-check against a live feed fetch (no network in this environment).

## Fix round 1 (review follow-up)

### Known tradeoff: the 15-entry feed cap

`fetchChannelFeed`/`fetchFeeds` cannot see past the 15 most recent entries YouTube's RSS
feed exposes. A channel publishing more than 15 videos inside the 7-day window will lose
its earliest ones with no API error — this is an accepted tradeoff of moving off
`playlistItems.list`, not a bug, and it is not being fixed by reintroducing the API path.
What changed: it is no longer invisible. In `collectYouTubeVideos`
(`src/youtube/collector.js`), when a channel's feed returns exactly `FEED_ENTRY_CAP` (15)
entries and every one of them falls inside the window, that channel may have been
truncated, so a message is pushed into `errors` naming the channel — surfacing in the cron
log and admin alert the same way any other collection problem does. When the oldest of
the 15 falls outside the window, the feed is provably complete (there was a boundary
within the 15) and no warning fires. Tests: "a feed returning 15 entries all inside the
window is flagged as possibly truncated" / "...where the oldest falls outside the window
is NOT flagged" in `test/youtube-collector.test.js`.

### Garbled 200 responses no longer look like an empty feed

`fetchChannelFeed` (`src/youtube/rss.js`) now checks the response body for a `<feed`
root element plus the Atom namespace (`www.w3.org/2005/Atom`) before treating it as
a real feed. A CDN interstitial, CAPTCHA page, or truncated body still returns HTTP 200
but fails that check and throws, which `fetchFeeds` catches into its `errors` array like
any other per-channel failure. In the collector, a channel with a feed error takes the
existing error branch (`updateChannelActivity(ch.username, {})`), so it is stamped
checked-but-`lastVideoAt` untouched, not `lastVideoAt: null` as if genuinely empty — that
branch already existed for other feed errors, this just routes garbled 200s into it
instead of down the "0 entries" path. A well-formed feed with zero `<entry>` blocks still
passes the root check and returns `[]` with no error, unaffected.
Tests added to `test/youtube-rss.test.js`: "fetchChannelFeed treats a garbled 200 response
as an error, not an empty feed", "fetchFeeds surfaces a garbled 200 as an error...", and
"a well-formed feed with zero entries returns [] with no error".

### Minor: `views` — null instead of 0 on missing/unparseable

Checked `computeBoost` in `src/youtube/scoring.js` first: `if (!views || views <= 0) return 0`
treats `null` exactly like `0` or a missing value (both are falsy) — no different code path
needed, safe to switch. `parseChannelFeed` now returns `views: null` when the
`media:statistics views="…"` attribute is absent or fails `parseInt`, instead of coercing
to `0`, so a genuinely unwatched video (`views: 0`) is distinguishable from "couldn't read
it" (`views: null`). Test: "parseChannelFeed returns null views for a missing or
unparseable views attribute, not 0".

### Test results

```
npm test
```
```
ℹ tests 93
ℹ pass 93
ℹ fail 0
```
87 → 93 (+6: two collector truncation tests, three rss.js garbled/empty-feed tests, one
null-views test).
