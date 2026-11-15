'use strict';

/**
 * Релевантность: подходит ли пост этому пространству (личный блог и Blogger Market считаются отдельно).
 *
 * Без LLM и прозрачно - всегда видно, по каким словам решено:
 * 1. Слова интересов: из профиля автора («Темы», «Для кого»), расширенные словарём ниш
 *    (написал «ИИ» - ищем и «нейросеть», «ChatGPT», «Claude»...).
 * 2. Стоп-темы (поле профиля): совпадение режет оценку до «не наше».
 * 3. Обучение на кнопках 👍 / 👎: опорные слова оценённых постов (бренды, имена) получают
 *    небольшой плюс или минус. Вес ограничен, один клик не переворачивает ленту.
 * 4. Ручная оценка поста всегда главнее расчёта.
 *
 * score 0..1 = 1 - exp(-сумма весов совпавших слов / 2). Проценты - ориентир, не вероятность успеха.
 */

const { features, stem } = require('./topics');
const { stripBoilerplate } = require('./collectors');

// Словарь ниш: ключ - основа, которая может встретиться в профиле; значение - что искать в постах.
const LEXICON = {
  ии: ['ии', 'ai', 'нейросет', 'искусст', 'интелле', 'gpt', 'chatgp', 'openai', 'claude', 'anthro', 'gemini', 'llm', 'промпт', 'deepse', 'yandexgpt', 'gigach', 'midjou', 'вайбко'],
  нейросет: ['нейросет', 'gpt', 'chatgp', 'openai', 'claude', 'anthro', 'gemini', 'llm', 'промпт', 'midjou'],
  бизнес: ['бизнес', 'стартап', 'основат', 'продаж', 'маркетп', 'запуск', 'монети'],
  реклам: ['реклам', 'маркет', 'таргет', 'smm', 'инфлюе', 'блогер', 'блоге', 'охват', 'продви', 'бренд', 'креати', 'интегр', 'рекламо', 'cpm', 'трафик', 'аудито', 'ads'],
  блогер: ['блогер', 'блоге', 'инфлюе', 'креато', 'охват', 'reels', 'shorts', 'tiktok', 'ютубер', 'тиктокер'],
  маркетинг: ['маркет', 'реклам', 'бренд', 'продви', 'smm', 'таргет', 'воронк', 'конвер', 'лид', 'трафик'],
  запуск: ['запуск', 'стартап', 'продук', 'mvp', 'основат', 'проект'],
  проект: ['проект', 'запуск', 'продук', 'стартап'],
  продаж: ['продаж', 'клиент', 'выручк', 'воронк', 'лид', 'конвер'],
  деньг: ['деньг', 'доход', 'заработ', 'выручк', 'инвест', 'прибыл'],
  кейс: ['кейс']
};

// Слова профиля, которые сами по себе ничего не говорят о теме.
const GENERIC = new Set(['которы', 'владел', 'покупа', 'провер', 'подбор', 'цены', 'цен', 'опыт', 'личны', 'личн', 'малого', 'малый',
  'средне', 'своих', 'работа', 'делать', 'компан', 'клиент', 'людей', 'тех', 'кто', 'как', 'для', 'это', 'все', 'про']);

const DEFAULT_STOP = 'политика, война, СВО, теракт, убийство, ДТП, криминал, суд, похороны';

// «Наше» - нужно слово прямо из профиля (вес 1) плюс хотя бы одно близкое; двух близких слов мало.
const LABEL_ON = 0.55;
const LABEL_MAYBE = 0.2;
const FEEDBACK_STEP = 0.5;
const FEEDBACK_CAP = 2;

function stemsOf(text) {
  const words = String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9][a-zа-я0-9+-]{1,}/g) || [];
  return words.map((w) => (w.length <= 3 ? w : stem(w)));
}

/** Словарь интересов пространства: Map<основа, вес> + стоп-основы. */
function profileTerms(settings) {
  const terms = new Map();
  // основы постов не длиннее 6 знаков (см. stem) - словарь приводим к тому же виду
  const add = (s, w) => { s = s && s.slice(0, 6); if (s && s.length >= 2) terms.set(s, Math.max(terms.get(s) || 0, w)); };
  const own = stemsOf((settings.topics || '') + ' ' + (settings.audience || ''));
  for (const s of own) {
    if (GENERIC.has(s)) continue;
    if (s.length >= 4 || s === 'ии') add(s, 1);
    for (const [key, list] of Object.entries(LEXICON)) {
      if (s === key || s.startsWith(key) || key.startsWith(s) && s.length >= 4) for (const x of list) add(x, 0.7);
    }
  }
  const stop = new Set(String(settings.stop_topics == null ? DEFAULT_STOP : settings.stop_topics)
    .split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => { const w = x.toLowerCase().replace(/ё/g, 'е'); return w.length <= 3 ? w : stem(w).slice(0, 6); }));
  for (const s of ['и', 'для', 'в', 'на']) terms.delete(s);
  return { terms, stop };
}

function feedbackTerms(db, workspaceId) {
  const m = new Map();
  for (const r of db.prepare('SELECT term, weight FROM content_interest_terms WHERE workspace_id = ?').all(workspaceId)) m.set(r.term, r.weight);
  return m;
}

