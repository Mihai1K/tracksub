'use strict';

/**
 * Проверка настройки Яндекс Метрики без раскрытия токена.
 *
 * Токен вводится в интерфейсе (/app/integrations), хранится в базе зашифрованным
 * и расшифровывается только здесь, в момент вызова. В вывод он не попадает никогда.
 *
 *   node tools/yandex-check.js                проверить доступ к счётчику и список целей
 *   node tools/yandex-check.js --send         отправить конверсии из очереди по-настоящему
 *   node tools/yandex-check.js --queue        показать очередь конверсий
 */

const { open, one, all } = require('../src/db');
const { dbFile, cfg } = require('../src/config');
const secrets = require('../src/secrets');
const dispatcher = require('../src/conversions/dispatcher');

const BASE = 'https://api-metrika.yandex.net';

function mask(t) { return secrets.mask(t); }

async function metrika(path, token) {
  const res = await fetch(BASE + path, { headers: { Authorization: 'OAuth ' + token } });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch (e) { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, ok: res.ok, body };
}

async function check(db) {
  const creds = all(db, 'SELECT * FROM ad_platform_credentials');
  if (!creds.length) {
    console.log('Интеграции не настроены. Откройте ' + cfg.appUrl + '/app/integrations и заполните счётчик, цель и токен.');
    return;
  }

  for (const cred of creds) {
    const ws = one(db, 'SELECT name FROM workspaces WHERE id = ?', cred.workspace_id);
    console.log('\n=== ' + cred.provider + '  (проект: ' + (ws ? ws.name : cred.workspace_id) + ')');
    console.log('  режим:    ' + cred.mode);
    console.log('  счётчик:  ' + (cred.counter_id || 'не задан'));
    console.log('  цель:     ' + (cred.goal_id || 'не задана'));

    const token = secrets.decrypt(cred.token, cfg.secretKey);
    if (!token) {
      console.log('  токен:    нет (или ключ шифрования сменился) → отправки не будет');
      continue;
    }
    console.log('  токен:    ' + mask(token) + ' — расшифрован, в вывод не попадает');

    const me = await metrika('/management/v1/counters', token);
    if (!me.ok) {
      console.log('  ✗ Метрика отклонила токен: ' + me.status + ' ' + JSON.stringify(me.body).slice(0, 200));
      continue;
    }
    const counters = (me.body.counters || []).map((c) => c.id + ' (' + c.name + ')');
    console.log('  ✓ токен рабочий, доступных счётчиков: ' + counters.length);
    if (counters.length) console.log('    ' + counters.slice(0, 10).join(', '));

    if (!cred.counter_id) continue;
    const goals = await metrika('/management/v1/counter/' + cred.counter_id + '/goals', token);
    if (!goals.ok) {
      console.log('  ✗ нет доступа к целям счётчика ' + cred.counter_id + ': ' + goals.status);
      continue;
    }
    const list = goals.body.goals || [];
    console.log('  ✓ целей в счётчике: ' + list.length);
    for (const g of list) {
      // Идентификатор цели типа «Целевое событие» лежит не в id и не в name,
      // а в conditions[].url — именно его Метрика ждёт в колонке Target при загрузке конверсий.
      const ids = (g.conditions || []).map((cnd) => cnd.url).filter(Boolean);
      console.log('    id ' + g.id + ' | ' + g.name + ' | тип ' + g.type +
        (ids.length ? ' | идентификатор: ' + ids.join(', ') : ''));
    }

    const match = list.find((g) =>
      String(g.id) === String(cred.goal_id) ||
      g.name === cred.goal_id ||
      (g.conditions || []).some((cnd) => cnd.url === cred.goal_id));
    console.log(match
      ? '  ✓ цель «' + cred.goal_id + '» найдена в счётчике'
      : '  ⚠ цель «' + cred.goal_id + '» в счётчике не найдена — конверсии придут, но обучать будет нечего');
  }
}

function queue(db) {
  const rows = all(db,
    'SELECT c.*, s.ts_utc sub_ts FROM conversions c LEFT JOIN subscriptions s ON s.id = c.subscription_id ' +
    'ORDER BY c.created_at DESC LIMIT 20');
  console.log('\n=== ОЧЕРЕДЬ КОНВЕРСИЙ: ' + rows.length);
  for (const r of rows) {
    console.log('  ' + r.id + ' | ' + r.provider + ' | ' + r.kind + ' | ' + r.status + ' | режим ' + r.mode +
      ' | попыток ' + r.attempts + (r.error ? ' | ' + String(r.error).slice(0, 80) : '') +
      (r.external_id ? ' | загрузка ' + r.external_id : ''));
  }
  const pending = one(db, 'SELECT COUNT(*) c FROM conversions WHERE status IN (\'pending\',\'retrying\')').c;
  console.log('  ожидают отправки: ' + pending);
}

async function main() {
  const db = open(dbFile());
  const args = process.argv.slice(2);

  if (args.includes('--queue')) return queue(db);

  await check(db);

  if (args.includes('--send')) {
    console.log('\n=== ОТПРАВКА');
    const done = await dispatcher.processQueue(db, { limit: 50 });
    if (!done.length) console.log('  очередь пуста');
    for (const d of done) {
      console.log('  ' + d.id + ' → ' + d.result.status +
        (d.result.mode ? ' (' + d.result.mode + ')' : '') +
        (d.result.reason ? ' — ' + d.result.reason : '') +
        (d.result.error ? ' — ' + d.result.error : ''));
    }
    queue(db);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('Ошибка: ' + e.message); process.exit(1); });
}
module.exports = { check, queue };
