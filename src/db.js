'use strict';

/**
 * Хранилище. node:sqlite (Node 22.5+), без внешних зависимостей.
 * Схема — из architecture.md «Данные (ядро)». Всё время хранится в UTC, epoch ms.
 */

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',

  // --- конфигурация рабочего пространства -----------------------------------
  'CREATE TABLE IF NOT EXISTS workspaces (' +
    'id TEXT PRIMARY KEY,' +
    'name TEXT NOT NULL,' +
    'timezone TEXT NOT NULL DEFAULT \'Europe/Moscow\',' +
    'attribution_window_hours INTEGER NOT NULL DEFAULT 72,' +
    'created_at INTEGER NOT NULL)',

  'CREATE TABLE IF NOT EXISTS channels (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'platform TEXT NOT NULL,' +
    'external_chat_id TEXT NOT NULL,' +
    'title TEXT,' +
    'created_at INTEGER NOT NULL,' +
    'UNIQUE (platform, external_chat_id))',

  'CREATE TABLE IF NOT EXISTS tracking_links (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'channel_id TEXT NOT NULL REFERENCES channels(id),' +
    'slug TEXT NOT NULL UNIQUE,' +
    'source TEXT,' +
    'campaign TEXT,' +
    'creative TEXT,' +
    'platform_target TEXT NOT NULL DEFAULT \'max\',' +
    'redirect_mode TEXT NOT NULL DEFAULT \'bot\',' +
    'created_at INTEGER NOT NULL)',

  // --- трекинг ---------------------------------------------------------------
  'CREATE TABLE IF NOT EXISTS clicks (' +
    'id TEXT PRIMARY KEY,' +
    'tracking_link_id TEXT NOT NULL REFERENCES tracking_links(id),' +
    'workspace_id TEXT NOT NULL,' +
    'channel_id TEXT NOT NULL,' +
    'ts_utc INTEGER NOT NULL,' +
    'ip_hash TEXT,' +
    'user_agent TEXT,' +
    'referer TEXT,' +
    'query_json TEXT,' +
    'device_hint TEXT NOT NULL DEFAULT \'unknown\',' +
    'status TEXT NOT NULL DEFAULT \'counted\',' +
    'filter_reason TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_clicks_channel_ts ON clicks (channel_id, ts_utc)',
  'CREATE INDEX IF NOT EXISTS idx_clicks_dedup ON clicks (tracking_link_id, ip_hash, user_agent, ts_utc)',

  // --- вход: сырые события (system of record, не удаляются никогда) ----------
  'CREATE TABLE IF NOT EXISTS webhook_events (' +
    'id TEXT PRIMARY KEY,' +
    'received_at INTEGER NOT NULL,' +
    'transport TEXT NOT NULL,' +
    'headers_json TEXT,' +
    'body_raw TEXT NOT NULL,' +
    'idempotency_key TEXT NOT NULL UNIQUE,' +
    'status TEXT NOT NULL DEFAULT \'received\',' +
    'error TEXT,' +
    'attempts INTEGER NOT NULL DEFAULT 0,' +
    'processed_at INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events (status, received_at)',

  // --- нормализованные платформенно-нейтральные события ----------------------
  'CREATE TABLE IF NOT EXISTS platform_events (' +
    'id TEXT PRIMARY KEY,' +
    'raw_event_id TEXT NOT NULL UNIQUE REFERENCES webhook_events(id),' +
    'platform TEXT NOT NULL,' +
    'kind TEXT NOT NULL,' +
    'external_chat_id TEXT,' +
    'external_user_id TEXT,' +
    'ts_utc INTEGER NOT NULL,' +
    'payload TEXT,' +
    'inviter_id TEXT,' +
    'admin_id TEXT,' +
    'is_channel INTEGER,' +
    'extra_json TEXT,' +
    'domain_status TEXT NOT NULL DEFAULT \'pending\',' +
    'domain_note TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_pevents_domain ON platform_events (domain_status, ts_utc)',

  'CREATE TABLE IF NOT EXISTS platform_users (' +
    'id TEXT PRIMARY KEY,' +
    'platform TEXT NOT NULL,' +
    'external_user_id TEXT NOT NULL,' +
    'first_seen_at INTEGER NOT NULL,' +
    'UNIQUE (platform, external_user_id))',

  // --- доменные факты --------------------------------------------------------
  'CREATE TABLE IF NOT EXISTS bot_starts (' +
    'id TEXT PRIMARY KEY,' +
    'platform_event_id TEXT NOT NULL UNIQUE REFERENCES platform_events(id),' +
    'platform_user_id TEXT NOT NULL REFERENCES platform_users(id),' +
    'payload TEXT,' +
    'ts_utc INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_botstarts_user_ts ON bot_starts (platform_user_id, ts_utc)',

  'CREATE TABLE IF NOT EXISTS subscriptions (' +
    'id TEXT PRIMARY KEY,' +
    'channel_id TEXT NOT NULL REFERENCES channels(id),' +
    'platform_user_id TEXT NOT NULL REFERENCES platform_users(id),' +
    'ts_utc INTEGER NOT NULL,' +
    'platform_event_id TEXT NOT NULL UNIQUE REFERENCES platform_events(id),' +
    'status TEXT NOT NULL DEFAULT \'active\',' +
    'is_resubscribe INTEGER NOT NULL DEFAULT 0,' +
    'ended_at INTEGER,' +
    'ended_reason TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_subs_channel_user ON subscriptions (channel_id, platform_user_id, status)',

  'CREATE TABLE IF NOT EXISTS unsubscriptions (' +
    'id TEXT PRIMARY KEY,' +
    'channel_id TEXT NOT NULL REFERENCES channels(id),' +
    'platform_user_id TEXT NOT NULL REFERENCES platform_users(id),' +
    'subscription_id TEXT REFERENCES subscriptions(id),' +
    'ts_utc INTEGER NOT NULL,' +
    'reason TEXT NOT NULL,' +
    'platform_event_id TEXT NOT NULL UNIQUE REFERENCES platform_events(id))',
  'CREATE INDEX IF NOT EXISTS idx_unsubs_channel_user ON unsubscriptions (channel_id, platform_user_id, ts_utc)',

  // --- атрибуция: отдельный версионируемый слой ------------------------------
  'CREATE TABLE IF NOT EXISTS attributions (' +
    'id TEXT PRIMARY KEY,' +
    'subscription_id TEXT NOT NULL REFERENCES subscriptions(id),' +
    'type TEXT NOT NULL,' +
    'click_id TEXT,' +
    'confidence REAL,' +
    'margin REAL,' +
    'is_ambiguous INTEGER NOT NULL DEFAULT 0,' +
    'is_dense INTEGER NOT NULL DEFAULT 0,' +
    'window_hours INTEGER,' +
    'algo_version TEXT NOT NULL,' +
    'created_at INTEGER NOT NULL,' +
    'is_current INTEGER NOT NULL DEFAULT 1)',
  'CREATE INDEX IF NOT EXISTS idx_attr_sub ON attributions (subscription_id, is_current)',
  'CREATE INDEX IF NOT EXISTS idx_attr_click ON attributions (click_id, is_current)',

  'CREATE TABLE IF NOT EXISTS attribution_candidates (' +
    'id TEXT PRIMARY KEY,' +
    'attribution_id TEXT NOT NULL REFERENCES attributions(id),' +
    'click_id TEXT NOT NULL,' +
    'score REAL NOT NULL,' +
    'dt_seconds INTEGER NOT NULL,' +
    'rejected_reason TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_cand_attr ON attribution_candidates (attribution_id)',

  // --- продуктовая аналитика воронки (протокол §10) --------------------------
  'CREATE TABLE IF NOT EXISTS product_events (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT,' +
    'name TEXT NOT NULL,' +
    'ts_utc INTEGER NOT NULL,' +
    'props_json TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_product_events ON product_events (name, ts_utc)',
