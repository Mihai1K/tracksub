'use strict';

/** Подключение канала чужим админом: канал не должен попадать в чужой кабинет. */

const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { one, all } = require('../src/db');
const onboarding = require('../src/onboarding');
const ingest = require('../src/ingest');
const report = require('../src/report');
const tracking = require('../src/tracking');

const botAdded = (chatId, title, byUserId) => JSON.stringify({
  update_id: Math.floor(Math.random() * 1e9),
  my_chat_member: {
    chat: { id: chatId, title, type: 'channel', username: 'somechan' },
    from: { id: byUserId },
    date: Math.floor(Date.now() / 1000),
    old_chat_member: { status: 'left', user: { id: 999, is_bot: true } },
    new_chat_member: { status: 'administrator', user: { id: 999, is_bot: true } }
  }
});

test('чужой канал не попадает в существующий проект', () => {
  const { db, ws } = h.setup(); // это «наш» проект, он в базе первый
  const accepted = ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100999', 'Чужой канал', '777'), transport: 'polling' });

  const ch = one(db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-100999');
  assert.ok(ch, 'канал зарегистрирован');
  assert.notEqual(ch.workspace_id, ws.id, 'канал НЕ привязан к первому попавшемуся проекту');
  assert.equal(ch.status, 'unclaimed');
  assert.ok(ch.claim_token, 'выдан токен привязки');
  assert.equal(ch.added_by_telegram_id, '777');

  const sys = one(db, 'SELECT * FROM workspaces WHERE id = ?', ch.workspace_id);
  assert.equal(sys.is_system, 1, 'канал лежит в системном проекте до привязки');

  assert.equal(accepted.outbound.length, 1, 'добавившему уходит сообщение');
  assert.match(accepted.outbound[0].text, /claim\//);
  assert.equal(accepted.outbound[0].chatId, '777');
});

test('привязка переносит канал в кабинет того, кто открыл ссылку', () => {
  const { db, ws } = h.setup();
  ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100888', 'Канал', '555'), transport: 'polling' });
  const ch = one(db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-100888');

  const res = onboarding.claim(db, ch.claim_token, ws.id);
  assert.equal(res.ok, true);
  assert.equal(res.channel.workspace_id, ws.id);
  assert.equal(res.channel.status, 'connected');
  assert.ok(res.channel.claimed_at);
  assert.equal(res.channel.claim_token, null, 'токен погашен');

  const again = onboarding.claim(db, ch.claim_token, ws.id);
  assert.equal(again.ok, false, 'повторно тем же токеном забрать нельзя');
});

test('уже привязанный канал не перезахватывается при повторном добавлении бота', () => {
  const { db, ws } = h.setup();
  ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100777', 'Канал', '111'), transport: 'polling' });
  const ch = one(db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-100777');
  onboarding.claim(db, ch.claim_token, ws.id);

  const accepted = ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100777', 'Канал', '222'), transport: 'polling' });
  const after = one(db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-100777');
  assert.equal(after.workspace_id, ws.id, 'владелец не меняется');
  assert.equal(after.status, 'connected');
  assert.equal(accepted.outbound.length, 0, 'второму человеку ссылка привязки не уходит');
});

/** Бот, который отвечает, что человек — админ только перечисленных каналов. */
const apiWhereAdminOf = (chats) => ({
  getChatMember: async (chatId) => ({
    result: { status: chats.includes(String(chatId)) ? 'administrator' : 'left' }
  })
});

const privateCmd = (text, userId) => JSON.stringify({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, date: Math.floor(Date.now() / 1000),
    chat: { id: userId, type: 'private' }, from: { id: userId }, text }
});

test('/start отвечает приветствием и списком каналов, ждущих привязки', async () => {
  const { db } = h.setup();
  ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100666', 'Мой канал', '333'), transport: 'polling' });

  const got = ingest.accept(db, { platform: 'telegram', transport: 'polling', bodyRaw: privateCmd('/start', 333) });
  assert.ok(got.command, 'команда распознана');
  assert.equal(got.outbound.length, 0, 'приём события сам сообщений не шлёт');

  const msgs = await onboarding.command(db, apiWhereAdminOf([]), { text: got.command.text, userId: got.command.userId, appUrl: 'https://x.ru' });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /Откуда трафик/);
  assert.match(msgs[0].text, /Мой канал/, 'подсказывает, какой канал ждёт привязки');
  assert.match(msgs[0].text, /https:\/\/x\.ru\/claim\//, 'ссылка привязки на месте');
});

test('РЕГРЕССИЯ: канал от анонимного админа всё равно находится по /start', async () => {
  const { db } = h.setup();
  // В каналах админ часто действует анонимно: Telegram кладёт в from служебный
  // идентификатор, а не человека. Раньше канал после этого не находился никогда.
  ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100900', 'Канал с анонимом', '1087968824'), transport: 'polling' });

  const got = ingest.accept(db, { platform: 'telegram', transport: 'polling', bodyRaw: privateCmd('/start', 777) });
  const msgs = await onboarding.command(db, apiWhereAdminOf(['-100900']),
    { text: got.command.text, userId: got.command.userId, appUrl: 'https://x.ru' });
  assert.match(msgs[0].text, /Канал с анонимом/, 'право на канал подтверждено у самой платформы');

  const stranger = await onboarding.command(db, apiWhereAdminOf([]),
    { text: '/start', userId: '555', appUrl: 'https://x.ru' });
  assert.doesNotMatch(stranger[0].text, /Канал с анонимом/, 'постороннему канал не предлагается');
});

test('бот отвечает на /help, /status и на незнакомую команду', async () => {
  const { db, ws } = h.setup();
  ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100901', 'Подключённый', '12'), transport: 'polling' });
  const ch = one(db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-100901');
  onboarding.claim(db, ch.claim_token, ws.id);

  const help = await onboarding.command(db, apiWhereAdminOf([]), { text: '/help', userId: '12' });
  assert.match(help[0].text, /\/status/, 'справка перечисляет команды');

  const status = await onboarding.command(db, apiWhereAdminOf(['-100901']),
    { text: '/status', userId: '12', appUrl: 'https://x.ru' });
  assert.match(status[0].text, /Подключённый/, 'в сводке есть канал');
  assert.match(status[0].text, /за сутки/);

  const unknown = await onboarding.command(db, apiWhereAdminOf([]), { text: '/qwerty', userId: '12' });
  assert.equal(unknown.length, 1, 'молчание выглядело бы как зависший бот');
  assert.match(unknown[0].text, /\/help/);
});

test('ежедневный отчёт: считает за вчера, молчит в пустой день, не дублируется', async () => {
  const { db, ws } = h.setup();
  ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100555', 'Канал', '444'), transport: 'polling' });
  const ch = one(db, 'SELECT * FROM channels WHERE external_chat_id = ?', '-100555');
  onboarding.claim(db, ch.claim_token, ws.id);
  const now0 = Date.now();

  const empty = report.buildForChannel(db, one(db, 'SELECT * FROM channels WHERE id = ?', ch.id), now0);
  assert.equal(empty, null, 'в пустой день отчёт не формируется');

  // Событие ставим строго в середину вчерашних суток проекта и фиксируем «сейчас».
  // Раньше брали «20 часов назад», и тест падал, если его запускали вечером:
  // двадцать часов назад — это ещё сегодня.
  const now = Date.now();
  const ws2 = one(db, 'SELECT * FROM workspaces WHERE id = ?', ws.id);
  const window = report.yesterday(ws2, now);
  const yst = window.from + 12 * 3600 * 1000;
  const link = tracking.createLink(db, { workspaceId: ws.id, channelId: ch.id, slug: 'rep', source: 'yandex', redirectMode: 'direct' });
  tracking.registerClick(db, { slug: 'rep', method: 'GET', headers: { accept: 'text/html' }, query: {}, ip: '1.1.1.1', userAgent: 'Mozilla/5.0 (iPhone)', ipSalt: 's', now: yst });
  ingest.accept(db, {
    platform: 'telegram', transport: 'polling',
    bodyRaw: JSON.stringify({
      update_id: 77, chat_member: {
        chat: { id: '-100555', type: 'channel' }, from: { id: 'u5' }, date: Math.floor((yst + 60000) / 1000),
        old_chat_member: { status: 'left', user: { id: 'u5' } },
        new_chat_member: { status: 'member', user: { id: 'u5' } }
      }
    })
  });

  const built = report.buildForChannel(db, one(db, 'SELECT * FROM channels WHERE id = ?', ch.id), now);
  assert.ok(built, 'отчёт сформирован');
  assert.match(built.text, /Подписались: 1/);
  assert.match(built.text, /yandex/);

  const sent = [];
  const api = { sendMessage(chatId, text) { sent.push({ chatId, text }); return Promise.resolve({ mode: 'mock' }); } };
  await report.sendDaily(db, api, { now });
  assert.equal(sent.length, 1, 'отчёт ушёл владельцу');
  assert.equal(sent[0].chatId, '444');

  await report.sendDaily(db, api, { now });
  assert.equal(sent.length, 1, 'повторный запуск в тот же день ничего не дублирует');
});

test('администратору сервиса тариф не мешает', () => {
  // Владелец сервиса не должен выписывать подписку сам себе, чтобы открыть собственную админку.
  const { db, ws } = h.setup();
  const auth = require('../src/auth');
  const accounts = require('../src/accounts');

  const user = auth.createUser(db, { email: 'owner@svc.ru', password: 'secret123' });
  const own = accounts.createWorkspaceFor(db, user, { name: 'Свой проект' });
  assert.equal(accounts.planOf(db, own).key, 'free');
  assert.ok(accounts.checkLimit(db, own, 'conversions'), 'обычному пользователю передача конверсий закрыта');

  const { run } = require('../src/db');
  run(db, 'UPDATE users SET is_admin = 1 WHERE id = ?', user.id);
  const after = accounts.planOf(db, one(db, 'SELECT * FROM workspaces WHERE id = ?', own.id));
  assert.equal(after.key, 'service');
  assert.equal(accounts.checkLimit(db, one(db, 'SELECT * FROM workspaces WHERE id = ?', own.id), 'conversions'), null,
    'администратору передача конверсий доступна без тарифа');
  assert.ok(ws);
});

test('ID канала с потерянным минусом не попадает в базу', () => {
  const { db, ws } = h.setup();
  const bad = tracking.checkChatId('telegram', '1002946346442');
  assert.ok(bad, 'положительный ID отбракован');
  assert.match(bad, /-1002946346442/, 'в подсказке есть исправленный ID');
  assert.equal(tracking.checkChatId('telegram', '-1002946346442'), null, 'правильный ID проходит');
  assert.ok(tracking.checkChatId('telegram', '-500'), 'ID не канала отбракован');
  assert.ok(tracking.checkChatId('telegram', ''), 'пустой ID отбракован');
  assert.equal(tracking.checkChatId('max', 'c1'), null, 'для MAX формат не навязываем');
  assert.ok(ws);
  assert.ok(db);
});

test('один чат — один канал: второй ряд на тот же чат не создаётся', () => {
  const { db, ws, channel } = h.setup();
  assert.throws(
    () => tracking.connectChannel(db, { workspaceId: ws.id, platform: 'max', externalChatId: channel.external_chat_id }),
    /уже подключён/,
    'повтор в своём же кабинете отбит'
  );

  const other = tracking.createWorkspace(db, { name: 'Чужой' });
  assert.throws(
    () => tracking.connectChannel(db, { workspaceId: other.id, platform: 'max', externalChatId: channel.external_chat_id }),
    /занят другим кабинетом/,
    'чужой кабинет не может забрать канал через форму'
  );

  assert.equal(all(db, 'SELECT * FROM channels WHERE external_chat_id = ?', channel.external_chat_id).length, 1,
    'в базе по-прежнему один ряд на чат');
});

test('канал, заведённый руками до бота, уезжает в системный проект и ждёт привязки', () => {
  const { db } = h.setup();
  const squatter = tracking.createWorkspace(db, { name: 'Занял первым' });
  const pre = tracking.connectChannel(db, { workspaceId: squatter.id, platform: 'telegram', externalChatId: '-100654' });

  ingest.accept(db, { platform: 'telegram', bodyRaw: botAdded('-100654', 'Настоящий канал', '42'), transport: 'polling' });

  const ch = one(db, 'SELECT * FROM channels WHERE id = ?', pre.id);
  assert.equal(ch.status, 'unclaimed');
  assert.notEqual(ch.workspace_id, squatter.id, 'ряд ушёл из кабинета того, кто просто угадал ID');
  assert.equal(one(db, 'SELECT * FROM workspaces WHERE id = ?', ch.workspace_id).is_system, 1);
});
