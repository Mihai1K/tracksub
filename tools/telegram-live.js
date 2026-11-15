'use strict';

/**
 * Живая работа с Telegram без публичного домена.
 *
 * Зачем: боевой приём событий — вебхук, но он требует HTTPS-домена с валидным сертификатом.
 * Пока домена нет, реальные события можно получать через long polling: те же самые обновления
 * от Telegram, тот же конвейер (src/ingest.js), просто другой транспорт.
 *
 *   node tools/telegram-live.js check           состояние бота и готовность к тесту
 *   node tools/telegram-live.js poll            принимать реальные события (Ctrl+C — стоп)
 *   node tools/telegram-live.js set-webhook     перевести на вебхук (нужен APP_URL по https)
 *   node tools/telegram-live.js delete-webhook  снять вебхук, чтобы работал polling
 *
 * Токен читается из окружения и никогда не печатается.
 */

const { open, one, all, run } = require('../src/db');
const { cfg, dbFile } = require('../src/config');
const onboarding = require('../src/onboarding');
const ingest = require('../src/ingest');
const tracking = require('../src/tracking');
const invitePool = require('../src/invitePool');
const { TelegramApi } = require('../src/platform/telegramApi');

// chat_member по умолчанию НЕ приходит — ни в вебхук, ни в getUpdates. Требуется явный список.
const ALLOWED = ['chat_member', 'my_chat_member', 'chat_join_request', 'message'];

function log(msg, extra) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), msg }, extra || {})));
}

function api() {
  if (!cfg.telegram.token) {
    console.error('TELEGRAM_BOT_TOKEN не задан. Заполните .env и повторите.');
    process.exit(1);
  }
  return new TelegramApi({ token: cfg.telegram.token, mode: 'real' });
}

function openDb() {
  return open(dbFile());
}

async function check() {
  const tg = api();
  const me = await tg.getMe();
  console.log('\nБОТ');
  console.log('  username:      @' + me.result.username);
  console.log('  имя:           ' + me.result.first_name);
  console.log('  id:            ' + me.result.id);

  const hook = await tg.call('getWebhookInfo', {});
  console.log('\nТРАНСПОРТ');
  console.log('  webhook:       ' + (hook.result.url ? hook.result.url : 'не установлен → доступен polling'));
  console.log('  в очереди:     ' + hook.result.pending_update_count);
  if (hook.result.last_error_message) console.log('  ошибка:        ' + hook.result.last_error_message);
  const allowed = hook.result.allowed_updates;
  console.log('  chat_member:   ' + (hook.result.url
    ? (allowed && allowed.includes('chat_member') ? 'включён' : 'НЕ включён — подписки не придут')
    : 'будет запрошен явно при polling'));

  const db = openDb();
  const channels = all(db, 'SELECT * FROM channels WHERE platform = \'telegram\'');
  console.log('\nКАНАЛЫ В БАЗЕ: ' + channels.length);
  for (const ch of channels) {
    const links = one(db, 'SELECT COUNT(*) c FROM tracking_links WHERE channel_id = ?', ch.id).c;
    const pool = one(db, 'SELECT COUNT(*) c FROM invite_links WHERE channel_id = ? AND status = \'free\'', ch.id).c;
    const subs = one(db, 'SELECT COUNT(*) c FROM subscriptions WHERE channel_id = ?', ch.id).c;
    console.log('  ' + (ch.title || ch.external_chat_id) + ' | id ' + ch.external_chat_id +
      ' | статус ' + ch.status + ' | ссылок ' + links + ' | свободных приглашений ' + pool + ' | подписок ' + subs);

    if (ch.status === 'connected') {
      try {
        const info = await tg.getChat(ch.external_chat_id);
        const count = await tg.getChatMemberCount(ch.external_chat_id);
        console.log('    Telegram подтверждает: «' + (info.result.title || '') + '», участников ' + count.result);
      } catch (e) {
        console.log('    Telegram отвечает ошибкой: ' + e.message);
      }
    }
  }

  console.log('\nЧТО НУЖНО ДЛЯ ЖИВОГО ТЕСТА');
  console.log('  1. Создать канал в Telegram (можно приватный).');
  console.log('  2. Добавить @' + me.result.username + ' администратором с правом «Пригласительные ссылки».');
  console.log('  3. Запустить: node tools/telegram-live.js poll');
  console.log('     Бот пришлёт добавившему ссылку для привязки канала к кабинету.\n');
}

async function deleteWebhook() {
  const tg = api();
  const res = await tg.call('deleteWebhook', { drop_pending_updates: false });
  log('webhook удалён', { ok: res.result === true });
}

async function setWebhook() {
  if (!cfg.appUrl.startsWith('https://')) {
    console.error('APP_URL должен быть https — Telegram не принимает вебхук по http. Сейчас: ' + cfg.appUrl);
    process.exit(1);
  }
  if (!cfg.telegram.webhookSecret) {
    console.error('TELEGRAM_WEBHOOK_SECRET пуст. Без него боевой приём событий закрыт.');
    process.exit(1);
  }
  const tg = api();
  const url = cfg.appUrl + '/webhook/telegram';
  const res = await tg.call('setWebhook', {
    url, secret_token: cfg.telegram.webhookSecret, allowed_updates: ALLOWED, drop_pending_updates: false
  });
  log('webhook установлен', { url, ok: res.result === true, allowed_updates: ALLOWED });
}

