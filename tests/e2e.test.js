'use strict';

/**
 * Сквозной тест продукта: регистрация -> канал -> ссылка -> клик -> подписка -> атрибуция ->
 * дашборд -> конверсия. Это и есть definition of done из мастер-промта, только на mock-интеграциях.
 */

const test = require('node:test');
const assert = require('node:assert');
const { open, one, all, run } = require('../src/db');
const { createApp } = require('../src/server');
const dispatcher = require('../src/conversions/dispatcher');
const accounts = require('../src/accounts');

function csrfOf(html) {
  const m = html.match(/name="csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}

async function boot() {
  const db = open(':memory:');
  const app = createApp(db, { log: (l, m, meta) => { if (process.env.E2E_DEBUG && l === 'error') console.log('ERR', m, JSON.stringify(meta).slice(0, 800)); } });
  await new Promise((res) => app.server.listen(0, res));
  const port = app.server.address().port;
  const base = 'http://127.0.0.1:' + port;
  let cookie = '';

  async function req(path, opts) {
    const o = opts || {};
    const res = await fetch(base + path, {
      method: o.method || 'GET',
      redirect: 'manual',
      headers: Object.assign({ accept: 'text/html', cookie }, o.headers || {}),
      body: o.body
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookie) {
      const kv = sc.split(';')[0];
      const name = kv.split('=')[0];
      cookie = cookie.split('; ').filter(Boolean).filter((p) => !p.startsWith(name + '=')).concat(kv).join('; ');
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  }

  /** CSRF-токен берём со страницы, которая точно рендерит форму. */
  async function form(path, fields, csrfPath) {
    const page = await req(csrfPath || '/app/settings');
    const csrf = csrfOf(page.text);
    assert.ok(csrf, 'на странице ' + (csrfPath || '/app/settings') + ' есть csrf-токен');
    const body = new URLSearchParams(Object.assign({ csrf }, fields)).toString();
    return req(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  return { db, app, base, req, form, close: () => app.server.close() };
}

test('сквозной путь: регистрация → канал → ссылка → клик → подписка → атрибуция → дашборд → конверсия', async () => {
  const t = await boot();
  try {
    // 1. регистрация
    const reg = await t.req('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'owner@test.ru', password: 'secret123', workspace: 'Тест' }).toString()
    });
    assert.equal(reg.status, 302);
    assert.equal(reg.headers.get('location'), '/app');

    const app1 = await t.req('/app');
    assert.equal(app1.status, 200);
    assert.match(app1.text, /Настройка: 0 из 6/);

    // 2. канал
    await t.form('/app/channels', { platform: 'telegram', external_chat_id: '-1001', title: 'Тестовый канал', channel_url: 'https://t.me/test' });
    const ch = one(t.db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-1001');
    assert.ok(ch, 'канал создан');

    // 3. проверка канала — mock API помечает бота как mock, не как реальный
    await t.form('/app/channels/check', { channel: ch.id });
    const checked = one(t.db, 'SELECT * FROM channels WHERE id = ?', ch.id);
    assert.equal(checked.status, 'connected');
    assert.equal(checked.bot_status, 'mock', 'mock не выдаётся за настоящее подключение');

    // 4. ссылка в режиме собственной пригласительной ссылки
    await t.form('/app/links', {
      channel: ch.id, redirect_mode: 'invite', source: 'yandex_direct',
      campaign: 'autumn', creative: 'banner_1'
    });
    const link = one(t.db, 'SELECT * FROM tracking_links WHERE workspace_id = ?', ch.workspace_id);
    assert.ok(link, 'ссылка создана');
    assert.ok(one(t.db, 'SELECT COUNT(*) c FROM invite_links WHERE tracking_link_id = ?', link.id).c > 0, 'пул наполнен');

    // 5. клик по ссылке
    const click = await t.req('/c/' + link.slug + '?yclid=17886045680000000001&utm_source=direct', {
      headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }
    });
    assert.equal(click.status, 302);
    const invite = click.headers.get('location');
    assert.match(invite, /^https:\/\/t\.me\/\+mock/, 'редирект ведёт на выданную пригласительную ссылку');

    const clickRow = one(t.db, 'SELECT * FROM clicks WHERE status = \'counted\'');
    assert.ok(clickRow, 'клик записан');
    assert.match(clickRow.query_json, /17886045680000000001/, 'yclid сохранён');
    assert.ok(!JSON.stringify(clickRow).includes('127.0.0.1'), 'сырой IP не сохраняется');

    // 6. подписка приходит вебхуком и несёт ту же пригласительную ссылку
    const hook = await t.req('/webhook/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 1,
        chat_member: {
          chat: { id: '-1001', type: 'channel' },
          from: { id: 777 },
          date: Math.floor(Date.now() / 1000),
          old_chat_member: { status: 'left', user: { id: 777 } },
          new_chat_member: { status: 'member', user: { id: 777 } },
          invite_link: { invite_link: invite, name: 'x' }
        }
      })
    });
    assert.equal(hook.status, 200);

    // 7. атрибуция — точная, к нашему клику
    const attr = one(t.db, 'SELECT * FROM attributions WHERE is_current = 1');
    assert.ok(attr, 'атрибуция создана');
    assert.equal(attr.type, 'deterministic');
    assert.equal(attr.click_id, clickRow.id);
    assert.equal(attr.confidence, 1);

    // 8. дашборд показывает результат
    const dash = await t.req('/app');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /yandex_direct/);
    assert.match(dash.text, /точно/);

    // 9. расход -> появляется CPS
    await t.form('/app/spend', { scope_type: 'source', scope_value: 'yandex_direct', day: new Date().toISOString().slice(0, 10), amount: '500' });
    const dash2 = await t.req('/app');
    assert.match(dash2.text, /500 ₽/, 'расход виден');

    // 10. интеграция в режиме mock: очередь ведётся, наружу ничего не уходит
    // передача конверсий — тариф PRO, в MVP его включает администратор
    const wsRow = one(t.db, 'SELECT * FROM workspaces');
    const blocked = await t.form('/app/integrations', { provider: 'yandex_metrika', counter_id: '', goal_id: 'sub', token: '' });
    assert.equal(blocked.status, 302);
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM ad_platform_credentials').c, 0, 'на free тарифе интеграция не сохраняется');
    accounts.setPlan(t.db, wsRow.id, 'pro', 1, null);
    await t.form('/app/integrations', { provider: 'yandex_metrika', counter_id: '', goal_id: 'sub', token: '' });
    const cred = one(t.db, 'SELECT * FROM ad_platform_credentials');
    assert.equal(cred.mode, 'mock');

    const sub = one(t.db, 'SELECT * FROM subscriptions');
    dispatcher.enqueue(t.db, { workspaceId: ch.workspace_id, subscriptionId: sub.id, attributionId: attr.id, kind: 'first_subscription' });
    await dispatcher.processQueue(t.db, {});
    const conv = one(t.db, 'SELECT * FROM conversions');
    assert.equal(conv.status, 'sent');
    assert.equal(conv.mode, 'mock', 'режим отправки честно помечен как mock');
    assert.match(conv.payload_json, /17886045680000000001/, 'в конверсию ушёл yclid из клика');
  } finally {
    t.close();
  }
});

test('конверсия без yclid не отправляется, а помечается пропущенной', async () => {
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'x@test.ru', password: 'secret123' }).toString()
    });
    await t.form('/app/channels', { platform: 'max', external_chat_id: 'c1', title: 'MAX', channel_url: 'https://max.ru/c' });
    const ch = one(t.db, 'SELECT * FROM channels');
    await t.form('/app/links', { channel: ch.id, redirect_mode: 'direct', source: 'seeding' });
    const link = one(t.db, 'SELECT * FROM tracking_links');
    await t.req('/c/' + link.slug, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Android 14)' } });

    await t.req('/webhook/max', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_type: 'user_added', timestamp: Date.now(), chat_id: 'c1', user: { user_id: 'u1' }, is_channel: true })
    });
    const attr = one(t.db, 'SELECT * FROM attributions WHERE is_current = 1');
    assert.equal(attr.type, 'probabilistic', 'в MAX при прямом переходе атрибуция вероятностная');

    accounts.setPlan(t.db, ch.workspace_id, 'pro', 1, null);
    await t.form('/app/integrations', { provider: 'yandex_metrika', counter_id: '', goal_id: 'sub', token: '' });
    const sub = one(t.db, 'SELECT * FROM subscriptions');
    dispatcher.enqueue(t.db, { workspaceId: ch.workspace_id, subscriptionId: sub.id, attributionId: attr.id, kind: 'subscription' });
    await dispatcher.processQueue(t.db, {});
    const conv = one(t.db, 'SELECT * FROM conversions');
    assert.equal(conv.status, 'skipped');
    assert.match(conv.error, /yclid/);
  } finally {
    t.close();
  }
});

