'use strict';

/**
 * Склейка инфоповодов: посты разных источников об одном событии - одна тема с «температурой».
 *
 * Без LLM, поэтому осторожно: ложная склейка хуже пропущенной. Дайджесты («Вечерняя рассылка») не склеиваются.
 * - Текст поста → признаки: слова-основы (обрезка окончаний), с весом редкости по корпусу (IDF).
 *   «Опорные» признаки - имена собственные, латиница (бренды), числа - весят вдвое и обязательны:
 *   без двух общих опорных признаков посты не склеиваются. «Новая модель ChatGPT» и «ChatGPT подорожал»
 *   делят один бренд - этого мало.
 * - Пост присоединяется к теме, если похож на её «центр» (сумма векторов участников), а не на одного
 *   участника: так цепочка A~B~C не сливает A и C, которые друг на друга не похожи.
 * - Окно 3 суток: тема живёт, пока в неё приходят посты.
 * - Уже назначенные посты не переназначаются: номера тем стабильны для избранного и ссылок.
 *
 * Температура: независимые источники × log2(1 + сумма просмотров) × свежесть × (1 + разгон/5),
 * где разгон - лучшая «скорость к норме канала» среди постов темы (до ×5).
 */

const { id } = require('../ids');

const DAY = 86400000;
const WINDOW = 3 * DAY;
const SIM_JOIN = 0.28;
const MIN_ANCHORS = 2;
const DIGEST = /(рассылк|дайджест|главное за|итоги (дня|недели)|что произошло за|новости (дня|недели)|подборк)/i;

const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему ' +
  'теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть ' +
  'надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь ' +
  'этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти ' +
  'нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно ' +
  'всю между это также который которые которая которое году года лет млн млрд тыс руб рублей процентов человек время новый новая новые новое ' +
  'сообщает пишет заявил заявила стало стал стала говорит рассказал рассказали подробнее читать источник фото видео канал подписаться ' +
  'the and for with that this from are was you your our has have will about into new more how what why').split(/\s+/));

/** Обрезка окончаний: грубо, но сводит «нейросети/нейросетями/нейросеть» к одной основе. */
function stem(w) {
  if (w.length <= 3) return w; // СВО, ДТП, суд - короткие слова не режем
  if (/^[a-z0-9]/.test(w)) return w.length > 6 ? w.slice(0, 6) : w;
  return w.length > 6 ? w.slice(0, 6) : w.replace(/(ами|ями|ов|ев|ей|ам|ям|ах|ях|ом|ем|ой|ий|ый|ая|ое|ые|ую|а|я|ы|и|у|ю|е|о)$/, '') || w;
}

