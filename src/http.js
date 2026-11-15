'use strict';

/** Мелочи HTTP: разбор тела и cookie, безопасные заголовки, простой rate limit. */

const crypto = require('crypto');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || 1024 * 512;
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body || '')) out[k] = v;
  return out;
}

function securityHeaders(res, { csp } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', csp ||
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
}

function html(res, code, body, extraHeaders) {
  securityHeaders(res);
  res.writeHead(code, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, extraHeaders || {}));
  res.end(body);
}

function json(res, code, obj) {
  securityHeaders(res);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function redirect(res, location, extraHeaders) {
  securityHeaders(res);
  res.writeHead(302, Object.assign({ location, 'cache-control': 'no-store' }, extraHeaders || {}));
  res.end();
}

function setCookie(name, value, opts) {
  const o = opts || {};
  const parts = [name + '=' + encodeURIComponent(value)];
  parts.push('Path=' + (o.path || '/'));
  parts.push('HttpOnly');
  parts.push('SameSite=' + (o.sameSite || 'Lax'));
  if (o.secure) parts.push('Secure');
  if (o.maxAge != null) parts.push('Max-Age=' + Math.floor(o.maxAge / 1000));
  return parts.join('; ');
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

/** Скользящее окно в памяти. Для MVP достаточно; при масштабировании — вынести в Redis. */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    }
    return { ok: arr.length <= max, remaining: Math.max(0, max - arr.length) };
  };
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || !x.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = {
  esc, parseCookies, readBody, parseForm, html, json, redirect, setCookie,
  clientIp, createRateLimiter, securityHeaders, timingSafeEqual
};
