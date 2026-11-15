-- PostgreSQL DDL для перехода с SQLite.
-- ВНИМАНИЕ: не проверен на живой базе. См. docs/deployment.md, раздел «Хранилище».
-- Отличия от SQLite-схемы: типы (TEXT/BIGINT/DOUBLE PRECISION/BOOLEAN), placeholders $1..$n в коде.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  attribution_window_hours INTEGER NOT NULL DEFAULT 72,
  created_at BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  plan TEXT NOT NULL DEFAULT 'free',
  plan_expires_at BIGINT,
  demo_mode BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS workspace_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'owner',
  created_at BIGINT NOT NULL,
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  platform TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  title TEXT,
  username TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  bot_id TEXT,
  bot_name TEXT,
  bot_status TEXT,
  channel_url TEXT,
  connected_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE (platform, external_chat_id)
);
CREATE INDEX IF NOT EXISTS idx_channels_ws ON channels (workspace_id);

CREATE TABLE IF NOT EXISTS tracking_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  slug TEXT NOT NULL UNIQUE,
  source TEXT, campaign TEXT, creative TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT,
  extra_json TEXT,
  platform_target TEXT NOT NULL DEFAULT 'max',
  redirect_mode TEXT NOT NULL DEFAULT 'bot',
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_ws ON tracking_links (workspace_id, is_archived);

CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  tracking_link_id TEXT NOT NULL REFERENCES tracking_links(id),
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts_utc BIGINT NOT NULL,
  ip_hash TEXT, user_agent TEXT, referer TEXT, query_json TEXT,
  device_hint TEXT NOT NULL DEFAULT 'unknown',
  session_id TEXT, invite_link_id TEXT,
  status TEXT NOT NULL DEFAULT 'counted',
  filter_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_channel_ts ON clicks (channel_id, ts_utc);
CREATE INDEX IF NOT EXISTS idx_clicks_ws_ts ON clicks (workspace_id, ts_utc);
CREATE INDEX IF NOT EXISTS idx_clicks_dedup ON clicks (tracking_link_id, ip_hash, user_agent, ts_utc);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  received_at BIGINT NOT NULL,
  transport TEXT NOT NULL,
  headers_json TEXT,
  body_raw TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  processed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events (status, received_at);

CREATE TABLE IF NOT EXISTS platform_events (
  id TEXT PRIMARY KEY,
  raw_event_id TEXT NOT NULL UNIQUE REFERENCES webhook_events(id),
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_chat_id TEXT, external_user_id TEXT,
  ts_utc BIGINT NOT NULL,
  payload TEXT, inviter_id TEXT, admin_id TEXT,
  is_channel BOOLEAN, extra_json TEXT, invite_link TEXT,
  domain_status TEXT NOT NULL DEFAULT 'pending',
  domain_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_pevents_domain ON platform_events (domain_status, ts_utc);

CREATE TABLE IF NOT EXISTS platform_users (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  first_seen_at BIGINT NOT NULL,
  UNIQUE (platform, external_user_id)
);

CREATE TABLE IF NOT EXISTS bot_starts (
  id TEXT PRIMARY KEY,
  platform_event_id TEXT NOT NULL UNIQUE REFERENCES platform_events(id),
  platform_user_id TEXT NOT NULL REFERENCES platform_users(id),
  payload TEXT,
  ts_utc BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_botstarts_user_ts ON bot_starts (platform_user_id, ts_utc);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  workspace_id TEXT,
  platform_user_id TEXT NOT NULL REFERENCES platform_users(id),
  ts_utc BIGINT NOT NULL,
  platform_event_id TEXT NOT NULL UNIQUE REFERENCES platform_events(id),
  status TEXT NOT NULL DEFAULT 'active',
  is_resubscribe BOOLEAN NOT NULL DEFAULT FALSE,
  sequence TEXT NOT NULL DEFAULT 'first',
  ended_at BIGINT, ended_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_subs_channel_user ON subscriptions (channel_id, platform_user_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_ts ON subscriptions (workspace_id, ts_utc);

CREATE TABLE IF NOT EXISTS unsubscriptions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  platform_user_id TEXT NOT NULL REFERENCES platform_users(id),
  subscription_id TEXT REFERENCES subscriptions(id),
  ts_utc BIGINT NOT NULL,
  reason TEXT NOT NULL,
  platform_event_id TEXT NOT NULL UNIQUE REFERENCES platform_events(id)
);
CREATE INDEX IF NOT EXISTS idx_unsubs_channel_user ON unsubscriptions (channel_id, platform_user_id, ts_utc);

CREATE TABLE IF NOT EXISTS attributions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  type TEXT NOT NULL,
  click_id TEXT,
  confidence DOUBLE PRECISION,
  margin DOUBLE PRECISION,
  is_ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
  is_dense BOOLEAN NOT NULL DEFAULT FALSE,
  window_hours INTEGER,
  algo_version TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_attr_sub ON attributions (subscription_id, is_current);
CREATE INDEX IF NOT EXISTS idx_attr_click ON attributions (click_id, is_current);

CREATE TABLE IF NOT EXISTS attribution_candidates (
  id TEXT PRIMARY KEY,
  attribution_id TEXT NOT NULL REFERENCES attributions(id),
  click_id TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  dt_seconds INTEGER NOT NULL,
  rejected_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_cand_attr ON attribution_candidates (attribution_id);

CREATE TABLE IF NOT EXISTS invite_links (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  tracking_link_id TEXT REFERENCES tracking_links(id),
  click_id TEXT,
  platform TEXT NOT NULL,
  external_link TEXT NOT NULL,
  name TEXT,
  mode TEXT NOT NULL DEFAULT 'real',
  status TEXT NOT NULL DEFAULT 'free',
  created_at BIGINT NOT NULL,
  assigned_at BIGINT,
  UNIQUE (channel_id, external_link)
);
CREATE INDEX IF NOT EXISTS idx_invite_pool ON invite_links (channel_id, tracking_link_id, status);

CREATE TABLE IF NOT EXISTS spend_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel_id TEXT REFERENCES channels(id),
  scope_type TEXT NOT NULL, scope_value TEXT NOT NULL,
  day TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_scope ON spend_entries (workspace_id, scope_type, scope_value, day);

CREATE TABLE IF NOT EXISTS ad_platform_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'mock',
  counter_id TEXT, token TEXT, goal_id TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  subscription_id TEXT REFERENCES subscriptions(id),
  attribution_id TEXT REFERENCES attributions(id),
  provider TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  mode TEXT NOT NULL DEFAULT 'mock',
  attempts INTEGER NOT NULL DEFAULT 0,
  external_id TEXT, error TEXT, payload_json TEXT,
  created_at BIGINT NOT NULL, sent_at BIGINT, next_attempt_at BIGINT,
  UNIQUE (subscription_id, provider, kind)
);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversions (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL, channel_id TEXT, day TEXT NOT NULL,
  scope_type TEXT NOT NULL, scope_value TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  subscriptions INTEGER NOT NULL DEFAULT 0,
  unsubscriptions INTEGER NOT NULL DEFAULT 0,
  computed_at BIGINT NOT NULL,
  UNIQUE (workspace_id, channel_id, day, scope_type, scope_value)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT, user_id TEXT,
  action TEXT NOT NULL, target TEXT, meta_json TEXT,
  ts_utc BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_logs (workspace_id, ts_utc);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT
);

CREATE TABLE IF NOT EXISTS product_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT, name TEXT NOT NULL, ts_utc BIGINT NOT NULL, props_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_product_events ON product_events (name, ts_utc);
