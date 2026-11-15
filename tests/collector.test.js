'use strict';

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { one, all } = require('../src/db');
const pipeline = require('../src/pipeline');

test('повторная доставка одного события обрабатывается один раз', () => {
  const { db } = h.setup();
  const ev = h.userAdded('U1', h.T0);
  const first = h.deliver(db, ev);
  const second = h.deliver(db, ev);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.rawId, first.rawId);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM webhook_events').c, 1);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions').c, 1);
});

test('неверный секрет: 403 и ничего не сохраняется', () => {
  const { db } = h.setup();
  const res = h.deliver(db, h.userAdded('U1', h.T0), { secret: 'wrong' });
  assert.equal(res.status, 403);
  assert.equal(res.stored, false);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM webhook_events').c, 0);
});

test('невалидный JSON сохраняется как сырое и помечается failed', () => {
  const { db } = h.setup();
  const res = h.deliver(db, '{not json');
  assert.equal(res.stored, true);
  assert.equal(res.failed, true);
  const raw = one(db, 'SELECT * FROM webhook_events WHERE id = ?', res.rawId);
  assert.equal(raw.status, 'failed');
  assert.equal(raw.body_raw, '{not json');
});

test('событие без обязательных полей не теряется и доступно для повторного прогона', () => {
  const { db } = h.setup();
  const res = h.deliver(db, { update_type: 'user_added', chat_id: '-100500', user: { user_id: 'U1' } });
  assert.equal(res.failed, true);
  assert.match(res.error, /timestamp/);

  const pending = pipeline.processPending(db, 10);
  assert.equal(pending.length, 1, 'упавшее событие возвращается в очередь ретрая');
  const raw = one(db, 'SELECT attempts FROM webhook_events WHERE id = ?', res.rawId);
  assert.ok(raw.attempts >= 2, 'счётчик попыток растёт');
});

test('ретрай успешного события не создаёт дублей в домене', () => {
  const { db } = h.setup();
  const res = h.deliver(db, h.userAdded('U1', h.T0));
  pipeline.process(db, res.rawId);
  pipeline.process(db, res.rawId);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM platform_events').c, 1);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions').c, 1);
});

test('сырое тело и заголовки сохраняются до разбора', () => {
  const { db } = h.setup();
  const res = h.deliver(db, h.userAdded('U1', h.T0));
  const raw = one(db, 'SELECT * FROM webhook_events WHERE id = ?', res.rawId);
  assert.ok(raw.body_raw.includes('user_added'));
  assert.ok(JSON.parse(raw.headers_json)['x-max-bot-api-secret']);
  assert.equal(all(db, 'SELECT * FROM platform_events').length, 1);
});

test('РЕГРЕССИЯ: разные события Telegram не схлопываются в одно', () => {
  // Найдено на живом трафике: общий синтетический ключ собирался из полей плоской структуры MAX,
  // которых у Telegram нет, поэтому ВСЕ события бота получали один ключ и терялись как дубли.
  const { db } = h.setup();
  const tracking = require('../src/tracking');
  const ws = one(db, 'SELECT * FROM workspaces');
  tracking.connectChannel(db, { workspaceId: ws.id, platform: 'telegram', externalChatId: '-1001' });

  const member = (updateId, userId, ts) => JSON.stringify({
    update_id: updateId,
    chat_member: {
      chat: { id: '-1001', type: 'channel' },
      from: { id: userId }, date: ts,
      old_chat_member: { status: 'left', user: { id: userId } },
      new_chat_member: { status: 'member', user: { id: userId } }
    }
  });

  const pipeline = require('../src/pipeline');
  const a = pipeline.handleIncoming(db, { platform: 'telegram', bodyRaw: member(101, 'u1', 1756000000), secret: '', headers: {} });
  const b = pipeline.handleIncoming(db, { platform: 'telegram', bodyRaw: member(102, 'u2', 1756000100), secret: '', headers: {} });

  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, false, 'второе событие не должно считаться дублем первого');
  assert.equal(one(db, 'SELECT COUNT(*) c FROM webhook_events').c, 2);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions').c, 2, 'обе подписки дошли до домена');
});

test('повтор того же update_id Telegram отбрасывается', () => {
  const { db } = h.setup();
  const tracking = require('../src/tracking');
  const ws = one(db, 'SELECT * FROM workspaces');
  tracking.connectChannel(db, { workspaceId: ws.id, platform: 'telegram', externalChatId: '-1001' });
  const body = JSON.stringify({
    update_id: 555,
    chat_member: {
      chat: { id: '-1001', type: 'channel' }, from: { id: 'u9' }, date: 1756000000,
      old_chat_member: { status: 'left', user: { id: 'u9' } },
      new_chat_member: { status: 'member', user: { id: 'u9' } }
    }
  });
  const pipeline = require('../src/pipeline');
  const first = pipeline.handleIncoming(db, { platform: 'telegram', bodyRaw: body, secret: '', headers: {} });
  const again = pipeline.handleIncoming(db, { platform: 'telegram', bodyRaw: body, secret: '', headers: {} });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions').c, 1);
});

test('события MAX по-прежнему различаются синтетическим ключом', () => {
  const { db } = h.setup();
  const first = h.deliver(db, h.userAdded('U1', h.T0));
  const second = h.deliver(db, h.userAdded('U2', h.T0 + h.MIN));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM webhook_events').c, 2);
});

test('РЕГРЕССИЯ: повторная обработка выбирает адаптер по платформе события', () => {
  // Аудит боевой версии: processPending разбирал события Telegram адаптером MAX
  // и помечал их сломанными. Проверяем оба направления.
  const { db } = h.setup();
  const tracking = require('../src/tracking');
  const ws = one(db, 'SELECT * FROM workspaces');
  tracking.connectChannel(db, { workspaceId: ws.id, platform: 'telegram', externalChatId: '-100tg' });

  const collector = require('../src/collector');
  const pipeline = require('../src/pipeline');
  const ing = collector.ingest(db, {
    transport: 'polling', headers: {}, platform: 'telegram',
    adapter: require('../src/adapters/telegram'),
    bodyRaw: JSON.stringify({
      update_id: 777,
      chat_member: {
        chat: { id: '-100tg', type: 'channel' }, from: { id: 'u1' }, date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: 'left', user: { id: 'u1' } },
        new_chat_member: { status: 'member', user: { id: 'u1' } }
      }
    })
  });
  assert.equal(one(db, 'SELECT platform FROM webhook_events WHERE id = ?', ing.rawId).platform, 'telegram');

  const res = pipeline.processPending(db, 10);
  assert.equal(res.length, 1);
  assert.equal(one(db, 'SELECT status FROM webhook_events WHERE id = ?', ing.rawId).status, 'normalized');
  assert.equal(one(db, 'SELECT COUNT(*) c FROM subscriptions').c, 1);
});

test('платформа определяется по форме тела, если она не записана', () => {
  const { db } = h.setup();
  const pipeline = require('../src/pipeline');
  const tg = pipeline.adapterFor({ platform: null, body_raw: JSON.stringify({ update_id: 1 }) });
  const mx = pipeline.adapterFor({ platform: null, body_raw: JSON.stringify({ update_type: 'user_added' }) });
  assert.equal(tg.PLATFORM, 'telegram');
  assert.equal(mx.PLATFORM, 'max');
  assert.ok(db);
});
