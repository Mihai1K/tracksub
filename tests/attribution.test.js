'use strict';

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { one, all } = require('../src/db');
const pipeline = require('../src/pipeline');
const attribution = require('../src/attribution');

const attrOf = (db, userId) => one(db,
  'SELECT a.* FROM attributions a JOIN subscriptions s ON s.id = a.subscription_id ' +
  'JOIN platform_users pu ON pu.id = s.platform_user_id ' +
  'WHERE pu.external_user_id = ? AND a.is_current = 1 ORDER BY s.ts_utc DESC LIMIT 1', userId);

test('детерминированный сигнал побеждает более свежий вероятностный кандидат', () => {
  const { db } = h.setup();
  const det = h.click(db, 'a', h.T0);                 // раньше
  h.click(db, 'b', h.T0 + 50 * h.MIN);               // ближе к подписке, но без bot_started
  h.deliver(db, h.botStarted('U1', h.T0 + h.MIN, det.clickId));
  h.deliver(db, h.userAdded('U1', h.T0 + 55 * h.MIN));

  const a = attrOf(db, 'U1');
  assert.equal(a.type, 'deterministic');
  assert.equal(a.click_id, det.clickId);
  assert.equal(a.confidence, 1.0);
});

test('окно точной схемы: до 60 минут — уверенность 1.0, до 24 часов — 0.8', () => {
  const { db } = h.setup();
  const c1 = h.click(db, 'a', h.T0);
  h.deliver(db, h.botStarted('U1', h.T0, c1.clickId));
  h.deliver(db, h.userAdded('U1', h.T0 + 3 * h.HOUR));
  assert.equal(attrOf(db, 'U1').confidence, 0.8);

  // другой IP: иначе сработает дедуп кликов 30 секунд (§1) и клик не будет засчитан
  const c2 = h.click(db, 'a', h.T0, { ip: '10.0.0.2' });
  assert.equal(c2.counted, true);
  h.deliver(db, h.botStarted('U2', h.T0, c2.clickId));
  h.deliver(db, h.userAdded('U2', h.T0 + 30 * h.MIN));
  assert.equal(attrOf(db, 'U2').confidence, 1.0);
});

test('bot_started старше 24 часов точной атрибуции не даёт', () => {
  const { db } = h.setup();
  const c = h.click(db, 'a', h.T0);
  h.deliver(db, h.botStarted('U1', h.T0, c.clickId));
  h.deliver(db, h.userAdded('U1', h.T0 + 30 * h.HOUR));
  const a = attrOf(db, 'U1');
  assert.notEqual(a.type, 'deterministic');
});

test('два разных payload: побеждает последний, подписка помечается ambiguous', () => {
  const { db } = h.setup();
  const first = h.click(db, 'a', h.T0);
  const second = h.click(db, 'b', h.T0 + 5 * h.MIN);
  h.deliver(db, h.botStarted('U1', h.T0 + h.MIN, first.clickId));
  h.deliver(db, h.botStarted('U1', h.T0 + 6 * h.MIN, second.clickId));
  h.deliver(db, h.userAdded('U1', h.T0 + 10 * h.MIN));

  const a = attrOf(db, 'U1');
  assert.equal(a.type, 'deterministic');
  assert.equal(a.click_id, second.clickId);
  assert.equal(a.is_ambiguous, 1);
});

test('чужой payload не выдаётся за точную атрибуцию', () => {
  const { db } = h.setup();
  h.deliver(db, h.botStarted('U1', h.T0, 'notOurClickId42'));
  h.deliver(db, h.userAdded('U1', h.T0 + 5 * h.MIN));
  assert.notEqual(attrOf(db, 'U1').type, 'deterministic');
});

test('вероятностная схема: ближайший клик выигрывает, считаются confidence и margin', () => {
  const { db } = h.setup();
  h.click(db, 'a', h.T0);
  const near = h.click(db, 'b', h.T0 + 40 * h.MIN);
  h.deliver(db, h.userAdded('U1', h.T0 + 45 * h.MIN));

  const a = attrOf(db, 'U1');
  assert.equal(a.type, 'probabilistic');
  assert.equal(a.click_id, near.clickId);
  assert.ok(a.confidence > 0 && a.confidence < 1);
  assert.ok(a.margin > 1);
  const cands = all(db, 'SELECT * FROM attribution_candidates WHERE attribution_id = ?', a.id);
  assert.equal(cands.length, 2, 'сохраняются все кандидаты, а не только победитель');
});

test('близкие кандидаты дают ambiguous', () => {
  const { db } = h.setup();
  h.click(db, 'a', h.T0 + 30 * h.MIN);
  h.click(db, 'b', h.T0 + 31 * h.MIN);
  h.deliver(db, h.userAdded('U1', h.T0 + 32 * h.MIN));
  assert.equal(attrOf(db, 'U1').is_ambiguous, 1);
});

test('окно вероятностной схемы: 71 час — кандидат, 73 часа — нет', () => {
  const inside = h.setup();
  h.click(inside.db, 'a', inside_T(h.T0, 71));
  h.deliver(inside.db, h.userAdded('U1', h.T0));
  assert.equal(attrOf(inside.db, 'U1').type, 'probabilistic');

  const outside = h.setup();
  h.click(outside.db, 'a', inside_T(h.T0, 73));
  h.deliver(outside.db, h.userAdded('U1', h.T0));
  assert.equal(attrOf(outside.db, 'U1').type, 'unattributed');

  function inside_T(t, hours) { return t - hours * h.HOUR; }
});

