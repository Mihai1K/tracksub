'use strict';

/**
 * Ежедневный отчёт владельцу канала в личку.
 * Главное, что человек видит каждый день, поэтому текст короткий и без воды:
 * сколько пришло, сколько ушло, откуда, и что из этого стоит денег.
 */

const { one, all, run } = require('./db');
const { id } = require('./ids');
const analytics = require('./analytics');

const DAY = 24 * 3600 * 1000;

function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function pct(x) { return x == null ? '—' : (x * 100).toFixed(1).replace('.', ',') + '%'; }

/** Границы вчерашних суток в таймзоне проекта. */
function yesterday(ws, now) {
  const t = now || Date.now();
  const off = analytics.tzOffset(ws.timezone, t) * 60000;
  const localMidnight = Math.floor((t + off) / DAY) * DAY - off;
  return { from: localMidnight - DAY, to: localMidnight, day: new Date(localMidnight - DAY + off).toISOString().slice(0, 10) };
}

function buildForChannel(db, channel, now) {
  const ws = one(db, 'SELECT * FROM workspaces WHERE id = ?', channel.workspace_id);
  const period = yesterday(ws, now);
  const filters = {
    days: 1, from: period.from, to: period.to, channelId: channel.id,
    fromDay: period.day, toDay: period.day
  };

  const o = analytics.overview(db, ws, filters);
  const sources = analytics.breakdown(db, ws, filters, 'source');
  const net = o.subscriptions - o.unsubscriptionsLeft;

  if (!o.subscriptions && !o.unsubscriptions && !o.clicks) return null; // молчим в пустые дни

  const lines = [];
  lines.push('📊 ' + (channel.title || 'Канал') + ' — ' + period.day);
  lines.push('');
  lines.push('Подписались: ' + fmt(o.subscriptions) + (o.repeat ? ' (из них ' + fmt(o.repeat) + ' вернулись)' : ''));
  lines.push('Отписались: ' + fmt(o.unsubscriptionsLeft));
  lines.push('Итого: ' + (net >= 0 ? '+' : '') + fmt(net));
  if (o.clicks) lines.push('Переходов по ссылкам: ' + fmt(o.clicks) + ', конверсия ' + pct(o.cr));

  const known = sources.filter((s) => !s.isUnknown && s.subscriptions > 0);
  const unknown = sources.find((s) => s.isUnknown);

  if (known.length) {
    lines.push('');
    lines.push('Откуда пришли:');
    for (const s of known.slice(0, 8)) {
      let row = '• ' + s.label + ': ' + fmt(s.newSubscriptions || s.subscriptions);
      if (s.cps) row += ', по ' + fmt(s.cps) + ' ₽';
      if (s.retentionD30 && s.retentionD30.value != null) row += ', остаются ' + pct(s.retentionD30.value);
      lines.push(row);
    }
  }
  if (unknown && unknown.subscriptions) {
    lines.push('• источник неизвестен: ' + fmt(unknown.subscriptions) +
      ' (' + pct(unknown.subscriptions / o.subscriptions) + ')');
  }

  if (o.cps) {
    lines.push('');
    lines.push('Подписчик стоил ' + fmt(o.cps) + ' ₽' +
      (o.retainedCps ? ', живой — ' + fmt(o.retainedCps) + ' ₽' : ''));
  }

  return { text: lines.join('\n'), day: period.day, channel, workspace: ws, stats: o };
}

function alreadySent(db, channelId, day) {
  return !!one(db, 'SELECT id FROM audit_logs WHERE action = \'report.daily\' AND target = ?', channelId + '|' + day);
}

function markSent(db, channelId, day) {
  run(db, 'INSERT INTO audit_logs (id, workspace_id, user_id, action, target, meta_json, ts_utc) ' +
    'VALUES (?, NULL, NULL, \'report.daily\', ?, \'{}\', ?)', id('al'), channelId + '|' + day, Date.now());
}

/**
 * Рассылает отчёты по всем привязанным каналам, у которых есть кому писать.
 * Идемпотентна: повторный запуск в тот же день ничего не продублирует.
 */
async function sendDaily(db, api, opts) {
  const options = opts || {};
  const channels = all(db,
    'SELECT * FROM channels WHERE claimed_at IS NOT NULL AND added_by_telegram_id IS NOT NULL ' +
    'AND added_by_telegram_id <> \'\' AND platform = \'telegram\'');
  const out = [];

  for (const ch of channels) {
    const report = buildForChannel(db, ch, options.now);
    if (!report) { out.push({ channel: ch.id, skipped: 'нет событий за день' }); continue; }
    if (!options.force && alreadySent(db, ch.id, report.day)) {
      out.push({ channel: ch.id, skipped: 'уже отправлен' });
      continue;
    }
    try {
      const res = await api.sendMessage(ch.added_by_telegram_id, report.text);
      markSent(db, ch.id, report.day);
      out.push({ channel: ch.id, sent: true, mode: res.mode, day: report.day });
    } catch (e) {
      out.push({ channel: ch.id, sent: false, error: String(e.message) });
    }
  }
  return out;
}

module.exports = { buildForChannel, sendDaily, yesterday };
