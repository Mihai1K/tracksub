'use strict';

/**
 * GET через SOCKS5 без зависимостей. Нужен для Telegram: с сервера в России t.me закрыт,
 * а шлюз HOSTKEY даёт SOCKS-туннель. Настройка: CONTENT_TG_PROXY=socks5://host:port.
 * Поддерживает http и https (TLS поверх туннеля), chunked-ответы, редиректы не ходит.
 */

const net = require('net');
const tls = require('tls');

function parseProxy(s) {
  const m = String(s || '').match(/^socks5h?:\/\/([^:/]+):(\d+)\/?$/);
  if (!m) throw new Error('CONTENT_TG_PROXY: ожидается socks5://host:port');
  return { host: m[1], port: parseInt(m[2], 10) };
}

function socksConnect(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('таймаут SOCKS-прокси')); }, timeoutMs);
    let stage = 0;
    let buf = Buffer.alloc(0);
    sock.on('error', (e) => { clearTimeout(timer); reject(new Error('SOCKS: ' + e.message)); });
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
    sock.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) { clearTimeout(timer); sock.destroy(); reject(new Error('SOCKS: прокси требует авторизацию')); return; }
        buf = buf.slice(2);
        stage = 1;
        const h = Buffer.from(host);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) { clearTimeout(timer); sock.destroy(); reject(new Error('SOCKS: отказ в соединении, код ' + buf[1])); return; }
        const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < len) return;
        clearTimeout(timer);
        sock.removeListener('data', onData);
        resolve(sock);
      }
    });
  });
}

function decodeChunked(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(body.slice(i, nl).toString('latin1'), 16);
    if (!size) break;
    out.push(body.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

async function socksGetText(url, proxyUrl, opts) {
  const o = opts || {};
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const port = parseInt(u.port || (secure ? '443' : '80'), 10);
  const timeoutMs = o.timeoutMs || 20000;
  const raw = await socksConnect(parseProxy(proxyUrl), u.hostname, port, timeoutMs);
  const sock = secure ? tls.connect({ socket: raw, servername: u.hostname }) : raw;
  return new Promise((resolve, reject) => {
    const parts = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('таймаут запроса через прокси')); }, timeoutMs);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('data', (d) => parts.push(d));
    sock.on('end', () => {
      clearTimeout(timer);
      const all = Buffer.concat(parts);
      const sep = all.indexOf('\r\n\r\n');
      if (sep < 0) { reject(new Error('пустой ответ через прокси')); return; }
      const head = all.slice(0, sep).toString('latin1').split('\r\n');
      const status = parseInt((head[0].match(/^HTTP\/1\.[01] (\d{3})/) || [])[1], 10);
      const headers = {};
      for (const line of head.slice(1)) { const k = line.indexOf(':'); if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim(); }
      let body = all.slice(sep + 4);
      if (/chunked/i.test(headers['transfer-encoding'] || '')) body = decodeChunked(body);
      resolve({ status, headers, text: body.toString('utf8') });
    });
    const send = () => sock.write('GET ' + (u.pathname + u.search) + ' HTTP/1.1\r\nHost: ' + u.host +
      '\r\nUser-Agent: ' + (o.userAgent || 'Mozilla/5.0') + '\r\nAccept: text/html\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n');
    if (secure) sock.once('secureConnect', send); else send();
  });
}

/** Обёртка в форме fetch: подставляется сборщику Telegram, остальная логика не меняется. */
function socksFetch(proxyUrl) {
  return async (url, init) => {
    const r = await socksGetText(String(url), proxyUrl, { timeoutMs: 20000, userAgent: init && init.headers && init.headers['user-agent'] });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.text };
  };
}

module.exports = { socksGetText, socksFetch, parseProxy, decodeChunked };
