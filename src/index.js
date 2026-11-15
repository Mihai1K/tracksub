'use strict';

/** Точка входа: БД, фоновые задачи, сервер. */

const fs = require('fs');
const path = require('path');
const { open } = require('./db');
const { createApp } = require('./server');
const { cfg, dbFile } = require('./config');
const auth = require('./auth');
const accounts = require('./accounts');
const dispatcher = require('./conversions/dispatcher');
const report = require('./report');
const { TelegramApi } = require('./platform/telegramApi');
const { one } = require('./db');

function log(level, msg, meta) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, msg }, meta || {})));
}

function bootstrap() {
  const file = dbFile();
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = open(file);
  log('info', 'database ready', { file });

  if (cfg.secretKeyIsDerived) {
    log('warn', 'SECRET_KEY не задан: ключ шифрования токенов выведен из IP_SALT. ' +
      'Для боевой установки задайте отдельный SECRET_KEY', {});
  }
  if (cfg.ipSalt === 'dev-salt-change-me') {
    log('warn', 'IP_SALT не изменён: хеши адресов предсказуемы. Задайте свой IP_SALT', {});
  }

  for (const [name, conf] of [['Telegram', cfg.telegram], ['MAX', cfg.max]]) {
    if (conf.mode === 'real' && !conf.webhookSecret) {
      log('error', name + ': токен задан, а секрет вебхука — нет. Приём событий этой платформы ' +
        'будет отклоняться, пока секрет не появится', {});
    }
  }

  if (cfg.adminEmail && cfg.adminPassword && !one(db, 'SELECT id FROM users WHERE email = ?', cfg.adminEmail.toLowerCase())) {
    const admin = auth.createUser(db, { email: cfg.adminEmail, password: cfg.adminPassword, isAdmin: true });
    accounts.createWorkspaceFor(db, admin, { name: 'Администратор' });
    log('info', 'admin created', { email: admin.email });
  }
  return db;
}

function start() {
  const db = bootstrap();
  const app = createApp(db, { log });

  const worker = setInterval(async () => {
    try {
      const done = await dispatcher.processQueue(db, { limit: 25 });
      if (done.length) log('info', 'conversion queue processed', { count: done.length });
    } catch (e) {
      log('error', 'conversion worker failed', { error: String(e.message) });
    }
  }, cfg.conversionWorkerMs);
  worker.unref();

  /**
   * Добор недообработанных событий. Событие сначала сохраняется, потом обрабатывается —
   * если процесс умер между этими шагами, оно остаётся в статусе received навсегда.
   * Аудит боевой версии нашёл ровно такой случай после перезапуска.
   */
  const recovery = setInterval(() => {
    try {
      const done = require('./pipeline').processPending(db, 50);
      if (done.length) log('info', 'recovered pending events', { count: done.length });
    } catch (e) {
      log('error', 'recovery failed', { error: String(e.message) });
    }
  }, 120000);
  recovery.unref();

  // Ежедневные отчёты: проверяем раз в час, отправляем один раз в сутки после 10 утра.
  const reporter = setInterval(async () => {
    if (new Date().getHours() < 10) return;
    try {
      const api = new TelegramApi({ token: cfg.telegram.token, mode: cfg.telegram.mode });
      const res = await report.sendDaily(db, api, {});
      const sent = res.filter((r) => r.sent).length;
      if (sent) log('info', 'daily reports sent', { count: sent });
    } catch (e) {
      log('error', 'daily report failed', { error: String(e.message) });
    }
  }, 3600000);
  reporter.unref();

  // Content OS: фоновый сбор трендов (тот же вызов стоит в обёртке Selectel).
  require('./content/service').startCollector(db, { cfg, log });

  app.server.listen(cfg.port, () => {
    log('info', 'server started', {
      url: cfg.appUrl, port: cfg.port,
      telegram: cfg.telegram.mode, max: cfg.max.mode
    });
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('info', 'shutting down', { signal: sig });
      app.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
  return app;
}

if (require.main === module) start();
module.exports = { start, bootstrap };
