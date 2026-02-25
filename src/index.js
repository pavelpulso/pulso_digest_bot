import "dotenv/config";
import bot from "./bot.js";
import { startCron } from "./cron.js";

bot.launch().then(() => {
  startCron(bot);
  console.log("Bot started.");
}).catch((e) => {
  console.error("Bot failed to start:", e);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
