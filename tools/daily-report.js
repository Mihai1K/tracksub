'use strict';

/**
 * Рассылка ежедневных отчётов.
 *   node tools/daily-report.js            отправить за вчера (повторно не пришлёт)
 *   node tools/daily-report.js --dry      показать тексты, ничего не отправляя
 *   node tools/daily-report.js --force    отправить, даже если уже отправляли
 */

const { open, all } = require('../src/db');
const { dbFile, cfg } = require('../src/config');
const report = require('../src/report');
const { TelegramApi } = require('../src/platform/telegramApi');

async function main() {
  const db = open(dbFile());
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');

  if (dry) {
    const channels = all(db, 'SELECT * FROM channels WHERE claimed_at IS NOT NULL AND platform = \'telegram\'');
    if (!channels.length) console.log('Привязанных каналов нет.');
    for (const ch of channels) {
      const r = report.buildForChannel(db, ch);
      console.log('\n--- ' + (ch.title || ch.external_chat_id) + ' → ' + (ch.added_by_telegram_id || 'некому писать'));
      console.log(r ? r.text : '(за вчера событий не было, отчёт не отправляется)');
    }
    return;
  }

  const api = new TelegramApi({ token: cfg.telegram.token, mode: cfg.telegram.mode });
  const res = await report.sendDaily(db, api, { force: args.includes('--force') });
  for (const r of res) {
    console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), msg: 'daily report' }, r)));
  }
  if (!res.length) console.log('Каналов для отчёта нет.');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
