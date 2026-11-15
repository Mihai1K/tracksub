'use strict';

/**
 * Analytics Core. Считает только по сохранённым фактам, ничего не выдумывает.
 * Ключевая метрика продукта — стоимость удержанного подписчика (attribution.md §10).
 */

const { all, one } = require('./db');

const DAY = 24 * 3600 * 1000;
const HORIZONS = { d1: DAY, d7: 7 * DAY, d30: 30 * DAY };
const MIN_MATURE_COHORT = 20; // §10: меньше — показываем как прогноз, а не факт

function dayKey(ts, tzOffsetMinutes) {
  const d = new Date(ts + (tzOffsetMinutes || 0) * 60000);
  return d.toISOString().slice(0, 10);
}

/** Смещение таймзоны workspace в минутах на конкретный момент. */
function tzOffset(timezone, at) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    for (const part of dtf.formatToParts(new Date(at || Date.now()))) p[part.type] = part.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - (at || Date.now())) / 60000);
  } catch (e) {
    return 0;
  }
}

function filtersSql(filters) {
  const where = [];
  const args = [];
  if (filters.channelId) { where.push('ch.id = ?'); args.push(filters.channelId); }
  if (filters.platform) { where.push('ch.platform = ?'); args.push(filters.platform); }
  if (filters.source) { where.push('tl.source = ?'); args.push(filters.source); }
  if (filters.campaign) { where.push('tl.campaign = ?'); args.push(filters.campaign); }
  if (filters.creative) { where.push('tl.creative = ?'); args.push(filters.creative); }
  return { sql: where.length ? ' AND ' + where.join(' AND ') : '', args };
}

function clickStats(db, wsId, filters) {
  const f = filtersSql(filters);
  return one(db,
    'SELECT COUNT(*) clicks FROM clicks c ' +
    'JOIN tracking_links tl ON tl.id = c.tracking_link_id JOIN channels ch ON ch.id = c.channel_id ' +
    'WHERE c.workspace_id = ? AND c.status = \'counted\' AND c.ts_utc >= ? AND c.ts_utc < ?' + f.sql,
    wsId, filters.from, filters.to, ...f.args).clicks;
}

/** Подписки периода с их атрибуцией и разрезами. Один источник правды для всех отчётов. */
function subscriptionRows(db, wsId, filters) {
  const f = filtersSql(filters);
  return all(db,
    'SELECT s.id, s.ts_utc, s.sequence, s.is_resubscribe, s.status, s.ended_at, s.ended_reason, ' +
    'a.type attr_type, a.confidence, a.is_ambiguous, a.click_id, ' +
    'tl.source, tl.campaign, tl.creative, tl.slug, ch.id channel_id, ch.title channel_title, ch.platform ' +
    'FROM subscriptions s ' +
    'JOIN channels ch ON ch.id = s.channel_id ' +
    'LEFT JOIN attributions a ON a.subscription_id = s.id AND a.is_current = 1 ' +
    'LEFT JOIN clicks c ON c.id = a.click_id ' +
    'LEFT JOIN tracking_links tl ON tl.id = c.tracking_link_id ' +
    'WHERE ch.workspace_id = ? AND s.ts_utc >= ? AND s.ts_utc < ?' + f.sql,
    wsId, filters.from, filters.to, ...f.args);
}

function unsubStats(db, wsId, filters) {
  const f = filtersSql(filters);
  return one(db,
    'SELECT COUNT(*) total, SUM(CASE WHEN u.reason = \'left\' THEN 1 ELSE 0 END) left_count ' +
    'FROM unsubscriptions u JOIN channels ch ON ch.id = u.channel_id ' +
    'LEFT JOIN subscriptions s ON s.id = u.subscription_id ' +
    'LEFT JOIN attributions a ON a.subscription_id = s.id AND a.is_current = 1 ' +
    'LEFT JOIN clicks c ON c.id = a.click_id LEFT JOIN tracking_links tl ON tl.id = c.tracking_link_id ' +
    'WHERE ch.workspace_id = ? AND u.ts_utc >= ? AND u.ts_utc < ?' + f.sql,
    wsId, filters.from, filters.to, ...f.args);
}

/**
 * Retention по когорте подписок. Зрелость обязательна: подписки моложе горизонта
 * в знаменатель не входят (§10). Возвращает null, если считать не на чем.
 */
/**
 * Когорта привлечения — только первые подписки (attribution.md §9).
 * Повторные и возвраты в неё не входят: иначе источник, чьи подписчики «мигают»,
 * выглядел бы дешевле, чем он есть.
 */
