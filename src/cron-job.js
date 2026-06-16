/**
 * Standalone cron job script for system cron
 * Runs channel post collection and morning digest delivery
 * Usage: node src/cron-job.js --action=collect|digest
 */

import "dotenv/config"
import { collectChannelPosts } from "./gramjs.js"
import { getChannelUsernames, addChannel } from "./db.js"
import bot from "./bot.js"
import { sendMorningDigests } from "./bot.js"

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
