'use strict';

/**
 * Шифрование чужих токенов в базе (AES-256-GCM).
 * Клиент отдаёт нам OAuth-токен Яндекса — хранить его открытым текстом нельзя:
 * дамп базы не должен означать компрометацию рекламных кабинетов клиентов.
 *
 * Ключ — SECRET_KEY из окружения. Если его нет, ключ выводится из IP_SALT,
 * и это состояние честно сообщается в логе при старте.
 */

const crypto = require('crypto');

const PREFIX = 'enc.v1.';

function keyFrom(secret) {
  return crypto.createHash('sha256').update('token-encryption|' + String(secret || '')).digest();
}

function encrypt(plain, secret) {
  if (plain == null || plain === '') return plain;
  if (String(plain).startsWith(PREFIX)) return plain; // уже зашифровано
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(stored, secret) {
  if (stored == null || stored === '') return stored;
  const s = String(stored);
  if (!s.startsWith(PREFIX)) return s; // значение из старой версии — читаем как есть
  try {
    const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return null; // ключ сменился или данные повреждены — наружу отдаём null, а не мусор
  }
}

function mask(token) {
  const t = String(token || '');
  if (!t) return '';
  return t.length <= 8 ? '••••' : t.slice(0, 3) + '••••' + t.slice(-3);
}

module.exports = { encrypt, decrypt, mask, PREFIX };
