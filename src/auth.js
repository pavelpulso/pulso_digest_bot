import "dotenv/config"
import { createInterface } from "readline"
import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions/index.js"
import { getSetting, setSetting } from "./db.js"

const apiId = parseInt(process.env.TG_API_ID, 10)
const apiHash = process.env.TG_API_HASH

if (!apiId || !apiHash) {
  console.error("Set TG_API_ID and TG_API_HASH in .env")
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const question = (q) => new Promise((res) => rl.question(q, res))

const saved = getSetting("gramjs_session") || ""
const session = new StringSession(saved)

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5
})

async function main() {
  await client.start({
    phoneNumber: async () => await question("Phone number (with country code): "),
    password: async () => await question("2FA password (if any, else Enter): "),
    phoneCode: async () => await question("Code from Telegram: "),
    onError: (err) => console.error(err)
  })

  const sessionString = client.session.save()
  setSetting("gramjs_session", sessionString)
  console.log("\nSession saved to DB (settings.gramjs_session).")
  console.log("You can now start the bot: npm start")
  rl.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
