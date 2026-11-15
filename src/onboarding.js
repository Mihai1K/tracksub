'use strict';

/**
 * Подключение канала чужим админом.
 *
 * Продукт мультитенантный: бота добавляет к себе любой владелец канала. Значит канал нельзя
 * молча привязывать к какому-то существующему проекту — иначе чужие подписчики окажутся
 * в чужом кабинете. Канал сначала попадает в системный проект «Неподключённые» и ждёт,
 * пока его заберёт тот, кто добавил бота, по одноразовой ссылке.
 */

const crypto = require('crypto');
const { id } = require('./ids');
const { one, all, run } = require('./db');

const SYSTEM_WS_NAME = 'Неподключённые каналы';

function systemWorkspace(db) {
  let ws = one(db, 'SELECT * FROM workspaces WHERE is_system = 1');
  if (ws) return ws;
  const wsId = id('ws');
  run(db, 'INSERT INTO workspaces (id, name, timezone, attribution_window_hours, created_at, is_system, plan) ' +
    'VALUES (?, ?, \'UTC\', 72, ?, 1, \'free\')', wsId, SYSTEM_WS_NAME, Date.now());
  return one(db, 'SELECT * FROM workspaces WHERE id = ?', wsId);
}

/** Бота сделали администратором канала. Возвращает канал и сообщение, которое надо отправить. */
function botBecameAdmin(db, { platform, externalChatId, title, username, addedByTelegramId, botName, appUrl }) {
  const existing = one(db, 'SELECT * FROM channels WHERE platform = ? AND external_chat_id = ?', platform, String(externalChatId));

  if (existing && existing.claimed_at) {
    run(db, 'UPDATE channels SET status = \'connected\', bot_name = ?, bot_status = \'administrator\', ' +
      'title = COALESCE(NULLIF(?, \'\'), title) WHERE id = ?', botName || null, title || '', existing.id);
    return { channel: one(db, 'SELECT * FROM channels WHERE id = ?', existing.id), claimed: true, message: null };
  }

  const token = crypto.randomBytes(18).toString('base64url');
  const sys = systemWorkspace(db);
  let channelId;

  if (existing) {
    channelId = existing.id;
    // Непривязанный канал переезжает в системный проект. Иначе его мог бы занять любой,
    // кто просто ввёл ID канала в форму: ряд остался бы в его кабинете и показывал
    // чужую статистику до тех пор, пока настоящий админ не откроет ссылку привязки.
    run(db, 'UPDATE channels SET workspace_id = ?, status = \'unclaimed\', claim_token = ?, added_by_telegram_id = ?, ' +
      'bot_name = ?, bot_status = \'administrator\', title = COALESCE(NULLIF(?, \'\'), title), ' +
      'channel_url = COALESCE(?, channel_url) WHERE id = ?',
      sys.id, token, String(addedByTelegramId || ''), botName || null, title || '',
      username ? 'https://t.me/' + username : null, channelId);
  } else {
    channelId = id('ch');
    run(db, 'INSERT INTO channels (id, workspace_id, platform, external_chat_id, title, username, status, ' +
      'bot_name, bot_status, channel_url, claim_token, added_by_telegram_id, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, \'unclaimed\', ?, \'administrator\', ?, ?, ?, ?)',
      channelId, sys.id, platform, String(externalChatId), title || 'Канал', username || null,
      botName || null, username ? 'https://t.me/' + username : null, token, String(addedByTelegramId || ''), Date.now());
  }

  const channel = one(db, 'SELECT * FROM channels WHERE id = ?', channelId);
  const link = (appUrl || '') + '/claim/' + token;
  const message = 'Канал «' + (channel.title || '') + '» подключён к «Откуда трафик».\n\n' +
    'Осталось привязать его к вашему кабинету — по этой ссылке:\n' + link + '\n\n' +
    'Ссылка одноразовая и только для вас. Пока канал не привязан, статистика по нему не собирается.';

  return { channel, claimed: false, message, claimTo: addedByTelegramId ? String(addedByTelegramId) : null };
}

/** Забрать канал в свой проект. */
function claim(db, token, workspaceId) {
  if (!token) return { ok: false, error: 'Ссылка недействительна' };
  const channel = one(db, 'SELECT * FROM channels WHERE claim_token = ?', token);
  if (!channel) return { ok: false, error: 'Ссылка недействительна или канал уже привязан' };
  if (channel.claimed_at) return { ok: false, error: 'Канал уже привязан к кабинету' };

  run(db, 'UPDATE channels SET workspace_id = ?, status = \'connected\', claim_token = NULL, claimed_at = ? WHERE id = ?',
    workspaceId, Date.now(), channel.id);
  return { ok: true, channel: one(db, 'SELECT * FROM channels WHERE id = ?', channel.id) };
}

/** Неподключённые каналы, которые добавил этот телеграм-пользователь. */
function pendingFor(db, telegramUserId) {
  return all(db, 'SELECT * FROM channels WHERE added_by_telegram_id = ? AND claimed_at IS NULL AND claim_token IS NOT NULL',
    String(telegramUserId));
}

/**
 * Каналы, ждущие привязки, которыми этот человек действительно управляет.
 *
 * По полю «кто добавил бота» ориентироваться нельзя: в каналах администраторы часто
 * действуют анонимно, и Telegram кладёт в `from` не человека, а служебный идентификатор.
 * Из-за этого ссылка привязки уходила в никуда, а на /start человек не видел свой канал.
 * Поэтому право на канал спрашиваем у самой платформы.
 */
