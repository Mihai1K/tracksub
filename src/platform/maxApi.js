'use strict';

/**
 * Клиент MAX Bot API.
 * FACT (docs/max-api-findings.md): база platform-api2.max.ru, токен в заголовке Authorization,
 * подписка на события через POST /subscriptions, вебхук только HTTPS/443 с сертификатом доверенного УЦ.
 * Режимы real/mock, как и в Telegram: mock всегда помечен.
 */

const crypto = require('crypto');

const BASE = 'https://platform-api2.max.ru';

class MaxApi {
  constructor({ token, mode, fetchImpl, base } = {}) {
    this.token = token || '';
    this.mode = mode || (token ? 'real' : 'mock');
    this.fetch = fetchImpl || globalThis.fetch;
    this.base = base || BASE;
  }

  async call(method, path, params) {
    if (this.mode === 'mock') return this.mock(path, params);
    if (!this.token) throw new Error('MAX_BOT_TOKEN не задан');
    const url = this.base + path;
    const res = await this.fetch(url, {
      method,
      headers: { Authorization: this.token, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(params || {})
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
    if (!res.ok) {
      const err = new Error('MAX API ' + path + ': ' + res.status + ' ' + (body.message || text.slice(0, 200)));
      err.code = res.status;
      throw err;
    }
    return { mode: 'real', result: body };
  }

  mock(path, params) {
    const seed = crypto.createHash('sha1').update(path + JSON.stringify(params || {})).digest('hex').slice(0, 10);
    if (path === '/me') {
      return { mode: 'mock', result: { user_id: 900100, name: 'Mock Tracker', username: 'mock_tracker' } };
    }
    if (path.startsWith('/subscriptions')) {
      return { mode: 'mock', result: { success: true, subscriptions: [{ url: (params && params.url) || 'https://example/mock', time: Date.now() }] } };
    }
    if (path.startsWith('/chats')) {
      return { mode: 'mock', result: { chat_id: 'mock_' + seed, title: 'Mock MAX channel', type: 'channel', participants_count: 17 } };
    }
    return { mode: 'mock', result: {} };
  }

  getMe() { return this.call('GET', '/me'); }
  getChat(chatId) { return this.call('GET', '/chats/' + encodeURIComponent(chatId)); }
  listChats() { return this.call('POST', '/subscriptions', {}); }

  /** Подписка на события. Набор типов — ASSUMPTION до эксперимента, см. gate-1-experiment.md. */
  subscribe(url, secret, updateTypes) {
    return this.call('POST', '/subscriptions', {
      url,
      secret,
      update_types: updateTypes && updateTypes.length ? updateTypes : undefined
    });
  }
}

module.exports = { MaxApi, BASE };
