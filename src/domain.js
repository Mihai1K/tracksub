'use strict';

/**
 * Применение нормализованных событий к доменным фактам.
 * Правила подписок/отписок/повторных подписок — attribution.md §2, §3, §9.
 */

const { id } = require('./ids');
const { one, run } = require('./db');

const RESUBSCRIBE_WINDOW_MS = 7 * 24 * 3600 * 1000; // §9

function upsertPlatformUser(db, platform, externalUserId, tsUtc) {
  const found = one(db, 'SELECT * FROM platform_users WHERE platform = ? AND external_user_id = ?', platform, externalUserId);
  if (found) return found;
  const puId = id('pu');
  run(db, 'INSERT INTO platform_users (id, platform, external_user_id, first_seen_at) VALUES (?, ?, ?, ?)',
    puId, platform, externalUserId, tsUtc);
  return one(db, 'SELECT * FROM platform_users WHERE id = ?', puId);
}

function findChannel(db, platform, externalChatId) {
  return one(db, 'SELECT * FROM channels WHERE platform = ? AND external_chat_id = ?', platform, externalChatId);
}

function setDomain(db, eventId, status, note) {
  run(db, 'UPDATE platform_events SET domain_status = ?, domain_note = ? WHERE id = ?', status, note || null, eventId);
}

function apply(db, event) {
  if (event.domain_status === 'applied' || event.domain_status === 'ignored') {
    return { action: 'already_processed' };
  }

  if (event.kind === 'bot_start') {
    const user = upsertPlatformUser(db, event.platform, event.external_user_id, event.ts_utc);
    const bsId = id('bs');
    run(db, 'INSERT INTO bot_starts (id, platform_event_id, platform_user_id, payload, ts_utc) VALUES (?, ?, ?, ?, ?)',
      bsId, event.id, user.id, event.payload, event.ts_utc);
    setDomain(db, event.id, 'applied', event.payload ? 'bot_start with payload' : 'bot_start without payload');
    return { action: 'bot_start', botStartId: bsId, hasPayload: !!event.payload };
  }

  if (event.kind === 'subscribe') {
    if (event.is_channel !== 1) {
      setDomain(db, event.id, 'ignored', 'not a channel');
      return { action: 'ignored', reason: 'not_a_channel' };
    }
    const channel = findChannel(db, event.platform, event.external_chat_id);
    if (!channel) {
      setDomain(db, event.id, 'ignored', 'channel not connected');
      return { action: 'ignored', reason: 'unknown_channel' };
    }
    const user = upsertPlatformUser(db, event.platform, event.external_user_id, event.ts_utc);

    const active = one(db,
      'SELECT * FROM subscriptions WHERE channel_id = ? AND platform_user_id = ? AND status = \'active\'',
      channel.id, user.id);
    if (active) {
      // §9: повторное user_added при живой подписке — дубль на уровне домена
      setDomain(db, event.id, 'ignored', 'active subscription already exists');
      return { action: 'ignored', reason: 'duplicate_active_subscription', subscriptionId: active.id };
    }

    const lastLeft = one(db,
      'SELECT * FROM unsubscriptions WHERE channel_id = ? AND platform_user_id = ? AND reason = \'left\' ' +
      'ORDER BY ts_utc DESC LIMIT 1',
      channel.id, user.id);
    const hadAny = one(db,
      'SELECT id FROM subscriptions WHERE channel_id = ? AND platform_user_id = ? LIMIT 1', channel.id, user.id);
    const isResub = !!(lastLeft && event.ts_utc - lastLeft.ts_utc < RESUBSCRIBE_WINDOW_MS);
    // first — человека здесь ещё не было; repeat — вернулся быстро; reactivation — вернулся спустя время
    const sequence = !hadAny ? 'first' : (isResub ? 'repeat' : 'reactivation');

    const subId = id('sub');
    run(db,
      'INSERT INTO subscriptions (id, channel_id, platform_user_id, ts_utc, platform_event_id, status, ' +
      'is_resubscribe, sequence, workspace_id) VALUES (?, ?, ?, ?, ?, \'active\', ?, ?, ?)',
      subId, channel.id, user.id, event.ts_utc, event.id, isResub ? 1 : 0, sequence, channel.workspace_id);
    setDomain(db, event.id, 'applied', 'subscription: ' + sequence);
    return { action: 'subscribe', subscriptionId: subId, isResubscribe: isResub, sequence: sequence };
  }

  if (event.kind === 'unsubscribe') {
    if (event.is_channel !== 1) {
      setDomain(db, event.id, 'ignored', 'not a channel');
      return { action: 'ignored', reason: 'not_a_channel' };
    }
    const channel = findChannel(db, event.platform, event.external_chat_id);
    if (!channel) {
      setDomain(db, event.id, 'ignored', 'channel not connected');
      return { action: 'ignored', reason: 'unknown_channel' };
    }
    const user = upsertPlatformUser(db, event.platform, event.external_user_id, event.ts_utc);
    // §3: admin_id = null -> ушёл сам; иначе удалён администратором
    const reason = event.admin_id ? 'removed' : 'left';

    const active = one(db,
      'SELECT * FROM subscriptions WHERE channel_id = ? AND platform_user_id = ? AND status = \'active\' ' +
      'ORDER BY ts_utc DESC LIMIT 1',
      channel.id, user.id);

    const unsubId = id('unsub');
    run(db,
      'INSERT INTO unsubscriptions (id, channel_id, platform_user_id, subscription_id, ts_utc, reason, platform_event_id) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
      unsubId, channel.id, user.id, active ? active.id : null, event.ts_utc, reason, event.id);
    if (active) {
      run(db, 'UPDATE subscriptions SET status = \'ended\', ended_at = ?, ended_reason = ? WHERE id = ?',
        event.ts_utc, reason, active.id);
    }
    setDomain(db, event.id, 'applied', 'unsubscribe: ' + reason + (active ? '' : ' (no active subscription found)'));
    return { action: 'unsubscribe', unsubscriptionId: unsubId, reason: reason, subscriptionId: active ? active.id : null };
  }

  setDomain(db, event.id, 'ignored', 'kind not used by domain: ' + event.kind);
  return { action: 'ignored', reason: 'irrelevant_kind' };
}

module.exports = { apply, upsertPlatformUser, findChannel, RESUBSCRIBE_WINDOW_MS };
