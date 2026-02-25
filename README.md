# Pulso Digest Bot

Telegram bot that aggregates posts from channels and delivers a personalized digest (Node.js, GramJS, Gemini API, SQLite).

## Stack

- Node.js 20+
- Telegraf, GramJS (telegram), better-sqlite3, node-cron
- Gemini API via an OpenAI-compatible proxy (xray)
- **SQLite** database (file `data/db.sqlite`)

## Setup and deploy

```bash
npm install
cp .env.example .env
# Fill in .env (BOT_TOKEN, TG_API_ID, TG_API_HASH, GEMINI_*, ADMIN_ID, etc.)

# First run — obtain GramJS session
node src/auth.js

# Run with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## GitHub and auto-deploy to VPS

Repository: **https://github.com/pavelpulso/pulso_digest_bot**

1. **One-time VPS setup**  
   Clone the project and configure the environment:

   ```bash
   cd /home/your_user   # or another directory
   git clone https://github.com/pavelpulso/pulso_digest_bot.git
   cd pulso_digest_bot
   cp .env.example .env
   # edit .env
   node src/auth.js     # obtain GramJS session
   npm ci
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

   Remember the full path to the project directory (e.g. `/home/your_user/pulso_digest_bot`) — you will need it for the `DEPLOY_PATH` secret.

2. **GitHub secrets (required for auto-deploy)**  
   In the repo: **Settings → Secrets and variables → Actions** → **New repository secret**. Add:

   | Secret           | Description                                      |
   |------------------|--------------------------------------------------|
   | `VPS_HOST`       | VPS IP or hostname (no port)                     |
   | `VPS_USER`       | SSH username (e.g. `root` or `deploy`)           |
   | `SSH_PRIVATE_KEY`| Full contents of the private SSH key            |
   | `DEPLOY_PATH`    | Path to the project directory on the VPS (above) |

   For the deploy key: on your machine run `ssh-keygen -t ed25519 -C "github-deploy" -f deploy_key` (no passphrase), add the public key to `~/.ssh/authorized_keys` on the VPS, and put the private key contents into the `SSH_PRIVATE_KEY` secret.

3. **Auto-deploy**  
   On every `git push origin main`, GitHub Actions connects via SSH to the VPS and runs in `DEPLOY_PATH`: `git pull`, `npm ci --omit=dev`, `pm2 restart tg-digest-bot` (or starts the app if it isn’t running yet).

## Environment variables (.env)

| Variable | Description |
|----------|-------------|
| BOT_TOKEN | Bot token from @BotFather |
| TG_API_ID, TG_API_HASH | From my.telegram.org |
| TG_SESSION | GramJS session string (set after `node src/auth.js`) |
| CHANNELS | Initial channels, comma-separated, without @ |
| GEMINI_API_KEY, GEMINI_PROXY_URL, GEMINI_MODEL | Gemini via proxy |
| ADMIN_ID | Telegram user_id of the admin |
| DB_PATH | SQLite file path (default: ./data/db.sqlite) |

## Bot commands

- `/start` — Welcome and short help
- `/digest` — Top 10 posts for today
- `/profile` — View or set your profile (interests)
- `/summary` — Pick a date and get a summary for that day
- `/channels` — List tracked channels
- `/add @channel`, `/remove @channel` — Add or remove a channel

Forwarding a post from a channel to the bot adds that channel to the list.

Admin (ADMIN_ID): `/ban`, `/unban`, `/close`, `/open`, `/stats`.

## Project structure

- `src/index.js` — Entry point, starts bot and cron
- `src/bot.js` — Telegraf commands and handlers
- `src/cron.js` — Daily post collection (06:00)
- `src/gramjs.js` — Reading channels via GramJS
- `src/gemini.js` — Ranking and summary via Gemini
- `src/db.js` — SQLite (settings, channels, posts, rankings, users)
- `src/utils.js` — Formatting, pagination
- `src/auth.js` — GramJS session setup (run manually)
