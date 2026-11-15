'use strict';

/** Content OS: хранение, сбор по расписанию, лента. Всё строго в пределах workspace. */

const { one, all, run, tx } = require('../db');
const { id } = require('../ids');
const { COLLECTORS, parseSourceLine } = require('./collectors');
const scoring = require('./scoring');
const velocity = require('./velocity');
const topics = require('./topics');
const relevance = require('./relevance');
const publications = require('./publications');

const STATUSES = ['new', 'picked', 'archived'];
const SCRIPT_STATUSES = ['draft', 'approved', 'shot', 'published'];
const MAX_SOURCES = 300;

// ----------------------------------------------------------------- settings

function getSettings(db, workspaceId) {
  return one(db, 'SELECT * FROM content_settings WHERE workspace_id = ?', workspaceId) ||
    { workspace_id: workspaceId, author: '', audience: '', topics: '', tone: '', cta: '', stop_topics: null };
}

function saveSettings(db, workspaceId, form) {
  const v = (k) => String(form[k] || '').trim().slice(0, 1000);
  const stop = form.stop_topics == null ? null : v('stop_topics');
  run(db, 'INSERT INTO content_settings (workspace_id, author, audience, topics, tone, cta, stop_topics, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(workspace_id) DO UPDATE SET author = excluded.author, audience = excluded.audience, topics = excluded.topics, ' +
    'tone = excluded.tone, cta = excluded.cta, stop_topics = COALESCE(excluded.stop_topics, content_settings.stop_topics), updated_at = excluded.updated_at',
  workspaceId, v('author'), v('audience'), v('topics'), v('tone'), v('cta'), stop, Date.now());
  relevance.recompute(db, workspaceId, getSettings(db, workspaceId));
}

// ------------------------------------------------------------------ sources

function listSources(db, workspaceId) {
  return all(db, 'SELECT s.*, (SELECT COUNT(*) FROM content_items i WHERE i.source_id = s.id) items ' +
    'FROM content_sources s WHERE s.workspace_id = ? ORDER BY s.platform, s.kind, s.handle', workspaceId);
}

function getSource(db, workspaceId, sourceId) {
  return one(db, 'SELECT * FROM content_sources WHERE id = ? AND workspace_id = ?', sourceId, workspaceId);
}

/** Добавление списком: строка = источник. Возвращает { added, existed, bad }. */
function addSources(db, workspaceId, text, niche) {
  const res = { added: 0, existed: 0, bad: [] };
  const count = one(db, 'SELECT COUNT(*) c FROM content_sources WHERE workspace_id = ?', workspaceId).c;
  let room = MAX_SOURCES - count;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const p = parseSourceLine(line);
    if (!p) { res.bad.push(line.trim().slice(0, 80)); continue; }
    if (room <= 0) { res.bad.push(line.trim().slice(0, 80) + ' (лимит ' + MAX_SOURCES + ')'); continue; }
    const r = run(db, 'INSERT OR IGNORE INTO content_sources (id, workspace_id, platform, kind, handle, niche, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id('csrc'), workspaceId, p.platform, p.kind, p.handle, String(niche || '').trim().slice(0, 80), Date.now());
    if (r.changes) { res.added++; room--; } else res.existed++;
  }
  return res;
}

function setSourceActive(db, workspaceId, sourceId, active) {
  return run(db, 'UPDATE content_sources SET is_active = ? WHERE id = ? AND workspace_id = ?', active ? 1 : 0, sourceId, workspaceId).changes;
}

/** Удаление источника. Посты остаются в ленте (source_id обнуляется), сценарии не теряются. */
function deleteSource(db, workspaceId, sourceId) {
  return tx(db, () => {
    run(db, 'UPDATE content_items SET source_id = NULL WHERE source_id = ? AND workspace_id = ?', sourceId, workspaceId);
    return run(db, 'DELETE FROM content_sources WHERE id = ? AND workspace_id = ?', sourceId, workspaceId).changes;
  });
}

// -------------------------------------------------------------------- items

