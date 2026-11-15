'use strict';

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { one } = require('../src/db');

test('две подписки разных людей — две записи', () => {
  const { db } = h.setup();
  h.deliver(db, h.userAdded('U1', h.T0));
  h.deliver(db, h.userAdded('U2', h.T0 + h.MIN));
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions').c, 2);
});

test('повторный user_added при активной подписке игнорируется', () => {
  const { db } = h.setup();
  h.deliver(db, h.userAdded('U1', h.T0));
  const second = h.deliver(db, h.userAdded('U1', h.T0 + h.HOUR));
  assert.equal(second.domain.action, 'ignored');
  assert.equal(second.domain.reason, 'duplicate_active_subscription');
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions').c, 1);
});

test('admin_id = null -> ушёл сам; admin_id задан -> удалён админом', () => {
  const { db } = h.setup();
  h.deliver(db, h.userAdded('U1', h.T0));
  h.deliver(db, h.userRemoved('U1', h.T0 + h.HOUR, null));
  h.deliver(db, h.userAdded('U2', h.T0));
  h.deliver(db, h.userRemoved('U2', h.T0 + h.HOUR, 'ADMIN'));

  assert.equal(one(db, 'SELECT COUNT(*) c FROM unsubscriptions WHERE reason = \'left\'').c, 1);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM unsubscriptions WHERE reason = \'removed\'').c, 1);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions WHERE status = \'active\'').c, 0);
});

test('повторная подписка внутри 7 суток помечается resubscribe', () => {
  const { db } = h.setup();
  h.deliver(db, h.userAdded('U1', h.T0));
  h.deliver(db, h.userRemoved('U1', h.T0 + h.HOUR, null));
  const again = h.deliver(db, h.userAdded('U1', h.T0 + 2 * h.DAY));
  assert.equal(again.domain.isResubscribe, true);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions WHERE is_resubscribe = 1').c, 1);
});

test('подписка спустя более 7 суток — полноценная новая', () => {
  const { db } = h.setup();
  h.deliver(db, h.userAdded('U1', h.T0));
  h.deliver(db, h.userRemoved('U1', h.T0 + h.HOUR, null));
  const again = h.deliver(db, h.userAdded('U1', h.T0 + 8 * h.DAY));
  assert.equal(again.domain.isResubscribe, false);
});

test('удаление админом не блокирует последующую подписку и не считается left', () => {
  const { db } = h.setup();
  h.deliver(db, h.userAdded('U1', h.T0));
  h.deliver(db, h.userRemoved('U1', h.T0 + h.HOUR, 'ADMIN'));
  const again = h.deliver(db, h.userAdded('U1', h.T0 + 2 * h.DAY));
  assert.equal(again.domain.action, 'subscribe');
  assert.equal(again.domain.isResubscribe, false, 'семидневное правило смотрит только на добровольный уход');
});

test('события не по каналу и по чужому каналу игнорируются, но сохраняются', () => {
  const { db } = h.setup();
  const inChat = h.deliver(db, h.userAdded('U1', h.T0, { is_channel: false }));
  const foreign = h.deliver(db, h.userAdded('U2', h.T0, { chat_id: '-100999' }));
  assert.equal(inChat.domain.reason, 'not_a_channel');
  assert.equal(foreign.domain.reason, 'unknown_channel');
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions').c, 0);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM platform_events').c, 2, 'нормализованные события сохранены');
});

test('отписка без активной подписки фиксируется без падения', () => {
  const { db } = h.setup();
  const res = h.deliver(db, h.userRemoved('U9', h.T0, null));
  assert.equal(res.domain.action, 'unsubscribe');
  assert.equal(res.domain.subscriptionId, null);
});
