'use strict';

/**
 * «Залётность» поста.
 *
 * Главный показатель - outlier: во сколько раз просмотры поста выше медианы своего источника.
 * Так видно, какая тема выстрелила, а не какой канал просто большой. Тот же принцип,
 * что у vidIQ outliers.
 *
 * - Канал (TG/VK/YouTube-канал): медиана просмотров постов этого канала старше суток.
 *   Нужно минимум MIN_SAMPLE постов, иначе «мало данных» - цифру не придумываем.
 * - Тренды/поиск/импорт: база - подписчики автора (просмотры / подписчики), если известны;
 *   иначе оценка поставщика как есть (vidIQ, Virale); иначе нет оценки.
 *
 * score = log2(1 + outlier) × свежесть × (1 + бонус вовлечённости). Свежесть: 1 до 3 дней,
 * дальше плавно падает (0,5 к 14 дням). Посты моложе суток помечаются «ранний»:
 * их просмотры ещё растут, оценка занижена, а не завышена.
 */

const DAY = 86400000;
const MIN_SAMPLE = 8;
const MIN_SUBSCRIBERS = 1000;
const MIN_VIEWS = 10000;
const SAMPLE_LIMIT = 60;

function median(nums) {
  const a = nums.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function freshness(ageMs) {
  if (ageMs == null) return 0.7;
  const days = ageMs / DAY;
  if (days <= 3) return 1;
  return Math.max(0.15, Math.pow(0.5, (days - 3) / 11));
}

function engagement(item) {
  if (!item.views) return null;
  const parts = [item.likes, item.comments, item.shares].filter((x) => typeof x === 'number');
  if (!parts.length) return null;
  return parts.reduce((s, x) => s + x, 0) / item.views;
}

function round(x, d) {
  if (x == null || !Number.isFinite(x)) return null;
  const k = Math.pow(10, d);
  return Math.round(x * k) / k;
}

/**
 * Оценка одного поста. baseline - медиана просмотров источника (или null).
 * Возвращает { outlier, er, score, note }.
 */
function scoreItem(item, { baseline, sampleSize, now }) {
  const t = now || Date.now();
  const age = item.published_at ? t - item.published_at : null;
  const er = engagement(item);
  const notes = [];
  let outlier = null;

  if (baseline != null) {
    if (sampleSize < MIN_SAMPLE) notes.push('мало данных по каналу (' + sampleSize + ' из ' + MIN_SAMPLE + ')');
    else if (item.views != null && baseline > 0) outlier = item.views / baseline;
  } else if (item.views != null && item.author_subscribers > 0) {
    // У крошечных каналов отношение к подписчикам - шум (1 200 просмотров при 4 подписчиках = ×300).
    if (item.author_subscribers >= MIN_SUBSCRIBERS && item.views >= MIN_VIEWS) {
      outlier = item.views / item.author_subscribers;
      notes.push('к подписчикам автора');
    } else {
      notes.push('маленький канал или мало просмотров - оценки нет');
    }
  } else if (item.provider_score != null) {
    outlier = item.provider_score;
    notes.push('оценка поставщика');
  } else {
    notes.push('нет базы для сравнения');
  }

  if (age != null && age < DAY) notes.push('ранний: просмотры ещё растут');

  let score = null;
  if (outlier != null) {
    const erBonus = er == null ? 0 : Math.min(er, 0.2) * 2; // до +40%
    // Логарифм: ×50 и ×300 оба «очень залетело», но не должны хоронить под собой всё остальное.
    score = Math.log2(1 + Math.min(outlier, 200)) * freshness(age) * (1 + erBonus);
  }
  return { outlier: round(outlier, 2), er: round(er, 4), score: round(score, 3), note: notes.join('; ') || null };
}

/** Пересчёт всех постов одного источника-канала после сбора. */
function rescoreSource(db, source, now) {
  const t = now || Date.now();
  const rows = db.prepare('SELECT * FROM content_items WHERE source_id = ? ORDER BY published_at DESC LIMIT 200').all(source.id);
  const usesBaseline = source.kind === 'channel';
  let baseline = null;
  let sampleSize = 0;
  if (usesBaseline) {
    const mature = rows.filter((r) => r.views != null && r.published_at && t - r.published_at >= DAY).slice(0, SAMPLE_LIMIT);
    sampleSize = mature.length;
    baseline = median(mature.map((r) => r.views));
    if (baseline == null) baseline = 0; // канал без зрелых постов: оценки нет, но и подписчиков не подставляем
  }
  const upd = db.prepare('UPDATE content_items SET outlier = ?, er = ?, score = ?, score_note = ? WHERE id = ?');
  for (const r of rows) {
    const s = scoreItem(r, { baseline: usesBaseline ? baseline : null, sampleSize, now: t });
    upd.run(s.outlier, s.er, s.score, s.note, r.id);
  }
  return { baseline, sampleSize, count: rows.length };
}

/** Пересчёт одного поста без источника (импорт). */
function rescoreLoose(db, itemId, now) {
  const r = db.prepare('SELECT * FROM content_items WHERE id = ?').get(itemId);
  if (!r) return null;
  const s = scoreItem(r, { baseline: null, sampleSize: 0, now });
  db.prepare('UPDATE content_items SET outlier = ?, er = ?, score = ?, score_note = ? WHERE id = ?').run(s.outlier, s.er, s.score, s.note, r.id);
  return s;
}

module.exports = { median, freshness, engagement, scoreItem, rescoreSource, rescoreLoose, MIN_SAMPLE, DAY };