const UPSERT = 'INSERT INTO content_items (id, workspace_id, source_id, provider, platform, url, author, title, body, published_at, ' +
  'views, likes, comments, shares, author_subscribers, provider_score, observed_at, created_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(workspace_id, url) DO UPDATE SET ' +
  'source_id = COALESCE(content_items.source_id, excluded.source_id), ' +
  'author = COALESCE(excluded.author, content_items.author), title = COALESCE(excluded.title, content_items.title), ' +
  'body = COALESCE(excluded.body, content_items.body), published_at = COALESCE(excluded.published_at, content_items.published_at), ' +
  'views = COALESCE(excluded.views, content_items.views), likes = COALESCE(excluded.likes, content_items.likes), ' +
  'comments = COALESCE(excluded.comments, content_items.comments), shares = COALESCE(excluded.shares, content_items.shares), ' +
  'author_subscribers = COALESCE(excluded.author_subscribers, content_items.author_subscribers), ' +
  'provider_score = COALESCE(excluded.provider_score, content_items.provider_score), observed_at = excluded.observed_at';

/** Запись постов; статус, заметки и сценарии существующих постов не трогаются. */
function upsertItems(db, workspaceId, items, { sourceId, provider, platform, now }) {
  const t = now || Date.now();
  const stmt = db.prepare(UPSERT);
  const ids = [];
  tx(db, () => {
    for (const it of items) {
      stmt.run(id('citm'), workspaceId, sourceId || null, provider, it.platform || platform, it.url,
        it.author || null, it.title || null, it.body || null, it.publishedAt || null,
        it.views == null ? null : it.views, it.likes == null ? null : it.likes,
        it.comments == null ? null : it.comments, it.shares == null ? null : it.shares,
        it.authorSubscribers == null ? null : it.authorSubscribers,
        it.providerScore == null ? null : it.providerScore, t, t);
      ids.push(one(db, 'SELECT id FROM content_items WHERE workspace_id = ? AND url = ?', workspaceId, it.url).id);
    }
  });
  return ids;
}

/** Сбор одного источника: сеть → запись → пересчёт залётности → состояние источника. */
async function collectSource(db, source, { fetch: fetchFn, cfg, now, log }) {
  const t = now || Date.now();
  const collector = COLLECTORS[source.platform];
  run(db, 'UPDATE content_sources SET last_fetch_at = ? WHERE id = ?', t, source.id);
  velocity.backfillSource(db, source.id);
  try {
    const res = await collector(source, { fetch: fetchFn || fetch, cfg, now: t });
    const items = res.items.filter((i) => i.url);
    const ids = upsertItems(db, source.workspace_id, items, { sourceId: source.id, provider: source.platform, platform: source.platform, now: t });
    velocity.recordSnapshots(db, ids, t);
    const sc = scoring.rescoreSource(db, source, t);
    velocity.recomputeSource(db, source.id, t);
    run(db, 'UPDATE content_sources SET last_success_at = ?, last_error = NULL, last_count = ?, ' +
      'title = COALESCE(?, title), subscribers = COALESCE(?, subscribers) WHERE id = ?',
    t, items.length, res.meta && res.meta.title || null, res.meta && res.meta.subscribers != null ? res.meta.subscribers : null, source.id);
    return { ok: true, count: items.length, baseline: sc.baseline, sampleSize: sc.sampleSize };
  } catch (e) {
    const msg = String(e && e.name === 'TimeoutError' ? 'таймаут запроса' : (e && e.message) || e).slice(0, 300);
    run(db, 'UPDATE content_sources SET last_error = ? WHERE id = ?', msg, source.id);
    if (log) log('warn', 'content source failed', { source: source.id, platform: source.platform, error: msg });
    return { ok: false, error: msg };
  }
}

/**
 * Источники, которым пора обновиться (по всем workspace). Telegram и VK дешёвые - их чаще
 * (fastHours), иначе свежий пост успевает «уехать» из окна последних постов и скорость не посчитать.
 * Поиск YouTube стоит квоты - его реже (intervalHours), а метрики уже найденных роликов
 * обновляются отдельно и дёшево (remeasureYoutube).
 */
function dueSources(db, { intervalHours, fastHours, now, limit }) {
  const t = now || Date.now();
  const fast = fastHours || intervalHours;
  return all(db, 'SELECT * FROM content_sources WHERE is_active = 1 AND (last_fetch_at IS NULL OR last_fetch_at <= ' +
    'CASE WHEN platform = \'youtube\' THEN ? ELSE ? END) ' +
    'ORDER BY last_fetch_at IS NOT NULL, last_fetch_at LIMIT ?', t - intervalHours * 3600000, t - fast * 3600000, limit || 25);
}

/**
 * Перезамер свежих роликов YouTube по ID (videos.list - 1 единица квоты на 50 роликов).
 * Ролики младше 3 суток, которые не мерили дольше 3 часов.
 */
