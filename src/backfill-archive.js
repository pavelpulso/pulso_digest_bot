/**
 * One-off (but resumable) backfill of the YouTube archive playlist from digest history.
 *
 * The archive only grows from the day it was created, while `digest_shown` remembers every
 * video the digest ever surfaced. This walks that history oldest-first and inserts whatever
 * the archive is missing.
 *
 * Each insert costs 50 quota units against a 10k daily budget, so a large history takes
 * several days. Re-running is safe and picks up where the last run stopped — progress lives
 * in the playlist itself, not in a cursor.
 *
 * Usage: node src/backfill-archive.js [--limit=150] [--dry-run]
 */

import "dotenv/config"
import { getShownVideoIds } from "./db.js"
import { YouTubeClient } from "./youtube/client.js"
import { appendVideos } from "./youtube/playlist.js"

const DEFAULT_LIMIT = 150

function arg(name) {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]
}

async function main() {
  const adminId = parseInt(process.env.ADMIN_ID, 10) || 0
  if (!adminId) {
    console.error("[backfill] ADMIN_ID is not set — the playlist belongs to that one account.")
    process.exit(1)
  }

  const limit = parseInt(arg("limit"), 10) || DEFAULT_LIMIT
  const dryRun = process.argv.includes("--dry-run")

  const videoIds = getShownVideoIds(adminId)
  console.log(`[backfill] ${videoIds.length} videos in digest history.`)
  if (videoIds.length === 0) return

  if (dryRun) {
    console.log(`[backfill] Dry run — would insert up to ${limit}, oldest first:`)
    console.log(videoIds.slice(0, limit).map((id) => `  https://youtu.be/${id}`).join("\n"))
    return
  }

  const client = new YouTubeClient()
  if (!client.isReady()) {
    console.error("[backfill] YouTube client is not configured (YOUTUBE_REFRESH_TOKEN).")
    process.exit(1)
  }

  const result = await appendVideos({ client, videoIds, maxWrites: limit })
  console.log(`[backfill] Added ${result.added} (archive now ${result.size}, playlist ${result.playlistId}).`)

  if (result.quotaExhausted) {
    console.log(`[backfill] Daily quota exhausted — ${result.remaining} left. Re-run tomorrow.`)
  } else if (result.remaining) {
    console.log(`[backfill] Run budget reached — ${result.remaining} left. Re-run to continue.`)
  } else {
    console.log("[backfill] History fully archived.")
  }
}

main().catch((e) => {
  console.error("[backfill] Failed:", e.message)
  process.exit(1)
})