async function pendingForUser(db, api, telegramUserId) {
  const waiting = all(db,
    'SELECT * FROM channels WHERE claimed_at IS NULL AND claim_token IS NOT NULL ORDER BY created_at DESC LIMIT 50');
  const mine = [];
  for (const ch of waiting) {
    if (String(ch.added_by_telegram_id || '') === String(telegramUserId)) { mine.push(ch); continue; }
    if (ch.platform !== 'telegram' || !api) continue;
    try {
      const r = await api.getChatMember(ch.external_chat_id, telegramUserId);
      const status = r && r.result && r.result.status;
      if (status === 'creator' || status === 'administrator') mine.push(ch);
    } catch (e) {
      // Бота выгнали, канал удалён или ID устарел — такой канал просто не предлагаем.
    }
  }
  return mine;
}

/** Сводка по каналам, которыми управляет человек: что подключено и что происходит. */
async function statusFor(db, api, telegramUserId) {
  const connected = all(db,
    'SELECT * FROM channels WHERE claimed_at IS NOT NULL ORDER BY created_at DESC LIMIT 50');
  const lines = [];
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const ch of connected) {
    if (ch.platform !== 'telegram' || !api) continue;
    let status = null;
    try {
      const r = await api.getChatMember(ch.external_chat_id, telegramUserId);
      status = r && r.result && r.result.status;
    } catch (e) { continue; }
    if (status !== 'creator' && status !== 'administrator') continue;
    const subs = one(db, 'SELECT COUNT(*) c FROM subscriptions WHERE channel_id = ? AND ts_utc >= ?', ch.id, dayAgo).c;
    const un = one(db, 'SELECT COUNT(*) c FROM unsubscriptions WHERE channel_id = ? AND ts_utc >= ?', ch.id, dayAgo).c;
    lines.push('• ' + (ch.title || ch.external_chat_id) + '\n  за сутки: +' + subs + ' / −' + un);
  }
  return lines;
}

const HELP =
  'Что я умею:\n\n' +
  '/start — приветствие и каналы, ждущие привязки\n' +
  '/status — что происходит с вашими каналами за сутки\n' +
  '/help — эта справка\n\n' +
  'Всё остальное — в кабинете: ссылки, источники, стоимость подписчика, отчёты.';

/**
 * Ответ бота на команду в личке. Команды живут здесь, а не в приёме событий:
 * ответ зависит от обращений к Telegram, а приём события обязан оставаться быстрым.
 */
async function command(db, api, { text, userId, appUrl }) {
  const cmd = String(text || '').trim().split(/[\s@]/)[0].toLowerCase();
  const link = (ch) => (appUrl || '') + '/claim/' + ch.claim_token;

  if (cmd === '/start') {
    // /start cos_<код> - привязка контент-сводки (Content OS) из профиля автора.
    const linked = require('./content/notify').handleStart(db, { text, telegramUserId: userId });
    if (linked) return [{ chatId: String(userId), text: linked }];
    let out = WELCOME;
    const pending = await pendingForUser(db, api, userId);
    if (pending.length) {
      out += '\n\nЖдут привязки:\n' + pending
        .map((ch) => '• ' + (ch.title || ch.external_chat_id) + '\n  ' + link(ch)).join('\n');
    }
    return [{ chatId: String(userId), text: out }];
  }

  if (cmd === '/help') return [{ chatId: String(userId), text: HELP }];

  if (cmd === '/status') {
    const pending = await pendingForUser(db, api, userId);
    const lines = await statusFor(db, api, userId);
    let out = '';
    if (lines.length) out += 'Ваши каналы:\n' + lines.join('\n');
    else out += 'Подключённых каналов за вами пока не числится.';
    if (pending.length) {
      out += '\n\nЖдут привязки:\n' + pending
        .map((ch) => '• ' + (ch.title || ch.external_chat_id) + '\n  ' + link(ch)).join('\n');
    }
    if (appUrl) out += '\n\nПодробности в кабинете: ' + appUrl + '/app';
    return [{ chatId: String(userId), text: out }];
  }

  // Неизвестная команда: молчание выглядит как зависший бот.
  if (cmd.startsWith('/')) {
    return [{ chatId: String(userId), text: 'Такой команды я не знаю. Что умею — /help' }];
  }
  return [];
}

const WELCOME =
  'Привет! Я «Откуда трафик» — аналитика подписок в Telegram и MAX.\n\n' +
  'Показываю:\n' +
  '• откуда приходят подписчики\n' +
  '• какая реклама их приводит\n' +
  '• сколько стоит подписчик\n' +
  '• кто отписывается и как быстро\n' +
  '• какой источник даёт живую аудиторию, а какой — только цифры\n\n' +
  'Как начать:\n' +
  '1. Добавьте меня администратором в свой канал (нужно право «Пригласительные ссылки»).\n' +
  '2. Я пришлю ссылку, чтобы привязать канал к вашему кабинету.\n' +
  '3. Создайте tracking-ссылку и поставьте её в рекламу.';

module.exports = { botBecameAdmin, claim, pendingFor, pendingForUser, statusFor, command,
  systemWorkspace, WELCOME, HELP, SYSTEM_WS_NAME };