test('чужой workspace недоступен, CSRF обязателен, админка закрыта', async () => {
  const t = await boot();
  try {
    const anon = await t.req('/app');
    assert.equal(anon.status, 302, 'без входа кабинет недоступен');

    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'u@test.ru', password: 'secret123' }).toString()
    });
    const noCsrf = await t.req('/app/channels', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ platform: 'telegram', external_chat_id: '-1' }).toString()
    });
    assert.equal(noCsrf.status, 403, 'форма без CSRF-токена отклоняется');

    const admin = await t.req('/admin');
    assert.equal(admin.status, 403, 'админка закрыта для обычного пользователя');
  } finally {
    t.close();
  }
});

test('демо-режим помечен и полностью удаляется', async () => {
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'd@test.ru', password: 'secret123' }).toString()
    });
    const settings = await t.req('/app/settings');
    const csrf = csrfOf(settings.text);
    await t.req('/app/demo', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString()
    });

    const ws = one(t.db, 'SELECT * FROM workspaces');
    assert.equal(ws.demo_mode, 1);
    // «больше нуля» — слишком слабо: за таким утверждением пряталось схлопывание событий
    // по ключу идемпотентности. Проверяем объём и то, что источников действительно несколько.
    const subs = one(t.db, 'SELECT COUNT(*) c FROM subscriptions').c;
    assert.ok(subs > 30, 'демо создаёт десятки подписок, а не одну: получено ' + subs);
    const sources = all(t.db,
      'SELECT DISTINCT tl.source s FROM subscriptions su ' +
      'JOIN attributions a ON a.subscription_id = su.id AND a.is_current = 1 ' +
      'JOIN clicks c ON c.id = a.click_id JOIN tracking_links tl ON tl.id = c.tracking_link_id').map((r) => r.s);
    assert.ok(sources.length >= 2, 'подписки распределились по нескольким источникам: ' + sources.join(', '));
    const dash = await t.req('/app');
    assert.match(dash.text, /DEMO MODE/, 'в интерфейсе видно, что данные демонстрационные');

    await t.req('/app/demo', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString()
    });
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM subscriptions').c, 0, 'демо-данные удалены полностью');
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM clicks').c, 0);
  } finally {
    t.close();
  }
});

