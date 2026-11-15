'use strict';

/** HTTP-слой: маршруты, сессии, редирект, вебхуки, интерфейс. */

const http = require('http');
const { URL } = require('url');

const { open, one, all, run } = require('./db');
const H = require('./http');
const V = require('./views');
const auth = require('./auth');
const crmBridge = require('./crmBridge');
const accounts = require('./accounts');
const tracking = require('./tracking');
const analytics = require('./analytics');
const pipeline = require('./pipeline');
const invitePool = require('./invitePool');
const dispatcher = require('./conversions/dispatcher');
const { TelegramApi } = require('./platform/telegramApi');
const { MaxApi } = require('./platform/maxApi');
const { id } = require('./ids');
const docs = require('./docs');
const ingest = require('./ingest');
const onboarding = require('./onboarding');
const { cfg } = require('./config');

const loginLimiter = H.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const clickLimiter = H.createRateLimiter({ windowMs: 60 * 1000, max: 600 });
const webhookLimiter = H.createRateLimiter({ windowMs: 60 * 1000, max: 3000 });

function apiFor(platform, mode) {
  if (platform === 'telegram') return new TelegramApi({ token: cfg.telegram.token, mode: mode || cfg.telegram.mode });
  return new MaxApi({ token: cfg.max.token, mode: mode || cfg.max.mode });
}

/** Ответы бота уходят после того, как событие сохранено: приём не должен ждать сеть. */
function sendOutbound(platform, outbound, log) {
  if (!outbound || !outbound.length) return;
  const api = apiFor(platform);
  for (const m of outbound) {
    Promise.resolve(api.sendMessage(m.chatId, m.text))
      .then((r) => log('info', 'bot message sent', { platform, chatId: m.chatId, mode: r.mode }))
      .catch((e) => log('warn', 'bot message failed', { platform, chatId: m.chatId, error: String(e.message) }));
  }
}

