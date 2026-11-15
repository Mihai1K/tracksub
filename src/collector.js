'use strict';

/**
 * Event Collector. Принимает сырое, ничего не интерпретирует.
 * Правило №1 архитектуры: сырое событие сохраняется ДО любой обработки и не удаляется никогда.
 */

const { id, idempotencyKey } = require('./ids');
const { tx, one, run } = require('./db');

/**
 * @returns {{rawId: string|null, duplicate: boolean, key: string}}
 * duplicate=true означает повторную доставку того же события — это нормальный режим,
 * ответ вызывающему всё равно 200 (attribution.md §11).
 */
function ingest(db, { transport, headers, bodyRaw, now, adapter, platform }) {
  const ts = now || Date.now();
  let parsed = null;
  try {
    parsed = JSON.parse(bodyRaw);
  } catch (e) {
    parsed = null; // невалидный JSON тоже сохраняем: ключ построим от тела
  }

  // Ключ спрашиваем у адаптера: у платформ разная форма события и разные гарантии уникальности
  let key = null;
  if (parsed && adapter && typeof adapter.idempotencyKey === 'function') key = adapter.idempotencyKey(parsed);
  if (!key && parsed) key = idempotencyKey(parsed);
  if (!key) key = require('crypto').createHash('sha256').update('unparsable|' + bodyRaw).digest('hex');

  const existing = one(db, 'SELECT id FROM webhook_events WHERE idempotency_key = ?', key);
  if (existing) return { rawId: existing.id, duplicate: true, key };

  const rawId = id('raw');
  try {
    run(
      db,
      'INSERT INTO webhook_events (id, received_at, transport, headers_json, body_raw, idempotency_key, status, platform) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      rawId,
      ts,
      transport || 'webhook',
      JSON.stringify(headers || {}),
      bodyRaw,
      key,
      'received',
      platform || (adapter && adapter.PLATFORM) || null
    );
  } catch (e) {
    // гонка двух одновременных доставок: уникальный индекс отработал
    if (String(e.message).includes('UNIQUE')) {
      const row = one(db, 'SELECT id FROM webhook_events WHERE idempotency_key = ?', key);
      return { rawId: row ? row.id : null, duplicate: true, key };
    }
    throw e;
  }
  return { rawId, duplicate: false, key };
}

function markFailed(db, rawId, error) {
  run(
    db,
    'UPDATE webhook_events SET status = ?, error = ?, attempts = attempts + 1, processed_at = ? WHERE id = ?',
    'failed',
    String(error && error.message ? error.message : error),
    Date.now(),
    rawId
  );
}

function markProcessed(db, rawId, status) {
  run(
    db,
    'UPDATE webhook_events SET status = ?, error = NULL, attempts = attempts + 1, processed_at = ? WHERE id = ?',
    status,
    Date.now(),
    rawId
  );
}

/** Сырые события, ожидающие обработки или упавшие: пригодно для ретрая по расписанию. */
function pending(db, limit) {
  return db
    .prepare(
      'SELECT * FROM webhook_events WHERE status IN (\'received\', \'failed\') ORDER BY received_at ASC LIMIT ?'
    )
    .all(limit || 100);
}

module.exports = { ingest, markFailed, markProcessed, pending, tx };