test('токен рекламного кабинета хранится в базе зашифрованным', async () => {
  const secrets = require('../src/secrets');
  const { cfg } = require('../src/config');
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'k@test.ru', password: 'secret123' }).toString()
    });
    const ws = one(t.db, 'SELECT * FROM workspaces');
    accounts.setPlan(t.db, ws.id, 'pro', 1, null);
    await t.form('/app/integrations', { provider: 'yandex_metrika', counter_id: '99', goal_id: 'sub', token: 'y0_super_secret' });

    const cred = one(t.db, 'SELECT * FROM ad_platform_credentials');
    assert.ok(cred.token.startsWith('enc.v1.'), 'в базе лежит шифртекст');
    assert.ok(!cred.token.includes('y0_super_secret'), 'открытого токена в базе нет');
    assert.equal(secrets.decrypt(cred.token, cfg.secretKey), 'y0_super_secret', 'расшифровка возвращает исходный токен');
    assert.equal(cred.mode, 'real', 'со счётчиком и токеном интеграция переходит в режим real');

    const pageHtml = (await t.req('/app/integrations')).text;
    assert.ok(!pageHtml.includes('y0_super_secret'), 'токен не показывается в интерфейсе');
  } finally {
    t.close();
  }
});

test('в боевом режиме вебхук без секрета отклоняется', async () => {
  const { cfg } = require('../src/config');
  const t = await boot();
  const saved = { mode: cfg.max.mode, secret: cfg.max.webhookSecret };
  try {
    cfg.max.mode = 'real';
    cfg.max.webhookSecret = '';
    const res = await t.req('/webhook/max', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_type: 'user_added', timestamp: Date.now(), chat_id: 'x', user: { user_id: 'u' }, is_channel: true })
    });
    assert.equal(res.status, 403, 'без секрета боевой вебхук закрыт');
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM webhook_events').c, 0, 'подделка не попадает в хранилище');
  } finally {
    cfg.max.mode = saved.mode;
    cfg.max.webhookSecret = saved.secret;
    t.close();
  }
});

