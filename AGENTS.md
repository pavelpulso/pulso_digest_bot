# AGENTS.md

## 🤖 GLOBAL EXPERT DEVELOPER RULES

### 🤔 THINKING FRAMEWORK
```
[1. ANALYZE] What needs to be solved
[2. PLAN] Solution architecture  
[3. CODE] Working code only
[4. TEST] Edge cases + errors
```

### 🛠 CORE PRINCIPLES

**KISS**: Simplest solution. No overengineering.

**DRY**: Extract repeated code → function/module

**SOLID**:
- S: Single responsibility per module
- O: Extend behavior, don't modify code
- L: Subtypes are interchangeable
- I: Small, clear interfaces
- D: Inject dependencies from outside

**QUALITY**:
- Handle edge cases (empty/error/timeout)
- Validate input data
- Log critical operations
- Design for scale (pagination/caching)

---

Контекст для AI-ассистентов, работающих с проектом Pulso Digest Bot.

---

## Обзор проекта

**Pulso Digest Bot** — Telegram-бот, который собирает посты из отслеживаемых каналов и формирует персонализированный дайджест с помощью Gemini API.

### Ключевые технологии

- **Node.js 20+** (ES Modules)
- **Telegraf** — Telegram Bot API
- **GramJS (telegram)** — MTProto клиент для чтения каналов
- **better-sqlite3** — SQLite база данных
- **node-cron** — планировщик задач
- **Gemini API** — через OpenAI-совместимый прокси (xray)

---

## Структура проекта

```
src/
├── index.js    # Точка входа: запуск бота и cron
├── bot.js      # Telegraf: команды, обработчики, клавиатуры
├── cron.js     # Сбор постов (06:00) и утренняя рассылка (07:00)
├── gramjs.js   # Чтение каналов через MTProto (GramJS)
├── gemini.js   # Ранжирование и генерация дайджеста через Gemini API
├── db.js       # SQLite: пользователи, каналы, посты, рейтинги
├── utils.js    # Форматирование, пагинация, константы
└── auth.js     # Получение GramJS-сессии (запускается вручную)
```

---

## Основные команды

### Разработка

```bash
npm install                  # Установка зависимостей
cp .env.example .env         # Создать .env и заполнить переменные
node src/auth.js             # Получить GramJS-сессию (один раз)
npm run dev                  # Запуск с nodemon (hot reload)
npm start                    # Продакшн запуск
```

### Деплой

```bash
npm run deploy               # SSH на VPS + deploy.sh (требуется .deploy.env)
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

## Архитектура

### Поток данных

1. **Сбор (cron 06:00)**: `cron.js` → `gramjs.js` собирает посты за 24ч → сохраняет в `posts` таблицу через `db.js`
2. **Ранжирование (по запросу)**: `bot.js` → `gemini.js rankPosts()` → таблица `rankings`
3. **Дайджест**: `bot.js` → `gemini.js generateSummaryBlocks()` → отправка пользователю
4. **Утренняя рассылка (cron 07:00)**: `sendMorningDigests()` → тизер + кнопка → полный дайджест

### База данных (SQLite)

**Таблицы:**
- `settings` — глобальные настройки (gramjs_session, is_open)
- `channels` — отслеживаемые каналы
- `posts` — собранные посты (channel, post_id, text, link, views, date)
- `rankings` — ранжирование постов для пользователя (user_id, post_id, score, reason)
- `users` — пользователи (profile, digest_max_items, minus_keywords)
- `user_channel_settings` — настройки каналов для пользователя (hidden, priority)
- `post_feedback` — лайки/дизлайки для персонализации

---

## Ключевые модули

### `src/bot.js`

- Команды: `/start`, `/digest`, `/profile`, `/summary`, `/channels`, `/add`, `/remove`, `/menu`, `/digest_max`, `/minus_words`
- Admin-команды: `/ban`, `/unban`, `/close`, `/open`, `/stats`
- Inline-кнопки: digest, summary, channels, profile, feedback
- Функции: `digestReply()`, `sendMorningDigests()`, `ensureRankingsForUser()`

### `src/gemini.js`

- `rankPosts(posts, userProfile, options)` — оценка постов (score 0-1)
- `generateSummaryBlocks(posts, dateLabel, userProfile, maxItems)` — генерация блоков дайджеста + тизер
- `recommendChannels(userProfile, channelUsernames)` — рекомендации каналов по профилю

### `src/db.js`

- CRUD для channels, posts, rankings, users
- `getRankedPostIds()`, `getRankedPostIdsAboveScore()` — получение ранжированных постов
- `upsertPostFeedback()` — сохранение обратной связи

### `src/utils.js`

- `DIGEST_PAGE_SIZE = 10`
- `MIN_DIGEST_SCORE = 0.5` — минимальный score для попадания в дайджест
- Форматирование: `formatDigestHeader()`, `formatBlockText()`, `formatChannelList()`

---

## Переменные окружения (.env)

| Переменная | Описание |
|------------|----------|
| `BOT_TOKEN` | Токен бота от @BotFather |
| `TG_API_ID`, `TG_API_HASH` | Данные с my.telegram.org |
| `GEMINI_API_KEY` | API-ключ Gemini |
| `GEMINI_PROXY_URL` | URL прокси (xray), например `http://127.0.0.1:10808` |
| `GEMINI_MODEL` | Модель Gemini (по умолчанию `gemini-3-flash`) |
| `ADMIN_ID` | Telegram user_id админа |
| `CHANNELS` | Начальные каналы (через запятую, без @) |
| `DB_PATH` | Путь к SQLite (по умолчанию `./data/db.sqlite`) |

---

## Конвенции кода

- **ES Modules**: `import`/`export`, `type: "module"` в package.json
- **Асинхронность**: `async`/`await`
- **Именование**: camelCase для переменных и функций, UPPER_CASE для констант
- **База данных**: синхронный `better-sqlite3`, WAL-режим
- **Форматирование**: HTML для Telegram-сообщений (parse_mode: "HTML")
- **Ошибки**: логирование в консоль, краткие сообщения пользователю через `formatErrorForChat()`

---

## Тестирование

Тестов нет. Для проверки: запустить бота локально (`npm run dev`) и протестировать команды.

---

## Деплой на VPS

1. Клонировать репозиторий
2. `cp .env.example .env` + заполнить переменные
3. `node src/auth.js` — получить GramJS-сессию
4. `npm ci`
5. `pm2 start ecosystem.config.cjs`
6. `pm2 save && pm2 startup`

Обновление: `git pull && npm ci && pm2 restart tg-digest-bot`

---

## Важные нюансы

- **GramJS-сессия** хранится в БД (`settings.gramjs_session`), не в .env
- **Рейтинг постов** персонализирован для каждого пользователя (user profile + channel priorities + feedback)
- **Фильтрация**: скрытые каналы, minus-слова, рекламные посты (ИНН, erid)
- **Утренний дайджест**: сначала тизер с кнопкой, затем полный дайджест
- **Timezone**: Europe/Moscow для cron-задач
