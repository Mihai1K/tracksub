'use strict';

/** Нормализация: платформенное сырое событие -> доменно-нейтральная запись. Идемпотентна по raw_event_id. */

const { id } = require('./ids');
const { one, run } = require('./db');

function normalize(db, rawRow, adapter) {
  const existing = one(db, 'SELECT * FROM platform_events WHERE raw_event_id = ?', rawRow.id);
  if (existing) return { event: existing, created: false };

  const update = JSON.parse(rawRow.body_raw); // бросит, если тело невалидно — обработается выше
  const n = adapter.parse(update);

  const eventId = id('pe');
  run(
    db,
    'INSERT INTO platform_events (id, raw_event_id, platform, kind, external_chat_id, external_user_id, ts_utc, ' +
      'payload, inviter_id, admin_id, is_channel, extra_json, invite_link, domain_status) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    eventId,
    rawRow.id,
    n.platform,
    n.kind,
    n.externalChatId,
    n.externalUserId,
    n.tsUtc,
    n.payload,
    n.inviterId,
    n.adminId,
    n.isChannel === null ? null : n.isChannel ? 1 : 0,
    JSON.stringify(n.extra || {}),
    n.inviteLink || null,
    'pending'
  );
  return { event: one(db, 'SELECT * FROM platform_events WHERE id = ?', eventId), created: true };
}

module.exports = { normalize };
