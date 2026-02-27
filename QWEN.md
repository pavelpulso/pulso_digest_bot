# Pulso Digest Bot — Project Context

## 🤖 Global Expert Developer Rules

### 🤔 МЫШЛЕНИЕ
```
[1. АНАЛИЗ] Что нужно решить
[2. ПЛАН] Архитектура решения  
[3. КОД] Только рабочий код
[4. ТЕСТ] Граничные случаи + ошибки
```

### 🛠 ОСНОВНЫЕ ПРИНЦИПЫ

**KISS**: Простейшее решение. Без лишнего.

**DRY**: Повторяющееся → вынести в функцию/модуль

**SOLID**:
- S: 1 модуль = 1 ответственность
- O: Расширяй поведение, не меняй код
- L: Подтипы взаимозаменяемы
- I: Маленькие четкие интерфейсы
- D: Зависимости передавай извне

**Качество**:
- Обрабатывай edge cases (пусто/ошибка/timeout)
- Проверяй входные данные
- Логируй критические операции
- Делай масштабируемо (pagination/caching)

---

## Project Overview

**Pulso Digest Bot** is a Telegram bot that aggregates posts from tracked channels and delivers a personalized digest using Gemini AI for ranking and summarization.

### Core Technologies

- **Runtime:** Node.js 20+ (ES Modules)
- **Telegram Bot:** Telegraf
- **Telegram Client:** GramJS (`telegram` package) for MTProto channel reading
- **Database:** SQLite via `better-sqlite3` (file: `data/db.sqlite`)
- **AI:** Gemini API via OpenAI-compatible proxy (xray)
- **Scheduling:** `node-cron`
- **Process Manager:** PM2

### Architecture Flow

1. **Collection (cron 06:00 MSK):** `cron.js` → `gramjs.js` fetches posts from last 24h → saves to `posts` table
2. **Ranking (on-demand):** `bot.js` → `gemini.js rankPosts()` → stores in `rankings` table
3. **Digest Generation:** `bot.js` → `gemini.js generateSummaryBlocks()` → sends to user
4. **Morning Delivery (cron 07:00 MSK):** `sendMorningDigests()` → teaser with button → full digest

---

## Project Structure

```
src/
├── index.js        # Entry point: starts bot and cron
├── bot.js          # Telegraf commands, handlers, inline keyboards
├── cron.js         # Daily post collection (06:00) and morning digest (07:00)
├── gramjs.js       # Channel reading via MTProto (GramJS)
├── gemini.js       # Post ranking and digest generation via Gemini API
├── db.js           # SQLite CRUD: users, channels, posts, rankings, feedback
├── utils.js        # Formatting, pagination, constants
└── auth.js         # GramJS session setup (run manually once)

data/
└── db.sqlite       # SQLite database file
```

---

## Building and Running

### Initial Setup

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your values (see Environment Variables below)

# Obtain GramJS session (one-time)
npm run auth
# or: node src/auth.js
```

### Development

```bash
# Start with hot reload (nodemon)
npm run dev

# Start in production mode
npm start
```

### Production Deployment (PM2)

```bash
# Start with PM2
pm2 start ecosystem.config.cjs

# Save PM2 process list and configure startup
pm2 save
pm2 startup
```

### Deploy to VPS

**One-time setup:**
```bash
git clone https://github.com/pavelpulso/pulso_digest_bot.git
cd pulso_digest_bot
cp .env.example .env
# Edit .env
node src/auth.js
npm ci
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

**Update deployment:**
```bash
# Option A: From local machine (requires .deploy.env)
npm run deploy

# Option B: On VPS
./deploy.sh
```

---

## Environment Variables (.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `BOT_TOKEN` | Telegram bot token from @BotFather | Yes |
| `TG_API_ID` | API ID from my.telegram.org | Yes |
| `TG_API_HASH` | API Hash from my.telegram.org | Yes |
| `GEMINI_API_KEY` | Gemini API key (Google AI Studio) | Yes |
| `GEMINI_PROXY_URL` | Proxy URL for Gemini (e.g., `http://127.0.0.1:10808`) | Yes |
| `GEMINI_MODEL` | Gemini model (default: `gemini-3-flash`) | No |
| `ADMIN_ID` | Telegram user_id of admin (for /ban, /unban, etc.) | Yes |
| `CHANNELS` | Initial channels, comma-separated, without @ | No |
| `DB_PATH` | SQLite database path (default: `./data/db.sqlite`) | No |

**Note:** GramJS session is stored in the database (`settings.gramjs_session`), not in `.env`.

---

## Bot Commands

