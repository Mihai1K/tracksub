'use strict';

/**
 * Сценарий Gate 2: больше 20 событий, покрывающих все случаи из протокола §14.
 * Синтетика: реальные payload'ы MAX не подтверждены до эксперимента E1-E8 (см. gate-1-report.md §3).
 * Форма событий взята из моделей официальной библиотеки max-messenger/max-botapi-python.
 */

const tracking = require('../src/tracking');

const T0 = Date.UTC(2026, 8, 1, 10, 0, 0); // 01.09.2026 10:00 UTC
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const HEADERS_HUMAN = { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' };

function userAdded(chatId, userId, ts, isChannel, inviterId) {
  return {
    update_type: 'user_added',
    timestamp: ts,
    chat_id: chatId,
    user: { user_id: userId, name: 'User ' + userId },
    is_channel: isChannel !== false,
    inviter_id: inviterId == null ? null : inviterId
  };
}

function userRemoved(chatId, userId, ts, adminId) {
  return {
    update_type: 'user_removed',
    timestamp: ts,
    chat_id: chatId,
    user: { user_id: userId, name: 'User ' + userId },
    is_channel: true,
    admin_id: adminId == null ? null : adminId
  };
}

function botStarted(chatId, userId, ts, payload) {
  return {
    update_type: 'bot_started',
    timestamp: ts,
    chat_id: chatId,
    user: { user_id: userId, name: 'User ' + userId },
    user_locale: 'ru',
    payload: payload
  };
}

function click(db, slug, ts, ua) {
  const r = tracking.registerClick(db, {
    slug,
    method: 'GET',
    headers: HEADERS_HUMAN,
    query: { utm_source: slug },
    ip: '10.0.0.' + (ts % 200),
    userAgent: ua || HEADERS_HUMAN['user-agent'],
    referer: 'https://ad.example/',
    ipSalt: 'fixture-salt',
    now: ts
  });
  if (!r.ok) throw new Error('click failed: ' + r.reason);
  return r.clickId;
}

/** Готовит workspace/канал/ссылки/клики и возвращает список событий в порядке доставки. */
function build(db) {
  const ws = tracking.createWorkspace(db, { name: 'Test WS', timezone: 'Europe/Moscow', attributionWindowHours: 72 });
  const channel = tracking.connectChannel(db, { workspaceId: ws.id, platform: 'max', externalChatId: '-100500', title: 'Тестовый канал' });
  const other = tracking.connectChannel(db, { workspaceId: ws.id, platform: 'max', externalChatId: '-100777', title: 'Второй канал' });

  const linkBot = tracking.createLink(db, { workspaceId: ws.id, channelId: channel.id, slug: 'yd-a', source: 'yandex_direct', campaign: 'c1', creative: 'a', redirectMode: 'bot' });
  const linkDirect = tracking.createLink(db, { workspaceId: ws.id, channelId: channel.id, slug: 'yd-b', source: 'yandex_direct', campaign: 'c2', creative: 'b', redirectMode: 'direct' });
  const linkSeed = tracking.createLink(db, { workspaceId: ws.id, channelId: channel.id, slug: 'seed', source: 'max_seeding', campaign: 'chan_x', redirectMode: 'direct' });
  const linkDense = tracking.createLink(db, { workspaceId: ws.id, channelId: other.id, slug: 'dense', source: 'max_seeding', campaign: 'dense', redirectMode: 'direct' });

  const C = {};
  C.det1 = click(db, 'yd-a', T0);                       // приведёт к точной атрибуции U1
  C.probA = click(db, 'yd-b', T0 + 10 * MIN);           // кандидат 1 для U2
  C.probB = click(db, 'seed', T0 + 25 * MIN);           // кандидат 2 для U2 (ближе по времени)
  C.detA = click(db, 'yd-a', T0 + 40 * MIN);            // первый payload U7
  C.detB = click(db, 'yd-b', T0 + 45 * MIN);            // второй payload U7 -> побеждает
  C.late = click(db, 'yd-a', T0 + 50 * MIN);            // подписка через 3 часа -> confidence 0.8

  const denseClicks = [];
  for (let i = 0; i < 21; i++) denseClicks.push(click(db, 'dense', T0 + 60 * MIN + i * MIN, 'Mozilla/5.0 (Android 14)'));

  const events = [];
  const push = (note, update) => events.push({ note, update });

  // 1-2. Точная схема: bot_started с payload -> подписка
  push('E-01 bot_started c payload (точная схема)', botStarted(1, 'U1', T0 + 2 * MIN, C.det1));
  push('E-02 подписка U1 -> deterministic', userAdded('-100500', 'U1', T0 + 5 * MIN));
  // 3. Повторная доставка того же события
  push('E-03 дубль доставки E-02 -> идемпотентность', userAdded('-100500', 'U1', T0 + 5 * MIN));
  // 4. Вероятностная схема с двумя кандидатами
  push('E-04 подписка U2 без bot_started -> probabilistic, 2 кандидата', userAdded('-100500', 'U2', T0 + 30 * MIN));
  // 5. Добровольная отписка
  push('E-05 U2 ушёл сам -> reason=left', userRemoved('-100500', 'U2', T0 + 2 * HOUR, null));
  // 6. Повторная подписка внутри 7 суток
  push('E-06 U2 подписался снова через 2 дня -> resubscribe', userAdded('-100500', 'U2', T0 + 2 * DAY));
  // 7. Подписка без единого клика
  push('E-07 подписка U3 без кликов -> unattributed', userAdded('-100500', 'U3', T0 + 3 * DAY + HOUR));
  // 8. Удаление администратором
  push('E-08 U3 удалён админом -> reason=removed', userRemoved('-100500', 'U3', T0 + 3 * DAY + 2 * HOUR, 'ADMIN1'));
  // 9. Событие не по каналу
  push('E-09 user_added в чат (is_channel=false) -> ignored', userAdded('-100500', 'U4', T0 + 6 * HOUR, false));
  // 10. Неизвестный канал
  push('E-10 подписка в неподключённый канал -> ignored', userAdded('-100999', 'U5', T0 + 6 * HOUR));
  // 11. Структурно некорректное событие
  push('E-11 нет timestamp -> failed, но сохранено', { update_type: 'user_added', chat_id: '-100500', user: { user_id: 'U6' }, is_channel: true });
  // 12-13. payload, который не расшифровывается в наш клик
  push('E-12 bot_started с чужим payload', botStarted(1, 'U6', T0 + 7 * HOUR, 'ZZZZnotOurClick'));
  push('E-13 подписка U6 -> откат на probabilistic/unattributed', userAdded('-100500', 'U6', T0 + 7 * HOUR + 5 * MIN));
  // 14. Два разных payload до одной подписки
  push('E-14 bot_started U7 payload=detA', botStarted(1, 'U7', T0 + 41 * MIN, C.detA));
  push('E-15 bot_started U7 payload=detB (позже)', botStarted(1, 'U7', T0 + 46 * MIN, C.detB));
  push('E-16 подписка U7 -> deterministic detB, is_ambiguous', userAdded('-100500', 'U7', T0 + 48 * MIN));
  // 15. Поздняя подписка в точной схеме
  push('E-17 bot_started U8 payload=late', botStarted(1, 'U8', T0 + 51 * MIN, C.late));
  push('E-18 подписка U8 через 3 часа -> confidence 0.8', userAdded('-100500', 'U8', T0 + 3 * HOUR + 51 * MIN));
  // 16. Подписка при уже активной подписке
  push('E-19 повторный user_added U1 при активной подписке -> ignored', userAdded('-100500', 'U1', T0 + 4 * HOUR));
  // 17. Нерелевантный тип
  push('E-20 message_created -> other/ignored', { update_type: 'message_created', timestamp: T0 + 5 * HOUR, chat_id: '-100500', user: { user_id: 'U1' } });
  // 18. Отписка без активной подписки
  push('E-21 user_removed без активной подписки', userRemoved('-100500', 'U9', T0 + 5 * HOUR + MIN, null));
  // 19. Плотный поток кандидатов
  push('E-22 подписка U10 в плотном канале -> is_dense', userAdded('-100777', 'U10', T0 + 90 * MIN));
  // 20. Невалидный JSON
  push('E-23 невалидный JSON -> failed, но сохранено', '__RAW__{not json');

  return { ws, channel, other, links: { linkBot, linkDirect, linkSeed, linkDense }, clicks: C, denseClicks, events, T0 };
}

module.exports = { build, T0, MIN, HOUR, DAY, userAdded, userRemoved, botStarted, HEADERS_HUMAN };
