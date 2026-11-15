'use strict';

/** VK Реклама: связка клика и подписки идёт по rb_clickid, который VK сам дописывает к ссылке. */

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { one } = require('../src/db');
const dispatcher = require('../src/conversions/dispatcher');
const { VkAdsProvider } = require('../src/conversions/providers');
const { id } = require('../src/ids');
const { run } = require('../src/db');

function setupVk(db, opts) {
  const ws = one(db, 'SELECT * FROM workspaces');
  run(db, 'INSERT INTO ad_platform_credentials (id, workspace_id, provider, mode, counter_id, goal_id, created_at) ' +
    'VALUES (?, ?, \'vk_ads\', ?, ?, ?, ?)',
    id('cred'), ws.id, (opts && opts.mode) || 'real', '3523812', 'tg_subscription', Date.now());
  return ws;
}

test('адрес события VK собирается по формату трекера', () => {
  const p = new VkAdsProvider({ pixelId: '3523812', goal: 'tg_subscription', mode: 'mock' });
  assert.equal(
    p.buildUrl({ rbClickId: '162103862-1717925069-7', price: 0 }),
    'https://top-fwz1.mail.ru/tracker?id=3523812;e=RG%3A/tg_subscription;rb_clickid=162103862-1717925069-7'
  );
});

test('подписка уходит в VK, когда в клике был rb_clickid', async () => {
  const { db } = h.setup();
  const ws = setupVk(db);

  const click = h.click(db, 'a', h.T0, { query: { rb_clickid: '162103862-1717925069-7' } });
  assert.equal(click.counted, true);
  h.deliver(db, h.userAdded('U1', h.T0 + 5 * h.MIN));

  const sub = one(db, 'SELECT * FROM subscriptions');
  dispatcher.enqueue(db, { workspaceId: ws.id, subscriptionId: sub.id, kind: 'subscription' });

  const calls = [];
  const factory = () => new VkAdsProvider({
    pixelId: '3523812', goal: 'tg_subscription', mode: 'real',
    fetchImpl: async (url) => { calls.push(url); return { status: 200 }; }
  });
  await dispatcher.processQueue(db, { providerFactory: factory });

  const conv = one(db, 'SELECT * FROM conversions');
  assert.equal(conv.status, 'sent');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /top-fwz1\.mail\.ru\/tracker/);
  assert.match(calls[0], /rb_clickid=162103862-1717925069-7/);
  assert.match(calls[0], /e=RG%3A\/tg_subscription/);
});

test('без rb_clickid конверсия в VK не уходит, а честно помечается пропущенной', async () => {
  const { db } = h.setup();
  const ws = setupVk(db);

  h.click(db, 'a', h.T0, { query: { utm_source: 'vk' } }); // метки есть, идентификатора клика нет
  h.deliver(db, h.userAdded('U2', h.T0 + 5 * h.MIN));
  const sub = one(db, 'SELECT * FROM subscriptions');
  dispatcher.enqueue(db, { workspaceId: ws.id, subscriptionId: sub.id, kind: 'subscription' });

  let called = 0;
  await dispatcher.processQueue(db, {
    providerFactory: () => new VkAdsProvider({
      pixelId: '3523812', mode: 'real', fetchImpl: async () => { called += 1; return { status: 200 }; }
    })
  });

  const conv = one(db, 'SELECT * FROM conversions');
  assert.equal(conv.status, 'skipped');
  assert.match(conv.error, /rb_clickid/);
  assert.equal(called, 0, 'в VK ничего не отправлялось');
});

test('ошибка VK 5xx повторяется, 4xx — нет', async () => {
  const { db } = h.setup();
  const ws = setupVk(db);
  h.click(db, 'a', h.T0, { query: { rb_clickid: 'abc-1' } });
  h.deliver(db, h.userAdded('U3', h.T0 + 2 * h.MIN));
  const sub = one(db, 'SELECT * FROM subscriptions');
  dispatcher.enqueue(db, { workspaceId: ws.id, subscriptionId: sub.id, kind: 'subscription' });

  await dispatcher.processQueue(db, {
    providerFactory: () => new VkAdsProvider({
      pixelId: '1', mode: 'real', fetchImpl: async () => ({ status: 500 })
    })
  });
  assert.equal(one(db, 'SELECT status FROM conversions').status, 'retrying', '500 — временная ошибка');

  run(db, 'UPDATE conversions SET status = \'pending\', attempts = 0, next_attempt_at = ?', Date.now());
  await dispatcher.processQueue(db, {
    providerFactory: () => new VkAdsProvider({
      pixelId: '1', mode: 'real', fetchImpl: async () => ({ status: 400 })
    })
  });
  const conv = one(db, 'SELECT * FROM conversions');
  assert.equal(conv.status, 'failed', '400 — повторять бессмысленно');
  assert.match(conv.error, /повторы бессмысленны/);
});