async function remeasureYoutube(db, { cfg, fetch: fetchFn, now }) {
  const t = now || Date.now();
  if (!cfg.content.youtubeKey) return 0;
  const rows = all(db, 'SELECT id, url, source_id FROM content_items WHERE provider = \'youtube\' AND published_at >= ? AND observed_at <= ? ' +
    'ORDER BY published_at DESC LIMIT 200', t - 3 * 86400000, t - 3 * 3600000);
  if (!rows.length) return 0;
  const vid = (u) => (String(u).match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1];
  const ids = [...new Set(rows.map((r) => vid(r.url)).filter(Boolean))].slice(0, 50);
  const stats = await require('./collectors').youtubeStats(ids, { fetch: fetchFn || fetch, cfg });
  const upd = db.prepare('UPDATE content_items SET views = COALESCE(?, views), likes = COALESCE(?, likes), comments = COALESCE(?, comments), observed_at = ? WHERE id = ?');
  const touched = [];
  for (const r of rows) {
    const s = stats[vid(r.url)];
    if (!s) continue;
    upd.run(s.views, s.likes, s.comments, t, r.id);
    touched.push(r);
  }
  velocity.recordSnapshots(db, touched.map((r) => r.id), t);
  for (const sid of new Set(touched.map((r) => r.source_id).filter(Boolean))) velocity.recomputeSource(db, sid, t);
  return touched.length;
}

