'use strict';

/**
 * Attribution Engine — центральная часть продукта.
 * Реализует docs/attribution.md §5–§9 буквально. Любое отступление помечено ОТСТУПЛЕНИЕ и объяснено.
 *
 * Чистая функция над сохранёнными фактами: результат пересчитывается из сырых данных в любой момент,
 * старые версии не удаляются (is_current).
 */

const { id } = require('./ids');
const { one, all, run } = require('./db');

const ALGO_VERSION = '1.0.0';

const DET_WINDOW_MS = 60 * 60 * 1000;        // §4 окно точной схемы
const DET_MAX_MS = 24 * 60 * 60 * 1000;      // §4 предельное окно с понижением уверенности
const DET_CONF_FULL = 1.0;
const DET_CONF_LATE = 0.8;
const DELIVERY_SLACK_MS = 120 * 1000;        // §4 технический допуск на задержку доставки
const TAU_MS = 30 * 60 * 1000;               // §7 постоянная затухания
const DENSE_THRESHOLD = 20;                  // §7 признак плотного потока
const AMBIG_MARGIN = 1.2;                    // §7
const AMBIG_CONFIDENCE = 0.5;                // §7
const FRESHNESS_REUSED = 0.6;                // §7
const DEVICE_MISMATCH = 0.85;                // §7
/**
 * Сколько подписок максимум может «объяснить» один клик. Экспоненциальное затухание по времени
 * делает старые клики почти невесомыми, но если в окне ровно один клик, он выигрывает всегда —
 * и забирает себе хоть сорок человек. Один переход не приводит сорок человек: дальше это органика,
 * совпавшая по времени. Порог обсуждаемый, но лучше недосчитать источник, чем раздуть его.
 */
const MAX_REUSE_PER_CLICK = 5;

/**
 * ОТСТУПЛЕНИЕ от §7 (device_match), вынужденное и задокументированное:
 * события MAX не содержат никаких признаков устройства (FACT: UserAdded = inviter_id, chat_id, user,
 * is_channel). Сравнивать device_hint клика не с чем. Поэтому множитель понижается только для кликов,
 * по которым устройство не определено вовсе, — это по-прежнему штраф за слабый сигнал, но честный.
 * Как только платформа отдаст признак устройства, здесь появится настоящее сравнение.
 */
function deviceMatch(click /*, event */) {
  return click.device_hint && click.device_hint !== 'unknown' ? 1.0 : DEVICE_MISMATCH;
}

function loadContext(db, subscriptionId) {
  const sub = one(db, 'SELECT * FROM subscriptions WHERE id = ?', subscriptionId);
  if (!sub) throw new Error('subscription not found: ' + subscriptionId);
  const channel = one(db, 'SELECT * FROM channels WHERE id = ?', sub.channel_id);
  const workspace = one(db, 'SELECT * FROM workspaces WHERE id = ?', channel.workspace_id);
  return { sub, channel, workspace };
}

/**
 * Сильнейший сигнал: событие вступления принесло саму пригласительную ссылку (Telegram),
 * а ссылка была выдана конкретному клику. Здесь угадывать нечего.
 */
function inviteLinkCandidate(db, ctx) {
  const ev = one(db, 'SELECT * FROM platform_events WHERE id = ?', ctx.sub.platform_event_id);
  if (!ev || !ev.invite_link) return null;
  const invite = one(db,
    'SELECT * FROM invite_links WHERE channel_id = ? AND external_link = ?', ctx.sub.channel_id, ev.invite_link);
  if (!invite || !invite.click_id) return null;
  const click = one(db, 'SELECT * FROM clicks WHERE id = ? AND status = \'counted\'', invite.click_id);
  if (!click) return null;
  return { click: click, invite: invite, dtMs: Math.max(0, ctx.sub.ts_utc - click.ts_utc) };
}

