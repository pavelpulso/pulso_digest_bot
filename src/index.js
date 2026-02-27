import "dotenv/config"
import bot from "./bot.js"
import { startCron } from "./cron.js"

bot.launch().then(async () => {
  startCron(bot)
  console.log("Bot started.")
  try {
    await bot.telegram.setMyCommands([
      { command: "digest", description: "📰 Get the latest digest" },
      { command: "summary", description: "📋 Get summary for a specific date" },
      { command: "channels", description: "📢 Manage your channels" },
      { command: "profile", description: "👤 Profile & Settings" },
      { command: "menu", description: "📱 Show main menu" },
      { command: "add", description: "➕ Add a channel" },
      { command: "remove", description: "➖ Remove a channel" },
      { command: "minus_words", description: "🚫 Set minus words filter" },
      { command: "digest_max", description: "⚙️ Set max digest items" },
      { command: "digest_format", description: "📄 Set digest format (full/compact)" }
    ])
    console.log("Bot commands registered.")
  } catch (err) {
    console.error("Failed to set commands:", err)
  }
}).catch((e) => {
  console.error("Bot failed to start:", e)
  process.exit(1)
})

process.once("SIGINT", () => bot.stop("SIGINT"))
process.once("SIGTERM", () => bot.stop("SIGTERM"))
