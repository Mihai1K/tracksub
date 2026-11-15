'use strict';

/**
 * Демо-данные. Живут в отдельном канале, помечены во всех отчётах и удаляются одной кнопкой.
 * Проходят через тот же конвейер, что и настоящие события: демо не должно вести себя иначе,
 * иначе оно врёт про продукт.
 */

const { one, all, run } = require('./db');
const tracking = require('./tracking');
const pipeline = require('./pipeline');
const invitePool = require('./invitePool');
const { TelegramApi } = require('./platform/telegramApi');

const DEMO_TITLE = 'DEMO — пример канала';
const DAY = 24 * 3600 * 1000;

function demoChannel(db, ws) {
  return one(db, 'SELECT * FROM channels WHERE workspace_id = ? AND external_chat_id = ?', ws.id, 'demo-' + ws.id);
}

async function seed(db, ws) {
  if (demoChannel(db, ws)) return demoChannel(db, ws);
  const api = new TelegramApi({ mode: 'mock' });
  const channel = tracking.connectChannel(db, {
    workspaceId: ws.id, platform: 'telegram', externalChatId: 'demo-' + ws.id, title: DEMO_TITLE
  });
  run(db, 'UPDATE channels SET status = \'connected\', bot_name = \'demo_bot\', bot_status = \'mock\', ' +
    'channel_url = \'https://t.me/demo\', connected_at = ? WHERE id = ?', Date.now(), channel.id);

  const defs = [
    { slug: 'demo-direct', source: 'yandex_direct', campaign: 'search_brand', creative: 'text_1', mode: 'invite' },
    { slug: 'demo-seed', source: 'max_seeding', campaign: 'channels_mix', creative: 'post_a', mode: 'direct' },
    { slug: 'demo-vk', source: 'vk_ads', campaign: 'lookalike', creative: 'video_1', mode: 'direct' }
  ];
  const links = defs.map((d) => tracking.createLink(db, {
    workspaceId: ws.id, channelId: channel.id, slug: d.slug, source: d.source,
    campaign: d.campaign, creative: d.creative, redirectMode: d.mode, platformTarget: 'telegram'
  }));
  await invitePool.refill(db, { channel, link: links[0], api, size: 30 });

  const now = Date.now();
  const headers = { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' };
  let userSeq = 0;
  const plan = [
    { link: 0, clicks: 6, subs: 3 }, { link: 1, clicks: 9, subs: 2 }, { link: 2, clicks: 4, subs: 1 }
  ];

  for (let d = 27; d >= 0; d -= 3) {
    for (const p of plan) {
      const link = links[p.link];
      const clickIds = [];
      for (let i = 0; i < p.clicks; i++) {
        const ts = now - d * DAY + i * 7 * 60000;
        const r = tracking.registerClick(db, {
          slug: link.slug, method: 'GET', headers, query: { yclid: 'demo' + (userSeq * 100 + i) },
          ip: '10.' + (d % 250) + '.' + i + '.' + p.link, userAgent: headers['user-agent'],
          ipSalt: 'demo', now: ts
        });
        if (r.ok && r.counted) {
          clickIds.push({ id: r.clickId, ts });
          if (link.redirect_mode === 'invite') {
            invitePool.assign(db, { channelId: channel.id, trackingLinkId: link.id, clickId: r.clickId });
          }
        }
      }
      for (let s = 0; s < p.subs && s < clickIds.length; s++) {
        const cl = clickIds[s];
        userSeq += 1;
        const uid = 'demo_u' + userSeq;
        const invite = one(db, 'SELECT * FROM invite_links WHERE click_id = ?', cl.id);
        const subTs = cl.ts + 4 * 60000;
        pipeline.handleIncoming(db, {
          transport: 'demo', headers: {}, secret: '', platform: 'telegram',
          bodyRaw: JSON.stringify({
            update_id: userSeq * 10 + 1,
            chat_member: {
              chat: { id: 'demo-' + ws.id, type: 'channel' },
              from: { id: uid }, date: Math.floor(subTs / 1000),
              old_chat_member: { status: 'left', user: { id: uid } },
              new_chat_member: { status: 'member', user: { id: uid } },
              invite_link: invite ? { invite_link: invite.external_link, name: 'demo' } : undefined
            }
          })
        });
        if (userSeq % 4 === 0) {
          pipeline.handleIncoming(db, {
            transport: 'demo', headers: {}, secret: '', platform: 'telegram',
            bodyRaw: JSON.stringify({
              update_id: userSeq * 10 + 2,
              chat_member: {
                chat: { id: 'demo-' + ws.id, type: 'channel' },
                from: { id: uid }, date: Math.floor((subTs + 2 * DAY) / 1000),
                old_chat_member: { status: 'member', user: { id: uid } },
                new_chat_member: { status: 'left', user: { id: uid } }
              }
            })
          });
        }
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const spend = [['yandex_direct', 12400], ['max_seeding', 6800], ['vk_ads', 3200]];
  for (const [src, amount] of spend) {
    run(db, 'INSERT INTO spend_entries (id, workspace_id, scope_type, scope_value, day, amount, currency, created_at) ' +
      'VALUES (?, ?, \'source\', ?, ?, ?, \'RUB\', ?)',
      require('./ids').id('sp'), ws.id, src, today, amount, Date.now());
  }

  run(db, 'UPDATE workspaces SET demo_mode = 1 WHERE id = ?', ws.id);
  return channel;
}

function remove(db, ws) {
  const channel = demoChannel(db, ws);
  if (channel) {
    const subs = all(db, 'SELECT id FROM subscriptions WHERE channel_id = ?', channel.id).map((r) => r.id);
    for (const sid of subs) {
      run(db, 'DELETE FROM attribution_candidates WHERE attribution_id IN (SELECT id FROM attributions WHERE subscription_id = ?)', sid);
      run(db, 'DELETE FROM attributions WHERE subscription_id = ?', sid);
      run(db, 'DELETE FROM conversions WHERE subscription_id = ?', sid);
    }
    run(db, 'DELETE FROM unsubscriptions WHERE channel_id = ?', channel.id);
    run(db, 'DELETE FROM subscriptions WHERE channel_id = ?', channel.id);
    run(db, 'DELETE FROM invite_links WHERE channel_id = ?', channel.id);
    run(db, 'DELETE FROM clicks WHERE channel_id = ?', channel.id);
    run(db, 'DELETE FROM tracking_links WHERE channel_id = ?', channel.id);
    run(db, 'DELETE FROM channels WHERE id = ?', channel.id);
  }
  run(db, 'DELETE FROM spend_entries WHERE workspace_id = ? AND scope_value IN (\'yandex_direct\',\'max_seeding\',\'vk_ads\')', ws.id);
  run(db, 'UPDATE workspaces SET demo_mode = 0 WHERE id = ?', ws.id);
}

module.exports = { seed, remove, demoChannel, DEMO_TITLE };
