'use strict';

/**
 * PlatformAdapter для Telegram.
 *
 * Отличие от MAX, определяющее продукт: в Telegram событие вступления НЕСЁТ ссылку,
 * по которой человек пришёл (ChatMemberUpdated.invite_link). Поэтому при выдаче каждому
 * клику собственной пригласительной ссылки атрибуция получается детерминированной
 * без бота-прокладки и без потери конверсии.
 *
 * Время в Telegram — секунды, в MAX — миллисекунды. Нормализуем в миллисекунды.
 */

const crypto = require('crypto');

const PLATFORM = 'telegram';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const JOINED = new Set(['member', 'administrator', 'creator']);
const GONE = new Set(['left', 'kicked']);

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

function verify(headers, expectedSecret) {
  if (!expectedSecret) return { ok: true, reason: 'secret_not_configured' };
  const lower = {};
  for (const k of Object.keys(headers || {})) lower[k.toLowerCase()] = headers[k];
  const got = lower[SECRET_HEADER];
  if (!got) return { ok: false, reason: 'secret_missing' };
  if (!timingSafeEqual(got, expectedSecret)) return { ok: false, reason: 'secret_mismatch' };
  return { ok: true };
}

/**
 * update_id уникален в пределах бота и монотонно растёт — это и есть готовый ключ идемпотентности.
 * Общий синтетический ключ из ids.js для Telegram НЕ подходит: он собирается из полей плоской
 * структуры MAX (update_type, chat_id, user.user_id, timestamp), которых у Telegram нет,
 * и потому схлопывает все события бота в одно. Проверено на живом трафике.
 */
function idempotencyKey(update) {
  if (!update || update.update_id == null) return null;
  return 'telegram:' + update.update_id;
}

function memberStatus(member) {
  if (!member) return null;
  if (member.status === 'restricted') return member.is_member ? 'member' : 'left';
  return member.status;
}

function parse(update) {
  if (!update || typeof update !== 'object') throw new ValidationError('update is not an object');
  if (update.update_id == null) throw new ValidationError('missing field: update_id');

  const base = {
    platform: PLATFORM,
    externalChatId: null,
    externalUserId: null,
    tsUtc: null,
    payload: null,
    inviterId: null,
    adminId: null,
    isChannel: null,
    inviteLink: null,
    extra: { update_id: update.update_id }
  };

  if (update.chat_member || update.my_chat_member) {
    const cm = update.chat_member || update.my_chat_member;
    if (!cm.chat || cm.chat.id == null) throw new ValidationError('missing field: chat.id');
    if (!cm.from || cm.from.id == null) throw new ValidationError('missing field: from.id');
    if (typeof cm.date !== 'number') throw new ValidationError('missing or invalid field: date');

    const target = cm.new_chat_member && cm.new_chat_member.user ? cm.new_chat_member.user : cm.from;
    const before = memberStatus(cm.old_chat_member);
    const after = memberStatus(cm.new_chat_member);

    Object.assign(base, {
      externalChatId: String(cm.chat.id),
      externalUserId: String(target.id),
      tsUtc: cm.date * 1000, // FACT: Telegram отдаёт секунды
      isChannel: cm.chat.type === 'channel' || cm.chat.type === 'supergroup',
      inviteLink: cm.invite_link && cm.invite_link.invite_link ? String(cm.invite_link.invite_link) : null,
      inviterId: cm.from && cm.from.id != null ? String(cm.from.id) : null,
      extra: {
        update_id: update.update_id,
        chat_type: cm.chat.type,
        old_status: before,
        new_status: after,
        invite_link_name: cm.invite_link && cm.invite_link.name ? cm.invite_link.name : null
      }
    });

    if (update.my_chat_member) {
      // изменился статус самого бота — это не подписка пользователя
      return Object.assign(base, { kind: 'bot_membership' });
    }
    if ((before === null || GONE.has(before)) && JOINED.has(after)) {
      return Object.assign(base, { kind: 'subscribe' });
    }
    if (JOINED.has(before) && GONE.has(after)) {
      // kicked = удалён администратором, left = ушёл сам
      return Object.assign(base, {
        kind: 'unsubscribe',
        adminId: after === 'kicked' ? (cm.from && cm.from.id != null ? String(cm.from.id) : 'unknown') : null
      });
    }
    return Object.assign(base, { kind: 'other' });
  }

  if (update.chat_join_request) {
    const r = update.chat_join_request;
    if (!r.chat || !r.from || typeof r.date !== 'number') throw new ValidationError('invalid chat_join_request');
    return Object.assign(base, {
      kind: 'join_request',
      externalChatId: String(r.chat.id),
      externalUserId: String(r.from.id),
      tsUtc: r.date * 1000,
      isChannel: true,
      inviteLink: r.invite_link && r.invite_link.invite_link ? String(r.invite_link.invite_link) : null
    });
  }

  if (update.message && update.message.text && String(update.message.text).startsWith('/start')) {
    const m = update.message;
    const payload = String(m.text).slice(6).trim() || null;
    return Object.assign(base, {
      kind: 'bot_start',
      externalChatId: m.chat && m.chat.id != null ? String(m.chat.id) : null,
      externalUserId: m.from && m.from.id != null ? String(m.from.id) : null,
      tsUtc: (m.date || Math.floor(Date.now() / 1000)) * 1000,
      payload
    });
  }

  return Object.assign(base, {
    kind: 'other',
    tsUtc: Date.now(),
    externalChatId: null,
    externalUserId: null
  });
}

module.exports = { PLATFORM, SECRET_HEADER, verify, parse, idempotencyKey, ValidationError, JOINED, GONE };