// --- аккаунты и доступ -----------------------------------------------------
  'CREATE TABLE IF NOT EXISTS users (' +
    'id TEXT PRIMARY KEY,' +
    'email TEXT NOT NULL UNIQUE,' +
    'password_hash TEXT NOT NULL,' +
    'is_admin INTEGER NOT NULL DEFAULT 0,' +
    'created_at INTEGER NOT NULL,' +
    'last_login_at INTEGER)',

  'CREATE TABLE IF NOT EXISTS sessions (' +
    'id TEXT PRIMARY KEY,' +
    'user_id TEXT NOT NULL REFERENCES users(id),' +
    'csrf TEXT NOT NULL,' +
    'created_at INTEGER NOT NULL,' +
    'expires_at INTEGER NOT NULL,' +
    'ip_hash TEXT,' +
    'user_agent TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at)',

  'CREATE TABLE IF NOT EXISTS password_resets (' +
    'id TEXT PRIMARY KEY,' +
    'user_id TEXT NOT NULL REFERENCES users(id),' +
    'token_hash TEXT NOT NULL UNIQUE,' +
    'created_at INTEGER NOT NULL,' +
    'expires_at INTEGER NOT NULL,' +
    'used_at INTEGER)',

  'CREATE TABLE IF NOT EXISTS workspace_members (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'user_id TEXT NOT NULL REFERENCES users(id),' +
    'role TEXT NOT NULL DEFAULT \'owner\',' +
    'created_at INTEGER NOT NULL,' +
    'UNIQUE (workspace_id, user_id))',

  // --- пригласительные ссылки платформ (детерминированная атрибуция Telegram) --
  'CREATE TABLE IF NOT EXISTS invite_links (' +
    'id TEXT PRIMARY KEY,' +
    'channel_id TEXT NOT NULL REFERENCES channels(id),' +
    'tracking_link_id TEXT REFERENCES tracking_links(id),' +
    'click_id TEXT,' +
    'platform TEXT NOT NULL,' +
    'external_link TEXT NOT NULL,' +
    'name TEXT,' +
    'mode TEXT NOT NULL DEFAULT \'real\',' +
    'status TEXT NOT NULL DEFAULT \'free\',' +
    'created_at INTEGER NOT NULL,' +
    'assigned_at INTEGER,' +
    'UNIQUE (channel_id, external_link))',
  'CREATE INDEX IF NOT EXISTS idx_invite_pool ON invite_links (channel_id, tracking_link_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_invite_click ON invite_links (click_id)',

  // --- расходы (вводятся вручную в MVP) --------------------------------------
  'CREATE TABLE IF NOT EXISTS spend_entries (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'channel_id TEXT REFERENCES channels(id),' +
    'scope_type TEXT NOT NULL,' +
    'scope_value TEXT NOT NULL,' +
    'day TEXT NOT NULL,' +
    'amount REAL NOT NULL,' +
    'currency TEXT NOT NULL DEFAULT \'RUB\',' +
    'created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_spend_scope ON spend_entries (workspace_id, scope_type, scope_value, day)',

  // --- выгрузка конверсий ----------------------------------------------------
  'CREATE TABLE IF NOT EXISTS ad_platform_credentials (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'provider TEXT NOT NULL,' +
    'mode TEXT NOT NULL DEFAULT \'mock\',' +
    'counter_id TEXT,' +
    'token TEXT,' +
    'goal_id TEXT,' +
    'created_at INTEGER NOT NULL,' +
    'UNIQUE (workspace_id, provider))',

  'CREATE TABLE IF NOT EXISTS conversions (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'subscription_id TEXT REFERENCES subscriptions(id),' +
    'attribution_id TEXT REFERENCES attributions(id),' +
    'provider TEXT NOT NULL,' +
    'kind TEXT NOT NULL,' +
    'status TEXT NOT NULL DEFAULT \'pending\',' +
    'mode TEXT NOT NULL DEFAULT \'mock\',' +
    'attempts INTEGER NOT NULL DEFAULT 0,' +
    'external_id TEXT,' +
    'error TEXT,' +
    'payload_json TEXT,' +
    'created_at INTEGER NOT NULL,' +
    'sent_at INTEGER,' +
    'next_attempt_at INTEGER,' +
    'UNIQUE (subscription_id, provider, kind))',
  'CREATE INDEX IF NOT EXISTS idx_conv_status ON conversions (status, next_attempt_at)',

  // --- витрина и аудит -------------------------------------------------------
  'CREATE TABLE IF NOT EXISTS daily_metrics (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL,' +
    'channel_id TEXT,' +
    'day TEXT NOT NULL,' +
    'scope_type TEXT NOT NULL,' +
    'scope_value TEXT NOT NULL,' +
    'clicks INTEGER NOT NULL DEFAULT 0,' +
    'subscriptions INTEGER NOT NULL DEFAULT 0,' +
    'unsubscriptions INTEGER NOT NULL DEFAULT 0,' +
    'computed_at INTEGER NOT NULL,' +
    'UNIQUE (workspace_id, channel_id, day, scope_type, scope_value))',

  'CREATE TABLE IF NOT EXISTS audit_logs (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT,' +
    'user_id TEXT,' +
    'action TEXT NOT NULL,' +
    'target TEXT,' +
    'meta_json TEXT,' +
    'ts_utc INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_logs (workspace_id, ts_utc)',

  // --- Content OS: тренды → идеи → сценарии ----------------------------------
  // Отдельные таблицы с префиксом content_: атрибуцию и её данные не трогают.
  'CREATE TABLE IF NOT EXISTS content_settings (' +
    'workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),' +
    'author TEXT NOT NULL DEFAULT \'\',' +
    'audience TEXT NOT NULL DEFAULT \'\',' +
    'topics TEXT NOT NULL DEFAULT \'\',' +
    'tone TEXT NOT NULL DEFAULT \'\',' +
    'cta TEXT NOT NULL DEFAULT \'\',' +
    'updated_at INTEGER NOT NULL)',

  'CREATE TABLE IF NOT EXISTS content_sources (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'platform TEXT NOT NULL,' +          // telegram | vk | youtube
    'kind TEXT NOT NULL,' +              // channel | search | trending
    'handle TEXT NOT NULL,' +            // username канала/паблика или поисковый запрос
    'title TEXT,' +
    'niche TEXT NOT NULL DEFAULT \'\',' +
    'subscribers INTEGER,' +
    'is_active INTEGER NOT NULL DEFAULT 1,' +
    'last_fetch_at INTEGER,' +
    'last_success_at INTEGER,' +
    'last_error TEXT,' +
    'last_count INTEGER NOT NULL DEFAULT 0,' +
    'created_at INTEGER NOT NULL,' +
    'UNIQUE (workspace_id, platform, kind, handle))',

  'CREATE TABLE IF NOT EXISTS content_items (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'source_id TEXT REFERENCES content_sources(id) ON DELETE SET NULL,' +
    'provider TEXT NOT NULL,' +          // telegram | vk | youtube | vidiq | virale | manual
    'platform TEXT NOT NULL,' +          // где опубликован оригинал
    'url TEXT NOT NULL,' +
    'author TEXT,' +
    'title TEXT,' +
    'body TEXT,' +
    'published_at INTEGER,' +
    'views INTEGER,' +
    'likes INTEGER,' +
    'comments INTEGER,' +
    'shares INTEGER,' +
    'author_subscribers INTEGER,' +
    'provider_score REAL,' +             // оценка поставщика (vidIQ outlier и т.п.), как есть
    'outlier REAL,' +                    // просмотры / медиана источника; NULL = мало данных
    'er REAL,' +                         // (реакции + комментарии + репосты) / просмотры
    'score REAL,' +
    'score_note TEXT,' +
    'status TEXT NOT NULL DEFAULT \'new\',' + // new | picked | archived
    'notes TEXT NOT NULL DEFAULT \'\',' +
    'observed_at INTEGER NOT NULL,' +
    'created_at INTEGER NOT NULL,' +
    'UNIQUE (workspace_id, url))',
  'CREATE INDEX IF NOT EXISTS idx_content_items_feed ON content_items (workspace_id, status, score)',
  'CREATE INDEX IF NOT EXISTS idx_content_items_source ON content_items (source_id, published_at)',

  'CREATE TABLE IF NOT EXISTS content_scripts (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'item_id TEXT REFERENCES content_items(id) ON DELETE SET NULL,' +
    'title TEXT NOT NULL,' +
    'format TEXT NOT NULL DEFAULT \'short\',' + // short | long
    'hooks TEXT NOT NULL DEFAULT \'\',' +       // три варианта хука, по строке
    'body TEXT NOT NULL DEFAULT \'\',' +
    'shot_list TEXT NOT NULL DEFAULT \'\',' +
    'cta TEXT NOT NULL DEFAULT \'\',' +
    'generator TEXT NOT NULL DEFAULT \'template\',' + // template | llm | manual
    'status TEXT NOT NULL DEFAULT \'draft\',' +       // draft | approved | shot | published
    'shoot_date TEXT,' +
    'published_url TEXT,' +
    'created_at INTEGER NOT NULL,' +
    'updated_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_content_scripts_ws ON content_scripts (workspace_id, status, updated_at)',

  // История замеров: один ряд - один снимок метрик поста. Повтор того же момента игнорируется.
  'CREATE TABLE IF NOT EXISTS content_snapshots (' +
    'item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,' +
    'observed_at INTEGER NOT NULL,' +
    'views INTEGER,' +
    'likes INTEGER,' +
    'comments INTEGER,' +
    'shares INTEGER,' +
    'PRIMARY KEY (item_id, observed_at))',

  // Темы: посты разных источников об одном событии. Пост - максимум в одной теме.
  'CREATE TABLE IF NOT EXISTS content_topics (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'title TEXT NOT NULL DEFAULT \'\',' +
    'primary_item_id TEXT,' +
    'first_seen_at INTEGER NOT NULL,' +
    'last_seen_at INTEGER NOT NULL,' +
    'items_count INTEGER NOT NULL DEFAULT 0,' +
    'sources_count INTEGER NOT NULL DEFAULT 0,' +
    'platforms TEXT NOT NULL DEFAULT \'\',' +
    'views_sum INTEGER NOT NULL DEFAULT 0,' +
    'velocity_sum REAL,' +
    'max_ratio REAL,' +
    'heat REAL NOT NULL DEFAULT 0,' +
    'status TEXT NOT NULL DEFAULT \'active\',' +
    'created_at INTEGER NOT NULL,' +
    'updated_at INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_content_topics_ws ON content_topics (workspace_id, status, last_seen_at)',
  'CREATE TABLE IF NOT EXISTS content_topic_items (' +
    'topic_id TEXT NOT NULL REFERENCES content_topics(id) ON DELETE CASCADE,' +
    'item_id TEXT NOT NULL UNIQUE REFERENCES content_items(id) ON DELETE CASCADE,' +
    'similarity REAL,' +
    'added_by TEXT NOT NULL DEFAULT \'auto\',' +
    'created_at INTEGER NOT NULL,' +
    'PRIMARY KEY (topic_id, item_id))',
  // «Это другая тема»: запрет автоматически возвращать пост в тему.
  'CREATE TABLE IF NOT EXISTS content_topic_splits (' +
    'topic_id TEXT NOT NULL,' +
    'item_id TEXT NOT NULL,' +
    'created_at INTEGER NOT NULL,' +
    'PRIMARY KEY (topic_id, item_id))',

  // Релевантность: выученные на 👍/👎 веса слов и журнал действий пользователя.
  'CREATE TABLE IF NOT EXISTS content_interest_terms (' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'term TEXT NOT NULL,' +
    'weight REAL NOT NULL,' +
    'updated_at INTEGER NOT NULL,' +
    'PRIMARY KEY (workspace_id, term))',
  'CREATE TABLE IF NOT EXISTS content_events (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'workspace_id TEXT NOT NULL,' +
    'item_id TEXT,' +
    'topic_id TEXT,' +
    'kind TEXT NOT NULL,' +              // open | favorite | unfavorite | script | archive | rate_up | rate_down | publish
    'at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_content_events_ws ON content_events (workspace_id, at)',

  // Свои публикации по сценариям и их метрики во времени.
  'CREATE TABLE IF NOT EXISTS content_publications (' +
    'id TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'script_id TEXT NOT NULL REFERENCES content_scripts(id) ON DELETE CASCADE,' +
    'platform TEXT NOT NULL,' +
    'url TEXT NOT NULL,' +
    'published_at INTEGER NOT NULL,' +
    'hook_index INTEGER,' +              // 1-3 - хук из сценария, 0 - свой
    'hook_text TEXT,' +
    'auto INTEGER NOT NULL DEFAULT 0,' + // метрики собираются сами
    'last_error TEXT,' +
    'created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_content_publications_ws ON content_publications (workspace_id, published_at)',
  'CREATE TABLE IF NOT EXISTS content_publication_metrics (' +
    'publication_id TEXT NOT NULL REFERENCES content_publications(id) ON DELETE CASCADE,' +
    'observed_at INTEGER NOT NULL,' +
    'views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER, clicks INTEGER, leads INTEGER,' +
    'source TEXT NOT NULL DEFAULT \'manual\',' +
    'PRIMARY KEY (publication_id, observed_at))',

  // Telegram-сводка и алерты: подписки чатов на пространство, одноразовые коды привязки, журнал отправок.
  'CREATE TABLE IF NOT EXISTS content_subscriptions (' +
    'workspace_id TEXT NOT NULL REFERENCES workspaces(id),' +
    'chat_id TEXT NOT NULL,' +
    'user_id TEXT,' +
    'digest_on INTEGER NOT NULL DEFAULT 1,' +
    'alerts_on INTEGER NOT NULL DEFAULT 1,' +
    'digest_hour INTEGER NOT NULL DEFAULT 9,' + // час по Москве
    'created_at INTEGER NOT NULL,' +
    'PRIMARY KEY (workspace_id, chat_id))',
  'CREATE TABLE IF NOT EXISTS content_link_codes (' +
    'code TEXT PRIMARY KEY,' +
    'workspace_id TEXT NOT NULL,' +
    'user_id TEXT,' +
    'expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS content_notifications (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'workspace_id TEXT NOT NULL,' +
    'chat_id TEXT NOT NULL,' +
    'kind TEXT NOT NULL,' +              // digest | alert | test
    'ref TEXT NOT NULL,' +
    'status TEXT NOT NULL,' +            // sent | failed
    'error TEXT,' +
    'sent_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_content_notifications_ref ON content_notifications (chat_id, workspace_id, ref)'
];