function describe(update) {
  if (update.my_chat_member) {
    const cm = update.my_chat_member;
    return 'my_chat_member: бот в «' + (cm.chat.title || cm.chat.id) + '» стал ' +
      (cm.new_chat_member && cm.new_chat_member.status);
  }
  if (update.chat_member) {
    const cm = update.chat_member;
    const from = cm.old_chat_member && cm.old_chat_member.status;
    const to = cm.new_chat_member && cm.new_chat_member.status;
    const user = cm.new_chat_member && cm.new_chat_member.user;
    return 'chat_member: ' + (user ? (user.username ? '@' + user.username : 'id ' + user.id) : '?') +
      ' ' + from + ' → ' + to + (cm.invite_link ? ' по ссылке ' + cm.invite_link.invite_link : ' без ссылки');
  }
  if (update.chat_join_request) return 'chat_join_request';
  if (update.message) return 'message: ' + String(update.message.text || '').slice(0, 40);
  return Object.keys(update).filter((k) => k !== 'update_id').join(',');
}

async function poll(options) {
  const tg = api();
  const db = openDb();
  const me = await tg.getMe();
  const botName = me.result.username;

  const hook = await tg.call('getWebhookInfo', {});
  if (hook.result.url) {
    console.error('Установлен вебхук ' + hook.result.url + ' — polling работать не будет.');
    console.error('Снимите его: node tools/telegram-live.js delete-webhook');
    process.exit(1);
  }

  console.log('Слушаю реальные события Telegram для @' + botName + '. Ctrl+C — остановить.');
  console.log('Типы обновлений: ' + ALLOWED.join(', ') + '\n');

  let offset = 0;
  let stop = false;
  process.on('SIGINT', () => { stop = true; console.log('\nОстанавливаюсь…'); });

  while (!stop) {
    let res;
    try {
      res = await tg.call('getUpdates', { offset, timeout: 25, allowed_updates: ALLOWED });
    } catch (e) {
      log('ошибка getUpdates', { error: e.message });
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const update of res.result) {
      offset = update.update_id + 1;
      console.log('← ' + describe(update));

      const accepted = ingest.accept(db, {
        platform: 'telegram', bodyRaw: JSON.stringify(update), transport: 'polling', botName
      });

      let outbound = accepted.outbound || [];
      if (accepted.command) {
        try {
          outbound = outbound.concat(await onboarding.command(db, tg, {
            text: accepted.command.text, userId: accepted.command.userId, appUrl: cfg.appUrl
          }));
        } catch (e) {
          console.log('  → команда не обработана: ' + e.message);
        }
      }

      for (const m of outbound) {
        try {
          await tg.sendMessage(m.chatId, m.text);
          console.log('  → отправлено сообщение пользователю ' + m.chatId);
        } catch (e) {
          console.log('  → не удалось написать пользователю ' + m.chatId + ': ' + e.message +
            (String(e.message).includes('403') ? ' (он не начинал диалог с ботом)' : ''));
        }
      }
      const r = accepted.result;
      if (accepted.duplicate) console.log('  дубль, уже обработано');
      else if (r && r.failed) console.log('  ОШИБКА обработки: ' + r.error);
      else if (r && r.domain) {
        console.log('  → ' + r.domain.action + (r.domain.reason ? ' (' + r.domain.reason + ')' : ''));
        if (r.attribution) {
          console.log('  → атрибуция: ' + r.attribution.type +
            (r.attribution.confidence != null ? ', уверенность ' + r.attribution.confidence : '') +
            (r.attribution.click_id ? ', клик ' + r.attribution.click_id : ''));
        }
        if (accepted.conversions.length) console.log('  → конверсий в очередь: ' + accepted.conversions.length);
      }
    }
  }
}

/** Создание боевой ссылки из консоли: нужна для теста, пока кабинет открыт не у всех. */
async function makeLink(args) {
  const db = openDb();
  const tg = api();
  const externalId = args.channel;
  const ch = one(db, 'SELECT * FROM channels WHERE platform = \'telegram\' AND external_chat_id = ?', String(externalId));
  if (!ch) { console.error('Канал ' + externalId + ' не подключён. Сначала poll --auto-connect.'); process.exit(1); }

  const slug = args.slug || require('crypto').randomBytes(5).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 7);
  const link = tracking.createLink(db, {
    workspaceId: ch.workspace_id, channelId: ch.id, slug,
    source: args.source || 'test', campaign: args.campaign || null, creative: args.creative || null,
    redirectMode: 'invite', platformTarget: 'telegram'
  });
  const pool = await invitePool.refill(db, { channel: ch, link, api: tg, size: parseInt(args.pool || '5', 10) });
  if (pool.error) { console.error('Не удалось создать ни одной пригласительной ссылки: ' + pool.error); process.exit(1); }

  console.log('Ссылка создана:');
  console.log('  ' + cfg.appUrl + '/c/' + slug);
  console.log('  для Яндекс Директа добавьте в объявление ?yclid={yclid}; VK дописывает rb_clickid сам');
  console.log('  источник: ' + (args.source || 'test') + ' | кампания: ' + (args.campaign || '—') +
    ' | креатив: ' + (args.creative || '—'));
  console.log('  пригласительных ссылок в пуле: ' + pool.created.length + ' из ' + pool.requested +
    (pool.failed ? ' (не далось ' + pool.failed + ' — сеть до Telegram нестабильна, добьём фоном)' : ''));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(argv[i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'check';
  if (cmd === 'check') return check();
  if (cmd === 'poll') return poll({});
  if (cmd === 'set-webhook') return setWebhook();
  if (cmd === 'delete-webhook') return deleteWebhook();
  if (cmd === 'make-link') return makeLink(args);
  console.error('Команды: check | poll [--auto-connect] | set-webhook | delete-webhook | make-link');
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => { console.error('Ошибка: ' + e.message); process.exit(1); });
}
module.exports = { ALLOWED, describe };