test('идентификатор клика не утекает в текст ошибки целиком', async () => {
  const p = new VkAdsProvider({
    pixelId: '1', mode: 'real', fetchImpl: async () => ({ status: 403 })
  });
  await assert.rejects(
    () => p.send([{ rbClickId: 'secret-click-id-12345', price: 0 }]),
    (e) => {
      assert.ok(!e.message.includes('secret-click-id-12345'), 'идентификатор замаскирован');
      assert.match(e.message, /rb_clickid=\*\*\*/);
      return true;
    }
  );
});

test('Метрика по-прежнему отбраковывает нечисловой yclid', async () => {
  const { db } = h.setup();
  const ws = one(db, 'SELECT * FROM workspaces');
  run(db, 'INSERT INTO ad_platform_credentials (id, workspace_id, provider, mode, counter_id, goal_id, created_at) ' +
    'VALUES (?, ?, \'yandex_metrika\', \'mock\', \'111\', \'g\', ?)', id('cred'), ws.id, Date.now());

  h.click(db, 'a', h.T0, { query: { yclid: 'NOT_A_NUMBER' } });
  h.deliver(db, h.userAdded('U4', h.T0 + 2 * h.MIN));
  const sub = one(db, 'SELECT * FROM subscriptions');
  dispatcher.enqueue(db, { workspaceId: ws.id, subscriptionId: sub.id, kind: 'subscription' });
  await dispatcher.processQueue(db, {});

  const conv = one(db, 'SELECT * FROM conversions');
  assert.equal(conv.status, 'skipped');
  assert.match(conv.error, /не число/);
});

test('страница ссылок показывает, доехал ли идентификатор рекламной системы', async () => {
  const { open } = require('../src/db');
  const { createApp } = require('../src/server');
  const db = open(':memory:');
  const app = createApp(db, { log: () => {} });
  await new Promise((res) => app.server.listen(0, res));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  let cookie = '';
  async function req(path, opts) {
    const o = opts || {};
    const r = await fetch(base + path, {
      method: o.method || 'GET', redirect: 'manual',
      headers: Object.assign({ accept: 'text/html', cookie }, o.headers || {}), body: o.body
    });
    for (const sc of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = sc.split(';')[0], n = kv.split('=')[0];
      cookie = cookie.split('; ').filter(Boolean).filter((p) => !p.startsWith(n + '=')).concat(kv).join('; ');
    }
    return { status: r.status, text: await r.text() };
  }
  try {
    await req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'vkui@test.ru', password: 'secret123' }).toString()
    });
    const ws = one(db, 'SELECT * FROM workspaces');
    const tracking = require('../src/tracking');
    const ch = tracking.connectChannel(db, { workspaceId: ws.id, platform: 'telegram', externalChatId: '-100ui' });
    tracking.createLink(db, { workspaceId: ws.id, channelId: ch.id, slug: 'uitest', source: 'vk_ads', redirectMode: 'direct' });
    run(db, 'UPDATE channels SET channel_url = ? WHERE id = ?', 'https://t.me/x', ch.id);

    await req('/c/uitest?rb_clickid=162103862-1717925069', {
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Android 14)' }
    });
    const page = await req('/app/links');
    assert.match(page.text, /Последние переходы/);
    assert.match(page.text, /rb_clickid/);
    assert.match(page.text, /162103862-1717925069/);
  } finally {
    app.server.close();
  }
});

test('идентификатор клика VK принимается под любым из возможных имён', async () => {
  for (const name of ['rb_clickid', 'clickid', 'click_id', 'vk_click_id']) {
    const { db } = h.setup();
    const ws = setupVk(db);
    h.click(db, 'a', h.T0, { query: { [name]: 'ID-' + name } });
    h.deliver(db, h.userAdded('U_' + name, h.T0 + 3 * h.MIN));
    const sub = one(db, 'SELECT * FROM subscriptions');
    dispatcher.enqueue(db, { workspaceId: ws.id, subscriptionId: sub.id, kind: 'subscription' });

    const urls = [];
    await dispatcher.processQueue(db, {
      providerFactory: () => new VkAdsProvider({
        pixelId: '1', goal: 'g', mode: 'real',
        fetchImpl: async (u) => { urls.push(u); return { status: 200 }; }
      })
    });
    assert.equal(one(db, 'SELECT status FROM conversions').status, 'sent', 'параметр ' + name + ' распознан');
    assert.match(urls[0], new RegExp('rb_clickid=ID-' + name));
  }
});
