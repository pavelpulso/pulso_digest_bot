/**
 * Standalone cron job script for system cron
 * Runs channel post collection and morning digest delivery
 * Usage: node src/cron-job.js --action=collect|digest
 */

import "dotenv/config"
import { collectChannelPosts } from "./gramjs.js"
import { getChannelUsernames, addChannel, setSetting } from "./db.js"
import bot from "./bot.js"
import { sendMorningDigests } from "./bot.js"
import { collectYouTubeVideos } from "./youtube/collector.js"
import { YouTubeClient } from "./youtube/client.js"

const ACTION = process.argv.find(a => a.startsWith("--action="))?.split("=")[1] || "collect"

function seedChannelsFromEnv() {
  const list = (process.env.CHANNELS || "").split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean)
  const existing = new Set(getChannelUsernames())
  const adminId = parseInt(process.env.ADMIN_ID, 10) || 0
  for (const username of list) {
    if (!existing.has(username)) {
      addChannel(username, adminId)
      existing.add(username)
    }
  }
}

/** Отозванный refresh-токен иначе исчезает в логах, и видео просто перестают приходить. */
async function alertAdmin(text) {
  const adminId = parseInt(process.env.ADMIN_ID, 10) || 0
  if (!adminId) return
  try {
    await bot.telegram.sendMessage(adminId, `\u26a0\ufe0f ${text}`.slice(0, 4000))
  } catch (e) {
    console.error("[cron-job] Admin alert failed:", e.message)
  }
}

async function runCollection() {
  const startTime = Date.now()
  console.log("[cron-job] Starting channel post collection...")
  try {
    seedChannelsFromEnv()
    const { collected, errors, perChannel } = await collectChannelPosts()
    const elapsed = Math.round((Date.now() - startTime) / 1000)

    if (errors.length) {
      console.error("[cron-job] Errors:", errors)
    }
    console.log(`[cron-job] Collected ${collected} posts in ${elapsed}s.`)
    if (perChannel && perChannel.length > 0) {
      console.log("[cron-job] Per channel:", perChannel.map(c => `${c.channel}:${c.count}`).join(", "))
    }

    // YouTube не имеет права отменить уже собранные посты, поэтому свой try/catch.
    try {
      const yt = await collectYouTubeVideos({
        client: new YouTubeClient(),
        addedBy: parseInt(process.env.ADMIN_ID, 10) || 0
      })
      if (yt.warnings.length) {
        console.log("[cron-job] YouTube warnings:", yt.warnings)
      }
      setSetting("yt_last_warnings", JSON.stringify({
        warnings: yt.warnings,
        collected: yt.collected,
        ranAt: new Date().toISOString()
      }))
      if (yt.errors.length) {
        console.error("[cron-job] YouTube errors:", yt.errors)
        await alertAdmin(`YouTube: ${yt.errors.slice(0, 5).join("\n")}`)
      }
      console.log(`[cron-job] Collected ${yt.collected} videos.`)
    } catch (e) {
      console.error("[cron-job] YouTube collection failed:", e.message)
      await alertAdmin(`YouTube collection failed: ${e.message}`)
    }

    console.log("[cron-job] Completed successfully.")
    process.exit(0)
  } catch (err) {
    console.error("[cron-job] Fatal error:", err.message, err.stack)
    process.exit(1)
  }
}

async function runMorningDigest() {
  console.log("[cron-job] Starting morning digest delivery...")
  try {
    await sendMorningDigests(bot)
    console.log("[cron-job] Morning digest delivery completed.")
    process.exit(0)
  } catch (err) {
    console.error("[cron-job] Morning digest error:", err.message, err.stack)
    process.exit(1)
  }
}

// Main execution
if (ACTION === "digest") {
  runMorningDigest()
} else {
  runCollection()
}
