'use strict';

/**
 * Пул пригласительных ссылок Telegram.
 *
 * Зачем: детерминированная атрибуция требует своей ссылки на каждый клик, а создавать её
 * синхронно в редиректе нельзя — это внешний HTTP-вызов на горячем пути и лимиты Bot API.
 * Поэтому ссылки готовятся заранее, редирект только забирает свободную.
 * Если пул пуст — редирект НЕ ждёт: человек уходит по обычной ссылке канала,
 * а подписка будет атрибуцирована вероятностно. Честная деградация вместо тормозов.
 */

const { id } = require('./ids');
const { one, all, run } = require('./db');

const DEFAULT_POOL_SIZE = 20;

function freeCount(db, channelId, trackingLinkId) {
  return one(db,
    'SELECT COUNT(*) c FROM invite_links WHERE channel_id = ? AND tracking_link_id = ? AND status = \'free\'',
    channelId, trackingLinkId).c;
}

const RETRIES = 3;
const RETRY_PAUSE_MS = 700;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Докладывает ссылки в пул до нужного размера. Вызывается фоном, не из редиректа.
 *
 * Сеть до Telegram из России нестабильна: обрывы случаются на ровном месте. Раньше первая же
 * ошибка обрывала всю пачку и пул оставался пустым. Теперь каждая ссылка пробуется несколько раз,
 * а неудача одной не мешает остальным — возвращаем, сколько удалось.
 */
async function refill(db, { channel, link, api, size }) {
  const target = size || DEFAULT_POOL_SIZE;
  const have = freeCount(db, channel.id, link.id);
  const created = [];
  const errors = [];

  for (let i = have; i < target; i++) {
    const name = link.slug + '-' + Math.random().toString(36).slice(2, 8);
    let res = null;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        res = await api.createChatInviteLink(channel.external_chat_id, name);
        break;
      } catch (e) {
        if (attempt === RETRIES) errors.push(String(e.message));
        else await pause(RETRY_PAUSE_MS * attempt);
      }
    }
    if (!res) continue; // эта ссылка не далась — пробуем следующую
    const url = res.result && res.result.invite_link;
    if (!url) break;
    try {
      run(db,
        'INSERT INTO invite_links (id, channel_id, tracking_link_id, platform, external_link, name, mode, status, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, \'free\', ?)',
        id('il'), channel.id, link.id, channel.platform, url, name, res.mode, Date.now());
      created.push(url);
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  return {
    created,
    requested: Math.max(0, target - have),
    error: created.length === 0 && errors.length ? errors[0] : null,
    failed: errors.length
  };
}

/** Синхронно выдаёт свободную ссылку клику. Возвращает null, если пул пуст. */
function assign(db, { channelId, trackingLinkId, clickId }) {
  const row = one(db,
    'SELECT * FROM invite_links WHERE channel_id = ? AND tracking_link_id = ? AND status = \'free\' ' +
    'ORDER BY created_at ASC LIMIT 1', channelId, trackingLinkId);
  if (!row) return null;
  run(db, 'UPDATE invite_links SET status = \'assigned\', click_id = ?, assigned_at = ? WHERE id = ? AND status = \'free\'',
    clickId, Date.now(), row.id);
  const updated = one(db, 'SELECT * FROM invite_links WHERE id = ?', row.id);
  return updated && updated.status === 'assigned' && updated.click_id === clickId ? updated : null;
}

function stats(db, workspaceId) {
  return all(db,
    'SELECT tl.slug, c.title, SUM(CASE WHEN il.status = \'free\' THEN 1 ELSE 0 END) free, ' +
    'SUM(CASE WHEN il.status = \'assigned\' THEN 1 ELSE 0 END) used, MAX(il.mode) mode ' +
    'FROM invite_links il JOIN tracking_links tl ON tl.id = il.tracking_link_id ' +
    'JOIN channels c ON c.id = il.channel_id WHERE tl.workspace_id = ? GROUP BY tl.slug, c.title',
    workspaceId);
}

module.exports = { refill, assign, freeCount, stats, DEFAULT_POOL_SIZE };
