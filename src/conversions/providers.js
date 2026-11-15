'use strict';

/**
 * Провайдеры выгрузки конверсий.
 *
 * Честно про Яндекс: отдельного приёмника офлайн-конверсий у Директа нет — Директ обучается
 * на целях Яндекс Метрики. Поэтому оба провайдера физически льют в Метрику, но у них разные
 * счётчик и цель, разные настройки и разный смысл в интерфейсе. Придумывать несуществующий
 * API Директа мы не будем.
 *
 * Каждый ответ несёт mode: real | mock. Mock никогда не выдаётся за настоящую отправку.
 */

const METRIKA_BASE = 'https://api-metrika.yandex.net';
const VK_TRACKER_BASE = 'https://top-fwz1.mail.ru';

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Формат Метрики: Yclid,Target,DateTime,Price,Currency; DateTime — unix-секунды. */
function buildCsv(rows) {
  const head = 'Yclid,Target,DateTime,Price,Currency';
  const body = rows.map((r) =>
    [csvEscape(r.yclid), csvEscape(r.target), Math.floor(r.tsUtc / 1000), csvEscape(r.price || 0), csvEscape(r.currency || 'RUB')].join(',')
  );
  return [head].concat(body).join('\n');
}

class YandexMetrikaProvider {
  constructor({ token, counterId, goal, mode, fetchImpl, base } = {}) {
    this.name = 'yandex_metrika';
    this.token = token || '';
    this.counterId = counterId || '';
    this.goal = goal || 'tg_subscription';
    this.mode = mode || (token && counterId ? 'real' : 'mock');
    this.fetch = fetchImpl || globalThis.fetch;
    this.base = base || METRIKA_BASE;
  }

  /**
   * Метрика связывает офлайн-конверсию с рекламой по yclid, и принимает его только числом —
   * проверено на живом API: строковое значение даёт 400 invalid_uploading.
   */
  supports(item) {
    return !!(item && item.yclid && /^\d+$/.test(String(item.yclid)));
  }

  skipReason(item) {
    if (!item || !item.yclid) return 'в клике нет yclid: Метрика не свяжет конверсию с рекламой';
    return 'yclid «' + String(item.yclid).slice(0, 40) + '» не число: Метрика такие не принимает';
  }

  async send(batch) {
    const rows = batch.map((b) => ({ yclid: b.yclid, target: this.goal, tsUtc: b.tsUtc, price: b.price, currency: b.currency }));
    const csv = buildCsv(rows);

    if (this.mode === 'mock') {
      return { mode: 'mock', ok: true, externalId: 'mock-upload-' + Date.now(), sent: rows.length, csv };
    }
    if (!this.token || !this.counterId) throw new Error('Не заданы токен или номер счётчика Метрики');

    const url = this.base + '/management/v1/counter/' + encodeURIComponent(this.counterId) +
      '/offline_conversions/upload?client_id_type=YCLID';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'conversions.csv');

    const res = await this.fetch(url, {
      method: 'POST',
      headers: { Authorization: 'OAuth ' + this.token },
      body: form
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    if (!res.ok) {
      const err = new Error('Метрика ответила ' + res.status + ': ' + text.slice(0, 300));
      // 5xx и 429 — временные, всё остальное повторять бессмысленно
      err.retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
    return {
      mode: 'real',
      ok: true,
      externalId: body.uploading && body.uploading.id ? String(body.uploading.id) : null,
      sent: rows.length
    };
  }
}

/** Директ: та же загрузка, но своя цель и свой счётчик. Отличается настройкой, не транспортом. */
class YandexDirectProvider extends YandexMetrikaProvider {
  constructor(opts) {
    super(opts);
    this.name = 'yandex_direct';
    this.goal = (opts && opts.goal) || 'direct_subscription';
  }
}

/**
 * VK Реклама.
 *
 * Пиксель VK живёт в браузере, а подписка происходит внутри Telegram — поэтому событие
 * отправляется с сервера в тот же приёмник, что и пиксельные: top-fwz1.mail.ru/tracker.
 * Связка «клик → подписка» идёт по rb_clickid: VK сам дописывает его к адресу перехода,
 * мы сохраняем все параметры клика и возвращаем этот идентификатор вместе с событием.
 *
 * Формат запроса нестандартный: параметры разделяются точкой с запятой, не амперсандом.
 * Авторизация не требуется, ответ — прозрачный пиксель 1×1.
 */
class VkAdsProvider {
  constructor({ pixelId, goal, mode, fetchImpl, base } = {}) {
    this.name = 'vk_ads';
    this.pixelId = pixelId || '';
    this.goal = goal || 'tg_subscription';
    this.mode = mode || (pixelId ? 'real' : 'mock');
    this.fetch = fetchImpl || globalThis.fetch;
    this.base = base || VK_TRACKER_BASE;
  }

  supports(item) {
    return !!(item && item.rbClickId);
  }

  skipReason() {
    return 'в клике нет rb_clickid: VK не свяжет подписку с объявлением';
  }

  /** VK принимает события по одному, поэтому отправляем последовательно и считаем доставленные. */
  async send(batch) {
    if (!this.pixelId && this.mode !== 'mock') throw new Error('Не задан идентификатор пикселя VK');

    const urls = batch.map((item) => this.buildUrl(item));
    if (this.mode === 'mock') {
      return { mode: 'mock', ok: true, externalId: null, sent: urls.length, urls };
    }

    let sent = 0;
    for (const url of urls) {
      const res = await this.fetch(url, { method: 'GET', redirect: 'manual' });
      // Трекер отвечает прозрачным пикселем; тело нам не нужно, важен только код
      if (res.status >= 400) {
        const err = new Error('VK ответил ' + res.status + ' на ' + url.replace(/rb_clickid=[^;&]*/, 'rb_clickid=***'));
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      sent += 1;
    }
    return { mode: 'real', ok: true, externalId: null, sent };
  }

  buildUrl(item) {
    // Пример из документации: ?id=3523812;e=RG%3A/offline_purchase;rb_clickid=CLICKID
    const value = item.price ? String(item.price) : '';
    const event = 'RG%3A' + value + '/' + encodeURIComponent(this.goal);
    return this.base + '/tracker?id=' + encodeURIComponent(this.pixelId) +
      ';e=' + event +
      ';rb_clickid=' + encodeURIComponent(item.rbClickId);
  }
}

module.exports = { YandexMetrikaProvider, YandexDirectProvider, VkAdsProvider, buildCsv, METRIKA_BASE, VK_TRACKER_BASE };
