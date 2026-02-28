# AGENTS.md

Context for AI assistants working with the Pulso Digest Bot project.

## 🤔 THINKING FRAMEWORK

```
[1. ANALYZE] What needs to be solved
[2. PLAN] Solution architecture
[3. CODE] Working code only
[4. TEST] Edge cases + errors
```

## 🛠 CORE PRINCIPLES

**KISS**: Simplest solution. No overengineering.

**DRY**: Extract repeated code → function/module

**SOLID**:
- S: Single responsibility per module
- O: Extend behavior, don't modify code
- L: Subtypes are interchangeable
- I: Small, clear interfaces
- D: Inject dependencies from outside

**QUALITY STANDARDS**:
- Handle edge cases (empty/error/timeout)
- Validate input data
- Log critical operations
- Design for scale (pagination/caching)

---

## Project Overview

**Pulso Digest Bot** is a Telegram bot that aggregates posts from tracked channels and delivers personalized digests using AI for ranking and summarization.

### Core Technologies

- **Runtime:** Node.js 20+ (ES Modules)
- **Telegram Bot:** Telegraf
- **Telegram Client:** GramJS (`telegram` package) for MTProto channel reading
- **Database:** SQLite via `better-sqlite3` (file: `data/db.sqlite`)
- **AI:** Multi-provider (Gemini, Groq, OpenRouter) with auto-fallback
- **Scheduling:** `node-cron`
- **Process Manager:** PM2

---

## Project Structure

```
src/
├── index.js    # Entry point: starts bot and cron
├── bot.js      # Telegraf: commands, handlers, inline keyboards
├── cron.js     # Post collection (06:00) and morning digest (07:00)
├── gramjs.js   # Channel reading via MTProto (GramJS)
├── gemini.js   # Post ranking and digest generation via AI
├── db.js       # SQLite: users, channels, posts, rankings, feedback
├── utils.js    # Formatting, pagination, constants
└── auth.js     # GramJS session setup (run manually once)
```

---

## Key Modules

### `src/bot.js`

Main bot logic: commands, inline keyboards, digest rendering, feedback handling.

**Commands:** `/start`, `/digest`, `/profile`, `/summary`, `/channels`, `/add`, `/remove`, `/menu`, `/digest_max`, `/minus_words`

**Admin commands:** `/ban`, `/unban`, `/close`, `/open`, `/stats`

**Key functions:**
- `digestReply()` — Renders digest with pagination
- `sendMorningDigests()` — Sends morning digest to all users
- `ensureRankingsForUser()` — Triggers ranking generation if needed

### `src/gemini.js`

AI integration for ranking and summarization.

**Key functions:**
- `rankPosts(posts, userProfile, options)` — Scores posts (0-1) based on profile and feedback
- `generateSummaryBlocks(posts, dateLabel, userProfile, maxItems)` — Generates digest blocks + teaser
- `recommendChannels(userProfile, channelUsernames)` — Recommends channels matching interests

### `src/db.js`

Database operations (synchronous `better-sqlite3`, WAL mode).

**Key functions:**
- CRUD for channels, posts, rankings, users
- `getRankedPostIdsWithTotal()` — Pagination support
- `upsertPostFeedback()` — Save like/dislike
- `getUserChannelSettings()` — Per-user channel preferences

### `src/cron.js`

Scheduled tasks (Europe/Moscow timezone).

- **06:00** — Collect posts from channels
- **07:00** — Send morning digests

### `src/gramjs.js`

Channel reading via MTProto.

**Key functions:**
- `fetchPostsFromChannels()` — Fetches posts from all tracked channels
- `fetchRecentPostsFromChannel(channelName, limit)` — Fetches recent posts from a specific channel

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

## Architecture Flow

1. **Collection (cron 06:00 MSK):** `cron.js` → `gramjs.js` fetches posts from last 24h → saves to `posts` table
2. **Ranking (on-demand):** `bot.js` → `gemini.js rankPosts()` → stores in `rankings` table
3. **Digest Generation:** `bot.js` → `gemini.js generateSummaryBlocks()` → sends to user
4. **Morning Delivery (cron 07:00 MSK):** `sendMorningDigests()` → teaser with button → full digest

---

## Development Commands

```bash
npm install                  # Install dependencies
cp .env.example .env         # Create .env and fill variables
node src/auth.js             # Obtain GramJS session (one-time)
npm run dev                  # Start with nodemon (hot reload)
npm start                    # Production start
npm run lint                 # Lint code
npm run lint:fix             # Fix lint issues
npm run deploy               # SSH to VPS + deploy.sh (requires .deploy.env)
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BOT_TOKEN` | Bot token from @BotFather |
| `TG_API_ID`, `TG_API_HASH` | From my.telegram.org |
| `AI_PROVIDER` | AI provider: `auto`, `gemini`, `groq`, `openrouter` (default: `auto`) |
| `GEMINI_API_KEY` | Gemini API key |
| `GEMINI_PROXY_URL` | Proxy URL (xray), e.g. `http://127.0.0.1:10808` |
| `GEMINI_MODEL` | Gemini model (default: `gemini-2.0-flash`) |
| `GROQ_API_KEY` | Groq API key |
| `GROQ_MODEL` | Groq model (default: `llama-3.3-70b-versatile`) |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | OpenRouter model |
| `ADMIN_ID` | Telegram user_id of admin |
| `CHANNELS` | Initial channels (comma-separated, without @) |
| `DB_PATH` | SQLite file path (default: `./data/db.sqlite`) |
| `DEBUG_AI` | Set to `1` or `true` to enable AI debug logging |

**Note:** GramJS session is stored in DB (`settings.gramjs_session`), not in `.env`.

---

## Code Conventions

- **ES Modules:** `import`/`export`, `type: "module"` in package.json
- **Async:** `async`/`await` throughout
- **Naming:** camelCase for variables/functions, UPPER_CASE for constants
- **Database:** Synchronous `better-sqlite3` with WAL mode
- **Formatting:** HTML for Telegram messages (`parse_mode: "HTML"`)
- **Error Handling:** Console logging + user-friendly messages via `formatErrorForChat()`
- **Code Language:** All string literals and comments must be in English

### File Size Limit

**Rule:** Keep files under **400 lines** (code only, excluding blank lines and comments).

**If a file exceeds 400 lines:**
1. Extract related functions into a separate module (e.g., `src/services/`, `src/handlers/`, `src/ui/`)
2. Split by responsibility (e.g., commands → `CommandHandler.js`, actions → `ActionHandler.js`)
3. Move constants/configs to `utils.js` or dedicated `constants.js`
4. Extract UI/keyboard logic to `src/ui/`
5. Extract service logic to `src/services/`

**Exceptions:**
- `db.js` — Database schema + operations (can be larger due to many queries)
- `prompts.js` — AI prompts (can be larger due to prompt templates)

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

### Feedback
- Like/dislike buttons under each post
- Feedback stored and used for ranking

### Channel Recommendations
- AI recommends channels matching user interests
- One-tap "Important" marking

---

## Important Notes

- **GramJS session** is obtained once via `node src/auth.js` and stored in DB
- **Timezone:** All cron jobs use Europe/Moscow timezone
- **Post filtering:** Ads (ИНН, erid), hidden channels, minus-words are excluded
- **Ranking is personalized:** Based on profile, channel priorities, and feedback history
- **Forwarding:** Forwarding a post from a channel to the bot adds that channel to tracking
- **Testing:** Manual testing via `npm run dev` (no automated tests)