test('РЕГРЕССИЯ: нечисловой yclid не отправляется в Метрику', async () => {
  // Живой ответ Метрики на строковый yclid: 400 invalid_uploading. Проверяем до отправки,
  // чтобы не молотить чужой API заведомо непринимаемыми данными.
  const dispatcherMod = require('../src/conversions/dispatcher');
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'y@test.ru', password: 'secret123' }).toString()
    });
    const ws = one(t.db, 'SELECT * FROM workspaces');
    accounts.setPlan(t.db, ws.id, 'pro', 1, null);
    await t.form('/app/channels', { platform: 'telegram', external_chat_id: '-1001', title: 'C', channel_url: 'https://t.me/c' });
    const ch = one(t.db, 'SELECT * FROM channels');
    await t.form('/app/links', { channel: ch.id, redirect_mode: 'direct', source: 'yandex' });
    const link = one(t.db, 'SELECT * FROM tracking_links');
    await t.req('/c/' + link.slug + '?yclid=NOT_A_NUMBER', { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iPhone)' } });
    await t.req('/webhook/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 9001,
        chat_member: {
          chat: { id: '-1001', type: 'channel' }, from: { id: 42 }, date: Math.floor(Date.now() / 1000),
          old_chat_member: { status: 'left', user: { id: 42 } },
          new_chat_member: { status: 'member', user: { id: 42 } }
        }
      })
    });
    await t.form('/app/integrations', { provider: 'yandex_metrika', counter_id: '999', goal_id: 'g', token: 'fake' });
    const sub = one(t.db, 'SELECT * FROM subscriptions');
    dispatcherMod.enqueue(t.db, { workspaceId: ws.id, subscriptionId: sub.id, kind: 'subscription' });
    await dispatcherMod.processQueue(t.db, {});

    const conv = one(t.db, 'SELECT * FROM conversions');
    assert.equal(conv.status, 'skipped');
    assert.match(conv.error, /не число/);
  } finally {
    t.close();
  }
});

test('РЕГРЕССИЯ: постоянная ошибка провайдера не уходит в бесконечные повторы', async () => {
  const dispatcherMod = require('../src/conversions/dispatcher');
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'p@test.ru', password: 'secret123' }).toString()
    });
    const ws = one(t.db, 'SELECT * FROM workspaces');
    accounts.setPlan(t.db, ws.id, 'pro', 1, null);
    await t.form('/app/channels', { platform: 'telegram', external_chat_id: '-1002', title: 'C', channel_url: 'https://t.me/c' });
    const ch = one(t.db, 'SELECT * FROM channels');
    await t.form('/app/links', { channel: ch.id, redirect_mode: 'direct', source: 'yandex' });
    const link = one(t.db, 'SELECT * FROM tracking_links');
    await t.req('/c/' + link.slug + '?yclid=1234567890', { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iPhone)' } });
    await t.req('/webhook/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 9002,
        chat_member: {
          chat: { id: '-1002', type: 'channel' }, from: { id: 43 }, date: Math.floor(Date.now() / 1000),
          old_chat_member: { status: 'left', user: { id: 43 } },
          new_chat_member: { status: 'member', user: { id: 43 } }
        }
      })
    });
    await t.form('/app/integrations', { provider: 'yandex_metrika', counter_id: '999', goal_id: 'g', token: 'fake' });
    const sub = one(t.db, 'SELECT * FROM subscriptions');
    dispatcherMod.enqueue(t.db, { workspaceId: ws.id, subscriptionId: sub.id, kind: 'subscription' });

    const permanent = () => ({
      name: 'x',
      send() { const e = new Error('Метрика ответила 400: плохие данные'); e.retryable = false; throw e; }
    });
    await dispatcherMod.processQueue(t.db, { providerFactory: permanent });

    const conv = one(t.db, 'SELECT * FROM conversions');
    assert.equal(conv.status, 'failed', 'после 400 сразу failed, без пяти лишних попыток');
    assert.equal(conv.attempts, 1);
    assert.match(conv.error, /повторы бессмысленны/);
  } finally {
    t.close();
  }
});

