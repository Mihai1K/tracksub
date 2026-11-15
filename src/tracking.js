'use strict';

/** Трекинг: ссылки, клики, фильтры и цель редиректа. Правила — attribution.md §1. */

const { id, clickId, hashIp } = require('./ids');
const { one, all, run } = require('./db');

const CLICK_DEDUP_MS = 30 * 1000; // §1
const BOT_UA = /(bot|crawler|spider|preview|curl|wget|headless|monitor|pingdom|facebookexternalhit|yandexbot|googlebot)/i;

function createWorkspace(db, { name, timezone, attributionWindowHours }) {
  const wsId = id('ws');
  run(db, 'INSERT INTO workspaces (id, name, timezone, attribution_window_hours, created_at) VALUES (?, ?, ?, ?, ?)',
    wsId, name, timezone || 'Europe/Moscow', attributionWindowHours || 72, Date.now());
  return one(db, 'SELECT * FROM workspaces WHERE id = ?', wsId);
}

/**
 * Проверяет ID чата до записи в базу. Телеграм выдаёт каналам и супергруппам
 * отрицательные ID вида -100…; положительное число — это ID пользователя, по нему
 * getChat всегда ответит «chat not found», и в кабинете навсегда останется мёртвая строка.
 */
function checkChatId(platform, externalChatId) {
  const raw = String(externalChatId == null ? '' : externalChatId).trim();
  if (!raw) return 'Укажите ID канала';
  if (platform !== 'telegram') return null; // формат chat_id в MAX мы не подтверждали — не выдумываем правило
  if (!/^-\d+$/.test(raw)) {
    return 'ID канала в Telegram отрицательный и начинается с -100. ' +
      'Похоже, потерян минус: попробуйте -' + raw.replace(/^-/, '');
  }
  if (!raw.startsWith('-100')) return 'Это не ID канала или супергруппы: такие ID начинаются с -100';
  return null;
}

function connectChannel(db, { workspaceId, platform, externalChatId, title }) {
  // Формат ID проверяет вызывающая сторона: демо-режим заводит каналы с условными
  // идентификаторами, а правило «-100…» касается только того, что вводит человек.
  // Два ряда на один и тот же чат недопустимы: события разложатся по тому ряду,
  // который первым вернёт выборка, и подписки уедут в чужой кабинет.
  const dup = one(db, 'SELECT * FROM channels WHERE platform = ? AND external_chat_id = ?',
    platform, String(externalChatId));
  if (dup) {
    throw new Error(dup.workspace_id === workspaceId
      ? 'Этот канал уже подключён'
      : 'Этот канал уже занят другим кабинетом. Чтобы забрать его себе, добавьте бота ' +
        'администратором в канал — он пришлёт ссылку для привязки.');
  }

  const chId = id('ch');
  run(db, 'INSERT INTO channels (id, workspace_id, platform, external_chat_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    chId, workspaceId, platform, String(externalChatId), title || null, Date.now());
  return one(db, 'SELECT * FROM channels WHERE id = ?', chId);
}

function createLink(db, { workspaceId, channelId, slug, source, campaign, creative, redirectMode, platformTarget }) {
  const linkId = id('tl');
  run(db,
    'INSERT INTO tracking_links (id, workspace_id, channel_id, slug, source, campaign, creative, platform_target, ' +
    'redirect_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    linkId, workspaceId, channelId, slug, source || null, campaign || null, creative || null,
    platformTarget || 'max', redirectMode || 'bot', Date.now());
  return one(db, 'SELECT * FROM tracking_links WHERE id = ?', linkId);
}

function deviceHint(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Mozilla|Chrome|Safari|Firefox|Edg/i.test(ua)) return 'web';
  return 'unknown';
}

