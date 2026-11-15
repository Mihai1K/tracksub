'use strict';

/**
 * История замеров и скорость роста.
 *
 * Каждый сбор пишет снимок метрик поста (content_snapshots). По снимкам считаем:
 * - velocity: просмотры в час между последним снимком и снимком не младше 30 минут до него.
 *   Пока снимок один - средняя скорость с публикации (views / часы с публикации), с пометкой.
 * - delta: прирост за последние ~6 часов (или за весь доступный промежуток, он указан).
 * - velocity_ratio: скорость поста / медиана скорости других свежих постов того же источника.
 *   Норма своя у каждого канала - общих порогов просмотров нет. Меньше 5 постов для сравнения -
 *   норма не считается.
 * - trend: растёт / ровно / замедляется / стоп - текущая скорость против предыдущего окна.
 * Падение счётчика (площадка пересчитала просмотры) не даёт отрицательной скорости: окно
 * отбрасывается, пометка «счётчик уменьшился».
 */

const HOUR = 3600000;
const MIN_GAP = 30 * 60000;        // ближе 30 минут скорость не считаем: шум
const DEDUP_GAP = 20 * 60000;      // повторный сбор в течение 20 минут не пишет новый снимок
const FRESH_HOURS = 48;            // для нормы канала берём посты не старше двух суток
const MIN_PEERS = 5;
const KEEP_DAYS = 30;              // снимки старше месяца прореживаем

