'use strict';

/**
 * Конвейер: сырое -> нормализованное -> домен -> атрибуция.
 * Каждый шаг идемпотентен, ошибка одного события не роняет остальные и не теряет данные.
 */

const collector = require('./collector');
const { normalize } = require('./normalize');
const domain = require('./domain');
const attribution = require('./attribution');
const maxAdapter = require('./adapters/max');
const telegramAdapter = require('./adapters/telegram');
const { one } = require('./db');

const ADAPTERS = { max: maxAdapter, telegram: telegramAdapter };

function handleIncoming(db, { transport, headers, bodyRaw, secret, now, platform }) {
  const adapter = ADAPTERS[platform || 'max'];
  const verified = adapter.verify(headers, secret);
  if (!verified.ok) return { status: 403, reason: verified.reason, stored: false };

  const ing = collector.ingest(db, { transport, headers, bodyRaw, now, adapter, platform: platform || 'max' });
  if (ing.duplicate) return { status: 200, duplicate: true, rawId: ing.rawId, stored: true };

  const result = process(db, ing.rawId, adapter);
  return Object.assign({ status: 200, duplicate: false, rawId: ing.rawId, stored: true }, result);
}

/**
 * Определяет платформу события по сохранённому полю, а при его отсутствии — по форме тела.
 * Событиям, записанным до появления колонки platform, иначе достался бы адаптер по умолчанию,
 * и повторная обработка ломала бы их. Найдено аудитом боевой версии.
 */
function adapterFor(raw, explicit) {
  if (explicit) return explicit;
  if (raw.platform && ADAPTERS[raw.platform]) return ADAPTERS[raw.platform];
  try {
    const body = JSON.parse(raw.body_raw);
    if (body && body.update_id != null) return ADAPTERS.telegram;
    if (body && body.update_type) return ADAPTERS.max;
  } catch (e) { /* тело не разбирается — решать нечему */ }
  return ADAPTERS.max;
}

/** Обработка одного сырого события. Безопасна для повторного вызова. */
function process(db, rawId, adapter) {
  const raw = one(db, 'SELECT * FROM webhook_events WHERE id = ?', rawId);
  if (!raw) return { error: 'raw event not found' };

  let event;
  try {
    const norm = normalize(db, raw, adapterFor(raw, adapter));
    event = norm.event;
  } catch (e) {
    collector.markFailed(db, rawId, e);
    return { normalized: false, error: String(e.message), failed: true };
  }

  let domainResult;
  try {
    domainResult = domain.apply(db, event);
  } catch (e) {
    collector.markFailed(db, rawId, e);
    return { normalized: true, eventId: event.id, error: String(e.message), failed: true };
  }

  let attr = null;
  if (domainResult.action === 'subscribe') {
    attr = attribution.attribute(db, domainResult.subscriptionId);
  }

  collector.markProcessed(db, rawId, 'normalized');
  return { normalized: true, eventId: event.id, domain: domainResult, attribution: attr };
}

/** Повторный прогон всего, что не доехало. Ретрай — штатный режим, а не аварийный. */
function processPending(db, limit) {
  const rows = collector.pending(db, limit);
  const out = [];
  for (const r of rows) out.push({ rawId: r.id, result: process(db, r.id) });
  return out;
}

/** Пересчёт атрибуции из сохранённых фактов — на любой момент, без потери истории. */
function reattributeAll(db) {
  const subs = db.prepare('SELECT id FROM subscriptions ORDER BY ts_utc ASC').all();
  return subs.map((s) => attribution.attribute(db, s.id));
}

module.exports = { handleIncoming, process, processPending, reattributeAll, adapterFor, ADAPTERS };
