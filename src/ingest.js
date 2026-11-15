'use strict';

/**
 * Единая точка приёма события платформы. Вебхук и long polling обязаны вести себя одинаково,
 * поэтому оба ходят сюда: расхождение между транспортами — источник багов, которых потом не найти.
 */

const collector = require('./collector');
const pipeline = require('./pipeline');
const accounts = require('./accounts');
const dispatcher = require('./conversions/dispatcher');
const { one } = require('./db');
const onboarding = require('./onboarding');
const { cfg } = require('./config');

/**
 * @param {object} db
 * @param {{platform: string, bodyRaw: string, transport: string, headers?: object, now?: number}} input
 * @returns {{duplicate: boolean, rawId: string|null, result: object|null, conversions: string[]}}
 */
function accept(db, input) {
  const adapter = pipeline.ADAPTERS[input.platform];
  if (!adapter) throw new Error('неизвестная платформа: ' + input.platform);

  const ing = collector.ingest(db, {
    transport: input.transport || 'webhook',
    headers: input.headers || {},
    bodyRaw: input.bodyRaw,
    now: input.now,
    adapter,
    platform: input.platform
  });
  if (ing.duplicate) return { duplicate: true, rawId: ing.rawId, result: null, conversions: [], outbound: [], command: null };

  const result = pipeline.process(db, ing.rawId, adapter);
  const conversions = result && result.domain && result.domain.action === 'subscribe'
    ? enqueueForSubscription(db, result.domain.subscriptionId)
    : [];

  // Исходящие сообщения не отправляем здесь: приём события должен оставаться быстрым
  // и синхронным. Возвращаем их наверх — транспорт отправит.
  const side = sideEffects(db, input, result);

  return { duplicate: false, rawId: ing.rawId, result, conversions, outbound: side.messages, command: side.command };
}

/**
 * Реакции бота на события: приветствие на /start и ссылка для привязки канала,
 * когда бота сделали администратором.
 */
function sideEffects(db, input, result) {
  const out = { messages: [], command: null };
  if (input.platform !== 'telegram') return out;

  let update = null;
  try { update = JSON.parse(input.bodyRaw); } catch (e) { return out; }

  // Команды в личке отвечает onboarding.command: ответ требует обращений к Telegram,
  // а приём события должен оставаться быстрым и синхронным. Здесь только помечаем.
  const msg = update.message;
  if (msg && msg.chat && msg.chat.type === 'private' && String(msg.text || '').startsWith('/')) {
    out.command = { text: msg.text, userId: String(msg.from && msg.from.id) };
    return out;
  }

  // бота сделали администратором канала
  const cm = update.my_chat_member;
  if (cm && cm.chat && cm.new_chat_member && cm.new_chat_member.status === 'administrator' &&
      (cm.chat.type === 'channel' || cm.chat.type === 'supergroup')) {
    const res = onboarding.botBecameAdmin(db, {
      platform: 'telegram',
      externalChatId: cm.chat.id,
      title: cm.chat.title,
      username: cm.chat.username,
      addedByTelegramId: cm.from && cm.from.id,
      botName: input.botName || null,
      appUrl: cfg.appUrl
    });
    if (res.message && res.claimTo) out.messages.push({ chatId: res.claimTo, text: res.message });
  }
  return out;
}

/** Ставит конверсию в очередь, если тариф это позволяет и интеграция настроена. */
function enqueueForSubscription(db, subscriptionId) {
  const sub = one(db, 'SELECT * FROM subscriptions WHERE id = ?', subscriptionId);
  if (!sub) return [];
  const channel = one(db, 'SELECT * FROM channels WHERE id = ?', sub.channel_id);
  const ws = one(db, 'SELECT * FROM workspaces WHERE id = ?', channel.workspace_id);
  if (accounts.checkLimit(db, ws, 'conversions')) return [];

  const attr = one(db, 'SELECT * FROM attributions WHERE subscription_id = ? AND is_current = 1', sub.id);
  return dispatcher.enqueue(db, {
    workspaceId: ws.id,
    subscriptionId: sub.id,
    attributionId: attr ? attr.id : null,
    kind: sub.sequence === 'first' ? 'first_subscription' : 'subscription'
  });
}

module.exports = { accept, enqueueForSubscription, sideEffects };