function acquisitionRows(rows) {
  return rows.filter((r) => r.sequence === 'first');
}

function retention(db, rows, horizonMs, now) {
  const t = now || Date.now();
  const mature = acquisitionRows(rows).filter((r) => r.ts_utc + horizonMs <= t);
  if (!mature.length) return { value: null, cohort: 0, alive: 0, isEstimate: true };
  let alive = 0;
  for (const r of mature) {
    const leftEarly = r.ended_at && r.ended_reason === 'left' && r.ended_at <= r.ts_utc + horizonMs;
    const removed = r.ended_reason === 'removed';
    if (removed) continue; // §3: удалённых админом исключаем из когорты целиком
    if (!leftEarly) alive += 1;
  }
  const cohort = mature.filter((r) => r.ended_reason !== 'removed').length;
  if (!cohort) return { value: null, cohort: 0, alive: 0, isEstimate: true };
  return { value: alive / cohort, cohort, alive, isEstimate: cohort < MIN_MATURE_COHORT };
}

function spendFor(db, wsId, filters, scopeType, scopeValue) {
  const args = [wsId];
  let sql = 'SELECT COALESCE(SUM(amount), 0) total FROM spend_entries WHERE workspace_id = ?';
  if (scopeType) { sql += ' AND scope_type = ? AND scope_value = ?'; args.push(scopeType, scopeValue); }
  if (filters && filters.fromDay) { sql += ' AND day >= ?'; args.push(filters.fromDay); }
  if (filters && filters.toDay) { sql += ' AND day <= ?'; args.push(filters.toDay); }
  return one(db, sql, ...args).total;
}

function money(x) { return x == null ? null : Math.round(x * 100) / 100; }

function overview(db, ws, filters) {
  const rows = subscriptionRows(db, ws.id, filters);
  const clicks = clickStats(db, ws.id, filters);
  const unsub = unsubStats(db, ws.id, filters);

  /**
   * Расход берём только по источникам, которые реально дали подписки в этом срезе.
   * Иначе в отчёте по каналу, куда рекламу не лили, всплывал бы расход соседнего канала —
   * и появлялась бы стоимость подписчика из воздуха.
   */
  const presentSources = Array.from(new Set(
    rows.filter((r) => r.attr_type && r.attr_type !== 'unattributed' && r.source).map((r) => r.source)
  ));
  const spend = filters.channelId
    ? presentSources.reduce((a, src) => a + spendFor(db, ws.id, filters, 'source', src), 0)
    : spendFor(db, ws.id, filters, null, null);

  const subs = rows.length;
  const acquisition = acquisitionRows(rows).length;
  const attributed = rows.filter((r) => r.attr_type && r.attr_type !== 'unattributed');
  /**
   * Знаменатель CPS — новые подписчики С ИЗВЕСТНЫМ источником. Делить расход на людей,
   * пришедших неизвестно откуда, значит выдумывать стоимость привлечения.
   */
  const paidAcquisition = acquisitionRows(rows)
    .filter((r) => r.attr_type && r.attr_type !== 'unattributed').length;
  const deterministic = rows.filter((r) => r.attr_type === 'deterministic').length;
  const probabilistic = rows.filter((r) => r.attr_type === 'probabilistic').length;
  const unattributed = subs - deterministic - probabilistic;
  const ambiguous = rows.filter((r) => r.is_ambiguous).length;

  const r30 = retention(db, rows, HORIZONS.d30);
  const cps = paidAcquisition && spend ? spend / paidAcquisition : null;
  const retainedCps = r30.value && paidAcquisition && spend ? spend / (paidAcquisition * r30.value) : null;

  return {
    clicks,
    subscriptions: subs,
    firstSubscriptions: acquisition,
    paidAcquisition,
    repeat: subs - acquisition,
    unsubscriptions: unsub.total || 0,
    unsubscriptionsLeft: unsub.left_count || 0,
    // Конверсия — доля переходов, ставших подписками. Органические подписчики
    // в числитель не идут: они пришли не по нашим ссылкам, и CR из-за них улетал за 10 000%.
    cr: clicks ? attributed.length / clicks : null,
    spend,
    cps: money(cps),
    retention: {
      d1: retention(db, rows, HORIZONS.d1),
      d7: retention(db, rows, HORIZONS.d7),
      d30: r30
    },
    retainedCps: money(retainedCps),
    attribution: {
      deterministic,
      probabilistic,
      unattributed,
      ambiguous,
      attributedShare: subs ? attributed.length / subs : null
    }
  };
}

