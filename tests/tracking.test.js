'use strict';

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { one } = require('../src/db');
const tracking = require('../src/tracking');

test('HEAD-запрос не считается кликом, но сохраняется', () => {
  const { db } = h.setup();
  const r = h.click(db, 'a', h.T0, { method: 'HEAD' });
  assert.equal(r.counted, false);
  assert.equal(r.filterReason, 'head_request');
  assert.equal(one(db, 'SELECT status FROM clicks WHERE id = ?', r.clickId).status, 'filtered');
});

test('бот по user-agent и запрос без Accept: text/html отбраковываются', () => {
  const { db } = h.setup();
  assert.equal(h.click(db, 'a', h.T0, { userAgent: 'Googlebot/2.1' }).filterReason, 'bot_ua');
  assert.equal(h.click(db, 'a', h.T0 + h.MIN, { headers: { accept: 'image/*' } }).filterReason, 'no_html_accept');
});

test('повтор того же клика в пределах 30 секунд — дедуп', () => {
  const { db } = h.setup();
  const first = h.click(db, 'a', h.T0);
  const dup = h.click(db, 'a', h.T0 + 10 * 1000);
  const later = h.click(db, 'a', h.T0 + 31 * 1000);
  assert.equal(first.counted, true);
  assert.equal(dup.filterReason, 'dedup_30s');
  assert.equal(later.counted, true);
});

test('неизвестный slug не создаёт клик', () => {
  const { db } = h.setup();
  const r = h.click(db, 'no-such-link', h.T0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_link');
  assert.equal(one(db, 'SELECT COUNT(*) c FROM clicks').c, 0);
});

test('device_hint определяется по user-agent', () => {
  assert.equal(tracking.deviceHint('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'ios');
  assert.equal(tracking.deviceHint('Mozilla/5.0 (Linux; Android 14)'), 'android');
  assert.equal(tracking.deviceHint('Mozilla/5.0 (Macintosh) Chrome/120'), 'web');
  assert.equal(tracking.deviceHint(''), 'unknown');
});

test('цель редиректа: bot даёт диплинк с click_id, direct — ссылку на канал', () => {
  const { db, link, link2 } = h.setup();
  const target = tracking.redirectTarget(link, 'abc123', { botName: 'mybot' });
  assert.equal(target, 'https://max.ru/mybot?start=abc123');

  const direct = tracking.redirectTarget(link2, 'abc123', { channelUrl: 'https://max.ru/mychannel' });
  assert.equal(direct, 'https://max.ru/mychannel');

  assert.throws(() => tracking.redirectTarget(link, 'abc123', {}), /botName/);
  assert.ok(db);
});

test('сырой IP не хранится, только хеш', () => {
  const { db } = h.setup();
  const r = h.click(db, 'a', h.T0, { ip: '203.0.113.77' });
  const row = one(db, 'SELECT * FROM clicks WHERE id = ?', r.clickId);
  assert.ok(row.ip_hash && row.ip_hash.length === 24);
  assert.ok(!JSON.stringify(row).includes('203.0.113.77'));
});

test('РЕГРЕССИЯ: пригласительная ссылка одноразовая и с сроком годности', async () => {
  // На живом тесте человек вступил повторно по старой ссылке, и подписка ушла к прежнему клику.
  // Без member_limit ссылка Telegram многоразовая и бессрочная: одна пересылка — и десяток
  // человек припишется одному клику.
  const calls = [];
  const api = {
    createChatInviteLink(chatId, name, opts) {
      calls.push({ chatId, name, opts });
      const { TelegramApi } = require('../src/platform/telegramApi');
      return new TelegramApi({ mode: 'mock' }).createChatInviteLink(chatId, name, opts);
    }
  };
  const { db, ws } = h.setup();
  const tracking = require('../src/tracking');
  const pool = require('../src/invitePool');
  const ch = tracking.connectChannel(db, { workspaceId: ws.id, platform: 'telegram', externalChatId: '-100777' });
  const link = tracking.createLink(db, { workspaceId: ws.id, channelId: ch.id, slug: 'inv', source: 's', redirectMode: 'invite' });

  await pool.refill(db, { channel: ch, link, api, size: 2 });
  assert.equal(calls.length, 2);

  const { TelegramApi } = require('../src/platform/telegramApi');
  const sample = await new TelegramApi({ mode: 'mock' }).createChatInviteLink('-100777', 'x');
  assert.equal(sample.result.member_limit, 1, 'ссылка рассчитана ровно на одного человека');
  assert.ok(sample.result.expire_date > Math.floor(Date.now() / 1000), 'у ссылки есть срок годности');
});

test('РЕГРЕССИЯ: обрыв связи не обнуляет весь пул пригласительных ссылок', async () => {
  // Сеть до Telegram из России нестабильна. Раньше первая же ошибка обрывала пачку
  // и пул оставался пустым — редирект уходил на обычную ссылку, атрибуция теряла точность.
  const { db, ws } = h.setup();
  const tracking = require('../src/tracking');
  const pool = require('../src/invitePool');
  const ch = tracking.connectChannel(db, { workspaceId: ws.id, platform: 'telegram', externalChatId: '-100flaky' });
  const link = tracking.createLink(db, { workspaceId: ws.id, channelId: ch.id, slug: 'flaky', source: 's', redirectMode: 'invite' });

  let call = 0;
  const api = {
    async createChatInviteLink(chatId, name) {
      call += 1;
      if (call === 2) throw new Error('fetch failed');   // одна ссылка упала
      if (call === 3) throw new Error('fetch failed');   // и её повтор тоже
      if (call === 4) throw new Error('fetch failed');   // и последний повтор
      return { mode: 'mock', result: { invite_link: 'https://t.me/+ok' + call, member_limit: 1 } };
    }
  };

  const res = await pool.refill(db, { channel: ch, link, api, size: 3 });
  assert.ok(res.created.length >= 2, 'остальные ссылки всё равно созданы: ' + res.created.length);
  assert.equal(res.error, null, 'частичный успех не считается провалом');
  assert.ok(res.failed >= 1, 'неудачи посчитаны');
  assert.ok(pool.freeCount(db, ch.id, link.id) >= 2);
});

test('РЕГРЕССИЯ: обрыв связи с Telegram не съедает ответ бота', async () => {
  const { TelegramApi } = require('../src/platform/telegramApi');
  let calls = 0;
  const api = new TelegramApi({
    token: 'x', mode: 'real',
    fetchImpl: async () => {
      calls++;
      // Первые две попытки — обрыв соединения, как это выглядит на боевом сервере.
      if (calls < 3) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    }
  });

  const r = await api.sendMessage('123', 'привет');
  assert.equal(calls, 3, 'две неудачные попытки и третья удачная');
  assert.equal(r.result.message_id, 7);
});

test('ошибку самого Telegram повторять не пытаемся', async () => {
  const { TelegramApi } = require('../src/platform/telegramApi');
  let calls = 0;
  const api = new TelegramApi({
    token: 'x', mode: 'real',
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'chat not found' }) };
    }
  });

  await assert.rejects(() => api.sendMessage('123', 'привет'), /chat not found/);
  assert.equal(calls, 1, 'отказ API — не повод долбиться повторно');
});
