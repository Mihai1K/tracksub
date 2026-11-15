'use strict';

/**
 * Telegram-сводка и алерты Content OS через бота TrackSub.
 *
 * Привязка: в профиле автора - кнопка, ведущая в бота с одноразовым кодом (/start cos_<код>).
 * Каждое пространство подписывается отдельно: сводка личного блога и Blogger Market не смешиваются.
 *
 * Утренняя сводка (по умолчанию 09:00 МСК): до 5 горячих тем за сутки с учётом релевантности,
 * плюс самые быстрые свои посты. Алерты - только по адаптивным порогам:
 *  - пост разгоняется в 5+ раз быстрее нормы своего канала (по замерам, не по средней),
 *    младше суток и не «не наше»;
 *  - тема за 6 часов подхвачена 3+ независимыми источниками и релевантна (≥ 0,5).
 * Не больше 5 алертов в сутки на подписку, ночью (23-08 МСК) молчим - утром будет сводка.
 * Каждое уведомление пишется в журнал: повторно об одном и том же не пишем.
 *
 * Кнопки - ссылки на сайт с подписью HMAC (действие + объект + срок): нажатие в Telegram
 * открывает кабинет и сразу выполняет действие. Без callback-кнопок не нужно менять вебхук бота.
 */

const crypto = require('crypto');
const { id } = require('../ids');
const topics = require('./topics');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MSK = 3 * HOUR;
const ALERTS_PER_DAY = 5;
const LINK_TTL = 7 * DAY;

const fmtK = (n) => (n == null ? '—' : n >= 10000 ? (Math.round(n / 100) / 10).toString().replace('.', ',') + 'K' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return n + ' ' + (m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c); };
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const mskHour = (t) => new Date(t + MSK).getUTCHours();
const mskDay = (t) => new Date(t + MSK).toISOString().slice(0, 10);

// ------------------------------------------------------------- подписанные ссылки

function sign(secret, payload) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url').slice(0, 22);
}

/** Ссылка-действие: /app/content/go/<action>/<kind>/<id>?w=<ws>&e=<срок>&s=<подпись>. */
function actionLink(cfg, { action, kind, ref, workspaceId, now }) {
  const exp = Math.floor(((now || Date.now()) + LINK_TTL) / 1000);
  const payload = [action, kind, ref, workspaceId, exp].join(':');
  return cfg.appUrl + '/app/content/go/' + action + '/' + kind + '/' + encodeURIComponent(ref) +
    '?w=' + encodeURIComponent(workspaceId) + '&e=' + exp + '&s=' + sign(cfg.secretKey, payload);
}

