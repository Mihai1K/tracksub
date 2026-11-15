'use strict';

/**
 * Свои публикации: сценарий → ролик/пост на площадке → метрики по времени.
 *
 * Метрики собираются сами там, где это бесплатно и без входа в аккаунт:
 * - YouTube: videos.list по ID (ключ API уже есть);
 * - Telegram: встраиваемая страница поста t.me/<канал>/<id>?embed=1 - просмотры и реакции;
 * - VK: пост на стене (vk.com/wall-1_2) - wall.getById сервисным ключом.
 * Instagram, TikTok, клипы VK, Threads - вручную (их API требуют входа в аккаунт владельца).
 *
 * Результат считается на вехах 24 ч / 72 ч / 7 дней от публикации - так ролики разного возраста
 * сравнимы. Веха берётся из ближайшего замера в окне ±40% от неё; нет замера - пусто, не угадываем.
 */

const { id } = require('../ids');
const { platformOf, cleanUrl } = require('./importer');
const C = require('./collectors');

const HOUR = 3600000;
const MILESTONES = [['v24', 24], ['v72', 72], ['v7d', 168]];
const TRACK_DAYS = 8;

function ytId(url) {
  const m = String(url).match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function tgPost(url) {
  const m = String(url).match(/t\.me\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})\/(\d+)/);
  return m ? { channel: m[1], post: m[2] } : null;
}
function vkWall(url) {
  const m = String(url).match(/vk\.(?:com|ru)\/(?:[^?#]*[?&]w=)?wall(-?\d+_\d+)/);
  return m ? m[1] : null;
}

/** Можно ли мерить автоматически и как. */
function autoMode(url) {
  if (ytId(url)) return 'youtube';
  if (tgPost(url)) return 'telegram';
  if (vkWall(url)) return 'vk';
  return null;
}

function addPublication(db, workspaceId, scriptId, { url, platform, publishedAt, hookIndex, hookText }, now) {
  const t = now || Date.now();
  const sc = db.prepare('SELECT id FROM content_scripts WHERE id = ? AND workspace_id = ?').get(scriptId, workspaceId);
  if (!sc) throw new Error('Сценарий не найден');
  const clean = cleanUrl(url);
  if (!clean) throw new Error('Нужна ссылка на опубликованный ролик или пост');
  const pid = id('cpub');
  db.prepare('INSERT INTO content_publications (id, workspace_id, script_id, platform, url, published_at, hook_index, hook_text, auto, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(pid, workspaceId, scriptId, platform || platformOf(clean), clean, publishedAt || t,
      hookIndex == null ? null : hookIndex, hookText ? String(hookText).slice(0, 300) : null, autoMode(clean) ? 1 : 0, t);
  db.prepare('UPDATE content_scripts SET status = \'published\', published_url = COALESCE(published_url, ?), updated_at = ? WHERE id = ?').run(clean, t, scriptId);
  return pid;
}

function addMetrics(db, workspaceId, publicationId, m, now) {
  const p = db.prepare('SELECT id FROM content_publications WHERE id = ? AND workspace_id = ?').get(publicationId, workspaceId);
  if (!p) return false;
  const n = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Math.max(0, Math.round(Number(x))));
  if (n(m.views) == null && n(m.likes) == null && n(m.leads) == null && n(m.clicks) == null) return false;
  db.prepare('INSERT OR REPLACE INTO content_publication_metrics (publication_id, observed_at, views, likes, comments, shares, saves, clicks, leads, source) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, m.observedAt || now || Date.now(), n(m.views), n(m.likes), n(m.comments), n(m.shares), n(m.saves), n(m.clicks), n(m.leads), m.source || 'manual');
  return true;
}

async function fetchMetrics(url, { fetch: fetchFn, cfg }) {
  const f = fetchFn || fetch;
  const yt = ytId(url);
  if (yt) {
    if (!cfg.content.youtubeKey) throw new Error('нет YOUTUBE_API_KEY');
    const s = (await C.youtubeStats([yt], { fetch: f, cfg }))[yt];
    if (!s) throw new Error('ролик не найден или скрыт');
    return { views: s.views, likes: s.likes, comments: s.comments };
  }
  const tg = tgPost(url);
  if (tg) {
    const base = (cfg.content.tgWebBase || 'https://t.me').replace(/\/$/, '');
    const via = cfg.content.tgProxy ? require('./socks').socksFetch(cfg.content.tgProxy) : f;
    const res = await via(base + '/' + tg.channel + '/' + tg.post + '?embed=1&mode=tme', { headers: { 'user-agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const views = C.parseCount((html.match(/tgme_widget_message_views">([^<]+)</) || [])[1]);
    if (views == null) throw new Error('пост не найден или канал закрыт');
    let likes = 0;
    for (const r of html.matchAll(/<span class="tgme_reaction[^"]*">(?:<[^>]+>(?:<\/[^>]+>)?)*\s*([\d.,]+[KkMm]?)<\/span>/g)) likes += C.parseCount(r[1]) || 0;
    return { views, likes: likes || null };
  }
  const vk = vkWall(url);
  if (vk) {
    if (!cfg.content.vkToken) throw new Error('нет VK_SERVICE_TOKEN');
    const q = new URLSearchParams({ posts: vk, access_token: cfg.content.vkToken, v: '5.199' });
    const res = await f('https://api.vk.com/method/wall.getById?' + q);
    const data = JSON.parse(await res.text());
    if (data.error) throw new Error('VK API: ' + (data.error.error_msg || data.error.error_code));
    const p = ((data.response && (data.response.items || data.response)) || [])[0];
    if (!p) throw new Error('пост не найден');
    return { views: p.views && p.views.count, likes: p.likes && p.likes.count, comments: p.comments && p.comments.count, shares: p.reposts && p.reposts.count };
  }
  throw new Error('эту площадку автоматически не мерим - внесите цифры вручную');
}

/** Перезамер своих публикаций: первые 3 суток раз в 6 ч, потом раз в сутки, до 8 дней. */
async function remeasure(db, { cfg, fetch: fetchFn, now, log }) {
  const t = now || Date.now();
  const rows = db.prepare('SELECT p.*, (SELECT MAX(observed_at) FROM content_publication_metrics m WHERE m.publication_id = p.id AND m.source = \'auto\') last ' +
    'FROM content_publications p WHERE p.auto = 1 AND p.published_at >= ?').all(t - TRACK_DAYS * 24 * HOUR);
  let done = 0;
  for (const p of rows) {
    const age = t - p.published_at;
    const every = age < 72 * HOUR ? 6 * HOUR : 24 * HOUR;
    if (p.last && t - p.last < every - 10 * 60000) continue;
    try {
      const m = await fetchMetrics(p.url, { fetch: fetchFn, cfg });
      addMetrics(db, p.workspace_id, p.id, Object.assign({ observedAt: t, source: 'auto' }, m), t);
      db.prepare('UPDATE content_publications SET last_error = NULL WHERE id = ?').run(p.id);
      done++;
    } catch (e) {
      db.prepare('UPDATE content_publications SET last_error = ? WHERE id = ?').run(String(e.message).slice(0, 200), p.id);
      if (log) log('warn', 'content publication metrics failed', { publication: p.id, error: String(e.message).slice(0, 200) });
    }
  }
  return done;
}

/** Значение метрики на вехе: замер в окне ±40% от вехи, ближайший к ней. */
function atMilestone(series, publishedAt, hours) {
  const target = publishedAt + hours * HOUR;
  const tol = hours * 0.4 * HOUR;
  let best = null;
  for (const s of series) {
    if (s.views == null) continue;
    const d = Math.abs(s.observed_at - target);
    if (d <= tol && (!best || d < best.d)) best = { d, v: s.views };
  }
  return best ? best.v : null;
}

/** Публикации пространства с метриками на вехах и происхождением темы. */
function results(db, workspaceId) {
  const pubs = db.prepare('SELECT p.*, sc.title script_title, sc.format, sc.item_id, sc.topic_id, ' +
    'i.provider item_provider, i.platform item_platform, i.outlier item_outlier, i.relevance item_relevance, ' +
    'COALESCE(src.title, src.handle, i.author) source_name, tp.sources_count topic_sources ' +
    'FROM content_publications p JOIN content_scripts sc ON sc.id = p.script_id ' +
    'LEFT JOIN content_items i ON i.id = sc.item_id LEFT JOIN content_sources src ON src.id = i.source_id ' +
    'LEFT JOIN content_topics tp ON tp.id = sc.topic_id ' +
    'WHERE p.workspace_id = ? ORDER BY p.published_at DESC').all(workspaceId);
  const seriesOf = db.prepare('SELECT * FROM content_publication_metrics WHERE publication_id = ? ORDER BY observed_at');
  return pubs.map((p) => {
    const s = seriesOf.all(p.id);
    const last = s[s.length - 1] || {};
    const sum = (k) => s.reduce((a, x) => Math.max(a, x[k] || 0), 0) || null; // накопительные - берём максимум
    const out = Object.assign({}, p, { series: s, views: last.views == null ? null : last.views, likes: sum('likes'), leads: sum('leads'), clicks: sum('clicks') });
    for (const [k, h] of MILESTONES) out[k] = atMilestone(s, p.published_at, h);
    return out;
  });
}

function median(xs) {
  const a = xs.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/**
 * Разбивка результатов: медиана просмотров на 72 ч (если вехи нет - последние просмотры) по группам.
 * Меньше 3 публикаций в группе - помечаем «мало данных»: выводы делать рано.
 */
function breakdown(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups].map(([key, list]) => ({
    key, count: list.length,
    median72: median(list.map((r) => (r.v72 != null ? r.v72 : r.views))),
    leads: list.reduce((a, r) => a + (r.leads || 0), 0),
    few: list.length < 3
  })).sort((a, b) => (b.median72 || 0) - (a.median72 || 0));
}

function listForScript(db, workspaceId, scriptId) {
  return results(db, workspaceId).filter((r) => r.script_id === scriptId);
}

function deletePublication(db, workspaceId, publicationId) {
  return db.prepare('DELETE FROM content_publications WHERE id = ? AND workspace_id = ?').run(publicationId, workspaceId).changes;
}

module.exports = { ytId, tgPost, vkWall, autoMode, addPublication, addMetrics, fetchMetrics, remeasure, atMilestone, results, breakdown, listForScript, deletePublication, median, MILESTONES };
