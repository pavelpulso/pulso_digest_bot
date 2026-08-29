import "dotenv/config"
import { createInterface } from "readline"

const clientId = process.env.YOUTUBE_CLIENT_ID
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET

if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env")
  console.error("Google Cloud → APIs & Services → Credentials → OAuth client ID → Desktop app")
  process.exit(1)
}

// Out-of-band flow: Google shows the code on screen, no local web server needed.
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly"

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
authUrl.searchParams.set("client_id", clientId)
authUrl.searchParams.set("redirect_uri", REDIRECT_URI)
authUrl.searchParams.set("response_type", "code")
authUrl.searchParams.set("scope", SCOPE)
authUrl.searchParams.set("access_type", "offline")
authUrl.searchParams.set("prompt", "consent")

const rl = createInterface({ input: process.stdin, output: process.stdout })
const question = (q) => new Promise((res) => rl.question(q, res))

async function main() {
  console.log("\nOpen this URL, grant access, then paste the code back here:\n")
  console.log(authUrl.toString(), "\n")
  const code = (await question("Code: ")).trim()

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code"
    })
  })
  const json = await res.json()

  if (!res.ok || !json.refresh_token) {
    console.error("Failed:", JSON.stringify(json))
    process.exit(1)
  }

  console.log("\nAdd this line to .env:\n")
  console.log(`YOUTUBE_REFRESH_TOKEN=${json.refresh_token}\n`)
  rl.close()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
