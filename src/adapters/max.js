'use strict';

/**
 * PlatformAdapter для MAX. Единственное место в системе, которое знает слово "max".
 * Всё, что ниже по конвейеру, работает с платформенно-нейтральными событиями.
 *
 * Опора на факты из docs/max-api-findings.md:
 *  - timestamp приходит в миллисекундах;
 *  - user_added: inviter_id?, chat_id, user, is_channel — ссылки/payload/источника НЕТ;
 *  - user_removed: admin_id = null означает добровольный выход;
 *  - bot_started: chat_id, user, user_locale?, payload? — payload из диплинка ?start=;
 *  - секрет вебхука приходит в заголовке X-Max-Bot-Api-Secret.
 */

const crypto = require('crypto');

const PLATFORM = 'max';
const SECRET_HEADER = 'x-max-bot-api-secret';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Проверка подлинности входящего запроса. Пустой ожидаемый секрет = проверка выключена. */
function verify(headers, expectedSecret) {
  if (!expectedSecret) return { ok: true, reason: 'secret_not_configured' };
  const lower = {};
  for (const k of Object.keys(headers || {})) lower[k.toLowerCase()] = headers[k];
  const got = lower[SECRET_HEADER];
  if (!got) return { ok: false, reason: 'secret_missing' };
  if (!timingSafeEqual(got, expectedSecret)) return { ok: false, reason: 'secret_mismatch' };
  return { ok: true };
}

function requireField(obj, path, value) {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('missing field: ' + path);
  }
  return value;
}

/**
 * Сырое обновление MAX -> нормализованное событие.
 * Бросает ValidationError на структурно некорректных данных: событие не теряется,
 * а помечается failed и остаётся в сыром хранилище для повторного прогона.
 */
function parse(update) {
  if (!update || typeof update !== 'object') throw new ValidationError('update is not an object');
  const type = requireField(update, 'update_type', update.update_type);
  const ts = update.timestamp;
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) {
    throw new ValidationError('missing or invalid field: timestamp');
  }

  const base = {
    platform: PLATFORM,
    tsUtc: Math.round(ts), // FACT: миллисекунды
    externalChatId: update.chat_id != null ? String(update.chat_id) : null,
    externalUserId: update.user && update.user.user_id != null ? String(update.user.user_id) : null,
    payload: null,
    inviterId: null,
    adminId: null,
    isChannel: null,
    extra: {}
  };

  switch (type) {
    case 'user_added':
      requireField(update, 'chat_id', base.externalChatId);
      requireField(update, 'user.user_id', base.externalUserId);
      return Object.assign(base, {
        kind: 'subscribe',
        inviterId: update.inviter_id != null ? String(update.inviter_id) : null,
        isChannel: update.is_channel === true,
        extra: { name: update.user && update.user.name }
      });

    case 'user_removed':
      requireField(update, 'chat_id', base.externalChatId);
      requireField(update, 'user.user_id', base.externalUserId);
      return Object.assign(base, {
        kind: 'unsubscribe',
        // FACT: admin_id = null => пользователь ушёл сам
        adminId: update.admin_id != null ? String(update.admin_id) : null,
        isChannel: update.is_channel === true
      });

    case 'bot_started':
      requireField(update, 'user.user_id', base.externalUserId);
      return Object.assign(base, {
        kind: 'bot_start',
        payload: update.payload != null ? String(update.payload) : null,
        extra: { userLocale: update.user_locale || null }
      });

    default:
      // Остальные типы (message_created, bot_added, ...) сохраняем, но домену они не нужны.
      return Object.assign(base, { kind: 'other', extra: { update_type: type } });
  }
}

/**
 * У MAX нет собственного идентификатора события (UNKNOWN, docs/max-api-findings.md),
 * поэтому ключ синтетический — состав зафиксирован в attribution.md §11.
 */
function idempotencyKey(update) {
  return require('../ids').idempotencyKey(update);
}

module.exports = { PLATFORM, SECRET_HEADER, verify, parse, idempotencyKey, ValidationError };
