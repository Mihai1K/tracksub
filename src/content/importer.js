'use strict';

/**
 * Ручной импорт референсов: vidIQ, ChatPlace Virale и любые ссылки.
 *
 * vidIQ работает через MCP в чате, у Virale лента отдаётся только по ключу платного плана.
 * Пока ключей нет, выдачу копируют сюда: JSON (массив или { items|results|videos|data: [...] }),
 * CSV/TSV с заголовком или просто список ссылок построчно. Названия колонок понимаем гибко.
 */

const { parseCount, firstLine } = require('./collectors');

const ALIASES = {
  url: ['url', 'link', 'video_url', 'videourl', 'permalink', 'post_url', 'href', 'ссылка'],
  title: ['title', 'name', 'caption', 'text', 'description', 'название', 'заголовок', 'текст'],
  views: ['views', 'view_count', 'viewcount', 'plays', 'play_count', 'playcount', 'просмотры'],
  likes: ['likes', 'like_count', 'likecount', 'reactions', 'лайки'],
  comments: ['comments', 'comment_count', 'commentcount', 'комментарии'],
  shares: ['shares', 'share_count', 'reposts', 'репосты'],
  author: ['author', 'channel', 'channel_title', 'channeltitle', 'channel_name', 'username', 'creator', 'account', 'автор', 'канал'],
  subscribers: ['subscribers', 'followers', 'subscriber_count', 'subscribercount', 'follower_count', 'подписчики'],
  published: ['published_at', 'publishedat', 'published', 'date', 'upload_date', 'created_at', 'createtime', 'дата'],
  score: ['score', 'outlier', 'outlier_score', 'outlierscore', 'multiplier', 'vph', 'viral_score', 'virality'],
  platform: ['platform', 'network', 'source', 'площадка']
};

const norm = (k) => String(k || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

function pick(obj, field) {
  const keys = Object.keys(obj);
  for (const alias of ALIASES[field]) {
    const k = keys.find((x) => norm(x) === alias);
    if (k != null && obj[k] !== '' && obj[k] != null) return obj[k];
  }
  return null;
}

function platformOf(url, hint) {
  const h = String(hint || '').toLowerCase();
  for (const p of ['youtube', 'instagram', 'tiktok', 'telegram', 'vk', 'threads']) if (h.includes(p)) return p;
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch (e) { return 'other'; }
  if (/youtube\.com|youtu\.be/.test(host)) return 'youtube';
  if (/instagram\.com/.test(host)) return 'instagram';
  if (/tiktok\.com/.test(host)) return 'tiktok';
  if (/t\.me|telegram\./.test(host)) return 'telegram';
  if (/vk\.(com|ru)|vkvideo\.ru/.test(host)) return 'vk';
  if (/threads\.(net|com)/.test(host)) return 'threads';
  return 'other';
}

function parseDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) { const n = parseInt(s, 10); return n < 1e12 ? n * 1000 : n; }
  if (/^\d{8}$/.test(s)) return Date.parse(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6) + 'T00:00:00Z');
  const ru = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (ru) return Date.UTC(+ru[3], +ru[2] - 1, +ru[1]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function cleanUrl(u) {
  const s = String(u || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const url = new URL(s);
    for (const k of [...url.searchParams.keys()]) if (/^utm_|^si$|^igsh|^fbclid$/.test(k)) url.searchParams.delete(k);
    url.hash = '';
    return url.toString();
  } catch (e) { return null; }
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function rowsFromText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t[0] === '[' || t[0] === '{') {
    const data = JSON.parse(t);
    if (Array.isArray(data)) return data;
    for (const k of ['items', 'results', 'videos', 'data', 'posts', 'outliers']) if (Array.isArray(data[k])) return data[k];
    return [data];
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0];
  const delim = ['\t', ';', ','].find((d) => head.includes(d) && /[A-Za-zА-Яа-я]/.test(head) && !/^https?:\/\//.test(head));
  if (delim) {
    const cols = splitCsvLine(head, delim);
    return lines.slice(1).map((l) => {
      const v = splitCsvLine(l, delim);
      const o = {};
      cols.forEach((c, i) => { o[c] = v[i]; });
      return o;
    });
  }
  // Просто ссылки: «ссылка [заметка]».
  return lines.map((l) => {
    const m = l.match(/(https?:\/\/\S+)\s*(.*)$/);
    return m ? { url: m[1], title: m[2] || null } : null;
  }).filter(Boolean);
}

/**
 * Разбор вставки. provider: vidiq | virale | manual.
 * Возвращает { items, skipped } в общем виде сборщиков.
 */
function parseImport(text, provider) {
  let rows;
  try { rows = rowsFromText(text); } catch (e) { throw new Error('Не получилось разобрать JSON: ' + e.message); }
  const items = [];
  let skipped = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') { skipped++; continue; }
    let url = cleanUrl(pick(r, 'url'));
    if (!url && r.id && /^[A-Za-z0-9_-]{11}$/.test(String(r.id)) && (provider === 'vidiq' || r.channelTitle)) {
      url = 'https://www.youtube.com/watch?v=' + r.id; // выдача vidIQ по YouTube часто без ссылки
    }
    if (!url) { skipped++; continue; }
    const title = pick(r, 'title');
    const score = pick(r, 'score');
    items.push({
      externalId: null,
      url,
      platform: platformOf(url, pick(r, 'platform')),
      author: pick(r, 'author') != null ? String(pick(r, 'author')).slice(0, 200) : null,
      title: title ? firstLine(String(title), 160) : null,
      body: title ? String(title).slice(0, 4000) : null,
      publishedAt: parseDate(pick(r, 'published')),
      views: parseCount(pick(r, 'views')),
      likes: parseCount(pick(r, 'likes')),
      comments: parseCount(pick(r, 'comments')),
      shares: parseCount(pick(r, 'shares')),
      authorSubscribers: parseCount(pick(r, 'subscribers')),
      providerScore: score != null && Number.isFinite(parseFloat(String(score).replace(',', '.').replace(/x$/i, '')))
        ? parseFloat(String(score).replace(',', '.').replace(/x$/i, '')) : null
    });
  }
  return { items, skipped };
}

module.exports = { parseImport, platformOf, parseDate, cleanUrl, rowsFromText };
