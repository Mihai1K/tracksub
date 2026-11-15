'use strict';

/** Конфигурация из окружения. Секретов в коде нет. */

function bool(v, dflt) {
  if (v == null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const cfg = {
  port: parseInt(process.env.PORT || '3000', 10),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || 'file:./data/app.sqlite',
  ipSalt: process.env.IP_SALT || 'dev-salt-change-me',
  secretKey: process.env.SECRET_KEY || process.env.IP_SALT || 'dev-salt-change-me',
  secretKeyIsDerived: !process.env.SECRET_KEY,
  secureCookies: bool(process.env.SECURE_COOKIES, String(process.env.APP_URL || '').startsWith('https://')),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    botName: process.env.TELEGRAM_BOT_NAME || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    mode: process.env.TELEGRAM_BOT_TOKEN ? 'real' : 'mock'
  },
  max: {
    token: process.env.MAX_BOT_TOKEN || '',
    botName: process.env.MAX_BOT_NAME || '',
    webhookSecret: process.env.MAX_WEBHOOK_SECRET || '',
    mode: process.env.MAX_BOT_TOKEN ? 'real' : 'mock'
  },
  // Общая CRM только для явно выбранного администратора; выключена без полного конфига.
  crm: {
    token: process.env.CRM_SESSION_BRIDGE_TOKEN || '',
    directorEmail: String(process.env.CRM_DIRECTOR_EMAIL || '').trim().toLowerCase()
  },
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  conversionWorkerMs: parseInt(process.env.CONVERSION_WORKER_MS || '60000', 10),
  invitePoolSize: parseInt(process.env.INVITE_POOL_SIZE || '20', 10),

  // Content OS: сбор трендов и сценарии. Ключи необязательны - без них источник честно пишет, чего не хватает.
  content: {
    collector: bool(process.env.CONTENT_COLLECTOR, true),
    fetchHours: Math.max(1, parseInt(process.env.CONTENT_FETCH_HOURS || '12', 10)),
    // Telegram и VK - чаще: окно последних постов у них короткое, а скорость считается по соседним замерам.
    fastHours: Math.max(1, parseInt(process.env.CONTENT_FAST_HOURS || '2', 10)),
    batch: Math.max(1, parseInt(process.env.CONTENT_BATCH || '20', 10)),
    tgWebBase: process.env.CONTENT_TG_WEB_BASE || 'https://t.me',
    tgProxy: process.env.CONTENT_TG_PROXY || '',
    vkToken: process.env.VK_SERVICE_TOKEN || '',
    youtubeKey: process.env.YOUTUBE_API_KEY || '',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.CONTENT_AI_MODEL || 'claude-opus-5-5'
  }
};

/** Путь к файлу БД из DATABASE_URL. Postgres пока не поддержан — см. docs/deployment.md. */
function dbFile() {
  const url = cfg.databaseUrl;
  if (url.startsWith('file:')) return url.slice(5);
  if (url.startsWith('postgres')) {
    throw new Error('PostgreSQL пока не поддержан этой сборкой. См. docs/deployment.md, раздел «Хранилище».');
  }
  return url;
}

module.exports = { cfg, dbFile, bool };
