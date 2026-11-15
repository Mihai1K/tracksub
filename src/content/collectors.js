'use strict';

/**
 * Сборщики публичных постов. Каждый возвращает { items, meta } в общем виде и ничего не пишет в БД.
 *
 * - Telegram: публичная веб-версия канала t.me/s/<канал>. Без аккаунта и без ключей,
 *   видны просмотры и реакции каждого поста. С сервера в России Telegram закрыт, поэтому
 *   базовый адрес настраивается (CONTENT_TG_WEB_BASE) - туда можно поставить свой прокси.
 * - VK: официальный API wall.get с сервисным ключом приложения (VK_SERVICE_TOKEN).
 * - YouTube: Data API v3 (YOUTUBE_API_KEY): тренды по региону, поиск по запросу, канал.
 *
 * fetch передаётся снаружи: в тестах подставляются записанные ответы.
 */

const UA = 'Mozilla/5.0 (compatible; TrackSubContent/1.0)';

// ------------------------------------------------------------------ helpers

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<i class="emoji"[^>]*>(?:<b>)?([^<]*)(?:<\/b>)?<\/i>/g, '$1')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** «6.61M», «56.1K», «1 234», «12,5K» → число. */
function parseCount(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? Math.round(s) : null;
  const t = String(s).trim().replace(/\s| /g, '').replace(',', '.');
  const m = t.match(/^(\d+(?:\.\d+)?)([KkMmBbКкМм]|тыс\.?|млн\.?)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = { k: 1e3, к: 1e3, 'тыс': 1e3, 'тыс.': 1e3, m: 1e6, м: 1e6, 'млн': 1e6, 'млн.': 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * mult);
}

function firstLine(text, max) {
  const line = String(text || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

async function getText(fetchFn, url, timeoutMs) {
  const res = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json' }, signal: AbortSignal.timeout(timeoutMs || 20000) });
  // ответ socksFetch - упрощённый, но с теми же ok/status/text()
  const body = await res.text();
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' от ' + new URL(url).host);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function getJson(fetchFn, url) {
  return JSON.parse(await getText(fetchFn, url));
}

/** Обязательные плашки («иностранный агент», «18+») не несут темы и забивают анонс. */
function stripBoilerplate(text) {
  return String(text || '')
    .replace(/^[^\n]*?(НАСТОЯЩИЙ|ДАННОЕ)\s+(МАТЕРИАЛ|СООБЩЕНИЕ)[\s\S]*?(ИНОСТРАНН[А-ЯЁ]+\s+АГЕНТ[А-ЯЁ]*|ЛИЦОМ)[^.\n]*[.\n]?\s*/i, '')
    .replace(/^\s*\d{2}\+\s*/, '')
    .trim();
}

// ------------------------------------------------------------------ handles

/** Из «https://t.me/s/channel», «@channel», «t.me/channel/123» → «channel». */
function normalizeHandle(platform, raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (platform === 'telegram') {
    s = s.replace(/^https?:\/\//, '').replace(/^(www\.)?(t\.me|telegram\.me)\/(s\/)?/, '').replace(/^@/, '');
    s = s.split(/[/?#]/)[0];
    return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s) ? s.toLowerCase() : null;
  }
  if (platform === 'vk') {
    s = s.replace(/^https?:\/\//, '').replace(/^(www\.|m\.)?vk\.(com|ru)\//, '').replace(/^@/, '');
    s = s.split(/[/?#]/)[0];
    return /^[A-Za-z0-9_.]{2,64}$/.test(s) ? s.toLowerCase() : null;
  }
  if (platform === 'youtube') {
    const m = s.match(/youtube\.com\/(@[A-Za-z0-9_.-]+)/);
    if (m) return m[1];
    if (/^@[A-Za-z0-9_.-]{2,}$/.test(s)) return s;
    return null;
  }
  return null;
}

/** Строка из формы «Добавить источники» → { platform, kind, handle } или null. */
function parseSourceLine(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  if (/t\.me\/|telegram\.me\//i.test(s) || /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) {
    const h = normalizeHandle('telegram', s);
    return h ? { platform: 'telegram', kind: 'channel', handle: h } : null;
  }
  if (/vk\.(com|ru)\//i.test(s)) {
    const h = normalizeHandle('vk', s);
    return h ? { platform: 'vk', kind: 'channel', handle: h } : null;
  }
  if (/youtube\.com\/@/i.test(s)) {
    const h = normalizeHandle('youtube', s);
    return h ? { platform: 'youtube', kind: 'channel', handle: h } : null;
  }
  const yt = s.match(/^(yt|youtube)\s*:\s*(.+)$/i);
  if (yt) {
    const q = yt[2].trim();
    if (/^(тренды|trending)(\s+[A-Za-z]{2})?$/i.test(q)) {
      const region = (q.split(/\s+/)[1] || 'RU').toUpperCase();
      return { platform: 'youtube', kind: 'trending', handle: region };
    }
    return { platform: 'youtube', kind: 'search', handle: q.slice(0, 120) };
  }
  return null;
}

// ------------------------------------------------------------------ Telegram

function parseTelegramPage(html, handle) {
  const items = [];
  const title = (html.match(/tgme_channel_info_header_title"><span dir="auto">([\s\S]*?)<\/span>/) || [])[1];
  let subscribers = null;
  const counters = html.match(/<span class="counter_value">([^<]+)<\/span>\s*<span class="counter_type">(subscribers?|подписчик[а-я]*)<\/span>/i);
  if (counters) subscribers = parseCount(counters[1]);

  const chunks = html.split('tgme_widget_message_wrap').slice(1);
  for (const chunk of chunks) {
    const post = (chunk.match(/data-post="([^"]+)"/) || [])[1];
    if (!post) continue;
    if (/service_message/.test(chunk.slice(0, 400))) continue;
    const textHtml = (chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const text = stripBoilerplate(htmlToText(textHtml));
    const views = parseCount((chunk.match(/tgme_widget_message_views">([^<]+)</) || [])[1]);
    const dt = (chunk.match(/<time datetime="([^"]+)"/) || [])[1];
    let reactions = 0;
    let hasReactions = false;
    for (const r of chunk.matchAll(/<span class="tgme_reaction[^"]*">(?:<[^>]+>(?:<\/[^>]+>)?)*\s*([\d.,]+[KkMm]?)<\/span>/g)) {
      const n = parseCount(r[1]);
      if (n != null) { reactions += n; hasReactions = true; }
    }
    const forwarded = /tgme_widget_message_forwarded_from/.test(chunk);
    const hasVideo = /tgme_widget_message_video/.test(chunk) || /roundvideo/.test(chunk);
    items.push({
      externalId: post,
      url: 'https://t.me/' + post,
      author: title ? htmlToText(title) : handle,
      title: firstLine(text, 140) || (hasVideo ? '[видео без подписи]' : '[пост без текста]'),
      body: text.slice(0, 4000),
      publishedAt: dt ? Date.parse(dt) : null,
      views,
      likes: hasReactions ? reactions : null,
      comments: null,
      shares: null,
      forwarded,
      media: hasVideo ? 'video' : null
    });
  }
  return { items, meta: { title: title ? htmlToText(title) : null, subscribers } };
}

async function collectTelegram(source, { fetch: fetchFn, cfg }) {
  const base = (cfg.content.tgWebBase || 'https://t.me').replace(/\/$/, '');
  const via = cfg.content.tgProxy ? require('./socks').socksFetch(cfg.content.tgProxy) : fetchFn;
  const html = await getText(via, base + '/s/' + encodeURIComponent(source.handle));
  if (!/tgme_channel_info|tgme_widget_message/.test(html)) {
    throw new Error('Канал не найден или закрыт: у приватных каналов нет публичной веб-версии');
  }
  const res = parseTelegramPage(html, source.handle);
  // Репосты чужих постов не показывают, что зашло автору, - в ленту их не берём.
  res.items = res.items.filter((i) => !i.forwarded);
  return res;
}

// ------------------------------------------------------------------ VK

function parseVkWall(json, handle) {
  if (json.error) {
    const err = new Error('VK API: ' + (json.error.error_msg || json.error.error_code));
    err.code = json.error.error_code;
    throw err;
  }
  const r = json.response || {};
  const group = (r.groups || [])[0] || (r.profiles || [])[0] || null;
  const items = [];
  for (const p of r.items || []) {
    if (p.marked_as_ads) continue;
    if (p.copy_history && p.copy_history.length) continue; // репост
    const text = String(p.text || '').trim();
    const hasVideo = (p.attachments || []).some((a) => a.type === 'video' || a.type === 'clip');
    items.push({
      externalId: p.owner_id + '_' + p.id,
      url: 'https://vk.com/wall' + p.owner_id + '_' + p.id,
      author: group ? (group.name || [group.first_name, group.last_name].filter(Boolean).join(' ')) : handle,
      title: firstLine(text, 140) || (hasVideo ? '[видео без подписи]' : '[пост без текста]'),
      body: text.slice(0, 4000),
      publishedAt: p.date ? p.date * 1000 : null,
      views: p.views ? p.views.count : null,
      likes: p.likes ? p.likes.count : null,
      comments: p.comments ? p.comments.count : null,
      shares: p.reposts ? p.reposts.count : null,
      pinned: !!p.is_pinned,
      media: hasVideo ? 'video' : null
    });
  }
  return { items, meta: { title: group ? group.name || null : null, subscribers: group && group.members_count != null ? group.members_count : null } };
}

async function collectVk(source, { fetch: fetchFn, cfg }) {
  if (!cfg.content.vkToken) throw new Error('Нет VK_SERVICE_TOKEN: сервисный ключ приложения из vk.com/apps?act=manage');
  const q = new URLSearchParams({
    domain: source.handle, count: '50', extended: '1', fields: 'members_count',
    access_token: cfg.content.vkToken, v: '5.199', lang: 'ru'
  });
  return parseVkWall(await getJson(fetchFn, 'https://api.vk.com/method/wall.get?' + q), source.handle);
}

// ------------------------------------------------------------------ YouTube

function ytVideoItems(videos, channelsById) {
  return (videos.items || []).map((v) => {
    const s = v.snippet || {};
    const st = v.statistics || {};
    const ch = channelsById[s.channelId];
    return {
      externalId: v.id,
      url: 'https://www.youtube.com/watch?v=' + v.id,
      author: s.channelTitle || null,
      title: s.title || '[без названия]',
      body: String(s.description || '').slice(0, 2000),
      publishedAt: s.publishedAt ? Date.parse(s.publishedAt) : null,
      views: st.viewCount != null ? parseInt(st.viewCount, 10) : null,
      likes: st.likeCount != null ? parseInt(st.likeCount, 10) : null,
      comments: st.commentCount != null ? parseInt(st.commentCount, 10) : null,
      shares: null,
      authorSubscribers: ch && ch.statistics && !ch.statistics.hiddenSubscriberCount && ch.statistics.subscriberCount != null
        ? parseInt(ch.statistics.subscriberCount, 10) : null,
      media: 'video'
    };
  });
}

async function collectYoutube(source, { fetch: fetchFn, cfg, now }) {
  const key = cfg.content.youtubeKey;
  if (!key) throw new Error('Нет YOUTUBE_API_KEY');
  const api = (path, params) => getJson(fetchFn, 'https://www.googleapis.com/youtube/v3/' + path + '?' +
    new URLSearchParams(Object.assign({ key }, params)));
  let videoIds = [];
  let meta = { title: null, subscribers: null };

  if (source.kind === 'trending') {
    const v = await api('videos', { part: 'snippet,statistics', chart: 'mostPopular', regionCode: source.handle || 'RU', maxResults: '50' });
    videoIds = (v.items || []).map((x) => x.id);
    meta.title = 'Тренды YouTube · ' + (source.handle || 'RU');
  } else if (source.kind === 'search') {
    const after = new Date((now || Date.now()) - 14 * 86400000).toISOString();
    const s = await api('search', { part: 'id', q: source.handle, type: 'video', order: 'viewCount', publishedAfter: after, regionCode: 'RU', relevanceLanguage: 'ru', maxResults: '25' });
    videoIds = (s.items || []).map((x) => x.id && x.id.videoId).filter(Boolean);
    meta.title = 'Поиск YouTube: ' + source.handle;
  } else {
    const ch = await api('channels', { part: 'snippet,statistics,contentDetails', forHandle: source.handle });
    const c = (ch.items || [])[0];
    if (!c) throw new Error('Канал YouTube не найден: ' + source.handle);
    meta = { title: c.snippet && c.snippet.title, subscribers: c.statistics && c.statistics.subscriberCount ? parseInt(c.statistics.subscriberCount, 10) : null };
    const uploads = c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads;
    const pl = await api('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '30' });
    videoIds = (pl.items || []).map((x) => x.contentDetails && x.contentDetails.videoId).filter(Boolean);
  }
  if (!videoIds.length) return { items: [], meta };

  const videos = await api('videos', { part: 'snippet,statistics', id: videoIds.slice(0, 50).join(',') });
  const channelIds = [...new Set((videos.items || []).map((v) => v.snippet && v.snippet.channelId).filter(Boolean))];
  const channelsById = {};
  if (channelIds.length) {
    const chs = await api('channels', { part: 'statistics', id: channelIds.slice(0, 50).join(',') });
    for (const c of chs.items || []) channelsById[c.id] = c;
  }
  let items = ytVideoItems(videos, channelsById);
  // Поиск по русскому запросу всё равно подмешивает ролики на других языках - оставляем кириллицу.
  if (source.kind === 'search' && /[а-яё]/i.test(source.handle)) {
    items = items.filter((i) => /[а-яё]/i.test(i.title + ' ' + i.body.slice(0, 300)) && !/[\u0900-\u0DFF]/.test(i.title));
  }
  return { items, meta };
}

/** Метрики роликов YouTube по ID: { id: { views, likes, comments } }. До 50 ID за запрос. */
async function youtubeStats(ids, { fetch: fetchFn, cfg }) {
  if (!ids.length) return {};
  const q = new URLSearchParams({ key: cfg.content.youtubeKey, part: 'statistics', id: ids.slice(0, 50).join(',') });
  const data = await getJson(fetchFn, 'https://www.googleapis.com/youtube/v3/videos?' + q);
  const out = {};
  for (const v of data.items || []) {
    const st = v.statistics || {};
    out[v.id] = {
      views: st.viewCount != null ? parseInt(st.viewCount, 10) : null,
      likes: st.likeCount != null ? parseInt(st.likeCount, 10) : null,
      comments: st.commentCount != null ? parseInt(st.commentCount, 10) : null
    };
  }
  return out;
}

const COLLECTORS = { telegram: collectTelegram, vk: collectVk, youtube: collectYoutube };

module.exports = {
  COLLECTORS, youtubeStats, stripBoilerplate, parseTelegramPage, parseVkWall, ytVideoItems,
  parseCount, normalizeHandle, parseSourceLine, htmlToText, firstLine
};