function createApp(db, options) {
  const opts = options || {};
  const log = opts.log || ((level, msg, meta) =>
    console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, msg }, meta || {}))));

  const crm = opts.crm || cfg.crm;

  function ctx(req, res) {
    const url = new URL(req.url, cfg.appUrl);
    const cookies = H.parseCookies(req);
    const session = auth.getSession(db, cookies.sid);
    const c = {
      url, cookies, req, res,
      user: session ? session.user : null,
      session: session ? session.session : null,
      ip: H.clientIp(req, cfg.trustProxy)
    };

    // Сообщение должно пережить редирект. Почти все формы отвечают POST → 302 → GET,
    // а контекст запроса на редиректе умирает: раньше текст «Сохранено» и текст ошибки
    // просто исчезали, и кнопка выглядела неработающей. Поэтому флеш едет в коротком cookie.
    let flash = {};
    if (cookies.flash) { try { flash = JSON.parse(cookies.flash) || {}; } catch (e) { flash = {}; } }
    Object.defineProperty(c, 'flash', {
      enumerable: true,
      get() { return flash; },
      set(v) {
        flash = v || {};
        try {
          res.setHeader('set-cookie', H.setCookie('flash', JSON.stringify(flash),
            { secure: cfg.secureCookies, maxAge: 30000 }));
        } catch (e) { /* заголовки уже отправлены — показывать нечего */ }
      }
    });
    return c;
  }

  function currentWorkspace(c) {
    if (!c.user) return null;
    const list = accounts.workspacesOf(db, c.user.id);
    if (!list.length) return null;
    const wanted = c.cookies.ws && list.find((w) => w.id === c.cookies.ws);
    return wanted || list[0];
  }

  function page(c, { title, active, body, flash, ws }) {
    const workspace = ws === undefined ? currentWorkspace(c) : ws;
    // Флеш одноразовый: показали — погасили, иначе он висел бы на следующих страницах.
    const extra = c.cookies.flash ? { 'set-cookie': H.setCookie('flash', '', { maxAge: 0 }) } : undefined;
    H.html(c.res, 200, V.layout({
      title, user: c.user, ws: workspace, active, body,
      flash: flash || c.flash, demo: workspace && workspace.demo_mode,
      workspaces: c.user ? accounts.workspacesOf(db, c.user.id) : [],
      directorCrm: crmBridge.isDirector(c.user, crm),
      csrf: c.session ? c.session.csrf : ''
    }), extra);
  }

  function requireAuth(c) {
    if (!c.user) { H.redirect(c.res, '/login'); return false; }
    return true;
  }

  function checkCsrf(c, form) {
    if (!c.session) return false;
    return H.timingSafeEqual(form.csrf, c.session.csrf);
  }

  function filtersFrom(c, ws) {
    const days = Math.min(365, Math.max(1, parseInt(c.url.searchParams.get('days') || '30', 10)));
    const to = Date.now();
    return {
      days,
      from: to - days * analytics.DAY,
      to,
      channelId: c.url.searchParams.get('channel') || null,
      fromDay: new Date(to - days * analytics.DAY).toISOString().slice(0, 10),
      toDay: new Date(to).toISOString().slice(0, 10)
    };
  }

  function progressOf(ws) {
    const chan = one(db, 'SELECT COUNT(*) c FROM channels WHERE workspace_id = ?', ws.id).c;
    const connected = one(db, 'SELECT COUNT(*) c FROM channels WHERE workspace_id = ? AND status = \'connected\'', ws.id).c;
    const links = one(db, 'SELECT COUNT(*) c FROM tracking_links WHERE workspace_id = ?', ws.id).c;
    const clicks = one(db, 'SELECT COUNT(*) c FROM clicks WHERE workspace_id = ? AND status = \'counted\'', ws.id).c;
    const subs = one(db, 'SELECT COUNT(*) c FROM subscriptions s JOIN channels ch ON ch.id = s.channel_id WHERE ch.workspace_id = ?', ws.id).c;
    const conv = one(db, 'SELECT COUNT(*) c FROM ad_platform_credentials WHERE workspace_id = ?', ws.id).c;
    return { channel: chan > 0, bot: connected > 0, link: links > 0, click: clicks > 0, subscription: subs > 0, conversion: conv > 0 };
  }

  // ---------------------------------------------------------------- маршруты
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  crmBridge.register({ route, db, crm });

  route('GET', /^\/health$/, async (c) => {
    const checks = { db: false, pendingEvents: null, failedEvents: null, pendingConversions: null };
    try {
      checks.db = !!one(db, 'SELECT 1 x').x;
      checks.pendingEvents = one(db, 'SELECT COUNT(*) c FROM webhook_events WHERE status = \'received\'').c;
      checks.failedEvents = one(db, 'SELECT COUNT(*) c FROM webhook_events WHERE status = \'failed\'').c;
      checks.pendingConversions = one(db, 'SELECT COUNT(*) c FROM conversions WHERE status IN (\'pending\',\'retrying\')').c;
    } catch (e) { checks.error = String(e.message); }
    H.json(c.res, checks.db ? 200 : 500, {
      status: checks.db ? 'ok' : 'error',
      version: require('../package.json').version,
      integrations: { telegram: cfg.telegram.mode, max: cfg.max.mode },
      checks
    });
  });

  // ------------------------------------------------------------- горячий путь
  route('GET', /^\/c\/([A-Za-z0-9_-]{1,64})$/, async (c, m) => {
    const rl = clickLimiter(c.ip);
    if (!rl.ok) { c.res.writeHead(429); c.res.end('too many requests'); return; }

    const slug = m[1];
    const link = one(db, 'SELECT * FROM tracking_links WHERE slug = ?', slug);
    if (!link) { H.html(c.res, 404, V.layout({ title: 'Ссылка не найдена', body: V.emptyState('Ссылка не найдена', 'Проверьте адрес.', '/', 'На главную') })); return; }
    const channel = one(db, 'SELECT * FROM channels WHERE id = ?', link.channel_id);

    const query = {};
    for (const [k, v] of c.url.searchParams) query[k] = v;

    const click = tracking.registerClick(db, {
      slug, method: c.req.method, headers: c.req.headers, query,
      ip: c.ip, userAgent: c.req.headers['user-agent'], referer: c.req.headers.referer,
      ipSalt: cfg.ipSalt
    });

    if (link.landing_mode === 'page') {
      const q = click.clickId ? '?k=' + encodeURIComponent(click.clickId) : '';
      // Пиксель ставим, только если интеграция с VK настроена боевым режимом:
      // чужой счётчик на странице никому не нужен.
      const vk = one(db, 'SELECT counter_id FROM ad_platform_credentials ' +
        'WHERE workspace_id = ? AND provider = \'vk_ads\' AND mode = \'real\'', link.workspace_id);
      H.html(c.res, 200, V.landingPage({
        channelTitle: channel.title, channelUrl: channel.channel_url,
        goUrl: '/c/' + encodeURIComponent(slug) + '/go' + q,
        vkPixelId: vk && vk.counter_id
      }), { 'cache-control': 'no-store, no-cache, must-revalidate' });
      return;
    }

    let target;
    try {
      target = tracking.resolveTarget(db, {
        link, channel, clickId: click.clickId,
        cfg: { botName: channel.platform === 'telegram' ? (channel.bot_name || cfg.telegram.botName) : (channel.bot_name || cfg.max.botName), channelUrl: channel.channel_url }
      });
    } catch (e) {
      log('error', 'redirect target failed', { slug, error: String(e.message) });
      H.html(c.res, 500, V.layout({ title: 'Ошибка', body: V.emptyState('Не удалось построить ссылку', String(e.message)) }));
      return;
    }

    if (target.poolEmpty) log('warn', 'invite pool empty', { slug, channel: channel.id });
    H.redirect(c.res, target.url, { 'cache-control': 'no-store, no-cache, must-revalidate' });
  });

  /**
   * Второй шаг режима «страница»: именно здесь выдаётся приглашение из пула.
   * Клик уже засчитан на показе страницы, сюда приходит его идентификатор.
   */
  route('GET', /^\/c\/([A-Za-z0-9_-]{1,64})\/go$/, async (c, m) => {
    if (!clickLimiter(c.ip).ok) { c.res.writeHead(429); c.res.end('too many requests'); return; }

    const slug = m[1];
    const link = one(db, 'SELECT * FROM tracking_links WHERE slug = ?', slug);
    if (!link) { H.html(c.res, 404, V.layout({ title: 'Ссылка не найдена', body: V.emptyState('Ссылка не найдена', 'Проверьте адрес.', '/', 'На главную') })); return; }
    const channel = one(db, 'SELECT * FROM channels WHERE id = ?', link.channel_id);

    // Клик со страницы. Если его нет (прямой заход на /go, устаревшая вкладка) —
    // засчитываем новый, иначе человек упрётся в ошибку на ровном месте.
    let clickId = c.url.searchParams.get('k');
    if (!clickId || !one(db, 'SELECT id FROM clicks WHERE id = ?', clickId)) {
      const query = {};
      for (const [k, v] of c.url.searchParams) if (k !== 'k') query[k] = v;
      clickId = tracking.registerClick(db, {
        slug, method: c.req.method, headers: c.req.headers, query,
        ip: c.ip, userAgent: c.req.headers['user-agent'], referer: c.req.headers.referer,
        ipSalt: cfg.ipSalt
      }).clickId;
    }

    let target;
    try {
      target = tracking.resolveTarget(db, {
        link, channel, clickId,
        cfg: { botName: channel.platform === 'telegram' ? (channel.bot_name || cfg.telegram.botName) : (channel.bot_name || cfg.max.botName), channelUrl: channel.channel_url }
      });
    } catch (e) {
      log('error', 'redirect target failed', { slug, error: String(e.message) });
      H.html(c.res, 500, V.layout({ title: 'Ошибка', body: V.emptyState('Не удалось построить ссылку', String(e.message)) }));
      return;
    }
    if (target.poolEmpty) log('warn', 'invite pool empty', { slug, channel: channel.id });
    H.redirect(c.res, target.url, { 'cache-control': 'no-store, no-cache, must-revalidate' });
  });

  // ---------------------------------------------------------------- вебхуки
  route('POST', /^\/webhook\/(telegram|max)$/, async (c, m) => {
    const platform = m[1];
    if (!webhookLimiter(c.ip).ok) { c.res.writeHead(429); c.res.end(); return; }
    let body = '';
    try { body = await H.readBody(c.req); } catch (e) { c.res.writeHead(413); c.res.end(); return; }

    const conf = platform === 'telegram' ? cfg.telegram : cfg.max;
    const secret = conf.webhookSecret;
    // Боевой режим без секрета — открытый приём чужих событий. Лучше отказать, чем принять подделку.
    if (!secret && conf.mode === 'real') {
      log('error', 'webhook rejected: secret not configured while token is set', { platform });
      c.res.writeHead(403); c.res.end(); return;
    }
    const verified = pipeline.ADAPTERS[platform].verify(c.req.headers, secret);
    if (!verified.ok) {
      log('warn', 'webhook rejected', { platform, reason: verified.reason });
      c.res.writeHead(403); c.res.end(); return;
    }

    const accepted = ingest.accept(db, {
      platform, bodyRaw: body, transport: 'webhook', headers: c.req.headers,
      botName: platform === 'telegram' ? cfg.telegram.botName : cfg.max.botName
    });
    sendOutbound(platform, accepted.outbound, log);
    if (accepted.command && platform === 'telegram') {
      // Ответ на команду готовится асинхронно: он спрашивает у Telegram, какими
      // каналами управляет человек. Вебхук при этом не ждёт — иначе Telegram
      // начнёт повторять доставку по таймауту.
      Promise.resolve(onboarding.command(db, apiFor('telegram'), {
        text: accepted.command.text, userId: accepted.command.userId, appUrl: cfg.appUrl
      }))
        .then((msgs) => sendOutbound(platform, msgs, log))
        .catch((e) => log('warn', 'bot command failed', { error: String(e.message) }));
    }
    log('info', 'webhook processed', {
      platform,
      duplicate: accepted.duplicate,
      failed: !!(accepted.result && accepted.result.failed),
      action: accepted.result && accepted.result.domain && accepted.result.domain.action,
      conversions: accepted.conversions.length
    });
    H.json(c.res, 200, { ok: true });
  });

  // ----------------------------------------------------------------- лендинг
  route('GET', /^\/$/, async (c) => {
    if (c.user) { H.redirect(c.res, '/app'); return; }
    page(c, { title: 'Откуда трафик — аналитика подписок в Telegram и MAX', active: '/', ws: null, body: docs.landing() });
  });
  route('GET', /^\/pricing$/, async (c) => {
    page(c, { title: 'Тарифы', active: '/pricing', ws: null, body: docs.pricing(accounts.PLANS) });
  });
  route('GET', /^\/docs$/, async (c) => {
    page(c, { title: 'Документация', active: '/docs', ws: null, body: docs.index() });
  });
  route('GET', /^\/docs\/([a-z0-9-]+)$/, async (c, m) => {
    const doc = docs.page(m[1]);
    if (!doc) { H.html(c.res, 404, V.layout({ title: 'Не найдено', body: V.emptyState('Страница не найдена', '', '/docs', 'К документации') })); return; }
    page(c, { title: doc.title, active: '/docs', ws: null, body: doc.body });
  });

  // ------------------------------------------------------------------- вход
  function authPage(title, action, fields, extra) {
    return `<div class="panel" style="max-width:420px;margin:40px auto">
<h1 style="font-size:22px">${title}</h1>${extra || ''}
<form method="post" action="${action}">${fields}</form></div>`;
  }

  route('GET', /^\/register$/, async (c) => {
    if (c.user) { H.redirect(c.res, '/app'); return; }
    page(c, { title: 'Регистрация', ws: null, body: authPage('Создать аккаунт', '/register',
      `<div class="field"><label for="e">Почта</label><input id="e" name="email" type="email" required autocomplete="email"></div>
<div class="field"><label for="p">Пароль</label><input id="p" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
<div class="field"><label for="n">Название проекта</label><input id="n" name="workspace" placeholder="Мой канал"></div>
<button>Зарегистрироваться</button> <a class="btn ghost" href="/login">Войти</a>`,
      '<p class="muted">Бесплатный тариф: 1 канал, 5 ссылок, аналитика без ограничений по времени.</p>') });
  });

  route('POST', /^\/register$/, async (c) => {
    const form = H.parseForm(await H.readBody(c.req));
    if (!loginLimiter(c.ip).ok) { c.res.writeHead(429); c.res.end('Слишком много попыток'); return; }
    try {
      const user = auth.createUser(db, { email: form.email, password: form.password });
      const ws = accounts.createWorkspaceFor(db, user, { name: form.workspace || 'Мой проект' });
      const sess = auth.createSession(db, user.id, { ip: c.ip, userAgent: c.req.headers['user-agent'], ipSalt: cfg.ipSalt });
      run(db, 'INSERT INTO product_events (id, workspace_id, name, ts_utc, props_json) VALUES (?, ?, ?, ?, ?)',
        id('pev'), ws.id, 'registration', Date.now(), '{}');
      H.redirect(c.res, '/app', { 'set-cookie': [
        H.setCookie('sid', sess.id, { secure: cfg.secureCookies, maxAge: auth.SESSION_TTL_MS }),
        H.setCookie('ws', ws.id, { secure: cfg.secureCookies, maxAge: auth.SESSION_TTL_MS })
      ] });
    } catch (e) {
      c.flash = { error: e.message };
      page(c, { title: 'Регистрация', ws: null, body: authPage('Создать аккаунт', '/register',
        `<div class="field"><label>Почта</label><input name="email" type="email" value="${H.esc(form.email || '')}" required></div>
<div class="field"><label>Пароль</label><input name="password" type="password" required minlength="8"></div>
<button>Зарегистрироваться</button>`) });
    }
  });

  route('GET', /^\/login$/, async (c) => {
    if (c.user) {
      if (c.url.searchParams.get('next') === '/crm' && !crmBridge.isDirector(c.user, crm)) {
        H.html(c.res, 403, V.layout({ title: 'Доступ ограничен', user: c.user, body: '<p>CRM доступна только директору. <a href="/app">Вернуться в кабинет</a></p>' })); return;
      }
      H.redirect(c.res, c.url.searchParams.get('next') === '/crm' ? '/crm' : '/app'); return;
    }
    page(c, { title: 'Вход', ws: null, body: authPage('Вход', '/login',
      `<input type="hidden" name="next" value="${c.url.searchParams.get('next') === '/crm' ? '/crm' : '/app'}"><div class="field"><label for="e">Почта</label><input id="e" name="email" type="email" required autocomplete="email"></div>
<div class="field"><label for="p">Пароль</label><input id="p" name="password" type="password" required autocomplete="current-password"></div>
<button>Войти</button> <a class="btn ghost" href="/register">Регистрация</a>
<p class="muted" style="margin-top:14px"><a href="/forgot">Забыли пароль?</a></p>`) });
  });

  route('POST', /^\/login$/, async (c) => {
    const form = H.parseForm(await H.readBody(c.req));
    if (!loginLimiter(c.ip + '|' + (form.email || '')).ok) { c.res.writeHead(429); c.res.end('Слишком много попыток входа'); return; }
    const user = auth.authenticate(db, form.email, form.password);
    if (!user) {
      c.flash = { error: 'Неверная почта или пароль' };
      page(c, { title: 'Вход', ws: null, body: authPage('Вход', '/login',
        `<input type="hidden" name="next" value="${form.next === '/crm' ? '/crm' : '/app'}"><div class="field"><label>Почта</label><input name="email" type="email" value="${H.esc(form.email || '')}" required></div>
<div class="field"><label>Пароль</label><input name="password" type="password" required></div><button>Войти</button>`) });
      return;
    }
    const sess = auth.createSession(db, user.id, { ip: c.ip, userAgent: c.req.headers['user-agent'], ipSalt: cfg.ipSalt });
    H.redirect(c.res, form.next === '/crm' && crmBridge.isDirector(user, crm) ? '/crm' : '/app', { 'set-cookie': H.setCookie('sid', sess.id, { secure: cfg.secureCookies, maxAge: auth.SESSION_TTL_MS }) });
  });

  route('POST', /^\/logout$/, async (c) => {
    if (c.session) auth.destroySession(db, c.session.id);
    H.redirect(c.res, '/', { 'set-cookie': H.setCookie('sid', '', { maxAge: 0 }) });
  });

  route('GET', /^\/forgot$/, async (c) => {
    page(c, { title: 'Восстановление пароля', ws: null, body: authPage('Восстановление пароля', '/forgot',
      `<div class="field"><label for="e">Почта</label><input id="e" name="email" type="email" required></div><button>Получить ссылку</button>`,
      '<p class="muted">Мы отправим ссылку для смены пароля. Почтовый отправитель в MVP не подключён: ссылка выводится в лог сервера, забрать её может администратор.</p>') });
  });

  route('POST', /^\/forgot$/, async (c) => {
    const form = H.parseForm(await H.readBody(c.req));
    if (!loginLimiter('forgot|' + c.ip).ok) { c.res.writeHead(429); c.res.end(); return; }
    const reset = auth.createPasswordReset(db, form.email);
    if (reset) log('info', 'password reset requested', { url: cfg.appUrl + '/reset?token=' + reset.token, email: reset.user.email });
    c.flash = { ok: 'Если такой адрес зарегистрирован, ссылка создана. В MVP она пишется в лог сервера.' };
    page(c, { title: 'Восстановление пароля', ws: null, body: authPage('Восстановление пароля', '/forgot',
      '<div class="field"><label>Почта</label><input name="email" type="email" required></div><button>Получить ссылку</button>') });
  });

  route('GET', /^\/reset$/, async (c) => {
    const token = c.url.searchParams.get('token') || '';
    page(c, { title: 'Новый пароль', ws: null, body: authPage('Новый пароль', '/reset',
      `<input type="hidden" name="token" value="${H.esc(token)}">
<div class="field"><label for="p">Новый пароль</label><input id="p" name="password" type="password" required minlength="8"></div>
<button>Сменить пароль</button>`) });
  });

  route('POST', /^\/reset$/, async (c) => {
    const form = H.parseForm(await H.readBody(c.req));
    const res = auth.consumePasswordReset(db, form.token, form.password);
    if (!res.ok) {
      c.flash = { error: res.error };
      page(c, { title: 'Новый пароль', ws: null, body: authPage('Новый пароль', '/reset',
        `<input type="hidden" name="token" value="${H.esc(form.token || '')}">
<div class="field"><label>Новый пароль</label><input name="password" type="password" required minlength="8"></div><button>Сменить пароль</button>`) });
      return;
    }
    c.flash = { ok: 'Пароль изменён, войдите заново' };
    page(c, { title: 'Вход', ws: null, body: authPage('Вход', '/login',
      `<div class="field"><label>Почта</label><input name="email" type="email" required></div>
<div class="field"><label>Пароль</label><input name="password" type="password" required></div><button>Войти</button>`) });
  });

  // Переключение проекта. Раньше его не было: пользователь молча работал не в том проекте
  // и не понимал, почему настройки не действуют.
  route('POST', /^\/app\/workspace$/, async (c) => {
    if (!requireAuth(c)) return;
    const form = H.parseForm(await H.readBody(c.req));
    if (!checkCsrf(c, form)) { c.res.writeHead(403); c.res.end('CSRF'); return; }
    const allowed = accounts.workspacesOf(db, c.user.id).some((w) => w.id === form.workspace);
    if (!allowed) { c.res.writeHead(403); c.res.end('Нет доступа к этому проекту'); return; }
    H.redirect(c.res, c.req.headers.referer && c.req.headers.referer.includes('/app') ? '/app' : '/app', {
      'set-cookie': H.setCookie('ws', form.workspace, { secure: cfg.secureCookies, maxAge: auth.SESSION_TTL_MS })
    });
  });

  // Привязка канала к кабинету по одноразовой ссылке из личного сообщения бота
  route('GET', /^\/claim\/([A-Za-z0-9_-]{10,64})$/, async (c, m) => {
    const token = m[1];
    if (!c.user) {
      H.redirect(c.res, '/login', { 'set-cookie': H.setCookie('claim', token, { secure: cfg.secureCookies, maxAge: 3600000 }) });
      return;
    }
    const ws = currentWorkspace(c);
    if (!ws) { H.redirect(c.res, '/register'); return; }
    const res = onboarding.claim(db, token, ws.id);
    if (!res.ok) {
      c.flash = { error: res.error };
      page(c, { title: 'Привязка канала', active: '/app', body: V.emptyState('Не получилось привязать канал', res.error, '/app/channels', 'К каналам') });
      return;
    }
    accounts.audit(db, { workspaceId: ws.id, userId: c.user.id, action: 'channel.claim', target: res.channel.id });
    log('info', 'channel claimed', { channel: res.channel.id, workspace: ws.id });
    // Оба cookie отдаём вместе: заголовки редиректа перекрывают выставленные ранее,
    // и подтверждение привязки иначе потерялось бы.
    H.redirect(c.res, '/app/channels', { 'set-cookie': [
      H.setCookie('claim', '', { maxAge: 0 }),
      H.setCookie('flash', JSON.stringify({ ok: 'Канал «' + (res.channel.title || res.channel.external_chat_id) +
        '» привязан к кабинету. Статистика по нему пошла.' }), { secure: cfg.secureCookies, maxAge: 30000 })
    ] });
  });

  require('./routes/app')({ db, route, page, requireAuth, currentWorkspace, checkCsrf, filtersFrom, progressOf, apiFor, log, cfg });
  require('./routes/admin')({ db, route, page, requireAuth, checkCsrf, log });
  require('./routes/content')({ db, route, page, requireAuth, currentWorkspace, checkCsrf, log, cfg, fetchImpl: opts.fetch, telegramApi: opts.telegramApi });

  // ------------------------------------------------------------------ сервер
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let c;
    try {
      c = ctx(req, res);
      // HEAD обслуживается теми же обработчиками, что и GET: Node сам не отдаст тело.
      // Без этого мониторинги и превью-боты получали 404 на живых страницах.
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = c.url.pathname.match(r.pattern);
        if (!m) continue;
        await r.handler(c, m);
        log('debug', 'request', { method: req.method, path: c.url.pathname, ms: Date.now() - started, status: res.statusCode });
        return;
      }
      H.html(res, 404, V.layout({ title: 'Не найдено', user: c.user, body: V.emptyState('Страница не найдена', 'Проверьте адрес.', '/', 'На главную') }));
    } catch (e) {
      log('error', 'unhandled', { path: req.url, error: String(e && e.stack || e) });
      if (!res.headersSent) H.html(res, 500, V.layout({ title: 'Ошибка', body: V.emptyState('Что-то сломалось', 'Мы записали ошибку в лог.', '/', 'На главную') }));
      else res.end();
    }
  });

  return { server, db, log, routes };
}

module.exports = { createApp, apiFor };
