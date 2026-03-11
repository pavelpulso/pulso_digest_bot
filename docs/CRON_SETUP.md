# Настройка системного cron на VPS

## Проблема
node-cron работает только внутри процесса Node.js. При перезапуске PM2 или падении процесса cron не срабатывает.

## Решение
Использовать системный cron + отдельные скрипты для задач.

---

## 1. Отключить node-cron в боте

В `src/index.js` убрать запуск cron (теперь он будет через системный cron):

```js
// Закомментировать или удалить:
// import { startCron } from "./cron.js"
// startCron(bot)
```

---

## 2. Настроить системный cron на VPS

Подключиться к VPS и выполнить:

```bash
crontab -e
```

Добавить строки (расписание в timezone сервера!):

```cron
# Ежедневный сбор постов в 06:00 MSK (03:00 UTC)
0 3 * * * cd /home/pullso/pulso_digest_bot && /home/pullso/.nvm/versions/node/v20.19.0/bin/node src/cron-job.js --action=collect >> ~/pulso-cron.log 2>&1

# Утренняя рассылка digest в 10:00 MSK (07:00 UTC)
0 7 * * * cd /home/pullso/pulso_digest_bot && /home/pullso/.nvm/versions/node/v20.19.0/bin/node src/cron-job.js --action=digest >> ~/pulso-cron.log 2>&1
```

**Важно:**
- Лог писать в `~/pulso-cron.log` (НЕ в `/var/log/` — нет прав на запись!)
- Путь к node через nvm: `~/.nvm/versions/node/v20.19.0/bin/node`
- Заменить `/home/pullso/` на ваш домашний каталог
- Время указывается по timezone сервера! Проверить: `timedatectl`

---

## 3. Проверка timezone сервера

```bash
timedatectl
# Если не MSK, установить:
sudo timedatectl set-timezone Europe/Moscow
```

---

## 4. Проверка работы

```bash
# Посмотреть логи cron
tail -f ~/pulso-cron.log

# Принудительно запустить сбор постов
cd /home/user/pulso_digest_bot && node src/cron-job.js --action=collect

# Принудительно запустить digest
cd /home/user/pulso_digest_bot && node src/cron-job.js --action=digest
```

---

## 5. Мониторинг

```bash
# Логи cron
tail -100 ~/pulso-cron.log

# Статус cron службы
sudo systemctl status cron

# Последние задания cron
grep CRON /var/log/syslog | tail -20
```

---

## Альтернатива: Оставить node-cron + PM2

Если хотите оставить текущий подход:

1. **Настроить PM2 на автоперезапуск:**
   ```bash
   pm2 start ecosystem.config.cjs --restart-delay=5000
   pm2 save
   ```

2. **Добавить health-check в `ecosystem.config.cjs`:**
   ```js
   module.exports = {
     apps: [{
       name: "tg-digest-bot",
       script: "src/index.js",
       watch: false,
       max_memory_restart: "200M",
       env_file: ".env",
       restart_delay: 5000,
       max_restarts: 10,
       min_uptime: 60000
     }]
   }
   ```

3. **Добавить логирование срабатываний cron** в `src/cron.js`

**Но системный cron надёжнее!**