/** Признаки поста: { stems: Map<основа, вес>, anchors: Set<основа> }. */
function features(text) {
  const t = String(text || '').slice(0, 600)
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#]/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}️]/gu, ' ');
  const stems = new Map();
  const anchors = new Set();
  for (const m of t.matchAll(/[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9+-]*|\d[\d.,%]*/g)) {
    const raw = m[0];
    if (/^\d/.test(raw)) {
      const n = raw.replace(/[.,]+$/, '');
      // годы и мелкие числа - шум; суммы, проценты, модели - опора
      if ((n.replace(/\D/g, '').length >= 3 && !/^20[12]\d$/.test(n)) || n.includes('%')) { const k = '#' + n; stems.set(k, 1); anchors.add(k); }
      continue;
    }
    const lower = raw.toLowerCase().replace(/ё/g, 'е');
    // короткие аббревиатуры (ИИ, AI, PR, IT) - смысловые слова для релевантности, но не опора склейки
    if (lower.length === 2 && /^[A-ZА-ЯЁ]{2}$/.test(raw)) { stems.set(lower, 1); continue; }
    if (lower.length < 3 || STOP.has(lower)) continue;
    const s = stem(lower);
    if (STOP.has(s)) continue;
    stems.set(s, 1);
    const before = t.slice(Math.max(0, m.index - 3), m.index);
    const sentenceStart = m.index === 0 || /[.!?\n«"]\s*$/.test(before) || /^\s*$/.test(t.slice(0, m.index));
    const latin = /^[A-Za-z]/.test(raw);
    const proper = /^[A-ZА-ЯЁ]/.test(raw) && !sentenceStart;
    if ((latin && raw.length >= 3) || proper || /^[A-ZА-ЯЁ]{2,}$/.test(raw)) anchors.add(s);
  }
  return { stems, anchors };
}

function vectorize(f, idf) {
  const v = new Map();
  let norm = 0;
  for (const s of f.stems.keys()) {
    const w = (idf.get(s) || idf.default) * (f.anchors.has(s) ? 2 : 1);
    v.set(s, w);
    norm += w * w;
  }
  return { v, norm: Math.sqrt(norm) || 1, anchors: f.anchors };
}

function cosine(a, b) {
  let dot = 0;
  const [small, big] = a.v.size < b.v.size ? [a, b] : [b, a];
  for (const [k, w] of small.v) { const o = big.v.get(k); if (o) dot += w * o; }
  return dot / (a.norm * b.norm);
}

function sharedAnchors(a, b) {
  let n = 0;
  for (const k of a.anchors) if (b.anchors.has(k)) n++;
  return n;
}

/** IDF по постам пространства за 14 дней. */
function buildIdf(docs) {
  const df = new Map();
  for (const f of docs) for (const s of f.stems.keys()) df.set(s, (df.get(s) || 0) + 1);
  const N = docs.length || 1;
  const idf = new Map();
  for (const [s, n] of df) idf.set(s, Math.log(1 + N / n));
  idf.default = Math.log(1 + N);
  return idf;
}

/** Центр темы: сумма векторов участников. Опорные признаки - встречающиеся хотя бы у двух участников (или у единственного). */
function centroid(members) {
  const v = new Map();
  const count = new Map();
  for (const m of members) {
    for (const [k, w] of m.vec.v) v.set(k, (v.get(k) || 0) + w);
    for (const a of m.vec.anchors) count.set(a, (count.get(a) || 0) + 1);
  }
  let norm = 0;
  for (const w of v.values()) norm += w * w;
  const need = members.length > 1 ? 2 : 1;
  const anchors = new Set([...count].filter(([, n]) => n >= need).map(([k]) => k));
  if (!anchors.size) for (const k of count.keys()) anchors.add(k);
  return { v, norm: Math.sqrt(norm) || 1, anchors };
}

const { stripBoilerplate } = require('./collectors');
const textOf = (it) => stripBoilerplate((it.title || '') + '\n' + (it.body || ''));
// Источник поста: канал/паблик, а для импорта - автор. Посты одного источника между собой не склеиваем:
// у канала общие слова (своё название, рубрики), и это не значит, что событие то же.
const srcOf = (it) => it.source_id || 'a:' + String(it.author || it.id).toLowerCase();

/**
 * Назначить темы новым постам пространства. Возвращает число затронутых тем.
 */
function clusterWorkspace(db, workspaceId, now) {
  const t = now || Date.now();
  const corpus = db.prepare('SELECT id, title, body FROM content_items WHERE workspace_id = ? AND COALESCE(published_at, created_at) >= ?')
    .all(workspaceId, t - 14 * DAY);
  if (!corpus.length) return 0;
  const feats = new Map(corpus.map((it) => [it.id, features(textOf(it))]));
  const idf = buildIdf([...feats.values()]);

  const recent = db.prepare('SELECT i.id, i.title, i.body, i.source_id, i.author, COALESCE(i.published_at, i.created_at) ts, ti.topic_id ' +
    'FROM content_items i LEFT JOIN content_topic_items ti ON ti.item_id = i.id ' +
    'WHERE i.workspace_id = ? AND i.status != \'archived\' AND COALESCE(i.published_at, i.created_at) >= ? ORDER BY ts')
    .all(workspaceId, t - WINDOW);

  const topics = new Map(); // topic_id -> { members }
  for (const it of recent) {
    const vec = vectorize(feats.get(it.id) || features(textOf(it)), idf);
    it.vec = vec;
    if (it.topic_id) {
      if (!topics.has(it.topic_id)) topics.set(it.topic_id, { id: it.topic_id, members: [], last: 0 });
      const tp = topics.get(it.topic_id);
      tp.members.push(it);
      tp.last = Math.max(tp.last, it.ts);
    }
  }

  const insTopic = db.prepare('INSERT INTO content_topics (id, workspace_id, title, first_seen_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insLink = db.prepare('INSERT OR IGNORE INTO content_topic_items (topic_id, item_id, similarity, added_by, created_at) VALUES (?, ?, ?, \'auto\', ?)');
  const blocked = db.prepare('SELECT 1 x FROM content_topic_splits WHERE item_id = ? AND topic_id = ?');
  const touched = new Set();

  for (const it of recent) {
    if (it.topic_id) continue;
    if (it.vec.anchors.size < MIN_ANCHORS) continue; // без опорных признаков тему не определить
    if (DIGEST.test(it.title || '')) continue;        // дайджест пересказывает много тем сразу
    let best = null;
    for (const tp of topics.values()) {
      if (it.ts - tp.last > WINDOW) continue;
      if (blocked.get(it.id, tp.id)) continue; // пользователь отделил этот пост от темы
      if (tp.members.every((m) => srcOf(m) === srcOf(it))) continue;
      const c = tp.centroid || (tp.centroid = centroid(tp.members));
      if (sharedAnchors(it.vec, c) < MIN_ANCHORS) continue;
      const sim = cosine(it.vec, c);
      if (sim >= SIM_JOIN && (!best || sim > best.sim)) best = { tp, sim };
    }
    // Новые посты сравниваем и с одиночками без темы: пара похожих постов рождает тему.
    if (!best) {
      for (const other of recent) {
        if (other === it || other.topic_id || !other.vec || other.ts > it.ts) continue;
        if (srcOf(other) === srcOf(it) || DIGEST.test(other.title || '')) continue;
        if (it.ts - other.ts > WINDOW) continue;
        if (sharedAnchors(it.vec, other.vec) < MIN_ANCHORS) continue;
        const sim = cosine(it.vec, other.vec);
        if (sim >= SIM_JOIN && (!best || sim > best.sim)) best = { other, sim };
      }
      if (best && best.other) {
        const tid = id('ctop');
        insTopic.run(tid, workspaceId, (best.other.title || '').slice(0, 200), best.other.ts, it.ts, t);
        insLink.run(tid, best.other.id, 1, t);
        best.other.topic_id = tid;
        const tp = { id: tid, members: [best.other], last: best.other.ts };
        topics.set(tid, tp);
        best = { tp, sim: best.sim };
      }
    }
    if (best && best.tp) {
      insLink.run(best.tp.id, it.id, Math.round(best.sim * 1000) / 1000, t);
      it.topic_id = best.tp.id;
      best.tp.members.push(it);
      best.tp.last = Math.max(best.tp.last, it.ts);
      best.tp.centroid = null;
      touched.add(best.tp.id);
    }
  }
  refreshTopics(db, workspaceId, t);
  return touched.size;
}

function freshness(ageMs) {
  const days = ageMs / DAY;
  return days <= 1 ? 1 : Math.max(0.15, Math.pow(0.5, (days - 1) / 2));
}

/** Пересчёт сводки тем: источники, просмотры, разгон, заголовок, температура. */
function refreshTopics(db, workspaceId, now) {
  const t = now || Date.now();
  const list = db.prepare('SELECT id FROM content_topics WHERE workspace_id = ? AND last_seen_at >= ?').all(workspaceId, t - 14 * DAY);
  const members = db.prepare('SELECT i.id, i.title, i.views, i.velocity, i.velocity_ratio, i.score, i.source_id, i.author, i.platform, ' +
    'COALESCE(i.published_at, i.created_at) ts FROM content_topic_items ti JOIN content_items i ON i.id = ti.item_id WHERE ti.topic_id = ?');
  const upd = db.prepare('UPDATE content_topics SET title = ?, primary_item_id = ?, first_seen_at = ?, last_seen_at = ?, items_count = ?, ' +
    'sources_count = ?, platforms = ?, views_sum = ?, velocity_sum = ?, max_ratio = ?, heat = ?, updated_at = ? WHERE id = ?');
  for (const { id: tid } of list) {
    const m = members.all(tid);
    if (!m.length) continue;
    const sources = new Set(m.map((x) => x.source_id || 'a:' + (x.author || x.id)));
    const views = m.reduce((s, x) => s + (x.views || 0), 0);
    const vel = m.reduce((s, x) => s + (x.velocity || 0), 0);
    const ratio = Math.max(0, ...m.map((x) => x.velocity_ratio || 0));
    const first = Math.min(...m.map((x) => x.ts));
    const last = Math.max(...m.map((x) => x.ts));
    // Заголовок - у самого сильного поста (по залётности, потом по просмотрам).
    const goodTitle = (x) => x.title && !/^\s*https?:\/\//.test(x.title) && !/^\[/.test(x.title);
    const primary = [...m].sort((a, b) => (goodTitle(b) - goodTitle(a)) || (b.views || 0) - (a.views || 0))[0];
    const heat = sources.size * Math.log2(1 + views) * freshness(t - last) * (1 + Math.min(ratio, 5) / 5);
    upd.run((primary.title || '').slice(0, 200), primary.id, first, last, m.length, sources.size,
      [...new Set(m.map((x) => x.platform))].join(','), views, Math.round(vel * 10) / 10, ratio || null,
      Math.round(heat * 100) / 100, t, tid);
  }
}

/** Темы пространства: по умолчанию от 2 независимых источников, горячие сверху. */
function listTopics(db, workspaceId, { days, minSources, status, now, limit, rel }) {
  const t = now || Date.now();
  // Наши темы выше: температура × (0,4 + 0,6 × релевантность). «Не наше» (< 0,2) скрыто, пока не попросили всё.
  const relWhere = rel === 'all' ? '' : rel === 'on' ? ' AND relevance >= 0.5' : ' AND (relevance IS NULL OR relevance >= 0.2)';
  return db.prepare('SELECT * FROM content_topics WHERE workspace_id = ? AND last_seen_at >= ? AND sources_count >= ? AND status = ?' + relWhere +
    ' ORDER BY heat * (0.4 + 0.6 * COALESCE(relevance, 1)) DESC LIMIT ?').all(workspaceId, t - (days || 3) * DAY, minSources || 2, status || 'active', limit || 50);
}

function topicItems(db, workspaceId, topicId) {
  return db.prepare('SELECT i.*, s.handle source_handle, ti.similarity, ti.added_by FROM content_topic_items ti ' +
    'JOIN content_items i ON i.id = ti.item_id LEFT JOIN content_sources s ON s.id = i.source_id ' +
    'JOIN content_topics tp ON tp.id = ti.topic_id WHERE ti.topic_id = ? AND tp.workspace_id = ? ' +
    'ORDER BY COALESCE(i.published_at, i.created_at)').all(topicId, workspaceId);
}

function getTopic(db, workspaceId, topicId) {
  return db.prepare('SELECT * FROM content_topics WHERE id = ? AND workspace_id = ?').get(topicId, workspaceId);
}

/** «Это другая тема»: пост выходит из темы и больше в неё автоматически не попадёт. */
function splitItem(db, workspaceId, topicId, itemId, now) {
  const tp = getTopic(db, workspaceId, topicId);
  if (!tp) return 0;
  const n = db.prepare('DELETE FROM content_topic_items WHERE topic_id = ? AND item_id = ?').run(topicId, itemId).changes;
  db.prepare('INSERT OR IGNORE INTO content_topic_splits (topic_id, item_id, created_at) VALUES (?, ?, ?)').run(topicId, itemId, now || Date.now());
  refreshTopics(db, workspaceId, now);
  return n;
}

function setTopicStatus(db, workspaceId, topicId, status) {
  if (!['active', 'archived'].includes(status)) return 0;
  return db.prepare('UPDATE content_topics SET status = ? WHERE id = ? AND workspace_id = ?').run(status, topicId, workspaceId).changes;
}

module.exports = { features, stem, buildIdf, vectorize, cosine, sharedAnchors, clusterWorkspace, refreshTopics, listTopics, topicItems, getTopic, splitItem, setTopicStatus, SIM_JOIN, MIN_ANCHORS };