test('окно настраивается на workspace', () => {
  const { db } = h.setup({ windowHours: 2 });
  h.click(db, 'a', h.T0 - 3 * h.HOUR);
  h.deliver(db, h.userAdded('U1', h.T0));
  assert.equal(attrOf(db, 'U1').type, 'unattributed');
});

test('допуск на задержку доставки: клик через 60 секунд после события — ещё кандидат', () => {
  const { db } = h.setup();
  h.click(db, 'a', h.T0 + 60 * 1000);
  h.deliver(db, h.userAdded('U1', h.T0));
  assert.equal(attrOf(db, 'U1').type, 'probabilistic');

  const late = h.setup();
  h.click(late.db, 'a', h.T0 + 5 * h.MIN);
  h.deliver(late.db, h.userAdded('U1', h.T0));
  assert.equal(attrOf(late.db, 'U1').type, 'unattributed');
});

test('плотный поток: больше 20 кандидатов — is_dense и уверенность вдвое ниже', () => {
  const { db } = h.setup();
  for (let i = 0; i < 21; i++) h.click(db, 'b', h.T0 + i * h.MIN);
  h.deliver(db, h.userAdded('U1', h.T0 + 25 * h.MIN));
  const a = attrOf(db, 'U1');
  assert.equal(a.is_dense, 1);
  assert.ok(a.confidence < 0.5);
  assert.equal(a.is_ambiguous, 1);
});

test('клик, привязанный точно к другой подписке, не становится кандидатом', () => {
  const { db } = h.setup();
  const det = h.click(db, 'a', h.T0);
  h.deliver(db, h.botStarted('U1', h.T0, det.clickId));
  h.deliver(db, h.userAdded('U1', h.T0 + 5 * h.MIN));
  h.deliver(db, h.userAdded('U2', h.T0 + 10 * h.MIN));

  const a = attrOf(db, 'U2');
  assert.equal(a.type, 'unattributed', 'единственный клик уже принадлежит другой подписке');
});

test('отфильтрованные клики в атрибуции не участвуют', () => {
  const { db } = h.setup();
  h.click(db, 'a', h.T0, { userAgent: 'YandexBot/3.0' });
  h.deliver(db, h.userAdded('U1', h.T0 + h.MIN));
  assert.equal(attrOf(db, 'U1').type, 'unattributed');
});

test('пересчёт из сырых данных идемпотентен и сохраняет историю версий', () => {
  const { db } = h.setup();
  h.click(db, 'a', h.T0);
  h.click(db, 'b', h.T0 + 20 * h.MIN);
  h.deliver(db, h.userAdded('U1', h.T0 + 25 * h.MIN));
  h.deliver(db, h.userAdded('U2', h.T0 + 26 * h.MIN));

  const snap = () => JSON.stringify(all(db,
    'SELECT subscription_id, type, click_id, confidence FROM attributions WHERE is_current = 1 ORDER BY subscription_id'));
  pipeline.reattributeAll(db);
  const first = snap();
  pipeline.reattributeAll(db);
  assert.equal(snap(), first, 'повторный пересчёт даёт тот же ответ');

  const total = one(db, 'SELECT COUNT(*) c FROM attributions').c;
  const current = one(db, 'SELECT COUNT(*) c FROM attributions WHERE is_current = 1').c;
  assert.ok(total > current, 'старые версии не удаляются');
  assert.equal(current, 2, 'актуальная версия ровно одна на подписку');
});

test('таймзона workspace не влияет на атрибуцию: хранение и сравнение в UTC', () => {
  const utc = h.setup({ timezone: 'UTC' });
  const vlad = h.setup({ timezone: 'Asia/Vladivostok' });
  for (const ctx of [utc, vlad]) {
    h.click(ctx.db, 'a', h.T0);
    h.deliver(ctx.db, h.userAdded('U1', h.T0 + 10 * h.MIN));
  }
  const a1 = attrOf(utc.db, 'U1');
  const a2 = attrOf(vlad.db, 'U1');
  assert.equal(a1.type, a2.type);
  assert.equal(Math.round(a1.confidence * 1e6), Math.round(a2.confidence * 1e6));
});

test('калибровка не выдаёт цифру точности, когда сравнивать не с чем', () => {
  const { db } = h.setup();
  const cal = attribution.calibrate(db);
  assert.equal(cal.accuracy, null);
  assert.ok(cal.note);
});

test('РЕГРЕССИЯ: один клик не получает кредит за десятки подписок', () => {
  // Найдено при разборе живых данных: единственный клик в канале забирал себе всех,
  // кто подписался в окне, — источник выглядел бы в разы эффективнее, чем он есть.
  const { db } = h.setup();
  h.click(db, 'a', h.T0);
  for (let i = 0; i < 30; i++) h.deliver(db, h.userAdded('u' + i, h.T0 + (i + 1) * 60 * 1000));

  const attributed = all(db,
    'SELECT COUNT(*) c FROM attributions WHERE is_current = 1 AND type = \'probabilistic\'')[0].c;
  const unattributed = all(db,
    'SELECT COUNT(*) c FROM attributions WHERE is_current = 1 AND type = \'unattributed\'')[0].c;

  assert.ok(attributed >= 1, 'ближайшая по времени подписка всё-таки привязывается');
  assert.ok(attributed <= 10, 'но не все тридцать: получилось ' + attributed);
  assert.ok(unattributed >= 20, 'остальные честно помечены как источник неизвестен');
});
