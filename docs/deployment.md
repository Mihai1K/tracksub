# Развёртывание

## Что это за приложение

Node.js без внешних зависимостей. Сервер, интерфейс и фоновые задачи — один процесс.
Хранилище — SQLite в файле. Порог входа: `node src/index.js` и обратный прокси с HTTPS.

## Какой сервер нужен

**Виртуальный хостинг не подойдёт.** На shared-тарифах (например Host-0 у рег.ру) есть PHP,
Perl и Python, но нет Node.js и нельзя держать постоянно работающий процесс. Нашему сервису
нужны и то, и другое: приём вебхуков, очередь конверсий, рассылка отчётов, пул ссылок.

Нужен **VPS** — минимальной конфигурации хватает с запасом:

| | |
|---|---|
| CPU | 1 ядро |
| RAM | 1 ГБ |
| Диск | 10 ГБ |
| ОС | Ubuntu 22.04 или 24.04 |
| Порты | 80 и 443 открыты наружу |

Внешних зависимостей у приложения нет, база — файл SQLite, redirect отвечает за доли миллисекунды.
Упрётесь в этот сервер не раньше нескольких тысяч активных каналов.

## Боевое развёртывание одной командой

```bash
# на сервере, от root
git clone <репозиторий> /opt/tracksub && cd /opt/tracksub
cp .env.example .env && $EDITOR .env      # APP_URL=https://tracksub.ru, секреты, токены
./deploy.sh
```

`deploy.sh` поставит Docker, поднимет приложение и Caddy, который сам получит сертификат
Let's Encrypt и будет его продлевать. Отдельная возня с certbot не нужна.

Перед запуском в DNS домена должна стоять A-запись на адрес сервера — иначе Let's Encrypt
не выдаст сертификат. Скрипт об этом предупредит.

После старта:

```bash
docker compose -f docker-compose.prod.yml exec app node tools/telegram-live.js set-webhook
```

Это переключит Telegram с long polling на вебхук по адресу `https://tracksub.ru/webhook/telegram`.

## Быстрый старт на сервере

```bash
git clone <репозиторий> tracker && cd tracker
cp .env.example .env && $EDITOR .env      # заполнить APP_URL, IP_SALT, ADMIN_EMAIL, ADMIN_PASSWORD
docker compose up -d --build
curl -s https://ваш-домен/health
```

Без Docker:

```bash
npm start
```

## Обратный прокси

Приложение слушает HTTP и ждёт HTTPS снаружи. Минимум для nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name tracker.example.ru;
  ssl_certificate     /etc/letsencrypt/live/tracker.example.ru/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/tracker.example.ru/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

В `.env` при этом обязательно `TRUST_PROXY=true` и `SECURE_COOKIES=true`, иначе адрес клиента
будет определяться неверно, а cookie уйдут без флага Secure.

## Подключение вебхуков

**Telegram.** Один раз после запуска:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://ваш-домен/webhook/telegram","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["chat_member","my_chat_member","chat_join_request","message"]}'
```

`chat_member` обязателен в `allowed_updates` — без него Telegram не пришлёт вступления в канал.
Это верно и для вебхука, и для `getUpdates`: по умолчанию этот тип обновлений не приходит вообще.
Бот должен быть администратором канала с правом приглашать по ссылке.

Проще выполнить это командой:

```bash
node tools/telegram-live.js set-webhook      # берёт APP_URL и секрет из .env
node tools/telegram-live.js check            # покажет, включён ли chat_member
```

### Пока нет домена: long polling

Вебхук требует HTTPS с валидным сертификатом. Пока домена нет, реальные события можно принимать
через long polling — это те же самые обновления Telegram и тот же конвейер (`src/ingest.js`),
отличается только транспорт:

```bash
node tools/telegram-live.js delete-webhook
node tools/telegram-live.js poll --auto-connect
```

Канал, в который добавили бота администратором, подключится сам. Для боевой эксплуатации
polling не годится (один процесс, нет ретраев на стороне Telegram) — это режим для живой проверки.

**MAX.** Требования платформы: только HTTPS на 443 и сертификат доверенного УЦ, плюс сертификат
Минцифры в доверенных на сервере. Подписка на события — `POST /subscriptions` с адресом
`https://ваш-домен/webhook/max` и секретом из `MAX_WEBHOOK_SECRET`.
Профиль разработчика на dev.max.ru доступен только резидентам РФ: юрлицам, ИП и самозанятым.

## Хранилище

Сейчас работает SQLite. Это сознательное решение для MVP: ноль зависимостей, мгновенный запуск,
резервная копия одной командой. Ограничение честное: одновременная запись из нескольких процессов
на SQLite деградирует.

**Переход на PostgreSQL** подготовлен, но не выполнен и не проверен:

- DDL лежит в `migrations/postgres/001_init.sql`;
- весь доступ к данным идёт через `one/all/run` из `src/db.js` — менять надо только этот слой
  и заменить `?` на `$1..$n`;
- оценка работы: день с тестами.

Порог, за которым это перестаёт быть отложенной задачей: примерно 50 активных проектов
или заметный поток вебхуков в секунду.

## Резервные копии

```bash
npm run backup                                  # копия в ./backups, хранится 14 последних
node tools/backup.js --db ./data/app.sqlite --out /mnt/backup --keep 30
```

Копия снимается через `VACUUM INTO` — это штатный механизм SQLite, консистентный на работающей базе.

**Восстановление:**

```bash
docker compose stop app
cp backups/app-2026-09-04T21-00-00.sqlite data/app.sqlite
docker compose start app
curl -s https://ваш-домен/health
```

Проверьте восстановление на тестовом сервере до того, как оно понадобится всерьёз.

## Наблюдаемость

- `GET /health` — состояние базы, очередь событий, число упавших событий и конверсий.
- Логи структурные, по строке JSON на событие: `level`, `msg`, `path`, `ms`, `status`.
- Разделы админки показывают упавшие события и проблемные конверсии с кнопкой повтора.

## Обновление

```bash
git pull && docker compose up -d --build
```

Схема БД мигрирует сама при старте: таблицы создаются с `IF NOT EXISTS`, новые колонки
добавляются в `migrateColumns`. Сырые события не удаляются никогда, поэтому атрибуцию
можно пересчитать после любого обновления.