/** Разбивка по источнику / кампании / креативу. Строка «источник неизвестен» присутствует всегда (§10). */
function breakdown(db, ws, filters, dimension) {
  const rows = subscriptionRows(db, ws.id, filters);
  const dimKey = dimension === 'campaign' ? 'campaign' : dimension === 'creative' ? 'creative' : 'source';

  const clickRows = all(db,
    'SELECT tl.' + dimKey + ' k, COUNT(*) clicks FROM clicks c ' +
    'JOIN tracking_links tl ON tl.id = c.tracking_link_id JOIN channels ch ON ch.id = c.channel_id ' +
    'WHERE c.workspace_id = ? AND c.status = \'counted\' AND c.ts_utc >= ? AND c.ts_utc < ?' +
    filtersSql(filters).sql + ' GROUP BY tl.' + dimKey,
    ws.id, filters.from, filters.to, ...filtersSql(filters).args);

  const groups = new Map();
  const keyOf = (r) => (r.attr_type && r.attr_type !== 'unattributed' && r[dimKey]) ? r[dimKey] : null;
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const c of clickRows) if (!groups.has(c.k)) groups.set(c.k, []);

  const out = [];
  for (const [k, list] of groups) {
    const clicks = (clickRows.find((c) => c.k === k) || {}).clicks || 0;
    const spend = k == null ? 0 : spendFor(db, ws.id, filters, dimKey, k);
    const r30 = retention(db, list, HORIZONS.d30);
    const subs = list.length;
    const acquisition = acquisitionRows(list).length;
    const attributedInGroup = list.filter((r) => r.attr_type && r.attr_type !== 'unattributed').length;
    const paidAcquisition = k == null ? 0 : acquisitionRows(list)
      .filter((r) => r.attr_type && r.attr_type !== 'unattributed').length;
    out.push({
      key: k,
      label: k == null ? 'Источник неизвестен' : k,
      isUnknown: k == null,
      clicks,
      subscriptions: subs,
      newSubscriptions: acquisition,
      repeat: subs - acquisition,
      cr: clicks ? attributedInGroup / clicks : null,
      spend,
      cps: paidAcquisition && spend ? money(spend / paidAcquisition) : null,
      retentionD30: r30,
      retainedCps: paidAcquisition && spend && r30.value ? money(spend / (paidAcquisition * r30.value)) : null,
      deterministic: list.filter((r) => r.attr_type === 'deterministic').length,
      probabilistic: list.filter((r) => r.attr_type === 'probabilistic').length,
      ambiguous: list.filter((r) => r.is_ambiguous).length
    });
  }
  out.sort((a, b) => (b.subscriptions - a.subscriptions) || (b.clicks - a.clicks));
  return out;
}

/** Ряды по дням в таймзоне workspace. */
function timeseries(db, ws, filters) {
  const off = tzOffset(ws.timezone, filters.to);
  const f = filtersSql(filters);
  const days = new Map();
  const touch = (d) => {
    if (!days.has(d)) days.set(d, { day: d, clicks: 0, subscriptions: 0, unsubscriptions: 0 });
    return days.get(d);
  };

  for (let t = filters.from; t < filters.to; t += DAY) touch(dayKey(t, off));

  for (const c of all(db,
    'SELECT c.ts_utc FROM clicks c JOIN tracking_links tl ON tl.id = c.tracking_link_id ' +
    'JOIN channels ch ON ch.id = c.channel_id WHERE c.workspace_id = ? AND c.status = \'counted\' ' +
    'AND c.ts_utc >= ? AND c.ts_utc < ?' + f.sql, ws.id, filters.from, filters.to, ...f.args)) {
    touch(dayKey(c.ts_utc, off)).clicks += 1;
  }
  for (const s of subscriptionRows(db, ws.id, filters)) touch(dayKey(s.ts_utc, off)).subscriptions += 1;
  for (const u of all(db,
    'SELECT u.ts_utc FROM unsubscriptions u JOIN channels ch ON ch.id = u.channel_id ' +
    'WHERE ch.workspace_id = ? AND u.ts_utc >= ? AND u.ts_utc < ?', ws.id, filters.from, filters.to)) {
    touch(dayKey(u.ts_utc, off)).unsubscriptions += 1;
  }

  return Array.from(days.values()).sort((a, b) => a.day.localeCompare(b.day));
}

module.exports = {
  overview, breakdown, timeseries, retention, acquisitionRows, subscriptionRows, spendFor,
  tzOffset, dayKey, HORIZONS, MIN_MATURE_COHORT, DAY
};