function verifyLink(cfg, { action, kind, ref, workspaceId, exp, sig, now }) {
  if (!sig || !exp) return false;
  if (Number(exp) * 1000 < (now || Date.now())) return false;
  const want = sign(cfg.secretKey, [action, kind, ref, workspaceId, exp].join(':'));
  const a = Buffer.from(String(sig));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------- привязка

function createLinkCode(db, workspaceId, userId, now) {
  const code = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO content_link_codes (code, workspace_id, user_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(code, workspaceId, userId, (now || Date.now()) + DAY);
  return code;
}

/** /start cos_<код> в личке бота: привязать чат к пространству. Возвращает текст ответа или null. */
function handleStart(db, { text, telegramUserId, now }) {
  const m = String(text || '').match(/^\/start(?:@\w+)?\s+cos_([A-Za-z0-9_-]{6,40})/);
  if (!m) return null;
  const t = now || Date.now();
  const row = db.prepare('SELECT * FROM content_link_codes WHERE code = ?').get(m[1]);
  if (!row || row.expires_at < t) return 'Ссылка устарела. Откройте «Профиль автора» в разделе «Контент» и подключите Telegram заново.';
  db.prepare('DELETE FROM content_link_codes WHERE code = ?').run(m[1]);
  const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(row.workspace_id);
  db.prepare('INSERT INTO content_subscriptions (workspace_id, chat_id, user_id, digest_on, alerts_on, digest_hour, created_at) VALUES (?, ?, ?, 1, 1, 9, ?) ' +
    'ON CONFLICT(workspace_id, chat_id) DO UPDATE SET user_id = excluded.user_id, digest_on = 1, alerts_on = 1')
    .run(row.workspace_id, String(telegramUserId), row.user_id, t);
  return 'Готово: сюда будет приходить контент-сводка пространства «' + (ws ? ws.name : '') + '».\n\n' +
    '• Каждое утро в 9:00 - горячие темы за сутки.\n' +
    '• Днём - алерт, если пост разгоняется в 5+ раз быстрее нормы канала или тему подхватили 3+ источника.\n\n' +
    'Время, алерты и отключение - в «Профиле автора».';
}

function subscriptions(db, workspaceId) {
  return db.prepare('SELECT * FROM content_subscriptions WHERE workspace_id = ? ORDER BY created_at').all(workspaceId);
}

function updateSubscription(db, workspaceId, chatId, { digestOn, alertsOn, digestHour }) {
  return db.prepare('UPDATE content_subscriptions SET digest_on = ?, alerts_on = ?, digest_hour = ? WHERE workspace_id = ? AND chat_id = ?')
    .run(digestOn ? 1 : 0, alertsOn ? 1 : 0, Math.min(23, Math.max(0, parseInt(digestHour, 10) || 9)), workspaceId, String(chatId)).changes;
}

function unsubscribe(db, workspaceId, chatId) {
  return db.prepare('DELETE FROM content_subscriptions WHERE workspace_id = ? AND chat_id = ?').run(workspaceId, String(chatId)).changes;
}

// --------------------------------------------------------------------- журнал

function alreadySent(db, chatId, workspaceId, ref) {
  return !!db.prepare('SELECT 1 x FROM content_notifications WHERE chat_id = ? AND workspace_id = ? AND ref = ? AND status = \'sent\'').get(String(chatId), workspaceId, ref);
}

function journal(db, { workspaceId, chatId, kind, ref, status, error, now }) {
  db.prepare('INSERT INTO content_notifications (workspace_id, chat_id, kind, ref, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(workspaceId, String(chatId), kind, ref, status, error || null, now || Date.now());
}

function alertsToday(db, chatId, workspaceId, now) {
  const t = now || Date.now();
  const dayStart = Date.parse(mskDay(t) + 'T00:00:00Z') - MSK;
  return db.prepare('SELECT COUNT(*) c FROM content_notifications WHERE chat_id = ? AND workspace_id = ? AND kind = \'alert\' AND status = \'sent\' AND sent_at >= ?')
    .get(String(chatId), workspaceId, dayStart).c;
}

async function send(db, api, sub, { kind, ref, text, buttons, now }) {
  try {
    await api.sendMessage(sub.chat_id, text, buttons && buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
    journal(db, { workspaceId: sub.workspace_id, chatId: sub.chat_id, kind, ref, status: 'sent', now });
    return true;
  } catch (e) {
    journal(db, { workspaceId: sub.workspace_id, chatId: sub.chat_id, kind, ref, status: 'failed', error: String(e.message).slice(0, 200), now });
    // Пользователь заблокировал бота - дальше не пишем, иначе будем долбить ошибками.
    if (/blocked|deactivated|chat not found|403/i.test(String(e.message))) unsubscribe(db, sub.workspace_id, sub.chat_id);
    return false;
  }
}

// --------------------------------------------------------------------- сводка

const relOk = 'COALESCE(i.relevance_label, \'on\') != \'off\'';

function buildDigest(db, cfg, workspaceId, now) {
  const t = now || Date.now();
  const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId);
  const tops = topics.listTopics(db, workspaceId, { days: 1, minSources: 2, now: t, limit: 5 });
  const lines = ['☀️ Контент-сводка · ' + (ws ? ws.name : '') + ' · ' + new Date(t + MSK).toISOString().slice(8, 10) + '.' + new Date(t + MSK).toISOString().slice(5, 7), ''];
  const buttons = [];
  tops.forEach((tp, i) => {
    const members = topics.topicItems(db, workspaceId, tp.id);
    const names = [...new Set(members.map((m) => m.author || m.source_handle).filter(Boolean))].slice(0, 3);
    const grow = members.reduce((s, m) => s + (m.delta_views || 0), 0);
    lines.push('🔥 ' + (i + 1) + '. ' + cut(tp.title, 110));
    lines.push(plural(tp.sources_count, 'источник', 'источника', 'источников') + ' · ' + fmtK(tp.views_sum) + ' просмотров' +
      (grow ? ' · +' + fmtK(grow) + ' за последние замеры' : '') + (tp.max_ratio >= 2 ? ' · разгон ×' + String(tp.max_ratio).replace('.', ',') : ''));
    if (names.length) lines.push('Пишут: ' + names.join(', '));
    lines.push('');
    buttons.push([
      { text: (i + 1) + '. ☆ В избранное', url: actionLink(cfg, { action: 'fav', kind: 'topic', ref: tp.id, workspaceId, now: t }) },
      { text: 'Сценарий', url: actionLink(cfg, { action: 'script', kind: 'topic', ref: tp.id, workspaceId, now: t }) },
      { text: 'Открыть', url: cfg.appUrl + '/app/content/topics#' + tp.id }
    ]);
  });
  // Самые быстрые посты без темы: залёт может быть и у одного канала.
  const fast = db.prepare('SELECT i.* FROM content_items i LEFT JOIN content_topic_items ti ON ti.item_id = i.id ' +
    'WHERE i.workspace_id = ? AND ti.item_id IS NULL AND i.status != \'archived\' AND ' + relOk + ' AND i.velocity_ratio >= 2 ' +
    'AND COALESCE(i.published_at, i.created_at) >= ? ORDER BY i.velocity_ratio DESC LIMIT ?').all(workspaceId, t - DAY, Math.max(0, 5 - tops.length) || 2);
  if (fast.length) {
    lines.push('⚡ Разгоняются быстрее нормы канала:');
    for (const it of fast) {
      lines.push('• ×' + String(it.velocity_ratio).replace('.', ',') + ' · ' + cut(it.title, 90) + ' (' + (it.author || '') + ')');
      buttons.push([
        { text: '☆ ' + cut(it.title, 24), url: actionLink(cfg, { action: 'fav', kind: 'item', ref: it.id, workspaceId, now: t }) },
        { text: 'Сценарий', url: actionLink(cfg, { action: 'script', kind: 'item', ref: it.id, workspaceId, now: t }) },
        { text: 'Пост', url: it.url }
      ]);
    }
    lines.push('');
  }
  if (!tops.length && !fast.length) return null; // нечего сказать - не пишем пустых сводок
  lines.push('Вся лента: ' + cfg.appUrl + '/app/content');
  return { text: lines.join('\n').slice(0, 4000), buttons: buttons.slice(0, 10) };
}

// --------------------------------------------------------------------- алерты

function alertCandidates(db, workspaceId, now) {
  const t = now || Date.now();
  const posts = db.prepare('SELECT i.* FROM content_items i WHERE i.workspace_id = ? AND i.status != \'archived\' AND ' + relOk +
    ' AND i.velocity_kind = \'measured\' AND i.velocity_ratio >= 5 AND COALESCE(i.published_at, i.created_at) >= ? ORDER BY i.velocity_ratio DESC LIMIT 5')
    .all(workspaceId, t - DAY);
  const tps = db.prepare('SELECT * FROM content_topics WHERE workspace_id = ? AND status = \'active\' AND sources_count >= 3 AND relevance >= 0.5 ' +
    'AND last_seen_at >= ? AND first_seen_at >= ? ORDER BY heat DESC LIMIT 5').all(workspaceId, t - 6 * HOUR, t - DAY);
  return { posts, topics: tps };
}

function postAlert(cfg, it, workspaceId, now) {
  return {
    ref: 'item:' + it.id,
    text: '🚨 Разгоняется: ' + cut(it.title, 140) + '\n\n' +
      '×' + String(it.velocity_ratio).replace('.', ',') + ' к обычной скорости канала · ⚡ ' + fmtK(Math.round(it.velocity)) + ' просмотров/час\n' +
      '👁 ' + fmtK(it.views) + ' · ' + (it.author || '') + (it.relevance != null ? ' · релевантность ' + Math.round(it.relevance * 100) + '%' : ''),
    buttons: [[
      { text: '☆ В избранное', url: actionLink(cfg, { action: 'fav', kind: 'item', ref: it.id, workspaceId, now }) },
      { text: 'Сценарий', url: actionLink(cfg, { action: 'script', kind: 'item', ref: it.id, workspaceId, now }) },
      { text: 'Пост', url: it.url }
    ]]
  };
}

function topicAlert(db, cfg, tp, workspaceId, now) {
  const names = [...new Set(topics.topicItems(db, workspaceId, tp.id).map((m) => m.author || m.source_handle).filter(Boolean))].slice(0, 4);
  return {
    ref: 'topic:' + tp.id,
    text: '🔥 Тему подхватили ' + plural(tp.sources_count, 'источник', 'источника', 'источников') + ': ' + cut(tp.title, 140) + '\n\n' +
      '👁 ' + fmtK(tp.views_sum) + ' суммарно · ' + names.join(', '),
    buttons: [[
      { text: '☆ В избранное', url: actionLink(cfg, { action: 'fav', kind: 'topic', ref: tp.id, workspaceId, now }) },
      { text: 'Сценарий', url: actionLink(cfg, { action: 'script', kind: 'topic', ref: tp.id, workspaceId, now }) },
      { text: 'Открыть', url: cfg.appUrl + '/app/content/topics#' + tp.id }
    ]]
  };
}

/**
 * Один проход: сводки, у которых подошёл час, и алерты. Вызывается планировщиком после сбора.
 * Возвращает { digests, alerts } - сколько отправлено.
 */
async function tick(db, { cfg, api, now, log }) {
  const t = now || Date.now();
  const out = { digests: 0, alerts: 0 };
  if (!api) return out;
  const subs = db.prepare('SELECT * FROM content_subscriptions').all();
  for (const sub of subs) {
    if (sub.digest_on && mskHour(t) >= sub.digest_hour && mskHour(t) < sub.digest_hour + 3) {
      const ref = 'digest:' + mskDay(t);
      if (!alreadySent(db, sub.chat_id, sub.workspace_id, ref)) {
        const d = buildDigest(db, cfg, sub.workspace_id, t);
        if (d && await send(db, api, sub, { kind: 'digest', ref, text: d.text, buttons: d.buttons, now: t })) out.digests++;
        else if (!d) journal(db, { workspaceId: sub.workspace_id, chatId: sub.chat_id, kind: 'digest', ref, status: 'sent', error: 'пусто - не отправляли', now: t });
      }
    }
    const h = mskHour(t);
    if (!sub.alerts_on || h < 8 || h >= 23) continue;
    const cand = alertCandidates(db, sub.workspace_id, t);
    const msgs = cand.topics.map((tp) => topicAlert(db, cfg, tp, sub.workspace_id, t)).concat(cand.posts.map((it) => postAlert(cfg, it, sub.workspace_id, t)));
    for (const m of msgs) {
      if (alertsToday(db, sub.chat_id, sub.workspace_id, t) >= ALERTS_PER_DAY) break;
      if (alreadySent(db, sub.chat_id, sub.workspace_id, m.ref)) continue;
      if (await send(db, api, sub, { kind: 'alert', ref: m.ref, text: m.text, buttons: m.buttons, now: t })) out.alerts++;
    }
  }
  if ((out.digests || out.alerts) && log) log('info', 'content notifications sent', out);
  return out;
}

module.exports = { actionLink, verifyLink, createLinkCode, handleStart, subscriptions, updateSubscription, unsubscribe, buildDigest, alertCandidates, tick, ALERTS_PER_DAY, mskHour };