/** Добавочные колонки: таблицы создаются с IF NOT EXISTS, поэтому новые поля доезжают так. */
const COLUMNS = [
  ['workspaces', 'currency', 'TEXT NOT NULL DEFAULT \'RUB\''],
  ['workspaces', 'plan', 'TEXT NOT NULL DEFAULT \'free\''],
  ['workspaces', 'plan_expires_at', 'INTEGER'],
  ['workspaces', 'demo_mode', 'INTEGER NOT NULL DEFAULT 0'],
  ['workspaces', 'created_by', 'TEXT'],
  ['channels', 'username', 'TEXT'],
  ['channels', 'status', 'TEXT NOT NULL DEFAULT \'pending\''],
  ['channels', 'bot_id', 'TEXT'],
  ['channels', 'bot_name', 'TEXT'],
  ['channels', 'bot_status', 'TEXT'],
  ['channels', 'connected_at', 'INTEGER'],
  ['channels', 'channel_url', 'TEXT'],
  ['channels', 'claim_token', 'TEXT'],
  ['channels', 'added_by_telegram_id', 'TEXT'],
  ['channels', 'claimed_at', 'INTEGER'],
  ['workspaces', 'is_system', 'INTEGER NOT NULL DEFAULT 0'],
  ['tracking_links', 'utm_source', 'TEXT'],
  ['tracking_links', 'utm_medium', 'TEXT'],
  ['tracking_links', 'utm_campaign', 'TEXT'],
  ['tracking_links', 'utm_content', 'TEXT'],
  ['tracking_links', 'extra_json', 'TEXT'],
  ['tracking_links', 'is_archived', 'INTEGER NOT NULL DEFAULT 0'],
  ['clicks', 'session_id', 'TEXT'],
  ['platform_events', 'invite_link', 'TEXT'],
  ['webhook_events', 'platform', 'TEXT'],
  ['clicks', 'invite_link_id', 'TEXT'],
  ['subscriptions', 'sequence', 'TEXT NOT NULL DEFAULT \'first\''],
  ['subscriptions', 'workspace_id', 'TEXT'],
  ['tracking_links', 'landing_mode', 'TEXT NOT NULL DEFAULT \'redirect\''],
  ['content_items', 'velocity', 'REAL'],
  ['content_items', 'velocity_kind', 'TEXT'],
  ['content_items', 'velocity_peak', 'REAL'],
  ['content_items', 'velocity_ratio', 'REAL'],
  ['content_items', 'delta_views', 'INTEGER'],
  ['content_items', 'delta_hours', 'REAL'],
  ['content_items', 'trend', 'TEXT'],
  ['content_items', 'velocity_note', 'TEXT'],
  ['content_items', 'relevance', 'REAL'],
  ['content_items', 'relevance_label', 'TEXT'],
  ['content_items', 'relevance_why', 'TEXT'],
  ['content_items', 'relevance_by', 'TEXT'],
  ['content_topics', 'relevance', 'REAL'],
  ['content_settings', 'stop_topics', 'TEXT'],
  ['content_scripts', 'topic_id', 'TEXT']
];

function migrateColumns(db) {
  for (const [table, column, ddl] of COLUMNS) {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
    if (!cols.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl);
  }
}

/**
 * Один чат — один ряд в channels. Индекс ставим после миграции колонок и мягко:
 * если в старой базе уже лежат дубликаты, запуск важнее ограничения — иначе сервис
 * не поднимется и перестанет принимать вебхуки. Запись всё равно проверяется в коде.
 */
function uniqueChannels(db) {
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_chat ON channels (platform, external_chat_id)');
    return true;
  } catch (e) {
    return false;
  }
}

function open(file) {
  const db = new DatabaseSync(file || ':memory:');
  for (const stmt of SCHEMA) db.exec(stmt);
  migrateColumns(db);
  uniqueChannels(db);
  return db;
}

/** Транзакция. node:sqlite синхронный, поэтому обычный try/catch. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const all = (db, sql, ...args) => db.prepare(sql).all(...args);
const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const run = (db, sql, ...args) => db.prepare(sql).run(...args);

module.exports = {
  uniqueChannels, open, tx, all, one, run, SCHEMA, COLUMNS, migrateColumns };
