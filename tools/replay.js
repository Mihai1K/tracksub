'use strict';

/**
 * Прогон сценария Gate 2 через реальный конвейер и печать результата.
 * Запуск: node tools/replay.js [--db data/gate2.sqlite]
 */

const fs = require('fs');
const path = require('path');
const { open, all, one } = require('../src/db');
const pipeline = require('../src/pipeline');
const attribution = require('../src/attribution');
const scenario = require('../fixtures/scenario');

const SECRET = 'gate2-secret';

function run(dbFile) {
  const db = open(dbFile || ':memory:');
  const s = scenario.build(db);

  const log = [];
  for (const e of s.events) {
    const bodyRaw = typeof e.update === 'string' && e.update.startsWith('__RAW__')
      ? e.update.slice(7)
      : JSON.stringify(e.update);
    const res = pipeline.handleIncoming(db, {
      transport: 'webhook',
      headers: { 'x-max-bot-api-secret': SECRET, 'content-type': 'application/json' },
      bodyRaw,
      secret: SECRET,
      platform: 'max'
    });
    log.push({ note: e.note, res });
  }

  // отдельная проверка: запрос с неверным секретом не должен попасть в хранилище
  const rejected = pipeline.handleIncoming(db, {
    headers: { 'x-max-bot-api-secret': 'wrong' },
    bodyRaw: JSON.stringify(scenario.userAdded('-100500', 'U99', scenario.T0, true)),
    secret: SECRET,
    platform: 'max'
  });

  return { db, s, log, rejected };
}

function main() {
  const argIdx = process.argv.indexOf('--db');
  const dbFile = argIdx > -1 ? process.argv[argIdx + 1] : ':memory:';
  if (dbFile !== ':memory:') {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
  const { db, log, rejected } = run(dbFile);

  const line = (a, b, c) => console.log(String(a).padEnd(52) + String(b).padEnd(26) + (c == null ? '' : c));

  console.log('\n=== ДОСТАВКА СОБЫТИЙ ===');
  line('событие', 'итог', 'детали');
  for (const l of log) {
    const r = l.res;
    let outcome = r.duplicate ? 'дубль (idempotent)' : r.failed ? 'failed' : (r.domain && r.domain.action) || 'stored';
    let detail = '';
    if (r.failed) detail = r.error;
    else if (r.domain && r.domain.reason) detail = r.domain.reason;
    if (r.attribution) {
      detail = r.attribution.type +
        (r.attribution.confidence != null ? ' conf=' + r.attribution.confidence.toFixed(2) : '') +
        (r.attribution.is_ambiguous ? ' AMBIGUOUS' : '') +
        (r.attribution.is_dense ? ' DENSE' : '');
    }
    line(l.note, outcome, detail);
  }
  line('запрос с неверным секретом', 'status=' + rejected.status, 'stored=' + rejected.stored);

  console.log('\n=== СЧЁТЧИКИ ===');
  const counts = {
    'сырых событий': one(db, 'SELECT COUNT(*) c FROM webhook_events').c,
    '  из них failed': one(db, 'SELECT COUNT(*) c FROM webhook_events WHERE status = \'failed\'').c,
    'нормализованных': one(db, 'SELECT COUNT(*) c FROM platform_events').c,
    '  applied': one(db, 'SELECT COUNT(*) c FROM platform_events WHERE domain_status = \'applied\'').c,
    '  ignored': one(db, 'SELECT COUNT(*) c FROM platform_events WHERE domain_status = \'ignored\'').c,
    'кликов (counted)': one(db, 'SELECT COUNT(*) c FROM clicks WHERE status = \'counted\'').c,
    'подписок': one(db, 'SELECT COUNT(*) c FROM subscriptions').c,
    '  повторных': one(db, 'SELECT COUNT(*) c FROM subscriptions WHERE is_resubscribe = 1').c,
    'отписок left': one(db, 'SELECT COUNT(*) c FROM unsubscriptions WHERE reason = \'left\'').c,
    'отписок removed': one(db, 'SELECT COUNT(*) c FROM unsubscriptions WHERE reason = \'removed\'').c
  };
  for (const k of Object.keys(counts)) line(k, counts[k]);

  console.log('\n=== АТРИБУЦИЯ ===');
  const byType = all(db,
    'SELECT type, COUNT(*) c, ROUND(AVG(confidence), 3) avg_conf FROM attributions WHERE is_current = 1 GROUP BY type');
  for (const r of byType) line(r.type, r.c, 'средняя уверенность: ' + (r.avg_conf == null ? '—' : r.avg_conf));

  const detail = all(db,
    'SELECT s.id sub, pu.external_user_id usr, a.type, a.confidence, a.margin, a.is_ambiguous, a.is_dense, ' +
    'tl.source, tl.campaign FROM subscriptions s ' +
    'JOIN platform_users pu ON pu.id = s.platform_user_id ' +
    'LEFT JOIN attributions a ON a.subscription_id = s.id AND a.is_current = 1 ' +
    'LEFT JOIN clicks c ON c.id = a.click_id ' +
    'LEFT JOIN tracking_links tl ON tl.id = c.tracking_link_id ORDER BY s.ts_utc');
  console.log('');
  line('подписчик', 'тип атрибуции', 'источник / кампания / признаки');
  for (const d of detail) {
    line(d.usr, d.type + (d.confidence != null ? ' ' + d.confidence.toFixed(2) : ''),
      [d.source || '—', d.campaign || '—', d.is_ambiguous ? 'AMBIGUOUS' : '', d.is_dense ? 'DENSE' : ''].filter(Boolean).join(' / '));
  }

  console.log('\n=== КАЛИБРОВКА (attribution.md §12) ===');
  const cal = attribution.calibrate(db);
  line('сравнимых подписок', cal.comparable, cal.note || '');
  line('совпало со схемой A', cal.matched, cal.accuracy == null ? '' : 'accuracy = ' + (cal.accuracy * 100).toFixed(1) + '%');
  console.log('\nЭто синтетика. Достоверность цифры точности равна нулю до эксперимента E1-E8.\n');

  console.log('=== ПЕРЕСЧЁТ ИЗ СЫРЫХ ДАННЫХ ===');
  const snap = () => JSON.stringify(all(db,
    'SELECT subscription_id, type, click_id, confidence FROM attributions WHERE is_current = 1 ORDER BY subscription_id'));
  const streaming = snap();
  pipeline.reattributeAll(db);
  const firstPass = snap();
  pipeline.reattributeAll(db);
  const secondPass = snap();

  line('поток == пересчёт', streaming === firstPass ? 'да' : 'нет',
    'расхождение здесь нормально: в потоке ещё не известны более поздние сигналы');
  line('пересчёт идемпотентен', firstPass === secondPass ? 'да' : 'НЕТ — это дефект',
    'версий атрибуции всего: ' + one(db, 'SELECT COUNT(*) c FROM attributions').c);
  console.log('');
  return firstPass === secondPass ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { run, SECRET };
