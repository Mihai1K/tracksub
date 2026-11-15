'use strict';

/**
 * Conversion Dispatcher: очередь, ретраи, статусы, ничего не теряет.
 * Состояния: pending -> sent | retrying -> failed | skipped.
 */

const { id } = require('./../ids');
const { one, all, run } = require('./../db');
const { YandexMetrikaProvider, YandexDirectProvider, VkAdsProvider } = require('./providers');
const secrets = require('../secrets');
const { cfg } = require('../config');

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [60000, 300000, 900000, 3600000, 10800000, 21600000];

function providerFor(row) {
  // Токен лежит в базе зашифрованным, расшифровываем только в момент отправки
  const token = secrets.decrypt(row.token, cfg.secretKey);
  if (row.provider === 'vk_ads') {
    // У VK авторизации нет: идентификатор пикселя лежит в том же поле, что счётчик у Яндекса
    return new VkAdsProvider({ pixelId: row.counter_id, goal: row.goal_id, mode: row.mode });
  }
  const opts = { token, counterId: row.counter_id, goal: row.goal_id, mode: row.mode };
  return row.provider === 'yandex_direct' ? new YandexDirectProvider(opts) : new YandexMetrikaProvider(opts);
}

function credentials(db, workspaceId) {
  return all(db, 'SELECT * FROM ad_platform_credentials WHERE workspace_id = ?', workspaceId);
}

/**
 * Ставит конверсию в очередь для каждой настроенной рекламной системы.
 * kind: subscription | first_subscription | retained_subscription
 */
function enqueue(db, { workspaceId, subscriptionId, attributionId, kind }) {
  const created = [];
  for (const cred of credentials(db, workspaceId)) {
    const existing = one(db,
      'SELECT id FROM conversions WHERE subscription_id = ? AND provider = ? AND kind = ?',
      subscriptionId, cred.provider, kind);
    if (existing) continue; // идемпотентность: одна конверсия одного вида на подписку

    const convId = id('cv');
    run(db,
      'INSERT INTO conversions (id, workspace_id, subscription_id, attribution_id, provider, kind, status, mode, ' +
      'created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?, ?, ?)',
      convId, workspaceId, subscriptionId, attributionId || null, cred.provider, kind, cred.mode, Date.now(), Date.now());
    created.push(convId);
  }
  return created;
}

/**
 * Данные для отправки. Собираем все идентификаторы, которые реально были в клике,
 * и ничего не выдумываем. Какой из них годится — решает провайдер: Метрике нужен yclid,
 * VK Рекламе — rb_clickid.
 */
function payloadFor(db, conversion) {
  const sub = one(db, 'SELECT * FROM subscriptions WHERE id = ?', conversion.subscription_id);
  if (!sub) return null;
  const attr = one(db, 'SELECT * FROM attributions WHERE subscription_id = ? AND is_current = 1', sub.id);
  if (!attr || !attr.click_id) return { skip: 'нет атрибуции — отправлять нечего' };
  const click = one(db, 'SELECT * FROM clicks WHERE id = ?', attr.click_id);
  if (!click) return { skip: 'клик не найден' };

  let query = {};
  try { query = JSON.parse(click.query_json || '{}'); } catch (e) { query = {}; }
  return {
    yclid: query.yclid || query.YCLID || null,
    /**
     * Идентификатор клика VK. Имя параметра принимаем в нескольких вариантах: по документации
     * VK дописывает rb_clickid к адресу перехода сам, но подтверждения этому мы не получили,
     * а в списке автоматических UTM-меток его нет. Поэтому ловим и то, что рекламодатель
     * мог проставить макросом вручную. Значение одно и то же, меняется только имя поля.
     */
    rbClickId: query.rb_clickid || query.rb_clickId || query.RB_CLICKID ||
      query.clickid || query.click_id || query.vk_click_id || null,
    tsUtc: sub.ts_utc,
    price: 0,
    currency: 'RUB',
    attributionType: attr.type,
    confidence: attr.confidence
  };
}

async function processOne(db, conversion, opts) {
  const cred = one(db, 'SELECT * FROM ad_platform_credentials WHERE workspace_id = ? AND provider = ?',
    conversion.workspace_id, conversion.provider);
  if (!cred) {
    run(db, 'UPDATE conversions SET status = \'failed\', error = ? WHERE id = ?',
      'нет настроек интеграции', conversion.id);
    return { status: 'failed' };
  }

  const payload = payloadFor(db, conversion);
  if (!payload) {
    run(db, 'UPDATE conversions SET status = \'failed\', error = ? WHERE id = ?', 'подписка не найдена', conversion.id);
    return { status: 'failed' };
  }
  if (payload.skip) {
    run(db, 'UPDATE conversions SET status = \'skipped\', error = ?, payload_json = ? WHERE id = ?',
      payload.skip, JSON.stringify(payload), conversion.id);
    return { status: 'skipped', reason: payload.skip };
  }

  const provider = (opts && opts.providerFactory ? opts.providerFactory(cred) : providerFor(cred));

  // Годится ли этот идентификатор именно этому провайдеру — знает провайдер, не ядро
  if (typeof provider.supports === 'function' && !provider.supports(payload)) {
    const reason = typeof provider.skipReason === 'function'
      ? provider.skipReason(payload)
      : 'провайдер не принимает такие данные';
    run(db, 'UPDATE conversions SET status = \'skipped\', error = ?, payload_json = ? WHERE id = ?',
      reason, JSON.stringify(payload), conversion.id);
    return { status: 'skipped', reason };
  }

  const attempts = conversion.attempts + 1;
  try {
    const res = await provider.send([payload]);
    run(db,
      'UPDATE conversions SET status = \'sent\', mode = ?, attempts = ?, external_id = ?, error = NULL, ' +
      'payload_json = ?, sent_at = ? WHERE id = ?',
      res.mode, attempts, res.externalId || null, JSON.stringify(payload), Date.now(), conversion.id);
    return { status: 'sent', mode: res.mode };
  } catch (e) {
    // 4xx — это «данные неверны», повтор ничего не изменит. Ретраим только 5xx и 429.
    const permanent = e.retryable === false;
    const giveUp = permanent || attempts >= MAX_ATTEMPTS;
    const next = Date.now() + (BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
    run(db,
      'UPDATE conversions SET status = ?, attempts = ?, error = ?, next_attempt_at = ?, payload_json = ? WHERE id = ?',
      giveUp ? 'failed' : 'retrying', attempts,
      (permanent ? 'постоянная ошибка, повторы бессмысленны: ' : '') + String(e.message).slice(0, 460),
      giveUp ? null : next, JSON.stringify(payload), conversion.id);
    return { status: giveUp ? 'failed' : 'retrying', permanent, error: String(e.message) };
  }
}

async function processQueue(db, opts) {
  const now = Date.now();
  const rows = all(db,
    'SELECT * FROM conversions WHERE status IN (\'pending\', \'retrying\') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ' +
    'ORDER BY created_at ASC LIMIT ?', now, (opts && opts.limit) || 50);
  const out = [];
  for (const c of rows) out.push({ id: c.id, result: await processOne(db, c, opts) });
  return out;
}

/** Ручной повтор из админки: сбрасывает состояние и возвращает в очередь. */
function retry(db, conversionId) {
  run(db, 'UPDATE conversions SET status = \'pending\', next_attempt_at = ?, error = NULL WHERE id = ?',
    Date.now(), conversionId);
  return one(db, 'SELECT * FROM conversions WHERE id = ?', conversionId);
}

module.exports = { enqueue, processQueue, processOne, retry, payloadFor, providerFor, MAX_ATTEMPTS };
