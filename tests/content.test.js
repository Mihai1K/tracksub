'use strict';

/**
 * Content OS: сборщики, залётность, импорт, сценарии и полный цикл
 * «источник → сбор → лента → сценарий → съёмка» через HTTP. Сеть подменена.
 */

const test = require('node:test');
const assert = require('node:assert');
const { open, one, all } = require('../src/db');
const { createApp } = require('../src/server');
const { cfg } = require('../src/config');
const C = require('../src/content/collectors');
const S = require('../src/content/scoring');
const I = require('../src/content/importer');
const W = require('../src/content/scripts');
const svc = require('../src/content/service');
const tracking = require('../src/tracking');

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

/** Страница t.me/s/<канал> в той же разметке, что отдаёт Telegram. */
function tgPage(handle, posts, opts) {
  const o = opts || {};
  const head = `<div class="tgme_channel_info_header_title"><span dir="auto">${o.title || 'Канал ' + handle}</span></div>
<div class="tgme_channel_info_counters"><div class="tgme_channel_info_counter"><span class="counter_value">${o.subs || '12.5K'}</span> <span class="counter_type">subscribers</span></div></div>`;
  const body = posts.map((p, i) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="${handle}/${100 + i}">
${p.fwd ? '<div class="tgme_widget_message_forwarded_from accent_color">Forwarded from</div>' : ''}
<div class="tgme_widget_message_text js-message_text" dir="auto">${p.text}</div>
<div class="tgme_widget_message_reactions"><span class="tgme_reaction"><tg-emoji emoji-id="1"></tg-emoji>${p.likes || 10}</span></div>
<span class="tgme_widget_message_views">${p.views}</span><span class="copyonly"> views</span>
<a class="tgme_widget_message_date" href="https://t.me/${handle}/${100 + i}"><time datetime="${new Date(p.ts).toISOString()}" class="time">10:00</time></a>
</div></div>`).join('');
  return '<html><body>' + head + body + '</body></html>';
}

function makeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [re, handler] of routes) {
      if (re.test(String(url))) {
        const r = await handler(String(url), init);
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return new Response(body, { status: r.status || 200, headers: { 'content-type': 'text/html' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// Обычный канал: 10 постов около 1 000 просмотров и один залёт на 5 000.
function regularPosts(now) {
  const posts = [];
  for (let i = 0; i < 10; i++) posts.push({ text: 'Обычный пост ' + i, views: String(900 + i * 20), ts: now - (i + 2) * DAY });
  posts.push({ text: 'Как мы нашли блогеров за день<br/>Подробности внутри', views: '5.2K', likes: 340, ts: now - 1.5 * DAY });
  posts.push({ text: 'Чужой репост', views: '50K', ts: now - 3 * DAY, fwd: true });
  return posts;
}

// ------------------------------------------------------------------ units

test('Telegram: разбор страницы канала - текст, просмотры, реакции, дата, подписчики, репосты', () => {
  const html = tgPage('mychan', regularPosts(NOW), { title: 'Мой <i class="emoji" style="x"><b>🔥</b></i> канал' });
  const r = C.parseTelegramPage(html, 'mychan');
  assert.equal(r.meta.subscribers, 12500);
  assert.equal(r.meta.title, 'Мой 🔥 канал');
  assert.equal(r.items.length, 12);
  const hot = r.items.find((i) => i.views === 5200);
  assert.equal(hot.url, 'https://t.me/mychan/110');
  assert.equal(hot.title, 'Как мы нашли блогеров за день');
  assert.equal(hot.body, 'Как мы нашли блогеров за день\nПодробности внутри');
  assert.equal(hot.likes, 340);
  assert.ok(r.items.find((i) => i.forwarded), 'репост распознан');
});

test('числа и источники: 6.61M, 12,5K, 1 234; разбор строк источников', () => {
  assert.equal(C.parseCount('6.61M'), 6610000);
  assert.equal(C.parseCount('12,5K'), 12500);
  assert.equal(C.parseCount('1 234'), 1234);
  assert.equal(C.parseCount('abc'), null);
  assert.deepEqual(C.parseSourceLine('https://t.me/s/AdIndex'), { platform: 'telegram', kind: 'channel', handle: 'adindex' });
  assert.deepEqual(C.parseSourceLine('vk.com/media1centr1'), { platform: 'vk', kind: 'channel', handle: 'media1centr1' });
  assert.deepEqual(C.parseSourceLine('yt: тренды'), { platform: 'youtube', kind: 'trending', handle: 'RU' });
  assert.deepEqual(C.parseSourceLine('YT: реклама у блогеров'), { platform: 'youtube', kind: 'search', handle: 'реклама у блогеров' });
  assert.equal(C.parseSourceLine('просто текст'), null);
});

test('VK: wall.get - метрики, ссылки, реклама и репосты отброшены, ошибка API наружу', () => {
  const r = C.parseVkWall({ response: {
    items: [
      { id: 1, owner_id: -5, date: NOW / 1000, text: 'Пост', views: { count: 900 }, likes: { count: 9 }, reposts: { count: 1 }, comments: { count: 2 } },
      { id: 2, owner_id: -5, date: NOW / 1000, text: 'Реклама', marked_as_ads: 1, views: { count: 1 } },
      { id: 3, owner_id: -5, date: NOW / 1000, text: '', copy_history: [{}], views: { count: 1 } }
    ],
    groups: [{ id: 5, name: 'Паблик', members_count: 40000 }]
  } }, 'pub');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].url, 'https://vk.com/wall-5_1');
  assert.equal(r.items[0].shares, 1);
  assert.equal(r.meta.subscribers, 40000);
  assert.throws(() => C.parseVkWall({ error: { error_code: 5, error_msg: 'User authorization failed' } }), /VK API: User authorization failed/);
});

test('залётность: ×медианы канала, мало данных не выдумываем, ранний пост помечен', () => {
  const base = { baseline: 1000, sampleSize: 10, now: NOW };
  const s = S.scoreItem({ views: 5000, likes: 250, published_at: NOW - 2 * DAY }, base);
  assert.equal(s.outlier, 5);
  assert.equal(s.er, 0.05);
  assert.ok(s.score > Math.log2(6), 'вовлечённость добавляет бонус');
  const tiny = S.scoreItem({ views: 1207, author_subscribers: 4, published_at: NOW - DAY }, { baseline: null, now: NOW });
  assert.equal(tiny.outlier, null, 'крошечный канал не даёт ×300');

  const few = S.scoreItem({ views: 5000, published_at: NOW - 2 * DAY }, { baseline: 1000, sampleSize: 3, now: NOW });
  assert.equal(few.outlier, null);
  assert.match(few.note, /мало данных/);

  const early = S.scoreItem({ views: 2000, published_at: NOW - 3600000 }, base);
  assert.match(early.note, /ранний/);

  const old = S.scoreItem({ views: 5000, published_at: NOW - 25 * DAY }, base);
  assert.ok(old.score < s.score / 2, 'старый пост ниже свежего');

  const loose = S.scoreItem({ views: 40000, author_subscribers: 8000, published_at: NOW - DAY }, { baseline: null, sampleSize: 0, now: NOW });
  assert.equal(loose.outlier, 5);
  assert.match(loose.note, /подписчикам/);
  assert.equal(S.scoreItem({ views: 10, provider_score: 7.5 }, { baseline: null, now: NOW }).outlier, 7.5);
  assert.equal(S.scoreItem({ views: 10 }, { baseline: null, now: NOW }).outlier, null);
});

test('импорт: JSON vidIQ, CSV с ; и русскими колонками, ссылки построчно', () => {
  const j = I.parseImport(JSON.stringify({ results: [
    { id: 'dQw4w9WgXcQ', title: 'Ролик', viewCount: '120000', subscriberCount: 8000, outlierScore: '15x', publishedAt: '2026-11-01T10:00:00Z' },
    { title: 'без ссылки' }
  ] }), 'vidiq');
  assert.equal(j.items.length, 1);
  assert.equal(j.skipped, 1);
  assert.equal(j.items[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(j.items[0].platform, 'youtube');
  assert.equal(j.items[0].providerScore, 15);
  assert.equal(j.items[0].authorSubscribers, 8000);

  const csv = I.parseImport('Ссылка;Название;Просмотры;Подписчики;Дата\n"https://www.instagram.com/reel/abc/?igsh=x";"Рилс; с точкой с запятой";1,2K;3000;05.11.2026', 'virale');
  assert.equal(csv.items[0].url, 'https://www.instagram.com/reel/abc/');
  assert.equal(csv.items[0].title, 'Рилс; с точкой с запятой');
  assert.equal(csv.items[0].views, 1200);
  assert.equal(csv.items[0].platform, 'instagram');
  assert.equal(csv.items[0].publishedAt, Date.UTC(2026, 10, 5));

  const urls = I.parseImport('https://www.tiktok.com/@a/video/1 крутой хук\nмусор\nhttps://vk.com/clip-1_2', 'manual');
  assert.equal(urls.items.length, 2);
  assert.equal(urls.items[0].title, 'крутой хук');
  assert.equal(urls.items[1].platform, 'vk');
  assert.throws(() => I.parseImport('[{"url":', 'manual'), /JSON/);
});

test('сценарий по шаблону: тема из тренда, пометки вместо выдуманных фактов, без длинного тире', () => {
  const item = { title: '🔥 Блогеры подняли цены — что делать', url: 'https://t.me/x/1', views: 5200, outlier: 5.2, author: 'Канал', body: '' };
  const s = W.buildTemplate(item, { audience: 'малого бизнеса', cta: 'Подпишись — будет ещё' }, 'short');
  assert.match(s.hooks, /^Блогеры подняли цены - что делать\. Что это значит для малого бизнеса/);
  assert.equal(W.topicOf({ title: 'WSJ: Mercedes-Benz начинает ставить в свои машины разговорные модели, которые работают прямо на железке' }), 'Mercedes-Benz начинает ставить в свои машины разговорные модели');
  assert.equal(s.hooks.split('\n').length, 3);
  assert.match(s.body, /\[вставь/);
  assert.match(s.body, /5 200 просмотров, ×5,2 к медиане канала/);
  for (const v of Object.values(s)) assert.ok(!/[—–]/.test(String(v)), 'нет длинного тире');
  const md = W.toMarkdown(Object.assign({ format: 'short', status: 'draft' }, s), item);
  assert.match(md, /^# /);
  assert.match(md, /## Хуки\n1\. /);
});

test('сценарий через Claude: схема ответа, модель, фолбэк на шаблон при ошибке', async () => {
  const item = { title: 'Тема', url: 'https://t.me/x/1', views: 100, body: 'Текст' };
  let sent = null;
  const ok = makeFetch([[/api\.anthropic\.com/, (u, init) => {
    sent = { headers: init.headers, body: JSON.parse(init.body) };
    return { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title: 'Заголовок — тест', hooks: ['a', 'b', 'c', 'd'], body: 'Текст', shot_list: 'Кадры', cta: 'Призыв' }) }] } };
  }]]);
  const s = await W.generate(item, {}, 'short', { apiKey: 'k', model: 'claude-opus-5-5', fetch: ok });
  assert.equal(s.generator, 'llm');
  assert.equal(s.title, 'Заголовок - тест');
  assert.equal(s.hooks.split('\n').length, 3);
  assert.equal(sent.body.model, 'claude-opus-5-5');
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.equal(sent.headers['anthropic-version'], '2026-10-21');

  const fail = makeFetch([[/api\.anthropic\.com/, () => ({ status: 529, body: { error: { message: 'overloaded' } } })]]);
  const t = await W.generate(item, {}, 'short', { apiKey: 'k', fetch: fail });
  assert.equal(t.generator, 'template');
  assert.match(t.warning, /overloaded/);
});

test('изоляция: чужой workspace не видит и не меняет посты, источники и сценарии', () => {
  const db = open(':memory:');
  const a = tracking.createWorkspace(db, { name: 'A' });
  const b = tracking.createWorkspace(db, { name: 'B' });
  svc.addSources(db, a.id, '@mychan', '');
  const [itemId] = svc.upsertItems(db, a.id, [{ url: 'https://t.me/mychan/1', title: 'x', views: 10 }], { provider: 'manual', platform: 'telegram' });
  const sid = svc.createScript(db, a.id, itemId, { title: 'S', body: 'b', generator: 'manual' }, 'short');
  const src = svc.listSources(db, a.id)[0];

  assert.equal(svc.feed(db, b.id, {}).length, 0);
  assert.equal(svc.getItem(db, b.id, itemId), undefined);
  assert.equal(svc.setItemStatus(db, b.id, itemId, 'archived'), 0);
  assert.equal(svc.getScript(db, b.id, sid), undefined);
  assert.equal(svc.updateScript(db, b.id, sid, { title: 'взлом' }), 0);
  assert.equal(svc.deleteScript(db, b.id, sid), 0);
  assert.equal(svc.deleteSource(db, b.id, src.id), 0);
  assert.equal(svc.getScript(db, a.id, sid).title, 'S');
  // тот же URL в другом проекте - отдельная запись
  svc.upsertItems(db, b.id, [{ url: 'https://t.me/mychan/1', title: 'y' }], { provider: 'manual', platform: 'telegram' });
  assert.equal(one(db, 'SELECT COUNT(*) c FROM content_items').c, 2);
});

test('повторный сбор обновляет цифры и не трогает статус, заметки и сценарии', async () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  svc.addSources(db, ws.id, '@mychan', '');
  const src = svc.listSources(db, ws.id)[0];
  let views = '5.2K';
  const fetchFn = makeFetch([[/t\.me\/s\/mychan/, () => {
    const p = regularPosts(NOW); p[10].views = views; return { body: tgPage('mychan', p) };
  }]]);
  const r1 = await svc.collectSource(db, src, { fetch: fetchFn, cfg, now: NOW });
  assert.equal(r1.ok, true);
  assert.equal(r1.count, 11, 'репост не попал');
  const hot = one(db, 'SELECT * FROM content_items WHERE url = ?', 'https://t.me/mychan/110');
  assert.ok(hot.outlier > 4.5 && hot.outlier < 6, 'outlier ' + hot.outlier);
  svc.setItemStatus(db, ws.id, hot.id, 'picked');
  svc.createScript(db, ws.id, hot.id, { title: 'S', generator: 'manual' }, 'short');

  views = '9K';
  await svc.collectSource(db, src, { fetch: fetchFn, cfg, now: NOW + 3600000 });
  const after = one(db, 'SELECT * FROM content_items WHERE url = ?', 'https://t.me/mychan/110');
  assert.equal(after.id, hot.id);
  assert.equal(after.views, 9000);
  assert.equal(after.status, 'picked');
  assert.equal(one(db, 'SELECT COUNT(*) c FROM content_scripts WHERE item_id = ?', hot.id).c, 1);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM content_items').c, 11);
});

test('ошибки источника видны и не роняют остальные; планировщик берёт только просроченные', async () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  svc.addSources(db, ws.id, '@goodchan\n@deadchan\nvk.com/somepub', '');
  const fetchFn = makeFetch([
    [/t\.me\/s\/goodchan/, () => ({ body: tgPage('goodchan', regularPosts(NOW)) })],
    [/t\.me\/s\/deadchan/, () => ({ body: '<html>If you have Telegram, you can contact</html>' })]
  ]);
  const c2 = Object.assign({}, cfg, { content: Object.assign({}, cfg.content, { vkToken: '', fetchHours: 12, batch: 10 }) });
  const res = await svc.runDue(db, { cfg: c2, fetch: fetchFn, now: NOW });
  assert.equal(res.length, 3);
  const byHandle = Object.fromEntries(svc.listSources(db, ws.id).map((s) => [s.handle, s]));
  assert.equal(byHandle.goodchan.last_error, null);
  assert.match(byHandle.deadchan.last_error, /не найден или закрыт/);
  assert.match(byHandle.somepub.last_error, /VK_SERVICE_TOKEN/);
  assert.equal(svc.dueSources(db, { intervalHours: 12, now: NOW + 3600000 }).length, 0, 'через час никто не просрочен');
  assert.equal(svc.dueSources(db, { intervalHours: 12, now: NOW + 13 * 3600000 }).length, 3);
});

test('YouTube: тренды с подписчиками каналов, оценка к подписчикам', async () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  svc.addSources(db, ws.id, 'yt: тренды RU', '');
  const src = svc.listSources(db, ws.id)[0];
  const fetchFn = makeFetch([
    [/youtube\/v3\/videos\?.*chart=mostPopular/, () => ({ body: { items: [{ id: 'v1' }, { id: 'v2' }] } })],
    [/youtube\/v3\/videos\?/, () => ({ body: { items: [
      { id: 'v1', snippet: { title: 'Залёт', channelId: 'c1', channelTitle: 'Малый канал', publishedAt: new Date(NOW - DAY).toISOString() }, statistics: { viewCount: '500000', likeCount: '20000', commentCount: '900' } },
      { id: 'v2', snippet: { title: 'Норма', channelId: 'c2', channelTitle: 'Большой канал', publishedAt: new Date(NOW - DAY).toISOString() }, statistics: { viewCount: '300000' } }
    ] } })],
    [/youtube\/v3\/channels\?/, () => ({ body: { items: [{ id: 'c1', statistics: { subscriberCount: '20000' } }, { id: 'c2', statistics: { subscriberCount: '3000000' } }] } })]
  ]);
  const c2 = Object.assign({}, cfg, { content: Object.assign({}, cfg.content, { youtubeKey: 'test' }) });
  const r = await svc.collectSource(db, src, { fetch: fetchFn, cfg: c2, now: NOW });
  assert.equal(r.ok, true, r.error);
  const feed = svc.feed(db, ws.id, { days: 14, now: NOW });
  assert.equal(feed[0].title, 'Залёт');
  assert.equal(feed[0].outlier, 25);
  assert.ok(fetchFn.calls.every((c) => c.url.includes('key=test')));
});

// -------------------------------------------------------------------- e2e

async function boot(fetchFn) {
  const db = open(':memory:');
  const app = createApp(db, { log: () => {}, fetch: fetchFn });
  await new Promise((res) => app.server.listen(0, res));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  let cookie = '';
  async function req(path, o) {
    const opts = o || {};
    const res = await fetch(base + path, { method: opts.method || 'GET', redirect: 'manual',
      headers: Object.assign({ accept: 'text/html', cookie }, opts.headers || {}), body: opts.body });
    for (const sc of res.headers.getSetCookie()) {
      const kv = sc.split(';')[0];
      const name = kv.split('=')[0];
      cookie = cookie.split('; ').filter(Boolean).filter((p) => !p.startsWith(name + '=')).concat(kv).join('; ');
    }
    return { status: res.status, headers: res.headers, text: await res.text() };
  }
  async function form(path, fields, from) {
    const page = await req(from || '/app/content/settings');
    const csrf = (page.text.match(/name="csrf" value="([^"]+)"/) || [])[1];
    assert.ok(csrf, 'csrf на ' + (from || '/app/content/settings'));
    return req(path, { method: 'POST', body: new URLSearchParams(Object.assign({ csrf }, fields)).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }
  return { db, req, form, close: () => app.server.close() };
}

test('полный цикл: проект → профиль → источники → сбор → лента → сценарий → правка → к съёмке → .md', async () => {
  const now = Date.now();
  const fetchFn = makeFetch([[/t\.me\/s\/mychan/, () => ({ body: tgPage('mychan', regularPosts(now), { title: 'Маркетинг ТГ' }) })]]);
  const t = await boot(fetchFn);
  try {
    const reg = await t.req('/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'mike@test.ru', password: 'secret123', workspace: 'Личный блог' }).toString() });
    assert.equal(reg.status, 302);

    const empty = await t.req('/app/content');
    assert.equal(empty.status, 200);
    assert.match(empty.text, /Лента пока пустая/);
    assert.match(empty.text, /href="\/app\/content" class="on">Контент/, 'пункт меню');

    await t.form('/app/content/settings', { author: 'Михаил', audience: 'предпринимателей', topics: 'реклама', tone: 'на ты', cta: 'Подпишись' });
    const added = await t.form('/app/content/sources', { lines: 'https://t.me/mychan\nкакая-то ерунда', niche: 'маркетинг' }, '/app/content/sources');
    assert.equal(added.status, 302);
    const srcPage = await t.req('/app/content/sources');
    assert.match(srcPage.text, /Не распознаны: какая-то ерунда/);
    assert.match(srcPage.text, /ещё не собирали/);

    await t.form('/app/content/sources/collect', { wait: '1' }, '/app/content/sources');
    const srcAfter = await t.req('/app/content/sources');
    assert.match(srcAfter.text, /Маркетинг ТГ/);
    assert.match(srcAfter.text, /\+11/);

    const feed = await t.req('/app/content?rel=all');
    assert.match(feed.text, /Как мы нашли блогеров за день/);
    assert.ok(feed.text.indexOf('Как мы нашли блогеров') < feed.text.indexOf('Обычный пост'), 'залёт выше обычных');
    // по умолчанию «не наше» скрыто: профиль про рекламу, «Обычный пост» без совпадений
    const relFeed = await t.req('/app/content');
    assert.match(relFeed.text, /Как мы нашли блогеров за день/);
    assert.doesNotMatch(relFeed.text, /Обычный пост 3/);
    assert.doesNotMatch(feed.text, /Чужой репост/);
    assert.match(feed.text, /×5,/);

    const hot = one(t.db, 'SELECT * FROM content_items WHERE title = ?', 'Как мы нашли блогеров за день');
    const gen = await t.form('/app/content/items/' + hot.id + '/script', { format: 'short' }, '/app/content');
    assert.equal(gen.status, 302);
    const scriptUrl = gen.headers.get('location');
    assert.match(scriptUrl, /^\/app\/content\/scripts\/cscr_/);
    const sc = await t.req(scriptUrl);
    assert.match(sc.text, /Каркас сценария готов/);
    assert.match(sc.text, /предпринимателей/);
    assert.match(sc.text, /Подпишись/);
    assert.equal(one(t.db, 'SELECT status FROM content_items WHERE id = ?', hot.id).status, 'picked');

    const id = scriptUrl.split('/').pop();
    await t.form(scriptUrl, { title: 'Мой ролик — про блогеров', hooks: 'Хук 1\nХук 2', body: 'Свой текст', shot_list: 'Кадры', cta: 'Подпишись', status: 'approved', shoot_date: '2026-11-12', published_url: '' }, scriptUrl);
    const saved = one(t.db, 'SELECT * FROM content_scripts WHERE id = ?', id);
    assert.equal(saved.title, 'Мой ролик - про блогеров', 'длинное тире заменено');
    assert.equal(saved.status, 'approved');
    assert.equal(saved.shoot_date, '2026-11-12');

    const list = await t.req('/app/content/scripts?status=approved');
    assert.match(list.text, /Мой ролик - про блогеров/);
    assert.match(list.text, /к съёмке/);

    const md = await t.req(scriptUrl + '.md');
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-disposition'), /attachment/);
    assert.match(md.text, /^# Мой ролик - про блогеров/);
    assert.match(md.text, /https:\/\/t\.me\/mychan\/110/);

    // промпт для чата и ручной сценарий
    const pr = await t.req('/app/content/items/' + hot.id + '/prompt');
    assert.match(pr.text, /Аудитория: предпринимателей/);
    await t.form('/app/content/items/' + hot.id + '/manual', { format: 'long', title: 'Из ChatGPT', body: 'Текст', hooks: '', shot_list: '', cta: '' }, '/app/content/items/' + hot.id + '/prompt');
    assert.equal(one(t.db, 'SELECT generator FROM content_scripts WHERE title = ?', 'Из ChatGPT').generator, 'manual');

    // импорт vidIQ попадает в ту же ленту
    const imp = await t.form('/app/content/import', { provider: 'vidiq', data: JSON.stringify([{ url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Outlier vidIQ', views: 90000, subscribers: 3000, published_at: new Date(now - DAY).toISOString() }]) }, '/app/content/import');
    assert.match(decodeURIComponent(imp.headers.get('set-cookie') || ''), /Импортировано: 1/);
    const feed2 = await t.req('/app/content?days=90');
    assert.ok(feed2.text.indexOf('Outlier vidIQ') < feed2.text.indexOf('Как мы нашли блогеров'), '×30 к подписчикам выше ×5');

    // избранное: кнопка, счётчик, фильтр без ограничения периода
    const imported = one(t.db, 'SELECT id FROM content_items WHERE title = ?', 'Outlier vidIQ');
    assert.match(feed2.text, /☆ В избранное/);
    await t.form('/app/content/items/' + imported.id + '/status', { status: 'picked' }, '/app/content');
    t.db.prepare('UPDATE content_items SET published_at = ? WHERE id = ?').run(now - 200 * DAY, imported.id);
    const fav = await t.req('/app/content?status=picked');
    assert.match(fav.text, /Outlier vidIQ/, 'старое избранное видно');
    assert.match(fav.text, /★ В избранном/);
    assert.match(fav.text, /★ \d+<\/span><span class="k">в избранном/);

    // архив убирает из ленты
    await t.form('/app/content/items/' + hot.id + '/status', { status: 'archived' }, '/app/content');
    const feed3 = await t.req('/app/content');
    assert.doesNotMatch(feed3.text, /Как мы нашли блогеров за день/);

    // второе пространство: своя пустая лента, данные первого не видны
    await t.form('/app/content/workspace', { name: 'Blogger Market' });
    const bmFeed = await t.req('/app/content');
    assert.match(bmFeed.text, /Контент · Blogger Market/);
    assert.match(bmFeed.text, /Лента пока пустая/);
    assert.doesNotMatch(bmFeed.text, /Outlier vidIQ/);
    assert.equal(all(t.db, 'SELECT * FROM workspaces').length, 2);

    // атрибуция TrackSub жива рядом
    const overview = await t.req('/app');
    assert.equal(overview.status, 200);
  } finally { t.close(); }
});

test('доступ: без входа - на логин; чужой сценарий - 404-эквивалент; POST без csrf - 403', async () => {
  const t = await boot(makeFetch([]));
  try {
    assert.equal((await t.req('/app/content')).status, 302);
    await t.req('/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@test.ru', password: 'secret123', workspace: 'A' }).toString() });
    const other = tracking.createWorkspace(t.db, { name: 'Чужой' });
    const sid = svc.createScript(t.db, other.id, null, { title: 'Секрет', generator: 'manual' }, 'short');
    const r = await t.req('/app/content/scripts/' + sid);
    assert.equal(r.status, 302);
    assert.equal((await t.req('/app/content/scripts/' + sid + '.md')).status, 404);
    const noCsrf = await t.req('/app/content/settings', { method: 'POST', body: 'author=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(noCsrf.status, 403);
    assert.equal(all(t.db, 'SELECT * FROM content_settings').length, 0);
  } finally { t.close(); }
});

test('Telegram через SOCKS5: рукопожатие, CONNECT по имени, chunked-ответ', async () => {
  const net = require('net');
  const http = require('http');
  const { socksGetText } = require('../src/content/socks');
  const web = http.createServer((req, res) => {
    res.setHeader('transfer-encoding', 'chunked');
    res.write('<div class="tgme_widget_message_wrap"><div data-post="x/1">');
    res.end('ok ' + req.url + '</div></div>');
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const webPort = web.address().port;
  let asked = null;
  const socks = net.createServer((c) => {
    let stage = 0;
    c.on('data', (d) => {
      if (stage === 0) { stage = 1; c.write(Buffer.from([5, 0])); return; }
      if (stage === 1) {
        stage = 2;
        const len = d[4];
        asked = d.slice(5, 5 + len).toString() + ':' + d.readUInt16BE(5 + len);
        const up = net.connect(webPort, '127.0.0.1', () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          c.pipe(up); up.pipe(c);
        });
      }
    });
  });
  await new Promise((r) => socks.listen(0, '127.0.0.1', r));
  try {
    const r = await socksGetText('http://t.me:' + webPort + '/s/chan', 'socks5://127.0.0.1:' + socks.address().port);
    assert.equal(asked, 't.me:' + webPort, 'имя хоста уходит в прокси, DNS резолвит шлюз');
    assert.equal(r.status, 200);
    assert.match(r.text, /ok \/s\/chan/);
  } finally { web.close(); socks.close(); }
});

// ------------------------------------------------------------ скорость роста

const V = require('../src/content/velocity');
const HOUR = 3600000;

test('скорость: средняя с публикации при одном замере, по замерам - при двух и больше', () => {
  const one = V.computeVelocity([{ observed_at: NOW, views: 6000 }], NOW - 3 * HOUR);
  assert.equal(one.velocity, 2000);
  assert.equal(one.kind, 'average');
  assert.match(one.note, /нужен второй замер/);
  assert.equal(one.delta, null);

  const two = V.computeVelocity([{ observed_at: NOW - 6 * HOUR, views: 7000 }, { observed_at: NOW, views: 12000 }], NOW - 10 * HOUR);
  assert.equal(two.kind, 'measured');
  assert.equal(two.velocity, 833.3, '12 000 против 7 000 за 6 часов = 833 в час');
  assert.equal(two.delta, 5000);
  assert.equal(two.deltaHours, 6);
});

test('скорость: тренд растёт/замедляется/стоп, окна короче 30 минут и падение счётчика отбрасываются', () => {
  const s = (pts) => pts.map(([h, v]) => ({ observed_at: NOW + h * HOUR, views: v }));
  assert.equal(V.computeVelocity(s([[0, 1000], [2, 2000], [4, 4000]])).trend, 'up');
  assert.equal(V.computeVelocity(s([[0, 1000], [2, 5000], [4, 6000]])).trend, 'down');
  assert.equal(V.computeVelocity(s([[0, 1000], [2, 2000], [4, 3000]])).trend, 'flat');
  assert.equal(V.computeVelocity(s([[0, 10000], [2, 12000], [4, 12001]])).trend, 'stop');

  const noisy = V.computeVelocity(s([[0, 1000], [0.1, 1500], [2, 3000]]));
  assert.equal(noisy.velocity, 1000, 'замер через 6 минут не считается окном');

  const reset = V.computeVelocity(s([[0, 5000], [2, 4000], [4, 6000]]));
  assert.equal(reset.velocity, 1000, 'после уменьшения счётчика считаем от нового значения');
  assert.match(reset.note, /счётчик уменьшился/);
  assert.ok(reset.velocity > 0);
});

test('замеры: повтор в течение 20 минут не пишет снимок, через 2 часа пишет; без просмотров - нет снимка', () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  const [a, b] = svc.upsertItems(db, ws.id, [{ url: 'https://t.me/x/1', views: 100 }, { url: 'https://t.me/x/2', views: null }], { provider: 'manual', platform: 'telegram', now: NOW });
  assert.equal(V.recordSnapshots(db, [a, b], NOW), 1);
  assert.equal(V.recordSnapshots(db, [a], NOW + 10 * 60000), 0);
  assert.equal(V.recordSnapshots(db, [a], NOW + 2 * HOUR), 1);
  assert.equal(V.series(db, a).length, 2);
});

test('норма канала: ×к норме считается по свежим постам того же источника, при малом числе - нет', async () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  svc.addSources(db, ws.id, '@velchan', '');
  const src = svc.listSources(db, ws.id)[0];
  const posts = (k) => {
    const p = [];
    for (let i = 0; i < 6; i++) p.push({ text: 'Обычный ' + i, views: String(1000 + i * 10 + k * (100 + i)), ts: NOW - (3 + i) * HOUR });
    p.push({ text: 'Ракета', views: String(2000 + k * 5000), ts: NOW - 2 * HOUR });
    return p;
  };
  let k = 0;
  const fetchFn = makeFetch([[/t\.me\/s\/velchan/, () => ({ body: tgPage('velchan', posts(k)) })]]);
  await svc.collectSource(db, src, { fetch: fetchFn, cfg, now: NOW });
  k = 1;
  await svc.collectSource(db, src, { fetch: fetchFn, cfg, now: NOW + HOUR });
  const rocket = one(db, 'SELECT * FROM content_items WHERE title = ?', 'Ракета');
  assert.equal(rocket.velocity_kind, 'measured');
  assert.equal(rocket.velocity, 5000);
  assert.ok(rocket.velocity_ratio > 20, 'ракета в десятки раз быстрее нормы канала: ' + rocket.velocity_ratio);
  const usual = one(db, 'SELECT * FROM content_items WHERE title = ?', 'Обычный 0');
  assert.ok(usual.velocity_ratio > 0.5 && usual.velocity_ratio < 1.5, 'обычный пост около нормы: ' + usual.velocity_ratio);

  const db2 = open(':memory:');
  const ws2 = tracking.createWorkspace(db2, { name: 'B' });
  svc.upsertItems(db2, ws2.id, [{ url: 'https://t.me/y/1', views: 10, publishedAt: NOW - HOUR }], { provider: 'manual', platform: 'telegram', now: NOW });
  const it = one(db2, 'SELECT id, published_at, created_at FROM content_items');
  V.recordSnapshots(db2, [it.id], NOW);
  V.recomputeItems(db2, [it], NOW, true);
  assert.equal(one(db2, 'SELECT velocity_ratio FROM content_items').velocity_ratio, null, 'одному посту не с кем сравниться');
});

test('частота: Telegram и VK раз в 2 часа, поиск YouTube раз в 12', () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  svc.addSources(db, ws.id, '@fastchan\nvk.com/pub\nyt: тест', '');
  db.prepare('UPDATE content_sources SET last_fetch_at = ?').run(NOW);
  const due = (h) => svc.dueSources(db, { intervalHours: 12, fastHours: 2, now: NOW + h * HOUR }).map((s) => s.platform).sort();
  assert.deepEqual(due(1), []);
  assert.deepEqual(due(3), ['telegram', 'vk']);
  assert.deepEqual(due(13), ['telegram', 'vk', 'youtube']);
});

test('перезамер YouTube: свежие ролики по ID одним запросом, снимок и скорость', async () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  svc.addSources(db, ws.id, 'yt: тест', '');
  const src = svc.listSources(db, ws.id)[0];
  svc.upsertItems(db, ws.id, [
    { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', views: 1000, publishedAt: NOW - 5 * HOUR },
    { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', views: 50, publishedAt: NOW - 10 * 86400000 }
  ], { sourceId: src.id, provider: 'youtube', platform: 'youtube', now: NOW });
  V.recordSnapshots(db, all(db, 'SELECT id FROM content_items').map((r) => r.id), NOW);
  const fetchFn = makeFetch([[/youtube\/v3\/videos\?/, (u) => {
    assert.match(u, /id=aaaaaaaaaaa(&|$)/, 'старый ролик не перезамеряется');
    return { body: { items: [{ id: 'aaaaaaaaaaa', statistics: { viewCount: '9000' } }] } };
  }]]);
  const c2 = Object.assign({}, cfg, { content: Object.assign({}, cfg.content, { youtubeKey: 'k' }) });
  const n = await svc.remeasureYoutube(db, { cfg: c2, fetch: fetchFn, now: NOW + 4 * HOUR });
  assert.equal(n, 1);
  const v = one(db, 'SELECT * FROM content_items WHERE url LIKE ?', '%aaaaaaaaaaa');
  assert.equal(v.views, 9000);
  assert.equal(v.velocity, 2000);
  assert.equal(fetchFn.calls.length, 1);
});

test('лента: скорость в карточке, мини-график и сортировка по скорости', async () => {
  const now = Date.now();
  let k = 0;
  const posts = () => {
    const p = [];
    for (let i = 0; i < 6; i++) p.push({ text: 'Спокойный пост ' + i, views: String(1000 + k * 50), ts: now - (5 + i) * HOUR });
    p.push({ text: 'Быстрый пост', views: String(1000 + k * 4000), ts: now - 4 * HOUR });
    return p;
  };
  const fetchFn = makeFetch([[/t\.me\/s\/speedy/, () => ({ body: tgPage('speedy', posts()) })]]);
  const t = await boot(fetchFn);
  try {
    await t.req('/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'v@test.ru', password: 'secret123', workspace: 'V' }).toString() });
    await t.form('/app/content/sources', { lines: '@speedy', niche: '' }, '/app/content/sources');
    await t.form('/app/content/sources/collect', { wait: '1' }, '/app/content/sources');
    // второй замер «через час»: сдвигаем первый снимок в прошлое
    t.db.prepare('UPDATE content_snapshots SET observed_at = observed_at - ?').run(HOUR);
    k = 1;
    await t.form('/app/content/sources/collect', { wait: '1' }, '/app/content/sources');
    const feed = await t.req('/app/content?sort=velocity');
    assert.match(feed.text, /⚡ 4 000\/ч/);
    assert.match(feed.text, /к норме канала/);
    assert.match(feed.text, /aria-label="Рост просмотров по 2 замерам"/);
    assert.ok(feed.text.indexOf('Быстрый пост') < feed.text.indexOf('Спокойный пост'), 'быстрый выше при сортировке по скорости');
    assert.match(feed.text, /value="velocity" selected/);
  } finally { t.close(); }
});

test('посты, собранные до истории замеров, дают скорость уже на первом новом сборе', async () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  svc.addSources(db, ws.id, '@oldchan', '');
  const src = svc.listSources(db, ws.id)[0];
  svc.upsertItems(db, ws.id, [{ url: 'https://t.me/oldchan/100', views: 1000, publishedAt: NOW - 5 * HOUR }], { sourceId: src.id, provider: 'telegram', platform: 'telegram', now: NOW - 2 * HOUR });
  assert.equal(one(db, 'SELECT COUNT(*) c FROM content_snapshots').c, 0, 'старая база без снимков');
  const fetchFn = makeFetch([[/t\.me\/s\/oldchan/, () => ({ body: tgPage('oldchan', [{ text: 'Пост', views: '3000', ts: NOW - 5 * HOUR }]) })]]);
  await svc.collectSource(db, src, { fetch: fetchFn, cfg, now: NOW });
  const it = one(db, 'SELECT * FROM content_items WHERE url = ?', 'https://t.me/oldchan/100');
  assert.equal(it.velocity_kind, 'measured');
  assert.equal(it.velocity, 1000, '2 000 просмотров за 2 часа');
});

test('плашка «иностранный агент» вырезается из текста поста', () => {
  const t = C.stripBoilerplate('НАСТОЯЩИЙ МАТЕРИАЛ (ИНФОРМАЦИЯ) ПРОИЗВЕДЕН, РАСПРОСТРАНЕН И (ИЛИ) НАПРАВЛЕН ИНОСТРАННЫМ АГЕНТОМ THE BELL ЛИБО КАСАЕТСЯ ДЕЯТЕЛЬНОСТИ ИНОСТРАННОГО АГЕНТА THE BELL. 18+\nЧто известно из утечки Росстата');
  assert.equal(t, 'Что известно из утечки Росстата');
  assert.equal(C.stripBoilerplate('Обычный текст про материал'), 'Обычный текст про материал');
});

// ------------------------------------------------------------------- темы

const TP = require('../src/content/topics');

function topicDb() {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  svc.addSources(db, ws.id, '@chan_a\n@chan_b\n@chan_c\n@chan_d', '');
  const src = Object.fromEntries(svc.listSources(db, ws.id).map((s) => [s.handle, s.id]));
  let n = 0;
  const add = (handle, title, views, hoursAgo) => {
    n++;
    svc.upsertItems(db, ws.id, [{ url: 'https://t.me/' + handle + '/' + n, title, body: title, views, publishedAt: NOW - hoursAgo * HOUR }],
      { sourceId: src[handle], provider: 'telegram', platform: 'telegram', now: NOW });
  };
  return { db, ws, add };
}

test('темы: одно событие в трёх каналах - одна тема; похожий, но другой инфоповод - отдельно', () => {
  const { db, ws, add } = topicDb();
  add('chan_a', 'OpenAI представила GPT-6: модель стала в два раза быстрее и дешевле для разработчиков', 50000, 10);
  add('chan_b', 'Вышла GPT-6 от OpenAI. Разработчики получили доступ, цена токенов снижена вдвое', 30000, 8);
  add('chan_c', 'OpenAI выпустила GPT-6 - что изменилось для разработчиков и бизнеса', 20000, 6);
  add('chan_d', 'ChatGPT подорожал: OpenAI подняла цену подписки Plus в России до 2500 рублей', 40000, 5);
  add('chan_a', 'Сбербанк запустил ипотеку под 2% для IT-специалистов в регионах', 10000, 4);
  TP.clusterWorkspace(db, ws.id, NOW);
  const list = TP.listTopics(db, ws.id, { days: 3, now: NOW });
  assert.equal(list.length, 1, JSON.stringify(list.map((t) => t.title)));
  assert.equal(list[0].sources_count, 3);
  assert.equal(list[0].items_count, 3);
  assert.equal(list[0].views_sum, 100000);
  assert.match(list[0].title, /GPT-6/);
  const items = TP.topicItems(db, ws.id, list[0].id).map((i) => i.title);
  assert.ok(!items.some((t) => /подорожал/.test(t)), 'подорожание ChatGPT - другой инфоповод');
});

test('темы: посты одного канала не склеиваются между собой, тема нужна от двух источников', () => {
  const { db, ws, add } = topicDb();
  add('chan_a', 'Утренняя рассылка The Bell: главное о рынках и Центробанке', 1000, 10);
  add('chan_a', 'Вечерняя рассылка The Bell: главное о рынках и Центробанке', 1000, 2);
  TP.clusterWorkspace(db, ws.id, NOW);
  assert.equal(one(db, 'SELECT COUNT(*) c FROM content_topics').c, 0);
});

test('темы: номер темы стабилен, новый пост присоединяется, «не про это» исключает навсегда, чужое пространство не видит', () => {
  const { db, ws, add } = topicDb();
  add('chan_a', 'Яндекс запустил Алису Pro с нейросетью YandexGPT 5 для бизнеса', 20000, 20);
  add('chan_b', 'Алиса Pro от Яндекса: YandexGPT 5 теперь доступна компаниям', 15000, 18);
  TP.clusterWorkspace(db, ws.id, NOW);
  const t1 = TP.listTopics(db, ws.id, { days: 3, now: NOW })[0];
  add('chan_c', 'Яндекс открыл YandexGPT 5 в Алисе Pro для бизнеса - первые отзывы', 9000, 3);
  TP.clusterWorkspace(db, ws.id, NOW);
  const t2 = TP.listTopics(db, ws.id, { days: 3, now: NOW })[0];
  assert.equal(t2.id, t1.id, 'та же тема');
  assert.equal(t2.sources_count, 3);
  const third = TP.topicItems(db, ws.id, t2.id).find((i) => /отзывы/.test(i.title));
  assert.equal(TP.splitItem(db, ws.id, t2.id, third.id, NOW), 1);
  TP.clusterWorkspace(db, ws.id, NOW);
  assert.equal(TP.getTopic(db, ws.id, t2.id).sources_count, 2, 'после «не про это» пост не вернулся');
  const other = tracking.createWorkspace(db, { name: 'B' });
  assert.equal(TP.topicItems(db, other.id, t2.id).length, 0);
  assert.equal(TP.splitItem(db, other.id, t2.id, third.id, NOW), 0);
});

test('темы: температура выше у темы с большим числом источников и свежее', () => {
  const { db, ws, add } = topicDb();
  add('chan_a', 'Wildberries ввёл платную приёмку товаров на складах Коледино', 10000, 60);
  add('chan_b', 'Платная приёмка на складах Wildberries в Коледино с понедельника', 10000, 58);
  add('chan_a', 'Ozon снизил комиссию для продавцов электроники до 5%', 10000, 5);
  add('chan_c', 'Ozon: комиссия для продавцов электроники снижена до 5%', 10000, 4);
  add('chan_d', 'Продавцы электроники на Ozon будут платить 5% комиссии', 10000, 3);
  TP.clusterWorkspace(db, ws.id, NOW);
  const list = TP.listTopics(db, ws.id, { days: 3, now: NOW });
  assert.equal(list.length, 2);
  assert.match(list[0].title, /Ozon/);
  assert.ok(list[0].heat > list[1].heat * 2);
});

test('темы: вкладка, «не про это», сценарий по теме с другими источниками, метка темы в ленте', async () => {
  const now = Date.now();
  const pages = {
    tch_one: [{ text: 'OpenAI представила GPT-6: модель стала в два раза быстрее и дешевле для разработчиков', views: '50K', ts: now - 10 * HOUR }],
    tch_two: [{ text: 'Вышла GPT-6 от OpenAI. Разработчики получили доступ, цена токенов снижена вдвое', views: '30K', ts: now - 8 * HOUR }]
  };
  const fetchFn = makeFetch([[/t\.me\/s\/(tch_\w+)/, (u) => ({ body: tgPage(u.match(/tch_\w+/)[0], pages[u.match(/tch_\w+/)[0]]) })]]);
  const t = await boot(fetchFn);
  try {
    await t.req('/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'tp@test.ru', password: 'secret123', workspace: 'T' }).toString() });
    await t.form('/app/content/sources', { lines: '@tch_one\n@tch_two', niche: '' }, '/app/content/sources');
    await t.form('/app/content/sources/collect', { wait: '1' }, '/app/content/sources');
    const page = await t.req('/app/content/topics');
    assert.equal(page.status, 200);
    assert.match(page.text, /2 источника/);
    assert.match(page.text, /GPT-6/);
    const feed = await t.req('/app/content');
    assert.match(feed.text, /тема · 2 источника/);
    const tp = one(t.db, 'SELECT * FROM content_topics');
    const sc = await t.form('/app/content/topics/' + tp.id + '/script', { format: 'short' }, '/app/content/topics');
    const script = one(t.db, 'SELECT * FROM content_scripts');
    assert.match(sc.headers.get('location'), /\/app\/content\/scripts\//);
    assert.match(script.body, /Другие источники темы:/);
    await t.form('/app/content/topics/' + tp.id + '/favorite', { on: '1' }, '/app/content/topics');
    assert.equal(one(t.db, 'SELECT status FROM content_items WHERE id = ?', tp.primary_item_id).status, 'picked');
    const second = one(t.db, 'SELECT item_id FROM content_topic_items WHERE item_id != ?', tp.primary_item_id);
    await t.form('/app/content/topics/' + tp.id + '/split', { item: second.item_id }, '/app/content/topics');
    const after = await t.req('/app/content/topics');
    assert.match(after.text, /Пока нет общих тем/, 'с одним источником тема не показывается');
  } finally { t.close(); }
});

// ------------------------------------------------------------ релевантность

const RL = require('../src/content/relevance');
const PERSONAL = { topics: 'ИИ в бизнесе, запуск проектов', audience: 'предпринимателей', stop_topics: null };
const BMP = { topics: 'реклама у блогеров, охваты', audience: 'владельцев бизнеса, которые покупают рекламу', stop_topics: null };

test('релевантность: словарь ниши, стоп-темы целым словом, общие слова профиля не считаются', () => {
  const p = RL.profileTerms(PERSONAL);
  const ai = RL.scoreText('Anthropic выпустила Claude 6: нейросеть для бизнеса стала дешевле', p);
  assert.equal(ai.label, 'on', JSON.stringify(ai));
  assert.ok(ai.matched.includes('claude'));
  assert.equal(RL.scoreText('ИИ меняет работу юристов', p).label !== 'off', true, 'аббревиатура ИИ распознана');
  const war = RL.scoreText('Удар по НПЗ: что известно о ходе СВО', p);
  assert.equal(war.label, 'off');
  assert.match(war.stopped, /сво/);
  assert.equal(RL.scoreText('Стремление к самосовершенствованию свойственно человеку', p).stopped, null, '«сво» не ловит «свойственно»');
  const bm = RL.profileTerms(BMP);
  assert.ok(!bm.terms.has('которы') && !bm.terms.has('владел') && !bm.terms.has('покупа'), 'общие слова профиля не ищем');
  assert.equal(RL.scoreText('Блогеры подняли цены на рекламные интеграции, охваты падают', bm).label, 'on');
  assert.equal(RL.scoreText('Росстат опубликовал данные об урожае пшеницы', bm).label, 'off');
});

test('релевантность: у каждого пространства своя оценка, пустой профиль никого не прячет', () => {
  const db = open(':memory:');
  const a = tracking.createWorkspace(db, { name: 'Личный' });
  const b = tracking.createWorkspace(db, { name: 'BM' });
  const post = { url: 'https://t.me/x/1', title: 'OpenAI выпустила агента для автоматизации бизнеса', views: 100, publishedAt: NOW - HOUR };
  svc.upsertItems(db, a.id, [post], { provider: 'telegram', platform: 'telegram', now: NOW });
  svc.upsertItems(db, b.id, [post], { provider: 'telegram', platform: 'telegram', now: NOW });
  RL.recompute(db, a.id, PERSONAL, { now: NOW });
  RL.recompute(db, b.id, BMP, { now: NOW });
  const ra = one(db, 'SELECT relevance_label l FROM content_items WHERE workspace_id = ?', a.id).l;
  const rb = one(db, 'SELECT relevance_label l FROM content_items WHERE workspace_id = ?', b.id).l;
  assert.equal(ra, 'on');
  assert.notEqual(rb, 'on', 'для рекламы у блогеров это не главное');
  RL.recompute(db, a.id, { topics: '', audience: '', stop_topics: '' }, { now: NOW });
  assert.equal(one(db, 'SELECT relevance FROM content_items WHERE workspace_id = ?', a.id).relevance, null);
});

test('релевантность: 👍/👎 перекрывают расчёт, учат слова с ограничением веса и пишут журнал', () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  const [x, y] = svc.upsertItems(db, ws.id, [
    { url: 'https://t.me/x/1', title: 'Wildberries меняет правила для продавцов', views: 1, publishedAt: NOW - HOUR },
    { url: 'https://t.me/x/2', title: 'Wildberries открыл новый склад в Казани', views: 1, publishedAt: NOW - HOUR }
  ], { provider: 'telegram', platform: 'telegram', now: NOW });
  RL.recompute(db, ws.id, PERSONAL, { now: NOW });
  const before = one(db, 'SELECT relevance FROM content_items WHERE id = ?', y).relevance;
  for (let i = 0; i < 10; i++) RL.rate(db, ws.id, x, true, NOW);
  RL.recompute(db, ws.id, PERSONAL, { now: NOW });
  const after = one(db, 'SELECT relevance, relevance_why w FROM content_items WHERE id = ?', y);
  assert.ok(after.relevance > before, 'похожий пост поднялся');
  assert.equal(one(db, 'SELECT weight FROM content_interest_terms WHERE term = ?', 'wildbe').weight, 2, 'вес ограничен');
  assert.equal(one(db, 'SELECT relevance, relevance_by b FROM content_items WHERE id = ?', x).b, 'user');
  RL.rate(db, ws.id, y, false, NOW);
  RL.recompute(db, ws.id, PERSONAL, { now: NOW });
  assert.equal(one(db, 'SELECT relevance_label l FROM content_items WHERE id = ?', y).l, 'off', 'ручное «не наше» не перезаписывается расчётом');
  assert.equal(one(db, 'SELECT COUNT(*) c FROM content_events WHERE kind = \'rate_up\'').c, 10);
  const other = tracking.createWorkspace(db, { name: 'B' });
  assert.equal(RL.rate(db, other.id, x, true, NOW), false, 'чужой пост не оценить');
});

test('релевантность в интерфейсе: метка, 👎 прячет пост, фильтр «Все посты», профиль показывает слова', async () => {
  const now = Date.now();
  const fetchFn = makeFetch([[/t\.me\/s\/relchan/, () => ({ body: tgPage('relchan', [
    { text: 'Нейросеть Claude помогла запустить бизнес за неделю', views: '5K', ts: now - 5 * HOUR },
    { text: 'Как вырастить томаты на балконе', views: '1K', ts: now - 6 * HOUR },
    { text: 'ChatGPT и нейросети для бизнеса: пять приёмов', views: '2K', ts: now - 7 * HOUR }
  ]) })]]);
  const t = await boot(fetchFn);
  try {
    await t.req('/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'rl@test.ru', password: 'secret123', workspace: 'R' }).toString() });
    await t.form('/app/content/settings', { author: 'Я', audience: 'предпринимателей', topics: 'ИИ в бизнесе', tone: '', cta: '', stop_topics: 'политика' });
    await t.form('/app/content/sources', { lines: '@relchan', niche: '' }, '/app/content/sources');
    await t.form('/app/content/sources/collect', { wait: '1' }, '/app/content/sources');
    const feed = await t.req('/app/content');
    assert.match(feed.text, /наше \d+%/);
    assert.doesNotMatch(feed.text, /томаты/, '«не наше» скрыто по умолчанию');
    assert.match((await t.req('/app/content?rel=all')).text, /томаты/);
    const chat = one(t.db, 'SELECT id FROM content_items WHERE title LIKE ?', 'ChatGPT%');
    await t.form('/app/content/items/' + chat.id + '/rate', { v: 'down' }, '/app/content');
    assert.doesNotMatch((await t.req('/app/content')).text, /пять приёмов/);
    const prof = await t.req('/app/content/settings');
    assert.match(prof.text, /Как система понимает ваши темы/);
    assert.match(prof.text, /<code>нейрос<\/code>/);
    assert.match(prof.text, /<code>полити<\/code>/);
  } finally { t.close(); }
});

// ------------------------------------------------------------- публикации

const PB = require('../src/content/publications');

test('публикации: распознаём ссылки для автозамера', () => {
  assert.equal(PB.ytId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(PB.ytId('https://youtu.be/abcdefghijk?si=x'), 'abcdefghijk');
  assert.equal(PB.ytId('https://youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.deepEqual(PB.tgPost('https://t.me/knyazevmik/123'), { channel: 'knyazevmik', post: '123' });
  assert.equal(PB.vkWall('https://vk.com/wall-123_456'), '-123_456');
  assert.equal(PB.vkWall('https://vk.com/knyazevmik?w=wall123_7'), '123_7');
  assert.equal(PB.autoMode('https://www.instagram.com/reel/abc/'), null);
  assert.equal(PB.autoMode('https://vk.com/clip-1_2'), null, 'клипы VK - вручную');
});

test('публикации: веха берёт ближайший замер в окне, иначе пусто', () => {
  const pub = NOW;
  const s = [{ observed_at: pub + 6 * HOUR, views: 100 }, { observed_at: pub + 22 * HOUR, views: 900 }, { observed_at: pub + 30 * HOUR, views: 1200 }];
  assert.equal(PB.atMilestone(s, pub, 24), 900);
  assert.equal(PB.atMilestone(s, pub, 72), null, 'замера около 72 ч нет - не угадываем');
});

test('публикации: автозамер Telegram, YouTube и VK, расписание 6 ч → сутки → стоп', async () => {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'A' });
  const sid = svc.createScript(db, ws.id, null, { title: 'Ролик', hooks: 'Хук один\nХук два', generator: 'manual' }, 'short');
  const tg = PB.addPublication(db, ws.id, sid, { url: 'https://t.me/mychan/55', publishedAt: NOW, hookIndex: 2, hookText: 'Хук два' }, NOW);
  const yt = PB.addPublication(db, ws.id, sid, { url: 'https://youtu.be/abcdefghijk', publishedAt: NOW }, NOW);
  const vk = PB.addPublication(db, ws.id, sid, { url: 'https://vk.com/wall-1_2', publishedAt: NOW }, NOW);
  const ig = PB.addPublication(db, ws.id, sid, { url: 'https://www.instagram.com/reel/xyz/', publishedAt: NOW }, NOW);
  assert.equal(one(db, 'SELECT platform FROM content_publications WHERE id = ?', ig).platform, 'instagram');
  assert.equal(one(db, 'SELECT status FROM content_scripts WHERE id = ?', sid).status, 'published');
  let tgViews = 1000;
  const fetchFn = makeFetch([
    [/t\.me\/mychan\/55\?embed=1/, () => ({ body: `<span class="tgme_reaction"><tg-emoji></tg-emoji>12</span><span class="tgme_widget_message_views">${tgViews}</span>` })],
    [/youtube\/v3\/videos/, () => ({ body: { items: [{ id: 'abcdefghijk', statistics: { viewCount: '5000', likeCount: '50' } }] } })],
    [/api\.vk\.com\/method\/wall\.getById/, () => ({ body: { response: { items: [{ views: { count: 700 }, likes: { count: 7 }, reposts: { count: 1 } }] } } })]
  ]);
  const c2 = Object.assign({}, cfg, { content: Object.assign({}, cfg.content, { youtubeKey: 'k', vkToken: 'v', tgProxy: '' }) });
  assert.equal(await PB.remeasure(db, { cfg: c2, fetch: fetchFn, now: NOW + HOUR }), 3, 'Instagram не мерим');
  assert.equal(await PB.remeasure(db, { cfg: c2, fetch: fetchFn, now: NOW + 3 * HOUR }), 0, 'рано');
  tgViews = 4000;
  assert.equal(await PB.remeasure(db, { cfg: c2, fetch: fetchFn, now: NOW + 7 * HOUR }), 3);
  assert.equal(await PB.remeasure(db, { cfg: c2, fetch: fetchFn, now: NOW + 80 * HOUR }), 3);
  assert.equal(await PB.remeasure(db, { cfg: c2, fetch: fetchFn, now: NOW + 90 * HOUR }), 0, 'после 72 ч - раз в сутки');
  assert.equal(await PB.remeasure(db, { cfg: c2, fetch: fetchFn, now: NOW + 9 * 24 * HOUR }), 0, 'после 8 дней не мерим');
  const r = PB.results(db, ws.id).find((x) => x.id === tg);
  assert.equal(r.views, 4000);
  assert.equal(r.likes, 12);
  assert.equal(r.hook_index, 2);
  assert.equal(PB.results(db, ws.id).find((x) => x.id === yt).views, 5000);
  assert.equal(PB.results(db, ws.id).find((x) => x.id === vk).views, 700);
  const other = tracking.createWorkspace(db, { name: 'B' });
  assert.equal(PB.addMetrics(db, other.id, tg, { views: 1 }), false, 'чужую публикацию не трогаем');
  assert.equal(PB.deletePublication(db, other.id, tg), 0);
  assert.throws(() => PB.addPublication(db, other.id, sid, { url: 'https://t.me/x/1' }), /не найден/);
});

test('публикации: разбивка по группам и пометка «мало данных»', () => {
  const rows = [
    { hook_index: 1, v72: 1000, views: 1200, leads: 1 }, { hook_index: 1, v72: 3000, views: 3100, leads: 0 }, { hook_index: 1, v72: 2000, views: 2000, leads: 2 },
    { hook_index: 2, v72: null, views: 9000, leads: 0 }
  ];
  const g = PB.breakdown(rows, (r) => 'хук ' + r.hook_index);
  assert.equal(g[0].key, 'хук 2');
  assert.equal(g[0].median72, 9000, 'без вехи - текущие просмотры');
  assert.equal(g[0].few, true);
  const h1 = g.find((x) => x.key === 'хук 1');
  assert.equal(h1.median72, 2000);
  assert.equal(h1.leads, 3);
  assert.equal(h1.few, false);
});

test('публикации в интерфейсе: добавить к сценарию, внести цифры, увидеть в «Результатах»', async () => {
  const fetchFn = makeFetch([[/t\.me\/mine\/9\?embed=1/, () => ({ body: '<span class="tgme_widget_message_views">2.5K</span>' })]]);
  const t = await boot(fetchFn);
  try {
    await t.req('/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'pb@test.ru', password: 'secret123', workspace: 'P' }).toString() });
    const wsId = one(t.db, 'SELECT id FROM workspaces').id;
    const sid = svc.createScript(t.db, wsId, null, { title: 'Мой ролик про ИИ', hooks: 'Первый\nВторой\nТретий', generator: 'manual' }, 'short');
    const page0 = await t.req('/app/content/scripts/' + sid);
    assert.match(page0.text, /Добавить публикацию/);
    assert.match(page0.text, /3\. Третий/);
    const today = new Date().toISOString().slice(0, 10);
    const add = await t.form('/app/content/scripts/' + sid + '/publications', { url: 'https://t.me/mine/9', published: today, hook: '3', hook_text: '' }, '/app/content/scripts/' + sid);
    assert.match(decodeURIComponent(add.headers.get('set-cookie') || ''), /Первый замер сделан/);
    const ig = await t.form('/app/content/scripts/' + sid + '/publications', { url: 'https://www.instagram.com/reel/abc/', published: today, hook: '0', hook_text: 'Свой заход' }, '/app/content/scripts/' + sid);
    assert.equal(ig.status, 302);
    const igPub = one(t.db, 'SELECT id FROM content_publications WHERE platform = ?', 'instagram');
    await t.form('/app/content/publications/' + igPub.id + '/metrics', { views: '15000', likes: '900', clicks: '40', leads: '3' }, '/app/content/scripts/' + sid);
    const res = await t.req('/app/content/results');
    assert.equal(res.status, 200);
    assert.match(res.text, /Мой ролик про ИИ/);
    assert.match(res.text, /15 000/);
    assert.match(res.text, /2 500/);
    assert.match(res.text, /Хуки/);
    assert.match(res.text, /свой хук/);
    assert.match(res.text, /мало данных/);
    assert.equal(one(t.db, 'SELECT COUNT(*) c FROM content_events WHERE kind = \'publish\'').c, 2);
  } finally { t.close(); }
});

// --------------------------------------------------- Telegram-сводка и алерты

const NT = require('../src/content/notify');
const onboarding = require('../src/onboarding');

function mockApi(opts) {
  const sent = [];
  return { sent, sendMessage: async (chatId, text, o) => {
    if (opts && opts.fail) throw new Error(opts.fail);
    sent.push({ chatId, text, markup: o && o.reply_markup }); return { mode: 'mock' };
  } };
}
const C2 = Object.assign({}, cfg, { appUrl: 'https://tracksub.test', secretKey: 'test-secret-key' });
// 10.11.2026 в разные часы по Москве (UTC+3)
const atMsk = (h, m) => Date.UTC(2026, 10, 10, h - 3, m || 0);

function notifyDb() {
  const db = open(':memory:');
  const ws = tracking.createWorkspace(db, { name: 'Личный блог' });
  return { db, ws };
}

test('Telegram: привязка по одноразовому коду, повтор и чужой код не работают', async () => {
  const { db, ws } = notifyDb();
  // command проверяет срок реальным временем: код тоже создаём относительно него.
  const code = NT.createLinkCode(db, ws.id, 'u1', Date.now());
  const res = await onboarding.command(db, null, { text: '/start cos_' + code, userId: '777' });
  assert.match(res[0].text, /Личный блог/);
  assert.equal(NT.subscriptions(db, ws.id)[0].chat_id, '777');
  const again = await onboarding.command(db, null, { text: '/start cos_' + code, userId: '888' });
  assert.match(again[0].text, /устарела/);
  assert.equal(NT.subscriptions(db, ws.id).length, 1);
  const plain = await onboarding.command(db, { getChatMember: async () => ({}) }, { text: '/start', userId: '999' });
  assert.match(plain[0].text, /Откуда трафик/, 'обычный /start не сломан');
});

test('Telegram: подписанная ссылка - подмена объекта, пространства и истёкший срок отвергаются', () => {
  const url = new URL(NT.actionLink(C2, { action: 'fav', kind: 'topic', ref: 'ctop_1', workspaceId: 'ws_a', now: NOW }));
  const q = url.searchParams;
  const base = { action: 'fav', kind: 'topic', ref: 'ctop_1', workspaceId: 'ws_a', exp: q.get('e'), sig: q.get('s'), now: NOW };
  assert.equal(NT.verifyLink(C2, base), true);
  assert.equal(NT.verifyLink(C2, Object.assign({}, base, { ref: 'ctop_2' })), false);
  assert.equal(NT.verifyLink(C2, Object.assign({}, base, { workspaceId: 'ws_b' })), false);
  assert.equal(NT.verifyLink(C2, Object.assign({}, base, { action: 'script' })), false);
  assert.equal(NT.verifyLink(C2, Object.assign({}, base, { now: NOW + 8 * 24 * HOUR })), false);
});

function seedHot(db, ws, now) {
  svc.addSources(db, ws.id, '@na\n@nb\n@nc', '');
  const src = Object.fromEntries(svc.listSources(db, ws.id).map((s) => [s.handle, s.id]));
  const ids = [];
  for (const [h, title] of [['na', 'OpenAI представила GPT-6 для бизнеса и разработчиков'], ['nb', 'Вышла GPT-6 от OpenAI: что изменилось для бизнеса и разработчиков'], ['nc', 'OpenAI выпустила GPT-6 - разбор для бизнеса и разработчиков']]) {
    ids.push(...svc.upsertItems(db, ws.id, [{ url: 'https://t.me/' + h + '/1', title, body: title, views: 20000, publishedAt: now - 3 * HOUR }], { sourceId: src[h], provider: 'telegram', platform: 'telegram', now }));
  }
  const rocket = svc.upsertItems(db, ws.id, [{ url: 'https://t.me/na/2', title: 'Нейросеть для бизнеса за 5 минут', views: 50000, publishedAt: now - 2 * HOUR }], { sourceId: src.na, provider: 'telegram', platform: 'telegram', now })[0];
  db.prepare('UPDATE content_items SET velocity = 9000, velocity_kind = \'measured\', velocity_ratio = 7.5, relevance = 0.8, relevance_label = \'on\' WHERE id = ?').run(rocket);
  const noise = svc.upsertItems(db, ws.id, [{ url: 'https://t.me/nb/3', title: 'Новости СВО', views: 90000, publishedAt: now - 2 * HOUR }], { sourceId: src.nb, provider: 'telegram', platform: 'telegram', now })[0];
  db.prepare('UPDATE content_items SET velocity = 20000, velocity_kind = \'measured\', velocity_ratio = 12, relevance = 0, relevance_label = \'off\' WHERE id = ?').run(noise);
  TP.clusterWorkspace(db, ws.id, now);
  RL.recompute(db, ws.id, PERSONAL, { now });
  db.prepare('UPDATE content_items SET relevance = 0.8, relevance_label = \'on\' WHERE id = ?').run(rocket);
  db.prepare('UPDATE content_topics SET relevance = 0.8 WHERE workspace_id = ?').run(ws.id);
  return { rocket, noise };
}

test('Telegram: утренняя сводка раз в день в свой час, с темой и кнопками; пустую не шлём', async () => {
  const { db, ws } = notifyDb();
  const now = atMsk(9, 5);
  seedHot(db, ws, now);
  db.prepare('INSERT INTO content_subscriptions (workspace_id, chat_id, digest_on, alerts_on, digest_hour, created_at) VALUES (?, ?, 1, 0, 9, ?)').run(ws.id, '777', now);
  const api = mockApi();
  assert.equal((await NT.tick(db, { cfg: C2, api, now: atMsk(8, 55) })).digests, 0, 'до 9:00 рано');
  assert.equal((await NT.tick(db, { cfg: C2, api, now })).digests, 1);
  assert.equal((await NT.tick(db, { cfg: C2, api, now: atMsk(10, 0) })).digests, 0, 'второй раз за день не шлём');
  const msg = api.sent[0];
  assert.match(msg.text, /Контент-сводка · Личный блог/);
  assert.match(msg.text, /GPT-6/);
  assert.match(msg.text, /3 источника/);
  assert.match(msg.text, /Разгоняются быстрее нормы/);
  assert.doesNotMatch(msg.text, /СВО/, '«не наше» в сводку не попадает');
  assert.ok(msg.markup.inline_keyboard[0][0].url.startsWith('https://tracksub.test/app/content/go/fav/topic/'));
  const empty = notifyDb();
  empty.db.prepare('INSERT INTO content_subscriptions (workspace_id, chat_id, digest_on, alerts_on, digest_hour, created_at) VALUES (?, ?, 1, 0, 9, ?)').run(empty.ws.id, '5', now);
  const api2 = mockApi();
  await NT.tick(empty.db, { cfg: C2, api: api2, now });
  assert.equal(api2.sent.length, 0, 'нечего сказать - молчим');
});

test('Telegram: алерты по адаптивным порогам, без повторов, лимит в день, ночью тишина', async () => {
  const { db, ws } = notifyDb();
  const now = atMsk(14);
  const { rocket } = seedHot(db, ws, now);
  db.prepare('INSERT INTO content_subscriptions (workspace_id, chat_id, digest_on, alerts_on, digest_hour, created_at) VALUES (?, ?, 0, 1, 9, ?)').run(ws.id, '777', now);
  const api = mockApi();
  const r1 = await NT.tick(db, { cfg: C2, api, now });
  assert.equal(r1.alerts, 2, 'тема из 3 источников и пост ×7,5');
  assert.ok(api.sent.some((m) => /Тему подхватили 3 источника/.test(m.text)));
  assert.ok(api.sent.some((m) => /×7,5 к обычной скорости канала/.test(m.text)));
  assert.ok(!api.sent.some((m) => /СВО/.test(m.text)), '«не наше» не алертим даже при ×12');
  assert.equal((await NT.tick(db, { cfg: C2, api, now: now + HOUR })).alerts, 0, 'повторно не пишем');
  const night = notifyDb();
  seedHot(night.db, night.ws, atMsk(23, 30));
  night.db.prepare('INSERT INTO content_subscriptions (workspace_id, chat_id, digest_on, alerts_on, digest_hour, created_at) VALUES (?, ?, 0, 1, 9, ?)').run(night.ws.id, '1', now);
  const apiN = mockApi();
  assert.equal((await NT.tick(night.db, { cfg: C2, api: apiN, now: atMsk(23, 30) })).alerts, 0, 'ночью тихо');
  for (let i = 0; i < 6; i++) db.prepare('INSERT INTO content_notifications (workspace_id, chat_id, kind, ref, status, sent_at) VALUES (?, ?, \'alert\', ?, \'sent\', ?)').run(ws.id, '777', 'x' + i, now);
  db.prepare('UPDATE content_items SET velocity_ratio = 8 WHERE id != ?').run(rocket);
  db.prepare('DELETE FROM content_notifications WHERE ref LIKE \'item:%\' OR ref LIKE \'topic:%\'').run();
  assert.equal((await NT.tick(db, { cfg: C2, api, now: now + 2 * HOUR })).alerts, 0, 'лимит алертов в день');
});

test('Telegram: заблокировал бота - подписка снимается, ошибка в журнале', async () => {
  const { db, ws } = notifyDb();
  const now = atMsk(14);
  seedHot(db, ws, now);
  db.prepare('INSERT INTO content_subscriptions (workspace_id, chat_id, digest_on, alerts_on, digest_hour, created_at) VALUES (?, ?, 0, 1, 9, ?)').run(ws.id, '777', now);
  await NT.tick(db, { cfg: C2, api: mockApi({ fail: 'Forbidden: bot was blocked by the user' }), now });
  assert.equal(NT.subscriptions(db, ws.id).length, 0);
  assert.equal(one(db, 'SELECT status FROM content_notifications LIMIT 1').status, 'failed');
});

test('Telegram в интерфейсе: кнопка ведёт в бота, тест-сводка уходит, ссылка из сообщения добавляет в избранное и пишет сценарий', async () => {
  const api = mockApi();
  const db = open(':memory:');
  const app = createApp(db, { log: () => {}, fetch: makeFetch([]), telegramApi: api });
  await new Promise((res) => app.server.listen(0, res));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  let cookie = '';
  const req = async (path, o) => {
    const opts = o || {};
    const r = await fetch(base + path, { method: opts.method || 'GET', redirect: 'manual', headers: Object.assign({ accept: 'text/html', cookie }, opts.headers || {}), body: opts.body });
    for (const sc of r.headers.getSetCookie()) { const kv = sc.split(';')[0]; const name = kv.split('=')[0]; cookie = cookie.split('; ').filter(Boolean).filter((p) => !p.startsWith(name + '=')).concat(kv).join('; '); }
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  const form = async (path, fields, from) => {
    const pg = await req(from);
    const csrf = (pg.text.match(/name="csrf" value="([^"]+)"/) || [])[1];
    return req(path, { method: 'POST', body: new URLSearchParams(Object.assign({ csrf }, fields)).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  };
  const savedName = cfg.telegram.botName;
  cfg.telegram.botName = 'tracksub_test_bot';
  try {
    await req('/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'tg@test.ru', password: 'secret123', workspace: 'Личный блог' }).toString() });
    const ws = one(db, 'SELECT * FROM workspaces');
    const settings = await req('/app/content/settings');
    assert.match(settings.text, /Подключить Telegram/);
    const link = await form('/app/content/telegram/link', {}, '/app/content/settings');
    const m = link.headers.get('location').match(/^https:\/\/t\.me\/tracksub_test_bot\?start=cos_([A-Za-z0-9_-]+)$/);
    assert.ok(m, link.headers.get('location'));
    await onboarding.command(db, null, { text: '/start cos_' + m[1], userId: '424242' });
    assert.match((await req('/app/content/settings')).text, /424242/);
    seedHot(db, ws, Date.now());
    const test1 = await form('/app/content/telegram/424242', { action: 'test' }, '/app/content/settings');
    assert.equal(test1.status, 302);
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0].text, /GPT-6/);
    const tp = one(db, 'SELECT * FROM content_topics');
    const favUrl = new URL(NT.actionLink(cfg, { action: 'fav', kind: 'topic', ref: tp.id, workspaceId: ws.id }));
    const fav = await req(favUrl.pathname + favUrl.search);
    assert.equal(fav.status, 302);
    assert.equal(one(db, 'SELECT status FROM content_items WHERE id = ?', tp.primary_item_id).status, 'picked');
    const scUrl = new URL(NT.actionLink(cfg, { action: 'script', kind: 'topic', ref: tp.id, workspaceId: ws.id }));
    const sc = await req(scUrl.pathname + scUrl.search);
    assert.match(sc.headers.get('location'), /\/app\/content\/scripts\/cscr_/);
    assert.equal(one(db, 'SELECT topic_id FROM content_scripts').topic_id, tp.id);
    const bad = await req(scUrl.pathname + scUrl.search.replace(/s=[^&]+/, 's=forged'));
    assert.match(decodeURIComponent(bad.headers.get('set-cookie') || ''), /устарела или повреждена/);
    await form('/app/content/telegram/424242', { action: 'delete' }, '/app/content/settings');
    assert.equal(NT.subscriptions(db, ws.id).length, 0);
  } finally { cfg.telegram.botName = savedName; app.server.close(); }
});