test('РЕГРЕССИЯ: HEAD-запрос обслуживается, а не возвращает 404', async () => {
  // Аудит боевой версии: мониторинги и превью-боты получали 404 на живых страницах.
  const t = await boot();
  try {
    const get = await t.req('/login');
    const head = await t.req('/login', { method: 'HEAD' });
    assert.equal(get.status, 200);
    assert.equal(head.status, 200, 'HEAD обслуживается тем же обработчиком, что и GET');
  } finally {
    t.close();
  }
});

test('РЕГРЕССИЯ: событие, сохранённое но не обработанное, добирается позже', async () => {
  // Если процесс умер между сохранением и обработкой, событие оставалось received навсегда.
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'rec@test.ru', password: 'secret123' }).toString()
    });
    const ws = one(t.db, 'SELECT * FROM workspaces');
    const tracking = require('../src/tracking');
    tracking.connectChannel(t.db, { workspaceId: ws.id, platform: 'telegram', externalChatId: '-100rec' });

    // имитируем обрыв: событие сохранено, обработка не выполнена
    const collector = require('../src/collector');
    const ing = collector.ingest(t.db, {
      transport: 'polling', headers: {},
      bodyRaw: JSON.stringify({
        update_id: 4242,
        chat_member: {
          chat: { id: '-100rec', type: 'channel' }, from: { id: 'u1' }, date: Math.floor(Date.now() / 1000),
          old_chat_member: { status: 'left', user: { id: 'u1' } },
          new_chat_member: { status: 'member', user: { id: 'u1' } }
        }
      }),
      adapter: require('../src/adapters/telegram')
    });
    assert.equal(one(t.db, 'SELECT status FROM webhook_events WHERE id = ?', ing.rawId).status, 'received');
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM subscriptions').c, 0);

    require('../src/pipeline').processPending(t.db, 10);
    assert.equal(one(t.db, 'SELECT status FROM webhook_events WHERE id = ?', ing.rawId).status, 'normalized');
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM subscriptions').c, 1, 'подписка доехала');
  } finally {
    t.close();
  }
});

test('РЕГРЕССИЯ: сообщение формы переживает редирект и гаснет после показа', async () => {
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'flash@test.ru', password: 'secret123' }).toString()
    });

    // Успех: POST → 302 → GET должен показать подтверждение.
    const saved = await t.form('/app/settings', { name: 'Новое имя', timezone: 'Europe/Moscow', window: '72' });
    assert.equal(saved.status, 302, 'форма отвечает редиректом');
    const afterSave = await t.req('/app/settings');
    assert.match(afterSave.text, /<div class="ok">Сохранено<\/div>/, 'подтверждение видно на странице после редиректа');

    const again = await t.req('/app/settings');
    assert.doesNotMatch(again.text, /<div class="ok">/, 'сообщение одноразовое и не висит на следующих страницах');

    // Ошибка: ID канала без минуса — человек должен увидеть причину, а не пустую страницу.
    const bad = await t.form('/app/channels',
      { platform: 'telegram', external_chat_id: '1002946346442', title: 'Канал' }, '/app/channels');
    assert.equal(bad.status, 302);
    const afterBad = await t.req('/app/channels');
    assert.match(afterBad.text, /<div class="err">[^<]*-1002946346442/, 'в ошибке есть исправленный ID');
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM channels').c, 0, 'мусорный канал в базу не попал');
  } finally {
    t.close();
  }
});

test('пустой канал можно убрать, канал с историей — нет', async () => {
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'rm@test.ru', password: 'secret123' }).toString()
    });
    run(t.db, 'UPDATE workspaces SET plan = \'pro\''); // на free один канал, а нам нужны два
    await t.form('/app/channels', { platform: 'telegram', external_chat_id: '-100111', title: 'Пустой' }, '/app/channels');
    await t.form('/app/channels', { platform: 'telegram', external_chat_id: '-100222', title: 'С историей' }, '/app/channels');
    const empty = one(t.db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-100111');
    const used = one(t.db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-100222');

    await t.form('/app/links', { channel: used.id, redirect_mode: 'direct', source: 'vk_ads' });

    const page = await t.req('/app/channels');
    assert.match(page.text, /channels\/remove/, 'кнопка «Убрать» есть у пустого канала');

    await t.form('/app/channels/remove', { channel: empty.id }, '/app/channels');
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM channels WHERE id = ?', empty.id).c, 0, 'пустой канал удалён');

    await t.form('/app/channels/remove', { channel: used.id }, '/app/channels');
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM channels WHERE id = ?', used.id).c, 1, 'канал со ссылкой остался');
    const after = await t.req('/app/channels');
    assert.match(after.text, /не удаляется, чтобы не потерять историю/, 'причина отказа объяснена');
  } finally {
    t.close();
  }
});

