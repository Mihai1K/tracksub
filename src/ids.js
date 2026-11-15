'use strict';

/** Генерация идентификаторов и ключей. Ноль зависимостей. */

const crypto = require('crypto');

const CLICK_ID_LEN = 16; // помещается в payload диплинка MAX (лимит 128, FACT)

function clickId() {
  return crypto.randomBytes(12).toString('base64url').slice(0, CLICK_ID_LEN);
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('base64url');
}

function hashIp(ip, salt) {
  return crypto.createHash('sha256').update(String(salt) + '|' + String(ip)).digest('hex').slice(0, 24);
}

/**
 * Синтетический ключ идемпотентности: собственного event id платформа не отдаёт (UNKNOWN,
 * см. max-api-findings.md). Состав ключа зафиксирован в attribution.md §11.
 */
function idempotencyKey(update) {
  const payload = update && update.payload != null ? String(update.payload) : '';
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  const parts = [
    update && update.update_type,
    update && update.chat_id,
    update && update.user && update.user.user_id,
    update && update.timestamp,
    payloadHash
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = { clickId, id, hashIp, idempotencyKey, CLICK_ID_LEN };
