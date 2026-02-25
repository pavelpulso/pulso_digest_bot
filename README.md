# Pulso Digest Bot

Telegram-бот для агрегации постов из каналов и персонализированного дайджеста (Node.js, GramJS, Gemini API, SQLite).

## Стек

- Node.js 20+
- Telegraf, GramJS (telegram), better-sqlite3, node-cron
- Gemini API через OpenAI-совместимый прокси (xray)
- БД: **SQLite** (файл `data/db.sqlite`)

## Установка и деплой

```bash
npm install
cp .env.example .env
# Заполнить .env (BOT_TOKEN, TG_API_ID, TG_API_HASH, GEMINI_*, ADMIN_ID и т.д.)

# Первый запуск — получить сессию GramJS
node src/auth.js

# Запуск через PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## GitHub и автодеплой на VPS

Репозиторий: **https://github.com/pavelpulso/pulso_digest_bot**

1. **Один раз на VPS**  
   Клонируйте проект и настройте окружение:

   ```bash
   cd /home/your_user   # или другой каталог
   git clone https://github.com/pavelpulso/pulso_digest_bot.git
   cd pulso_digest_bot
   cp .env.example .env
   # отредактировать .env
   node src/auth.js    # получить сессию GramJS
   npm ci
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

   Запомните полный путь к каталогу проекта (например `/home/your_user/pulso_digest_bot`) — он понадобится для секрета `DEPLOY_PATH`.

2. **Секреты в GitHub (обязательно для автодеплоя)**  
   В репозитории: **Settings → Secrets and variables → Actions** → **New repository secret**. Добавьте (без них автодеплой не заработает):

   | Секрет            | Описание                                      |
   |-------------------|-----------------------------------------------|
   | `VPS_HOST`        | IP или домен VPS (без порта)                  |
   | `VPS_USER`        | Пользователь SSH (например `root` или `deploy`) |
   | `SSH_PRIVATE_KEY` | Полное содержимое приватного SSH-ключа       |
   | `DEPLOY_PATH`     | Путь к каталогу проекта на VPS (см. выше)     |

   Ключ для деплоя: на своей машине `ssh-keygen -t ed25519 -C "github-deploy" -f deploy_key` (без пароля), положите публичный ключ в `~/.ssh/authorized_keys` на VPS, в секрет — содержимое `deploy_key`.

3. **Автодеплой**  
   При каждом `git push origin main` GitHub Actions подключается по SSH к VPS и выполняет в `DEPLOY_PATH`: `git pull`, `npm ci --omit=dev`, `pm2 restart tg-digest-bot` (или первый запуск, если бот ещё не был запущен).

## Переменные окружения (.env)

| Переменная | Описание |
|------------|----------|
| BOT_TOKEN | Токен бота от @BotFather |
| TG_API_ID, TG_API_HASH | my.telegram.org |
| TG_SESSION | Строка сессии GramJS (заполняется после `node src/auth.js`) |
| CHANNELS | Начальные каналы через запятую, без @ |
| GEMINI_API_KEY, GEMINI_PROXY_URL, GEMINI_MODEL | Gemini через прокси |
| ADMIN_ID | Telegram user_id администратора |
| DB_PATH | Путь к SQLite (по умолчанию ./data/db.sqlite) |

## Команды бота

- `/start` — приветствие
- `/digest` — топ-10 постов за сегодня
- `/profile` — просмотр/установка профиля (интересы)
- `/summary` — выбор даты и саммари за день
- `/channels` — список каналов
- `/add @channel`, `/remove @channel` — добавить/удалить канал

Пересланный пост из канала добавляет канал в список.

Админ (ADMIN_ID): `/ban`, `/unban`, `/close`, `/open`, `/stats`.

## Структура

- `src/index.js` — запуск бота и крона
- `src/bot.js` — команды и обработчики
- `src/cron.js` — сбор постов раз в 24ч (06:00)
- `src/gramjs.js` — чтение каналов через GramJS
- `src/gemini.js` — ранжирование и саммари через Gemini
- `src/db.js` — SQLite (settings, channels, posts, rankings, users)
- `src/utils.js` — форматирование, пагинация
- `src/auth.js` — получение GramJS-сессии (запуск вручную)
