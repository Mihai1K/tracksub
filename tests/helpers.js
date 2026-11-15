'use strict';

const { open } = require('../src/db');
const tracking = require('../src/tracking');
const pipeline = require('../src/pipeline');

const SECRET = 'test-secret';
const T0 = Date.UTC(2026, 8, 1, 10, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HUMAN = { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' };

function setup(opts) {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, {
    name: 'WS', timezone: (opts && opts.timezone) || 'Europe/Moscow',
    attributionWindowHours: (opts && opts.windowHours) || 72
  });
  const channel = tracking.connectChannel(db, { workspaceId: ws.id, platform: 'max', externalChatId: '-100500' });
  const link = tracking.createLink(db, { workspaceId: ws.id, channelId: channel.id, slug: 'a', source: 'yandex_direct', campaign: 'c1', redirectMode: 'bot' });
  const link2 = tracking.createLink(db, { workspaceId: ws.id, channelId: channel.id, slug: 'b', source: 'max_seeding', campaign: 'c2', redirectMode: 'direct' });
  return { db, ws, channel, link, link2 };
}

function click(db, slug, ts, extra) {
  const r = tracking.registerClick(db, Object.assign({
    slug, method: 'GET', headers: HUMAN, query: {}, ip: '10.0.0.1',
    userAgent: HUMAN['user-agent'], ipSalt: 's', now: ts
  }, extra || {}));
  return r;
}

function deliver(db, update, opts) {
  return pipeline.handleIncoming(db, {
    transport: 'webhook',
    headers: { 'x-max-bot-api-secret': (opts && opts.secret) || SECRET },
    bodyRaw: typeof update === 'string' ? update : JSON.stringify(update),
    secret: SECRET,
    platform: 'max'
  });
}

const userAdded = (userId, ts, over) => Object.assign({
  update_type: 'user_added', timestamp: ts, chat_id: '-100500',
  user: { user_id: userId }, is_channel: true, inviter_id: null
}, over || {});

const userRemoved = (userId, ts, adminId) => ({
  update_type: 'user_removed', timestamp: ts, chat_id: '-100500',
  user: { user_id: userId }, is_channel: true, admin_id: adminId == null ? null : adminId
});

const botStarted = (userId, ts, payload) => ({
  update_type: 'bot_started', timestamp: ts, chat_id: 1,
  user: { user_id: userId }, payload: payload
});

module.exports = { setup, click, deliver, userAdded, userRemoved, botStarted, SECRET, T0, MIN, HOUR, DAY, HUMAN };
