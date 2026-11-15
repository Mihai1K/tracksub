'use strict';

/**
 * Клиент Telegram Bot API.
 * Режимы: real (реальные вызовы) и mock (детерминированные ответы для разработки и тестов).
 * Ответ ВСЕГДА несёт поле mode — чтобы никто и нигде не принял mock за реальную интеграцию.
 */

const crypto = require('crypto');

const CALL_RETRIES = 3;
const RETRY_PAUSE_MS = 600;
const BASE = 'https://api.telegram.org';

class TelegramApi {
  constructor({ token, mode, fetchImpl, base } = {}) {
    this.token = token || '';
    this.mode = mode || (token ? 'real' : 'mock');
    this.fetch = fetchImpl || globalThis.fetch;
    this.base = base || BASE;
  }

  /**
   * Повторяем только обрывы связи, не ответы самого Telegram.
   *
   * Доступ к api.telegram.org из России нестабилен: одиночный сбой соединения
   * съедал ответ бота целиком — человек нажимал команду и видел тишину.
   * Ошибку самого API (неверный чат, нет прав) повторять бессмысленно и вредно.
   */
  async call(method, params) {
    if (this.mode === 'mock') return this.mock(method, params);
    if (!this.token) throw new Error('TELEGRAM_BOT_TOKEN не задан');

    let lastNetworkError = null;
    for (let attempt = 0; attempt < CALL_RETRIES; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * attempt));
      let res;
      try {
        res = await this.fetch(this.base + '/bot' + this.token + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params || {})
        });
      } catch (e) {
        lastNetworkError = e;
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const err = new Error('Telegram API ' + method + ': ' + (body.description || res.status));
        err.code = body.error_code || res.status;
        err.retryAfter = body.parameters && body.parameters.retry_after;
        throw err;
      }
      return { mode: 'real', result: body.result };
    }
    throw lastNetworkError;
  }

  mock(method, params) {
    const seed = crypto.createHash('sha1').update(method + JSON.stringify(params || {})).digest('hex').slice(0, 12);
    if (method === 'getMe') {
      return { mode: 'mock', result: { id: 100200300, is_bot: true, username: 'mock_tracker_bot', first_name: 'Mock' } };
    }
    if (method === 'createChatInviteLink') {
      return {
        mode: 'mock',
        result: {
          invite_link: 'https://t.me/+mock' + seed,
          name: (params && params.name) || null,
          creator: { id: 100200300, is_bot: true },
          member_limit: params && params.member_limit,
          expire_date: params && params.expire_date,
          creates_join_request: false,
          is_primary: false,
          is_revoked: false
        }
      };
    }
    if (method === 'getChat') {
      return {
        mode: 'mock',
        result: { id: (params && params.chat_id) || -100, title: 'Mock channel', type: 'channel', username: 'mock_channel' }
      };
    }
    if (method === 'sendMessage') {
      return { mode: 'mock', result: { message_id: 1, chat: { id: params && params.chat_id }, text: params && params.text } };
    }
    if (method === 'setWebhook' || method === 'deleteWebhook') return { mode: 'mock', result: true };
    if (method === 'getChatMemberCount') return { mode: 'mock', result: 42 };
    // Нейтральный ответ: в mock-режиме мы не знаем, кто чем управляет,
    // и не должны случайно выдать человеку чужой канал.
    if (method === 'getChatMember') return { mode: 'mock', result: { status: 'member' } };
    return { mode: 'mock', result: {} };
  }

  getMe() { return this.call('getMe', {}); }
  getChat(chatId) { return this.call('getChat', { chat_id: chatId }); }
  getChatMemberCount(chatId) { return this.call('getChatMemberCount', { chat_id: chatId }); }
  getChatMember(chatId, userId) { return this.call('getChatMember', { chat_id: chatId, user_id: userId }); }

  /**
   * Уникальная ссылка на клик.
   *
   * member_limit = 1 обязателен: без него ссылка многоразовая и бессрочная. На живом тесте
   * человек вступил повторно по старой ссылке, и подписка ушла к прежнему клику вместо свежего.
   * На реальном трафике то же самое произойдёт при пересылке ссылки: десяток людей припишется
   * одному клику. Цена решения — переслать ссылку другому человеку больше нельзя, второй
   * не вступит. Для рекламной атрибуции это правильный компромисс: мы платим за конкретный переход.
   *
   * expire_date не даёт копиться неиспользованным ссылкам: у чата есть предел числа активных.
   */
  createChatInviteLink(chatId, name, opts) {
    const o = opts || {};
    return this.call('createChatInviteLink', {
      chat_id: chatId,
      name: String(name || '').slice(0, 32),
      member_limit: o.memberLimit == null ? 1 : o.memberLimit,
      expire_date: o.expireDate == null
        ? Math.floor(Date.now() / 1000) + 7 * 24 * 3600
        : o.expireDate
    });
  }

  /** Личное сообщение пользователю. Работает только если он сам начал диалог с ботом. */
  sendMessage(chatId, text, opts) {
    return this.call('sendMessage', Object.assign({
      chat_id: chatId, text: String(text), disable_web_page_preview: true
    }, opts || {}));
  }

  setWebhook(url, secret) {
    return this.call('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['chat_member', 'my_chat_member', 'chat_join_request', 'message'],
      drop_pending_updates: false
    });
  }
}

module.exports = { TelegramApi, BASE };