### User Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/digest` | Get top 10 posts for today |
| `/profile` | View or set profile (interests) |
| `/minus_words` | Exclude posts containing specified words |
| `/summary` | Pick a date or get weekly summary (last 7 days) |
| `/channels` | List tracked channels and manage settings |
| `/add @channel` | Add a channel to tracking |
| `/remove @channel` | Remove a channel from tracking |
| `/menu` | Show main menu |
| `/digest_max` | Set max items per digest page (3-20) |
| `/digest_format` | Set digest format (full/compact) |

### Admin Commands (ADMIN_ID only)

| Command | Description |
|---------|-------------|
| `/ban` | Ban a user |
| `/unban` | Unban a user |
| `/close` | Close bot (stop accepting new users) |
| `/open` | Open bot |
| `/stats` | Show statistics |

---

## Database Schema

### Tables

- **`settings`** — Global settings (`gramjs_session`, `is_open`)
- **`channels`** — Tracked channels (username, added_by, added_at)
- **`posts`** — Collected posts (id, channel, post_id, text, link, views, date)
- **`rankings`** — Post rankings per user (user_id, post_id, score, reason, date)
- **`users`** — User profiles (user_id, username, profile, is_banned, digest_max_items, minus_keywords, digest_format)
- **`user_channel_settings`** — Per-user channel preferences (hidden, priority)
- **`post_feedback`** — User feedback on posts (user_id, post_id, rating: 1=like, -1=dislike)

### Key Constants (utils.js)

- `DIGEST_PAGE_SIZE = 10`
- `MIN_DIGEST_SCORE = 0.5` — Minimum score for digest inclusion

---

## Key Modules

### `src/bot.js`
Main bot logic: commands, inline keyboards, digest rendering, feedback handling.
- `digestReply()` — Renders digest with pagination
- `sendMorningDigests()` — Sends morning digest to all users
- `ensureRankingsForUser()` — Triggers ranking generation if needed

### `src/gemini.js`
AI integration for ranking and summarization.
- `rankPosts(posts, userProfile, options)` — Scores posts (0-1) based on profile and feedback
- `generateSummaryBlocks(posts, dateLabel, userProfile, maxItems)` — Generates digest blocks + teaser
- `recommendChannels(userProfile, channelUsernames)` — Recommends channels matching interests

### `src/db.js`
Database operations (synchronous `better-sqlite3`, WAL mode).
- CRUD for all tables
- `getRankedPostIdsWithTotal()` — Pagination support
- `upsertPostFeedback()` — Save like/dislike
- `getUserChannelSettings()` — Per-user channel preferences

### `src/cron.js`
Scheduled tasks (Europe/Moscow timezone).
- **06:00** — Collect posts from channels
- **07:00** — Send morning digests

---

## Development Conventions

- **Modules:** ES Modules (`import`/`export`), `"type": "module"` in package.json
- **Async:** `async`/`await` throughout
- **Naming:** camelCase for variables/functions, UPPER_CASE for constants
- **Database:** Synchronous `better-sqlite3` with WAL mode
- **Formatting:** HTML for Telegram messages (`parse_mode: "HTML"`)
- **Error Handling:** Console logging + user-friendly messages via `formatErrorForChat()`
- **Testing:** Manual testing via `npm run dev` (no automated tests)

---

## Product Features

### Personalization
- User profile (interests) influences ranking
- Channel priorities (normal/important)
- Hidden channels per user
- Minus-words filter
- Feedback (like/dislike) improves future rankings

### Morning Digest
- **06:00 MSK:** Posts collected
- **07:00 MSK:** Teaser sent with "Open digest" button, followed by full digest
- Posts filtered by score ≥ 0.5, limited by `digest_max_items`

### Digest Formats
- **Full:** Emoji + summary + action + potential + links
- **Compact:** Emoji + summary + links only
- "Why in digest" available via "📌 Подробнее" button

---

## Related Files

| File | Purpose |
|------|---------|
| `ecosystem.config.cjs` | PM2 configuration |
| `deploy.sh` | VPS deployment script (pull + install + restart) |
| `deploy-remote.sh` | SSH wrapper for remote deployment |
| `.deploy.env.example` | Template for deployment config (SSH target, path) |
| `nodemon.json` | Nodemon configuration for development |

---

## Important Notes

- **GramJS session** is obtained once via `node src/auth.js` and stored in DB
- **Timezone:** All cron jobs use Europe/Moscow timezone
- **Post filtering:** Ads (ИНН, erid), hidden channels, minus-words are excluded
- **Ranking is personalized:** Based on profile, channel priorities, and feedback history
- **Forwarding:** Forwarding a post from a channel to the bot adds that channel to tracking
