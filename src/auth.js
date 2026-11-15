'use strict';

/** Аутентификация: пароли (scrypt), сессии в БД, CSRF, сброс пароля. Без зависимостей. */

const crypto = require('crypto');
const { id, hashIp } = require('./ids');
const { one, run } = require('./db');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return 'scrypt$' + salt.toString('base64') + '$' + key.toString('base64');
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltB64, keyB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, SCRYPT);
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Пароль должен быть не короче 8 символов';
  if (!/[a-zA-Zа-яА-Я]/.test(p) || !/[0-9]/.test(p)) return 'Пароль должен содержать буквы и цифры';
  return null;
}

function createUser(db, { email, password, isAdmin }) {
  const mail = normalizeEmail(email);
  if (!validateEmail(mail)) throw new Error('Некорректный адрес почты');
  const pwdError = validatePassword(password);
  if (pwdError) throw new Error(pwdError);
  if (one(db, 'SELECT id FROM users WHERE email = ?', mail)) throw new Error('Такая почта уже зарегистрирована');

  const userId = id('u');
  run(db, 'INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, mail, hashPassword(password), isAdmin ? 1 : 0, Date.now());
  return one(db, 'SELECT * FROM users WHERE id = ?', userId);
}

function authenticate(db, email, password) {
  const user = one(db, 'SELECT * FROM users WHERE email = ?', normalizeEmail(email));
  if (!user) {
    crypto.scryptSync('dummy', 'dummysalt', 64, SCRYPT); // выравниваем время ответа
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) return null;
  run(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
  return user;
}

function createSession(db, userId, { ip, userAgent, ipSalt }) {
  const sid = crypto.randomBytes(24).toString('base64url');
  const csrf = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  run(db, 'INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sid, userId, csrf, now, now + SESSION_TTL_MS, hashIp(ip || '', ipSalt || 'salt'), String(userAgent || '').slice(0, 200));
  return { id: sid, csrf };
}

function getSession(db, sid) {
  if (!sid) return null;
  const s = one(db, 'SELECT * FROM sessions WHERE id = ?', sid);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    run(db, 'DELETE FROM sessions WHERE id = ?', sid);
    return null;
  }
  const user = one(db, 'SELECT * FROM users WHERE id = ?', s.user_id);
  if (!user) return null;
  return { session: s, user };
}

function destroySession(db, sid) {
  if (sid) run(db, 'DELETE FROM sessions WHERE id = ?', sid);
}

/** Возвращает токен в открытом виде: он показывается один раз и не хранится. */
function createPasswordReset(db, email) {
  const user = one(db, 'SELECT * FROM users WHERE email = ?', normalizeEmail(email));
  if (!user) return null; // наружу не сообщаем, существует ли адрес
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  run(db, 'INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    id('pr'), user.id, crypto.createHash('sha256').update(token).digest('hex'), now, now + RESET_TTL_MS);
  return { token, user };
}

function consumePasswordReset(db, token, newPassword) {
  const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const row = one(db, 'SELECT * FROM password_resets WHERE token_hash = ?', hash);
  if (!row) return { ok: false, error: 'Ссылка недействительна' };
  if (row.used_at) return { ok: false, error: 'Ссылка уже использована' };
  if (row.expires_at < Date.now()) return { ok: false, error: 'Срок действия ссылки истёк' };
  const pwdError = validatePassword(newPassword);
  if (pwdError) return { ok: false, error: pwdError };

  run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), row.user_id);
  run(db, 'UPDATE password_resets SET used_at = ? WHERE id = ?', Date.now(), row.id);
  run(db, 'DELETE FROM sessions WHERE user_id = ?', row.user_id); // сброс пароля гасит все сессии
  return { ok: true, userId: row.user_id };
}

module.exports = {
  hashPassword, verifyPassword, createUser, authenticate,
  createSession, getSession, destroySession,
  createPasswordReset, consumePasswordReset,
  validateEmail, validatePassword, normalizeEmail, SESSION_TTL_MS
};
