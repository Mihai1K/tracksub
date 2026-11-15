'use strict';

/** Метрики: что попадает в знаменатель CPS и в когорту удержания. */

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { one, run } = require('../src/db');
const analytics = require('../src/analytics');
const { id } = require('../src/ids');

function spend(db, ws, value, source) {
  run(db, 'INSERT INTO spend_entries (id, workspace_id, scope_type, scope_value, day, amount, currency, created_at) ' +
    'VALUES (?, ?, \'source\', ?, ?, ?, \'RUB\', ?)',
    id('sp'), ws.id, source || 'yandex_direct', new Date().toISOString().slice(0, 10), value, Date.now());
}

const filters = (ws) => ({ days: 30, from: Date.now() - 30 * analytics.DAY, to: Date.now() + 60000, channelId: null });

test('РЕГРЕССИЯ: повторная подписка не удешевляет стоимость подписчика', () => {
  // Найдено на живом тесте: человек вышел и вернулся, CPS упал с 500 до 250 ₽ на ровном месте.
  // attribution.md §9: повтор в когорту привлечения не попадает и в CPS не учитывается.
  const { db } = h.setup();
  const ws = one(db, 'SELECT * FROM workspaces');
  const now = Date.now();

  h.click(db, 'a', now - 20 * h.MIN);
  h.deliver(db, h.userAdded('U1', now - 19 * h.MIN));
  spend(db, ws, 500);

  const before = analytics.overview(db, ws, filters(ws));
  assert.equal(before.subscriptions, 1);
  assert.equal(before.cps, 500, 'один новый подписчик за 500 ₽');

  // тот же человек ушёл и вернулся в тот же день
  h.deliver(db, h.userRemoved('U1', now - 10 * h.MIN, null));
  h.click(db, 'b', now - 6 * h.MIN);
  h.deliver(db, h.userAdded('U1', now - 5 * h.MIN));

  const after = analytics.overview(db, ws, filters(ws));
  assert.equal(after.subscriptions, 2, 'обе подписки видны в отчёте');
  assert.equal(after.repeat, 1, 'одна из них помечена повторной');
  assert.equal(after.firstSubscriptions, 1);
  assert.equal(after.cps, 500, 'CPS не изменился: платили за одного нового подписчика');
});

test('повторные подписки не попадают в когорту удержания', () => {
  const { db } = h.setup();
  const ws = one(db, 'SELECT * FROM workspaces');
  const now = Date.now();
  const old = now - 40 * analytics.DAY;

  h.click(db, 'a', old);
  h.deliver(db, h.userAdded('U1', old + h.MIN));          // первая подписка, живёт больше 30 дней
  h.deliver(db, h.userRemoved('U1', old + 2 * h.MIN, null));
  h.deliver(db, h.userAdded('U1', old + 3 * h.MIN));      // возврат в тот же день

  const o = analytics.overview(db, ws, { days: 60, from: old - h.DAY, to: now, channelId: null });
  assert.equal(o.retention.d30.cohort, 1, 'в когорте только первая подписка');
});

test('разбивка по источникам показывает новые подписки отдельно от повторных', () => {
  const { db } = h.setup();
  const ws = one(db, 'SELECT * FROM workspaces');
  const now = Date.now();
  h.click(db, 'a', now - 30 * h.MIN);
  h.deliver(db, h.userAdded('U1', now - 29 * h.MIN));
  h.deliver(db, h.userRemoved('U1', now - 20 * h.MIN, null));
  h.click(db, 'a', now - 10 * h.MIN, { ip: '10.0.0.9' });
  h.deliver(db, h.userAdded('U1', now - 9 * h.MIN));
  spend(db, ws, 300, 'yandex_direct');

  const rows = analytics.breakdown(db, ws, filters(ws), 'source');
  const yandex = rows.find((r) => r.key === 'yandex_direct');
  assert.equal(yandex.subscriptions, 2);
  assert.equal(yandex.newSubscriptions, 1);
  assert.equal(yandex.repeat, 1);
  assert.equal(yandex.cps, 300, 'CPS считается по новым подписчикам');
});

test('удаление администратором не считается оттоком', () => {
  const { db } = h.setup();
  const ws = one(db, 'SELECT * FROM workspaces');
  const old = Date.now() - 40 * analytics.DAY;
  h.click(db, 'a', old);
  h.deliver(db, h.userAdded('U1', old + h.MIN));
  h.deliver(db, h.userRemoved('U1', old + h.DAY, 'ADMIN'));

  const o = analytics.overview(db, ws, { days: 60, from: old - h.DAY, to: Date.now(), channelId: null });
  assert.equal(o.unsubscriptionsLeft, 0, 'добровольных отписок нет');
  assert.equal(o.retention.d30.cohort, 0, 'удалённый админом исключён из когорты целиком');
});

test('РЕГРЕССИЯ: подписчики без источника не получают стоимость привлечения', () => {
  // На живом отчёте канал с 438 органическими подписчиками показал «подписчик стоил 1 ₽»:
  // расход соседнего канала делился на людей, пришедших неизвестно откуда.
  const { db } = h.setup();
  const ws = one(db, 'SELECT * FROM workspaces');
  const tracking = require('../src/tracking');
  const now = Date.now();

  // канал, куда рекламу не лили: подписки есть, источника нет
  const other = tracking.connectChannel(db, { workspaceId: ws.id, platform: 'max', externalChatId: '-100organic' });
  for (let i = 0; i < 5; i++) {
    h.deliver(db, h.userAdded('org' + i, now - (10 - i) * h.MIN, { chat_id: '-100organic' }));
  }
  spend(db, ws, 500, 'yandex_direct'); // расход по другому каналу

  const f = { days: 30, from: now - 30 * analytics.DAY, to: now + 60000, channelId: other.id };
  const o = analytics.overview(db, ws, f);
  assert.equal(o.subscriptions, 5);
  assert.equal(o.attribution.unattributed, 5);
  assert.equal(o.spend, 0, 'чужой расход в этот канал не попадает');
  assert.equal(o.cps, null, 'стоимость подписчика неизвестна, а не «1 ₽»');
  assert.equal(o.retainedCps, null);

  const rows = analytics.breakdown(db, ws, f, 'source');
  const unknown = rows.find((r) => r.isUnknown);
  assert.equal(unknown.cps, null, 'у строки «источник неизвестен» цены нет');
});

test('РЕГРЕССИЯ: органические подписчики не задирают конверсию перехода', () => {
  // На живом дашборде было «клик → подписка 11050%»: 442 подписки делились на 4 клика,
  // хотя 440 из них пришли не по нашим ссылкам.
  const { db } = h.setup();
  const ws = one(db, 'SELECT * FROM workspaces');
  const now = Date.now();

  const tracking = require('../src/tracking');
  const organic = tracking.connectChannel(db, { workspaceId: ws.id, platform: 'max', externalChatId: '-100org' });

  h.click(db, 'a', now - 20 * h.MIN);
  h.deliver(db, h.userAdded('paid', now - 19 * h.MIN));                                   // по ссылке
  for (let i = 0; i < 40; i++) {                                                          // сами, в другой канал
    h.deliver(db, h.userAdded('org' + i, now - 18 * h.MIN + i * 1000, { chat_id: '-100org' }));
  }
  assert.ok(organic);

  const o = analytics.overview(db, ws, filters(ws));
  assert.equal(o.clicks, 1);
  assert.equal(o.subscriptions, 41);
  assert.equal(o.attribution.unattributed, 40, 'органика осталась без источника');
  assert.equal(o.cr, 1, 'конверсия 100%: один переход дал одну подписку');
});