function median(nums) {
  const a = nums.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const round = (x, d) => (x == null || !Number.isFinite(x) ? null : Math.round(x * Math.pow(10, d)) / Math.pow(10, d));

/** Снимок для каждого поста, если с прошлого прошло больше DEDUP_GAP. */
function recordSnapshots(db, itemIds, now) {
  const t = now || Date.now();
  const last = db.prepare('SELECT observed_at FROM content_snapshots WHERE item_id = ? ORDER BY observed_at DESC LIMIT 1');
  const item = db.prepare('SELECT views, likes, comments, shares FROM content_items WHERE id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO content_snapshots (item_id, observed_at, views, likes, comments, shares) VALUES (?, ?, ?, ?, ?, ?)');
  let written = 0;
  for (const id of itemIds) {
    const prev = last.get(id);
    if (prev && t - prev.observed_at < DEDUP_GAP) continue;
    const m = item.get(id);
    if (!m || m.views == null) continue;
    written += ins.run(id, t, m.views, m.likes, m.comments, m.shares).changes;
  }
  return written;
}

/**
 * Посты, собранные до появления истории замеров, уже несут цифры прошлого сбора (observed_at).
 * Сохраняем их как первый снимок до того, как новый сбор перезапишет метрики, - тогда настоящая
 * скорость есть уже со следующего сбора.
 */
function backfillSource(db, sourceId) {
  return db.prepare('INSERT OR IGNORE INTO content_snapshots (item_id, observed_at, views, likes, comments, shares) ' +
    'SELECT id, observed_at, views, likes, comments, shares FROM content_items i WHERE source_id = ? AND views IS NOT NULL ' +
    'AND NOT EXISTS (SELECT 1 FROM content_snapshots s WHERE s.item_id = i.id)').run(sourceId).changes;
}

/**
 * Скорость по ряду снимков (по возрастанию времени). publishedAt нужен для средней скорости,
 * когда снимок один.
 */
function computeVelocity(snaps, publishedAt) {
  const out = { velocity: null, kind: null, delta: null, deltaHours: null, trend: null, note: null, peak: null };
  if (!snaps.length) return out;
  const last = snaps[snaps.length - 1];

  // окна между соседними снимками (с шагом не меньше MIN_GAP)
  const windows = [];
  let anchor = snaps[0];
  let dropped = false;
  for (let i = 1; i < snaps.length; i++) {
    const s = snaps[i];
    if (s.observed_at - anchor.observed_at < MIN_GAP) continue;
    if (s.views < anchor.views) { dropped = true; anchor = s; continue; }
    windows.push({ from: anchor, to: s, v: (s.views - anchor.views) / ((s.observed_at - anchor.observed_at) / HOUR) });
    anchor = s;
  }

  if (windows.length) {
    const cur = windows[windows.length - 1];
    out.velocity = round(cur.v, 1);
    out.kind = 'measured';
    out.peak = round(Math.max(...windows.map((w) => w.v)), 1);
    if (windows.length >= 2) {
      const prev = windows[windows.length - 2].v;
      if (cur.v < 1 && cur.to.views > 0 && (cur.to.views - cur.from.views) / cur.to.views < 0.005) out.trend = 'stop';
      else if (prev <= 0) out.trend = cur.v > 0 ? 'up' : 'stop';
      else if (cur.v > prev * 1.2) out.trend = 'up';
      else if (cur.v < prev * 0.8) out.trend = 'down';
      else out.trend = 'flat';
    }
  } else if (publishedAt && last.views != null) {
    const hours = (last.observed_at - publishedAt) / HOUR;
    if (hours >= 0.5) {
      out.velocity = round(last.views / hours, 1);
      out.kind = 'average';
      out.note = 'средняя с публикации, нужен второй замер';
    }
  }

  // прирост за ~6 часов: от самого позднего снимка, который старше 6 часов, иначе от первого
  const base = [...snaps].reverse().find((s) => last.observed_at - s.observed_at >= 6 * HOUR) || snaps[0];
  if (base !== last && last.views >= base.views) {
    out.delta = last.views - base.views;
    out.deltaHours = round((last.observed_at - base.observed_at) / HOUR, 1);
  }
  if (dropped) out.note = (out.note ? out.note + '; ' : '') + 'счётчик уменьшился - окно пропущено';
  return out;
}

/** Пересчёт скорости всех свежих постов источника и их нормы. */
function recomputeSource(db, sourceId, now) {
  const t = now || Date.now();
  const items = db.prepare('SELECT id, published_at, created_at FROM content_items WHERE source_id = ? AND COALESCE(published_at, created_at) >= ?')
    .all(sourceId, t - 14 * 24 * HOUR);
  return recomputeItems(db, items, t, true);
}

function recomputeItems(db, items, now, withNorm) {
  const t = now || Date.now();
  const snapsOf = db.prepare('SELECT observed_at, views FROM content_snapshots WHERE item_id = ? ORDER BY observed_at');
  const upd = db.prepare('UPDATE content_items SET velocity = ?, velocity_kind = ?, velocity_peak = ?, delta_views = ?, delta_hours = ?, ' +
    'trend = ?, velocity_note = ?, velocity_ratio = ? WHERE id = ?');
  const res = items.map((it) => Object.assign({ id: it.id, published: it.published_at || it.created_at }, computeVelocity(snapsOf.all(it.id), it.published_at)));

  // норма: медиана скорости свежих постов этого же источника, своя для каждого канала
  const fresh = res.filter((r) => r.velocity != null && t - r.published < FRESH_HOURS * HOUR);
  for (const r of res) {
    let ratio = null;
    if (withNorm && r.velocity != null && t - r.published < FRESH_HOURS * HOUR) {
      const peers = fresh.filter((p) => p.id !== r.id).map((p) => p.velocity);
      const norm = peers.length >= MIN_PEERS ? median(peers) : null;
      if (norm && norm > 0) ratio = round(r.velocity / norm, 2);
    }
    upd.run(r.velocity, r.kind, r.peak, r.delta, r.deltaHours, r.trend, r.note, ratio, r.id);
  }
  return res.length;
}

/** Прореживание: старше KEEP_DAYS оставляем по одному снимку в сутки. */
function pruneSnapshots(db, now) {
  const t = now || Date.now();
  return db.prepare('DELETE FROM content_snapshots WHERE observed_at < ? AND rowid NOT IN (' +
    'SELECT MIN(rowid) FROM content_snapshots WHERE observed_at < ? GROUP BY item_id, observed_at / 86400000)')
    .run(t - KEEP_DAYS * 24 * HOUR, t - KEEP_DAYS * 24 * HOUR).changes;
}

function series(db, itemId) {
  return db.prepare('SELECT observed_at, views FROM content_snapshots WHERE item_id = ? ORDER BY observed_at').all(itemId);
}

module.exports = { backfillSource, recordSnapshots, computeVelocity, recomputeSource, recomputeItems, pruneSnapshots, series, median, MIN_GAP, DEDUP_GAP, MIN_PEERS };