/** §6 — точная схема: bot_started(payload=click_id) + общий platform_user_id. */
function deterministicCandidates(db, ctx) {
  const { sub, channel } = ctx;
  const starts = all(
    db,
    'SELECT * FROM bot_starts WHERE platform_user_id = ? AND payload IS NOT NULL ' +
      'AND ts_utc >= ? AND ts_utc <= ? ORDER BY ts_utc DESC',
    sub.platform_user_id,
    sub.ts_utc - DET_MAX_MS,
    sub.ts_utc + DELIVERY_SLACK_MS
  );
  const out = [];
  for (const s of starts) {
    const click = one(
      db,
      'SELECT * FROM clicks WHERE id = ? AND status = \'counted\' AND workspace_id = ?',
      s.payload,
      channel.workspace_id
    );
    if (!click) continue; // payload не расшифровывается в наш клик — сигнал чужой или подделан
    out.push({ botStart: s, click: click, dtMs: sub.ts_utc - s.ts_utc });
  }
  return out;
}

/** §7 — вероятностная схема. */
function probabilisticCandidates(db, ctx, windowHours) {
  const { sub, channel } = ctx;
  const from = sub.ts_utc - windowHours * 3600 * 1000;
  const to = sub.ts_utc + DELIVERY_SLACK_MS;
  const clicks = all(
    db,
    'SELECT * FROM clicks WHERE channel_id = ? AND status = \'counted\' AND ts_utc >= ? AND ts_utc <= ? ' +
      'ORDER BY ts_utc DESC',
    channel.id,
    from,
    to
  );

  const scored = [];
  for (const c of clicks) {
    // §7: клики, уже привязанные детерминированно к другой подписке, кандидатами не являются
    const boundDet = one(
      db,
      'SELECT a.id FROM attributions a WHERE a.click_id = ? AND a.is_current = 1 AND a.type = \'deterministic\' ' +
        'AND a.subscription_id <> ?',
      c.id,
      sub.id
    );
    if (boundDet) continue;

    /**
     * §7 freshness. Порядок сравнения зафиксирован намеренно: «уже атрибуцирован» означает
     * «атрибуцирован к более ранней подписке», а не «к любой другой». Иначе результат зависел бы
     * от порядка обработки, и пересчёт из сырых данных давал бы каждый раз новый ответ.
     */
    const reuseCount = one(
      db,
      'SELECT COUNT(*) c FROM attributions a JOIN subscriptions s2 ON s2.id = a.subscription_id ' +
        'WHERE a.click_id = ? AND a.is_current = 1 AND a.subscription_id <> ? ' +
        'AND (s2.ts_utc < ? OR (s2.ts_utc = ? AND s2.id < ?))',
      c.id,
      sub.id,
      sub.ts_utc,
      sub.ts_utc,
      sub.id
    ).c;

    const dtMs = Math.max(0, sub.ts_utc - c.ts_utc); // §7: отрицательные -> 0
    /**
     * Штраф за переиспользование растёт с каждой подпиской, уже привязанной к этому клику.
     * Один клик физически не может привести сорок человек: если так выходит, это органика,
     * случайно совпавшая по времени. Пусть лучше источник будет неизвестен, чем раздут.
     */
    if (reuseCount >= MAX_REUSE_PER_CLICK) continue; // клик исчерпан, кандидатом больше не является
    const freshness = Math.pow(FRESHNESS_REUSED, reuseCount);
    const score = Math.exp(-dtMs / TAU_MS) * deviceMatch(c) * freshness;
    scored.push({ click: c, dtMs, score, reuseCount });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function supersede(db, subscriptionId) {
  run(db, 'UPDATE attributions SET is_current = 0 WHERE subscription_id = ? AND is_current = 1', subscriptionId);
}

function writeAttribution(db, subscriptionId, data, candidates) {
  supersede(db, subscriptionId);
  const attrId = id('attr');
  run(
    db,
    'INSERT INTO attributions (id, subscription_id, type, click_id, confidence, margin, is_ambiguous, is_dense, ' +
      'window_hours, algo_version, created_at, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
    attrId,
    subscriptionId,
    data.type,
    data.clickId || null,
    data.confidence == null ? null : data.confidence,
    data.margin == null ? null : (isFinite(data.margin) ? data.margin : null),
    data.isAmbiguous ? 1 : 0,
    data.isDense ? 1 : 0,
    data.windowHours == null ? null : data.windowHours,
    ALGO_VERSION,
    Date.now()
  );
  for (const c of candidates || []) {
    run(
      db,
      'INSERT INTO attribution_candidates (id, attribution_id, click_id, score, dt_seconds, rejected_reason) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
      id('cand'),
      attrId,
      c.clickId,
      c.score,
      Math.round(c.dtMs / 1000),
      c.rejectedReason || null
    );
  }
  return one(db, 'SELECT * FROM attributions WHERE id = ?', attrId);
}

/**
 * Атрибуция одной подписки. Идемпотентна: повторный вызов создаёт новую версию записи
 * и гасит предыдущую, история сохраняется.
 */
function attribute(db, subscriptionId) {
  const ctx = loadContext(db, subscriptionId);
  const windowHours = ctx.workspace.attribution_window_hours || 72;

  // 0. Пригласительная ссылка в самом событии — сигнал сильнее любого другого
  const byInvite = inviteLinkCandidate(db, ctx);
  if (byInvite) {
    return writeAttribution(
      db,
      subscriptionId,
      {
        type: 'deterministic',
        clickId: byInvite.click.id,
        confidence: 1.0,
        margin: null,
        isAmbiguous: false,
        isDense: false,
        windowHours: null
      },
      [{ clickId: byInvite.click.id, score: 1, dtMs: byInvite.dtMs }]
    );
  }

  // 1. Детерминированный сигнал побеждает всегда (§5, §8)
  const det = deterministicCandidates(db, ctx);
  if (det.length) {
    const top = det[0]; // последний по времени (§8)
    const distinctPayloads = new Set(det.map((d) => d.botStart.payload));
    const confidence = top.dtMs <= DET_WINDOW_MS ? DET_CONF_FULL : DET_CONF_LATE;
    return writeAttribution(
      db,
      subscriptionId,
      {
        type: 'deterministic',
        clickId: top.click.id,
        confidence,
        margin: null,
        isAmbiguous: distinctPayloads.size > 1,
        isDense: false,
        windowHours: null
      },
      det.map((d) => ({ clickId: d.click.id, score: 1, dtMs: d.dtMs }))
    );
  }

  // 2. Вероятностная схема (§7)
  const cands = probabilisticCandidates(db, ctx, windowHours);
  if (!cands.length) {
    return writeAttribution(db, subscriptionId, {
      type: 'unattributed',
      clickId: null,
      confidence: null,
      margin: null,
      isAmbiguous: false,
      isDense: false,
      windowHours
    }, []);
  }

  const sum = cands.reduce((a, c) => a + c.score, 0);
  const top = cands[0];
  const second = cands[1];
  let confidence = sum > 0 ? top.score / sum : 0;
  const margin = second && second.score > 0 ? top.score / second.score : Infinity;
  const isDense = cands.length > DENSE_THRESHOLD;
  if (isDense) confidence = confidence / 2; // §7: при плотном потоке честнее не угадывать

  const isAmbiguous = margin < AMBIG_MARGIN || confidence < AMBIG_CONFIDENCE;

  return writeAttribution(
    db,
    subscriptionId,
    {
      type: 'probabilistic',
      clickId: top.click.id,
      confidence,
      margin,
      isAmbiguous,
      isDense,
      windowHours
    },
    cands.slice(0, 50).map((c) => ({ clickId: c.click.id, score: c.score, dtMs: c.dtMs }))
  );
}

/** §12 — калибровка: что предсказала бы схема Б там, где есть детерминированная истина. */
function calibrate(db) {
  const rows = all(
    db,
    'SELECT a.subscription_id, a.click_id FROM attributions a WHERE a.is_current = 1 AND a.type = \'deterministic\''
  );
  let comparable = 0;
  let matched = 0;
  for (const r of rows) {
    const ctx = loadContext(db, r.subscription_id);
    const cands = probabilisticCandidates(db, ctx, ctx.workspace.attribution_window_hours || 72);
    if (!cands.length) continue;
    comparable += 1;
    if (cands[0].click.id === r.click_id) matched += 1;
  }
  return {
    comparable,
    matched,
    accuracy: comparable ? matched / comparable : null,
    note: comparable === 0 ? 'нет сравнимых подписок — цифру точности публиковать нельзя' : null
  };
}

module.exports = {
  attribute,
  inviteLinkCandidate,
  calibrate,
  ALGO_VERSION,
  DET_WINDOW_MS,
  DET_MAX_MS,
  DELIVERY_SLACK_MS,
  TAU_MS,
  DENSE_THRESHOLD,
  MAX_REUSE_PER_CLICK
};