/** Оценка одного текста. Возвращает { score, label, matched: [основы], stopped: основа|null }. */
function scoreText(text, profile, feedback) {
  const f = features(stripBoilerplate(text));
  const words = new Set([...f.stems.keys()]);
  let sum = 0;
  const matched = [];
  for (const w of words) {
    let wt = 0;
    for (const [term, weight] of profile.terms) {
      if (w === term || (term.length >= 4 && w.startsWith(term))) { wt = Math.max(wt, weight); }
    }
    const fb = feedback && feedback.get(w);
    if (fb) wt += fb;
    if (wt) { sum += wt; if (wt > 0) matched.push(w); }
  }
  let stopped = null;
  // короткие стоп-слова (СВО, ДТП, суд) - только целым словом, иначе «сво» ловит «свой»
  for (const w of words) for (const s of profile.stop) if (w === s || (s.length >= 5 && w.startsWith(s))) { stopped = s; break; }
  let score = sum > 0 ? 1 - Math.exp(-sum / 2) : 0;
  // Стоп-тема режет до «не наше», но сильный интерес (дайджест про ИИ, где мелькнула политика) только ослабляет.
  if (stopped) score = sum >= 2.5 ? score * 0.5 : Math.min(score, 0.1);
  score = Math.round(score * 100) / 100;
  return { score, label: score >= LABEL_ON ? 'on' : score >= LABEL_MAYBE ? 'maybe' : 'off', matched: matched.slice(0, 8), stopped };
}

/** Пересчёт релевантности постов пространства (ручные оценки не трогаем) и тем. */
function recompute(db, workspaceId, settings, opts) {
  const o = opts || {};
  const profile = profileTerms(settings);
  const fb = feedbackTerms(db, workspaceId);
  // Профиль не заполнен - не судим: релевантность пустая, лента показывает всё.
  if (!profile.terms.size && !fb.size) {
    db.prepare('UPDATE content_items SET relevance = NULL, relevance_label = NULL, relevance_why = NULL, relevance_by = NULL ' +
      'WHERE workspace_id = ? AND relevance_by IS NOT \'user\'').run(workspaceId);
    db.prepare('UPDATE content_topics SET relevance = NULL WHERE workspace_id = ?').run(workspaceId);
    return 0;
  }
  const since = (o.now || Date.now()) - (o.days || 14) * 86400000;
  const rows = db.prepare('SELECT id, title, body FROM content_items WHERE workspace_id = ? AND relevance_by IS NOT \'user\' AND COALESCE(published_at, created_at) >= ?')
    .all(workspaceId, since);
  const upd = db.prepare('UPDATE content_items SET relevance = ?, relevance_label = ?, relevance_why = ?, relevance_by = \'rule\' WHERE id = ?');
  for (const r of rows) {
    const s = scoreText((r.title || '') + '\n' + (r.body || ''), profile, fb);
    const why = s.stopped ? 'стоп-тема: ' + s.stopped : s.matched.length ? 'совпали: ' + s.matched.join(', ') : 'нет совпадений с темами профиля';
    upd.run(s.score, s.label, why, r.id);
  }
  // Тема наша, если наш её лучший пост: склейка уже гарантирует, что посты об одном.
  db.prepare('UPDATE content_topics SET relevance = (SELECT MAX(i.relevance) FROM content_topic_items ti JOIN content_items i ON i.id = ti.item_id ' +
    'WHERE ti.topic_id = content_topics.id) WHERE workspace_id = ?').run(workspaceId);
  return rows.length;
}

/** Ручная оценка 👍/👎: пост получает 1 или 0, его опорные слова - небольшой вес в обучении. */
function rate(db, workspaceId, itemId, positive, now) {
  const it = db.prepare('SELECT id, title, body FROM content_items WHERE id = ? AND workspace_id = ?').get(itemId, workspaceId);
  if (!it) return false;
  db.prepare('UPDATE content_items SET relevance = ?, relevance_label = ?, relevance_by = \'user\', relevance_why = ? WHERE id = ?')
    .run(positive ? 1 : 0, positive ? 'on' : 'off', positive ? 'вы отметили «наше»' : 'вы отметили «не наше»', it.id);
  const f = features(stripBoilerplate((it.title || '') + '\n' + (it.body || '')));
  const up = db.prepare('INSERT INTO content_interest_terms (workspace_id, term, weight, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(workspace_id, term) DO UPDATE SET weight = MAX(-?, MIN(?, content_interest_terms.weight + excluded.weight)), updated_at = excluded.updated_at');
  for (const a of f.anchors) if (!a.startsWith('#')) up.run(workspaceId, a, positive ? FEEDBACK_STEP : -FEEDBACK_STEP, now || Date.now(), FEEDBACK_CAP, FEEDBACK_CAP);
  logEvent(db, workspaceId, { itemId: it.id, kind: positive ? 'rate_up' : 'rate_down' }, now);
  return true;
}

/** Журнал действий: сигналы разной ценности для будущего обучения рекомендаций. */
function logEvent(db, workspaceId, { itemId, topicId, kind }, now) {
  db.prepare('INSERT INTO content_events (workspace_id, item_id, topic_id, kind, at) VALUES (?, ?, ?, ?, ?)')
    .run(workspaceId, itemId || null, topicId || null, kind, now || Date.now());
}

function describe(settings, db, workspaceId) {
  const p = profileTerms(settings);
  const fb = feedbackTerms(db, workspaceId);
  return {
    terms: [...p.terms].sort((a, b) => b[1] - a[1]).map(([t]) => t),
    stop: [...p.stop],
    learnedUp: [...fb].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 20),
    learnedDown: [...fb].filter(([, w]) => w < 0).sort((a, b) => a[1] - b[1]).map(([t]) => t).slice(0, 20)
  };
}

module.exports = { LEXICON, DEFAULT_STOP, profileTerms, scoreText, recompute, rate, logEvent, describe, LABEL_ON, LABEL_MAYBE };