/** Один проход планировщика: по очереди, с паузой - не долбим площадки параллельно. */
async function runDue(db, { cfg, fetch: fetchFn, log, now, pauseMs }) {
  const list = dueSources(db, { intervalHours: cfg.content.fetchHours, fastHours: cfg.content.fastHours, now, limit: cfg.content.batch });
  const results = [];
  for (const s of list) {
    results.push(Object.assign({ source: s.id }, await collectSource(db, s, { fetch: fetchFn, cfg, now, log })));
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  try {
    const n = await remeasureYoutube(db, { cfg, fetch: fetchFn, now });
    if (n && log) log('info', 'content youtube remeasured', { count: n });
  } catch (e) {
    if (log) log('warn', 'content youtube remeasure failed', { error: String(e.message).slice(0, 200) });
  }
  try {
    const n = await publications.remeasure(db, { cfg, fetch: fetchFn, now, log });
    if (n && log) log('info', 'content publications measured', { count: n });
  } catch (e) {
    if (log) log('warn', 'content publications remeasure failed', { error: String(e.message).slice(0, 200) });
  }
  velocity.pruneSnapshots(db, now);
  clusterTouched(db, list.map((s) => s.workspace_id), now, log);
  return results;
}

async function collectWorkspace(db, workspaceId, opts) {
  const list = all(db, 'SELECT * FROM content_sources WHERE workspace_id = ? AND is_active = 1 ORDER BY last_fetch_at IS NOT NULL, last_fetch_at', workspaceId);
  const out = [];
  for (const s of list) out.push(Object.assign({ source: s.id, handle: s.handle }, await collectSource(db, s, opts)));
  clusterTouched(db, [workspaceId], opts && opts.now, opts && opts.log);
  return out;
}

/** Склейка тем после сбора: ошибка склейки не должна ломать сбор. */
function clusterTouched(db, workspaceIds, now, log) {
  for (const ws of new Set(workspaceIds)) {
    try { topics.clusterWorkspace(db, ws, now); relevance.recompute(db, ws, getSettings(db, ws), { now }); } catch (e) {
      if (log) log('warn', 'content topics failed', { workspace: ws, error: String(e.message).slice(0, 200) });
    }
  }
}

function importItems(db, workspaceId, parsed, provider, now) {
  const t = now || Date.now();
  const ids = upsertItems(db, workspaceId, parsed.items, { sourceId: null, provider, platform: 'other', now: t });
  for (const itemId of ids) {
    const it = one(db, 'SELECT source_id FROM content_items WHERE id = ?', itemId);
    if (!it.source_id) scoring.rescoreLoose(db, itemId, t);
  }
  velocity.recordSnapshots(db, ids, t);
  velocity.recomputeItems(db, ids.map((id) => one(db, 'SELECT id, published_at, created_at FROM content_items WHERE id = ?', id)), t, false);
  clusterTouched(db, [workspaceId], t);
  return ids.length;
}

/**
 * Лента трендов. По умолчанию - свежее за `days` дней, без архива, лучшие сверху.
 * Посты без оценки идут после оценённых.
 */
function feed(db, workspaceId, { days, platform, status, minScore, q, limit, now, sort, rel }) {
  const t = now || Date.now();
  const where = ['i.workspace_id = ?'];
  const args = [workspaceId];
  if (days) { where.push('COALESCE(i.published_at, i.created_at) >= ?'); args.push(t - days * 86400000); }
  if (platform) { where.push('i.platform = ?'); args.push(platform); }
  if (status && STATUSES.includes(status)) { where.push('i.status = ?'); args.push(status); } else where.push('i.status != \'archived\'');
  if (minScore) { where.push('i.score >= ?'); args.push(minScore); }
  // Релевантность: по умолчанию прячем только «не наше»; посты без оценки (профиль пуст) видны всегда.
  if (rel === 'on') where.push('i.relevance_label = \'on\'');
  // Импорт (vidIQ, Virale, свои ссылки) выбран руками - его не прячем.
  else if (rel !== 'all' && status !== 'picked') where.push('(i.relevance_label IS NULL OR i.relevance_label != \'off\' OR i.source_id IS NULL)');
  if (q) { where.push('(i.title LIKE ? OR i.body LIKE ? OR i.author LIKE ?)'); const like = '%' + q + '%'; args.push(like, like, like); }
  return all(db, 'SELECT i.*, s.handle source_handle, s.kind source_kind, ti.topic_id, tp.sources_count topic_sources, ' +
    '(SELECT COUNT(*) FROM content_scripts sc WHERE sc.item_id = i.id) scripts ' +
    'FROM content_items i LEFT JOIN content_sources s ON s.id = i.source_id ' +
    'LEFT JOIN content_topic_items ti ON ti.item_id = i.id LEFT JOIN content_topics tp ON tp.id = ti.topic_id WHERE ' + where.join(' AND ') +
    (sort === 'velocity'
      ? ' ORDER BY i.velocity_ratio IS NULL, i.velocity_ratio DESC, i.velocity IS NULL, i.velocity DESC LIMIT ?'
      : sort === 'fresh' ? ' ORDER BY COALESCE(i.published_at, i.created_at) DESC LIMIT ?'
        : ' ORDER BY i.score IS NULL, i.score DESC, i.published_at DESC LIMIT ?'), ...args, Math.min(limit || 60, 300));
}

function getItem(db, workspaceId, itemId) {
  return one(db, 'SELECT * FROM content_items WHERE id = ? AND workspace_id = ?', itemId, workspaceId);
}

function setItemStatus(db, workspaceId, itemId, status) {
  if (!STATUSES.includes(status)) return 0;
  const prev = one(db, 'SELECT status FROM content_items WHERE id = ? AND workspace_id = ?', itemId, workspaceId);
  const n = run(db, 'UPDATE content_items SET status = ? WHERE id = ? AND workspace_id = ?', status, itemId, workspaceId).changes;
  if (n && prev && prev.status !== status) {
    relevance.logEvent(db, workspaceId, { itemId, kind: status === 'picked' ? 'favorite' : status === 'archived' ? 'archive' : prev.status === 'picked' ? 'unfavorite' : 'restore' });
  }
  return n;
}

function stats(db, workspaceId, now) {
  const t = now || Date.now();
  return {
    sources: one(db, 'SELECT COUNT(*) c FROM content_sources WHERE workspace_id = ?', workspaceId).c,
    failing: one(db, 'SELECT COUNT(*) c FROM content_sources WHERE workspace_id = ? AND last_error IS NOT NULL', workspaceId).c,
    items7d: one(db, 'SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND COALESCE(published_at, created_at) >= ?', workspaceId, t - 7 * 86400000).c,
    hot: one(db, 'SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND status != \'archived\' AND outlier >= 2 AND COALESCE(published_at, created_at) >= ?', workspaceId, t - 7 * 86400000).c,
    scripts: one(db, 'SELECT COUNT(*) c FROM content_scripts WHERE workspace_id = ? AND status IN (\'draft\',\'approved\')', workspaceId).c,
    favorites: one(db, 'SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND status = \'picked\'', workspaceId).c
  };
}

// ------------------------------------------------------------------ scripts

function createScript(db, workspaceId, itemId, s, format, opts) {
  const t = Date.now();
  const sid = id('cscr');
  tx(db, () => {
    run(db, 'INSERT INTO content_scripts (id, workspace_id, item_id, topic_id, title, format, hooks, body, shot_list, cta, generator, status, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'draft\', ?, ?)',
    sid, workspaceId, itemId || null, (opts && opts.topicId) || null, s.title, format === 'long' ? 'long' : 'short', s.hooks || '', s.body || '', s.shot_list || '', s.cta || '', s.generator || 'manual', t, t);
    if (itemId) run(db, 'UPDATE content_items SET status = \'picked\' WHERE id = ? AND workspace_id = ? AND status = \'new\'', itemId, workspaceId);
    relevance.logEvent(db, workspaceId, { itemId, kind: 'script' });
  });
  return sid;
}

function listScripts(db, workspaceId, status) {
  const args = [workspaceId];
  let extra = '';
  if (status && SCRIPT_STATUSES.includes(status)) { extra = ' AND sc.status = ?'; args.push(status); }
  return all(db, 'SELECT sc.*, i.url item_url, i.platform item_platform FROM content_scripts sc ' +
    'LEFT JOIN content_items i ON i.id = sc.item_id WHERE sc.workspace_id = ?' + extra +
    ' ORDER BY CASE sc.status WHEN \'approved\' THEN 0 WHEN \'draft\' THEN 1 WHEN \'shot\' THEN 2 ELSE 3 END, ' +
    'sc.shoot_date IS NULL, sc.shoot_date, sc.updated_at DESC', ...args);
}

function getScript(db, workspaceId, scriptId) {
  return one(db, 'SELECT * FROM content_scripts WHERE id = ? AND workspace_id = ?', scriptId, workspaceId);
}

function updateScript(db, workspaceId, scriptId, form) {
  const cur = getScript(db, workspaceId, scriptId);
  if (!cur) return 0;
  const v = (k, max) => (form[k] == null ? cur[k] : String(form[k]).replace(/\r\n/g, '\n').slice(0, max || 20000));
  const status = SCRIPT_STATUSES.includes(form.status) ? form.status : cur.status;
  const date = form.shoot_date == null ? cur.shoot_date : (/^\d{4}-\d{2}-\d{2}$/.test(form.shoot_date) ? form.shoot_date : null);
  const pub = form.published_url == null ? cur.published_url : (/^https?:\/\//.test(form.published_url.trim()) ? form.published_url.trim().slice(0, 500) : null);
  return run(db, 'UPDATE content_scripts SET title = ?, hooks = ?, body = ?, shot_list = ?, cta = ?, status = ?, shoot_date = ?, published_url = ?, ' +
    'generator = CASE WHEN ? THEN \'manual\' ELSE generator END, updated_at = ? WHERE id = ? AND workspace_id = ?',
  v('title', 200) || cur.title, v('hooks', 2000), v('body'), v('shot_list', 8000), v('cta', 1000), status, date, pub,
  form.from_prompt ? 1 : 0, Date.now(), scriptId, workspaceId).changes;
}

function deleteScript(db, workspaceId, scriptId) {
  return run(db, 'DELETE FROM content_scripts WHERE id = ? AND workspace_id = ?', scriptId, workspaceId).changes;
}

/**
 * Фоновый сборщик: раз в 10 минут берёт источники, которым пора обновиться
 * (не чаще CONTENT_FETCH_HOURS), по одному с паузой. Один проход за раз - без наложений.
 */
function startCollector(db, opts) {
  const { cfg, log, everyMs } = opts;
  if (!cfg.content.collector) return null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await runDue(db, { cfg, log, pauseMs: 1500 });
      if (res.length) log('info', 'content sources collected', { count: res.length, failed: res.filter((r) => !r.ok).length });
      // Сводка и алерты - после сбора, когда скорость и темы уже пересчитаны.
      const { TelegramApi } = require('../platform/telegramApi');
      const api = (opts && opts.api) || new TelegramApi({ token: cfg.telegram.token, mode: cfg.telegram.mode });
      await require('./notify').tick(db, { cfg, api, log });
    } catch (e) {
      log('error', 'content collector failed', { error: String(e.message) });
    } finally { busy = false; }
  };
  const timer = setInterval(tick, everyMs || 600000);
  timer.unref();
  return timer;
}

module.exports = {
  startCollector, remeasureYoutube, clusterTouched,
  STATUSES, SCRIPT_STATUSES, getSettings, saveSettings, listSources, getSource, addSources, setSourceActive, deleteSource,
  upsertItems, collectSource, dueSources, runDue, collectWorkspace, importItems, feed, getItem, setItemStatus, stats,
  createScript, listScripts, getScript, updateScript, deleteScript
};