test('режим «страница»: объявление ведёт на HTML, приглашение выдаётся по кнопке', async () => {
  const HUMAN = { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile' };
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'land@test.ru', password: 'secret123' }).toString()
    });
    await t.form('/app/channels', { platform: 'telegram', external_chat_id: '-100777001', title: 'Канал' }, '/app/channels');
    const ch = one(t.db, 'SELECT * FROM channels');
    await t.form('/app/links', { channel: ch.id, redirect_mode: 'invite', source: 'vk_ads' });
    const link = one(t.db, 'SELECT * FROM tracking_links');

    const direct = await t.req('/c/' + link.slug, { headers: HUMAN });
    assert.equal(direct.status, 302, 'по умолчанию ссылка ведёт в канал сразу');

    await t.form('/app/links/landing', { link: link.id, mode: 'page' }, '/app/links');
    assert.equal(one(t.db, 'SELECT * FROM tracking_links WHERE id = ?', link.id).landing_mode, 'page');

    const freeBefore = one(t.db, "SELECT COUNT(*) c FROM invite_links WHERE status = 'free'").c;
    assert.ok(freeBefore > 0, 'пул наполнен');

    const page = await t.req('/c/' + link.slug + '?rb_clickid=VK123', { headers: HUMAN });
    assert.equal(page.status, 200, 'площадка видит обычную страницу, а не редирект');
    assert.match(page.text, /Открыть канал в Telegram/);
    assert.match(page.text, /\/go\?k=/, 'на странице есть кнопка со вторым шагом');
    assert.equal(one(t.db, "SELECT COUNT(*) c FROM invite_links WHERE status = 'free'").c, freeBefore,
      'показ страницы не расходует пул: робот площадки приглашения не съест');

    const click = one(t.db, 'SELECT * FROM clicks ORDER BY ts_utc DESC');
    assert.match(click.query_json || '', /VK123/, 'идентификатор клика VK записан уже на показе страницы');

    const go = await t.req('/c/' + link.slug + '/go?k=' + click.id, { headers: HUMAN });
    assert.equal(go.status, 302);
    assert.match(go.headers.get('location') || '', /t\.me/);
    assert.equal(one(t.db, "SELECT COUNT(*) c FROM invite_links WHERE status = 'free'").c, freeBefore - 1,
      'приглашение выдано ровно на нажатие кнопки');
    assert.ok(one(t.db, 'SELECT * FROM clicks WHERE id = ?', click.id).invite_link_id,
      'приглашение привязано к тому же клику — атрибуция не теряется');
  } finally {
    t.close();
  }
});

test('пиксель VK стоит на странице перехода только при боевой интеграции', async () => {
  const HUMAN = { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile' };
  const t = await boot();
  try {
    await t.req('/register', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'pix@test.ru', password: 'secret123' }).toString()
    });
    await t.form('/app/channels', { platform: 'telegram', external_chat_id: '-100777002', title: 'Канал' }, '/app/channels');
    const ch = one(t.db, 'SELECT * FROM channels');
    await t.form('/app/links', { channel: ch.id, redirect_mode: 'invite', source: 'vk_ads' });
    const link = one(t.db, 'SELECT * FROM tracking_links');
    await t.form('/app/links/landing', { link: link.id, mode: 'page' }, '/app/links');

    const without = await t.req('/c/' + link.slug, { headers: HUMAN });
    assert.doesNotMatch(without.text, /top-fwz1/, 'без интеграции чужого счётчика на странице нет');

    run(t.db, "UPDATE workspaces SET plan = 'pro'"); // на free конверсии недоступны
    await t.form('/app/integrations', { provider: 'vk_ads', counter_id: '3794282', goal_id: 'tg_subscription' });
    const withPixel = await t.req('/c/' + link.slug, { headers: HUMAN });
    assert.match(withPixel.text, /top-fwz1\.mail\.ru\/js\/code\.js/, 'счётчик VK подключён');
    assert.match(withPixel.text, /id: "3794282"/, 'в счётчике наш идентификатор пикселя');
  } finally {
    t.close();
  }
});