/** Причина отбраковки или null, если клик засчитан. §1 */
function filterReason(db, { method, headers, link, ipHash, userAgent, ts }) {
  if (String(method || 'GET').toUpperCase() === 'HEAD') return 'head_request';
  if (BOT_UA.test(String(userAgent || ''))) return 'bot_ua';
  const accept = (headers && (headers.accept || headers.Accept)) || '';
  if (!String(accept).includes('text/html')) return 'no_html_accept';
  // Сравниваем только с засчитанными кликами: иначе цепочка отфильтрованных запросов
  // (бот, дёргающий ссылку раз в 20 секунд) бесконечно продлевала бы окно дедупа
  // и глушила бы клики живых людей.
  const recent = one(db,
    'SELECT id FROM clicks WHERE tracking_link_id = ? AND ip_hash = ? AND user_agent = ? ' +
    'AND status = \'counted\' AND ts_utc >= ? ORDER BY ts_utc DESC LIMIT 1',
    link.id, ipHash, String(userAgent || ''), ts - CLICK_DEDUP_MS);
  if (recent) return 'dedup_30s';
  return null;
}

/**
 * Регистрация клика. Отфильтрованные тоже сохраняются (§1), но не участвуют ни в метриках,
 * ни в атрибуции: у них status = 'filtered'.
 */
function registerClick(db, { slug, method, headers, query, ip, userAgent, referer, ipSalt, now }) {
  const ts = now || Date.now();
  const link = one(db, 'SELECT * FROM tracking_links WHERE slug = ?', slug);
  if (!link) return { ok: false, reason: 'unknown_link' };

  const ipHash = hashIp(ip || '', ipSalt || 'local-salt');
  const reason = filterReason(db, { method, headers, link, ipHash, userAgent, ts });
  const cid = clickId();

  run(db,
    'INSERT INTO clicks (id, tracking_link_id, workspace_id, channel_id, ts_utc, ip_hash, user_agent, referer, ' +
    'query_json, device_hint, status, filter_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    cid, link.id, link.workspace_id, link.channel_id, ts, ipHash, String(userAgent || ''), referer || null,
    JSON.stringify(query || {}), deviceHint(userAgent), reason ? 'filtered' : 'counted', reason);

  return { ok: true, clickId: cid, link, counted: !reason, filterReason: reason };
}

/** Цель редиректа. Режим bot даёт детерминированную атрибуцию, direct — только вероятностную. */
function redirectTarget(link, cid, cfg) {
  const platform = (cfg && cfg.platform) || link.platform_target || 'max';
  if (link.redirect_mode === 'bot') {
    if (!cfg || !cfg.botName) throw new Error('botName is required for redirect_mode=bot');
    const host = platform === 'telegram' ? 'https://t.me/' : 'https://max.ru/';
    return host + cfg.botName + '?start=' + encodeURIComponent(cid);
  }
  if (!cfg || !cfg.channelUrl) throw new Error('channelUrl is required for redirect_mode=direct');
  return cfg.channelUrl;
}

/**
 * Полное разрешение цели с учётом пула пригласительных ссылок (Telegram).
 * Возвращает и качество атрибуции, которое этот путь обеспечит, — это нужно показывать в интерфейсе.
 */
function resolveTarget(db, { link, channel, clickId, cfg }) {
  const conf = Object.assign({ platform: channel.platform }, cfg || {});

  if (link.redirect_mode === 'invite' && channel.platform === 'telegram') {
    const pool = require('./invitePool');
    const invite = pool.assign(db, { channelId: channel.id, trackingLinkId: link.id, clickId });
    if (invite) {
      run(db, 'UPDATE clicks SET invite_link_id = ? WHERE id = ?', invite.id, clickId);
      return { url: invite.external_link, attribution: 'deterministic', via: 'invite_link', poolEmpty: false };
    }
    // Пул пуст — не ждём внешний вызов на горячем пути, уходим по обычной ссылке канала
    if (channel.channel_url) {
      return { url: channel.channel_url, attribution: 'probabilistic', via: 'channel_url', poolEmpty: true };
    }
  }

  if (link.redirect_mode === 'bot') {
    return { url: redirectTarget(link, clickId, conf), attribution: 'deterministic', via: 'bot_deeplink', poolEmpty: false };
  }

  const url = channel.channel_url || (conf && conf.channelUrl);
  if (!url) throw new Error('У канала не задана ссылка');
  return { url, attribution: 'probabilistic', via: 'channel_url', poolEmpty: false };
}

module.exports = {
  createWorkspace, connectChannel, checkChatId, createLink, registerClick, redirectTarget, resolveTarget,
  deviceHint, CLICK_DEDUP_MS
};
