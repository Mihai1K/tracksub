'use strict';

/** Маршруты кабинета. Всё, что видит клиент после входа. */

const { one, all, run } = require('../db');
const H = require('../http');
const V = require('../views');
const accounts = require('../accounts');
const tracking = require('../tracking');
const analytics = require('../analytics');
const invitePool = require('../invitePool');
const dispatcher = require('../conversions/dispatcher');
const { id } = require('../ids');
const demo = require('../demo');
const secrets = require('../secrets');
const { cfg } = require('../config');

module.exports = function mount({ db, route, page, requireAuth, currentWorkspace, checkCsrf, filtersFrom, progressOf, apiFor, log, cfg }) {
  const csrf = (c) => `<input type="hidden" name="csrf" value="${H.esc(c.session ? c.session.csrf : '')}">`;
  const channelsOf = (ws) => all(db, 'SELECT * FROM channels WHERE workspace_id = ? ORDER BY created_at', ws.id);

  function guard(c) {
    if (!requireAuth(c)) return null;
    const ws = currentWorkspace(c);
    if (!ws) { H.redirect(c.res, '/register'); return null; }
    return ws;
  }

  async function post(c, handler) {
    const form = H.parseForm(await H.readBody(c.req));
    if (!checkCsrf(c, form)) { c.res.writeHead(403); c.res.end('CSRF'); return null; }
    return handler(form);
  }

  // ------------------------------------------------------------------ обзор
  route('GET', /^\/app$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const filters = filtersFrom(c, ws);
    const channels = channelsOf(ws);
    const o = analytics.overview(db, ws, filters);
    const series = analytics.timeseries(db, ws, filters);
    const prog = progressOf(ws);

    const body = `<h1>Обзор</h1><p class="sub">${H.esc(ws.name)} · последние ${filters.days} дней · таймзона ${H.esc(ws.timezone)}</p>
${V.onboarding(prog)}
${V.filterBar(filters, channels, '/app')}
${o.subscriptions || o.clicks ? V.statCards(o) + V.chart(series) + V.attributionQuality(o)
  : V.emptyState('Событий пока нет', 'Как только по вашей ссылке перейдут и подпишутся, здесь появятся цифры.', '/app/links', 'Создать ссылку')}
<h2>Источники</h2>${V.breakdownTable(analytics.breakdown(db, ws, filters, 'source'), 'Источник')}`;
    page(c, { title: 'Обзор', active: '/app', body });
  });

  for (const [path, dim, label] of [['/app/sources', 'source', 'Источник'], ['/app/campaigns', 'campaign', 'Кампания'], ['/app/creatives', 'creative', 'Креатив']]) {
    route('GET', new RegExp('^' + path.replace(/\//g, '\\/') + '$'), async (c) => {
      const ws = guard(c); if (!ws) return;
      const filters = filtersFrom(c, ws);
      const rows = analytics.breakdown(db, ws, filters, dim);
      const body = `<h1>${H.esc(label === 'Источник' ? 'Источники' : label === 'Кампания' ? 'Кампании' : 'Креативы')}</h1>
<p class="sub">Дешёвый подписчик не значит хороший: смотрите на стоимость живого подписчика, а не на CPS.</p>
${V.filterBar(filters, channelsOf(ws), path)}${V.breakdownTable(rows, label)}`;
      page(c, { title: label, active: path, body });
    });
  }

  // ----------------------------------------------------------------- каналы
  route('GET', /^\/app\/channels$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    // Убрать можно только пустой канал: кнопка не должна появляться там, где
    // за ней стоят подписки или ссылки — удаление молча унесло бы историю.
    const channels = channelsOf(ws).map((ch) => Object.assign({}, ch, { removable: isEmptyChannel(ch.id) }));
    const pools = invitePool.stats(db, ws.id);
    const body = `<h1>Каналы</h1><p class="sub">Бот должен быть администратором канала — иначе платформа не пришлёт события о подписках.</p>
${channels.length ? `<div class="tw"><table><thead><tr><th>Канал</th><th>Платформа</th><th>ID</th><th>Статус</th><th>Бот</th><th></th></tr></thead>
<tbody>${channels.map((ch) => `<tr><td>${H.esc(ch.title || '—')}</td><td>${H.esc(ch.platform)}</td>
<td><code>${H.esc(ch.external_chat_id)}</code></td>
<td>${ch.status === 'connected' ? '<span class="tag det">подключён</span>' : ch.status === 'error' ? '<span class="tag none">ошибка</span>' : '<span class="tag prob">ожидает</span>'}</td>
<td>${H.esc(ch.bot_name || '—')} ${ch.bot_status ? `<span class="tag neutral">${H.esc(ch.bot_status)}</span>` : ''}</td>
<td><div style="display:flex;gap:6px"><form method="post" action="/app/channels/check" style="margin:0">${csrf(c)}<input type="hidden" name="channel" value="${H.esc(ch.id)}"><button class="ghost" style="padding:4px 10px">Проверить</button></form>${ch.removable ? `<form method="post" action="/app/channels/remove" style="margin:0">${csrf(c)}<input type="hidden" name="channel" value="${H.esc(ch.id)}"><button class="ghost" style="padding:4px 10px">Убрать</button></form>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`
      : V.emptyState('Каналов пока нет', 'Подключите первый канал — это занимает минуту.')}
${pools.length ? `<h2>Пул пригласительных ссылок (Telegram)</h2>
<div class="tw"><table><thead><tr><th>Ссылка</th><th>Канал</th><th class="n">свободно</th><th class="n">выдано</th><th>режим</th></tr></thead>
<tbody>${pools.map((p) => `<tr><td><code>${H.esc(p.slug)}</code></td><td>${H.esc(p.title || '')}</td>
<td class="n">${p.free}</td><td class="n">${p.used}</td><td><span class="tag ${p.mode === 'real' ? 'real' : 'mock'}">${H.esc(p.mode)}</span></td></tr>`).join('')}</tbody></table></div>` : ''}
<div class="panel"><h3 style="margin-top:0">Подключить канал</h3>
<form method="post" action="/app/channels">${csrf(c)}
<div class="grid2">
<div class="field"><label for="pl">Платформа</label><select id="pl" name="platform">
<option value="telegram">Telegram</option><option value="max">MAX</option></select></div>
<div class="field"><label for="ext">ID канала</label><input id="ext" name="external_chat_id" required placeholder="-1001234567890">
<span class="muted">Telegram: числовой ID канала. MAX: chat_id из API.</span></div>
<div class="field"><label for="ti">Название</label><input id="ti" name="title" placeholder="Мой канал"></div>
<div class="field"><label for="cu">Ссылка на канал</label><input id="cu" name="channel_url" placeholder="https://t.me/mychannel">
<span class="muted">Нужна для режима прямого перехода и как запасной вариант.</span></div>
</div><button>Подключить</button></form></div>`;
    page(c, { title: 'Каналы', active: '/app/channels', body });
  });

  route('POST', /^\/app\/channels$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const limit = accounts.checkLimit(db, ws, 'channel');
      if (limit) { c.flash = { error: limit }; H.redirect(c.res, '/app/channels'); return; }
      const platform = form.platform === 'max' ? 'max' : 'telegram';
      const badId = tracking.checkChatId(platform, form.external_chat_id);
      if (badId) { c.flash = { error: badId }; H.redirect(c.res, '/app/channels'); return; }
      try {
        const ch = tracking.connectChannel(db, {
          workspaceId: ws.id, platform,
          externalChatId: form.external_chat_id, title: form.title
        });
        run(db, 'UPDATE channels SET channel_url = ?, status = \'pending\' WHERE id = ?', form.channel_url || null, ch.id);
        accounts.audit(db, { workspaceId: ws.id, userId: c.user.id, action: 'channel.connect', target: ch.id });
      } catch (e) {
        // Молчаливый отказ выглядел как «кнопка не работает»: страница просто
        // перерисовывалась без канала и без объяснения.
        log('warn', 'channel connect failed', { error: String(e.message) });
        c.flash = { error: String(e.message) };
      }
      H.redirect(c.res, '/app/channels');
    });
  });

  function isEmptyChannel(channelId) {
    return one(db, 'SELECT COUNT(*) c FROM subscriptions WHERE channel_id = ?', channelId).c === 0 &&
      one(db, 'SELECT COUNT(*) c FROM tracking_links WHERE channel_id = ?', channelId).c === 0;
  }

  route('POST', /^\/app\/channels\/remove$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const ch = one(db, 'SELECT * FROM channels WHERE id = ? AND workspace_id = ?', form.channel, ws.id);
      if (!ch) { H.redirect(c.res, '/app/channels'); return; }
      if (!isEmptyChannel(ch.id)) {
        c.flash = { error: 'По этому каналу уже есть подписки или ссылки — он не удаляется, чтобы не потерять историю.' };
        H.redirect(c.res, '/app/channels'); return;
      }
      run(db, 'DELETE FROM channels WHERE id = ?', ch.id);
      accounts.audit(db, { workspaceId: ws.id, userId: c.user.id, action: 'channel.remove', target: ch.id });
      c.flash = { ok: 'Канал «' + (ch.title || ch.external_chat_id) + '» убран из кабинета.' };
      H.redirect(c.res, '/app/channels');
    });
  });

  route('POST', /^\/app\/channels\/check$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async (form) => {
      const ch = one(db, 'SELECT * FROM channels WHERE id = ? AND workspace_id = ?', form.channel, ws.id);
      if (!ch) { H.redirect(c.res, '/app/channels'); return; }
      const api = apiFor(ch.platform);
      try {
        const info = await api.getChat(ch.external_chat_id);
        const bot = await api.getMe();
        const botName = bot.result.username || bot.result.name || null;
        run(db, 'UPDATE channels SET status = \'connected\', title = COALESCE(NULLIF(?, \'\'), title), bot_name = ?, ' +
          'bot_status = ?, bot_id = ?, connected_at = ? WHERE id = ?',
          (info.result && (info.result.title || info.result.name)) || '', botName,
          info.mode === 'mock' ? 'mock' : 'admin', String(bot.result.id || bot.result.user_id || ''), Date.now(), ch.id);

        if (ch.platform === 'telegram') {
          const links = all(db, 'SELECT * FROM tracking_links WHERE channel_id = ? AND redirect_mode = \'invite\'', ch.id);
          for (const l of links) await invitePool.refill(db, { channel: ch, link: l, api, size: cfg.invitePoolSize });
        }
      } catch (e) {
        run(db, 'UPDATE channels SET status = \'error\', bot_status = ? WHERE id = ?', String(e.message).slice(0, 120), ch.id);
      }
      H.redirect(c.res, '/app/channels');
    });
  });

  // ----------------------------------------------------------------- ссылки
  route('GET', /^\/app\/links$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const channels = channelsOf(ws);
    const links = all(db,
      'SELECT tl.*, ch.title channel_title, ch.platform, ' +
      '(SELECT COUNT(*) FROM clicks cl WHERE cl.tracking_link_id = tl.id AND cl.status = \'counted\') clicks ' +
      'FROM tracking_links tl JOIN channels ch ON ch.id = tl.channel_id ' +
      'WHERE tl.workspace_id = ? AND tl.is_archived = 0 ORDER BY tl.created_at DESC', ws.id);

    // Последние переходы: по ним видно, доехал ли идентификатор рекламной системы.
    // Без этого проверка «а приходит ли rb_clickid» требует лезть в базу.
    const recentClicks = all(db,
      'SELECT c.ts_utc, c.status, c.filter_reason, c.device_hint, c.query_json, tl.slug, tl.source, ' +
      'il.external_link FROM clicks c JOIN tracking_links tl ON tl.id = c.tracking_link_id ' +
      'LEFT JOIN invite_links il ON il.id = c.invite_link_id ' +
      'WHERE c.workspace_id = ? ORDER BY c.ts_utc DESC LIMIT 10', ws.id);

    const adId = (json) => {
      let q = {};
      try { q = JSON.parse(json || '{}'); } catch (e) { q = {}; }
      if (q.yclid || q.YCLID) return { label: 'yclid', value: String(q.yclid || q.YCLID), ok: true };
      const vk = q.rb_clickid || q.RB_CLICKID || q.clickid || q.click_id || q.vk_click_id;
      if (vk) return { label: 'идентификатор клика VK', value: String(vk), ok: true };
      return { label: 'нет идентификатора', value: '', ok: false };
    };

    const body = `<h1>Tracking-ссылки</h1>
<p class="sub">Ставьте эту ссылку в рекламу. Она считает переход и ведёт человека в канал.</p>
${links.length ? `<div class="tw"><table><thead><tr><th>Ссылка</th><th>Источник</th><th>Кампания</th><th>Креатив</th>
<th>Канал</th><th>Режим</th><th>Посадка</th><th class="n">клики</th></tr></thead>
<tbody>${links.map((l) => `<tr>
<td><input class="copy" readonly value="${H.esc(cfg.appUrl + '/c/' + l.slug)}"></td>
<td>${H.esc(l.source || '—')}</td><td>${H.esc(l.campaign || '—')}</td><td>${H.esc(l.creative || '—')}</td>
<td>${H.esc(l.channel_title || '')} <span class="tag neutral">${H.esc(l.platform)}</span></td>
<td>${l.redirect_mode === 'invite' ? '<span class="tag det">своя ссылка</span>' : l.redirect_mode === 'bot' ? '<span class="tag det">через бота</span>' : '<span class="tag prob">прямая</span>'}</td>
<td><form method="post" action="/app/links/landing" style="margin:0">${csrf(c)}
<input type="hidden" name="link" value="${H.esc(l.id)}">
<input type="hidden" name="mode" value="${l.landing_mode === 'page' ? 'redirect' : 'page'}">
<button class="ghost" style="padding:4px 10px">${l.landing_mode === 'page' ? 'страница' : 'сразу в канал'}</button></form></td>
<td class="n">${l.clicks}</td></tr>`).join('')}</tbody></table></div>
<p class="sub">«Сразу в канал» — переход мгновенный. «Страница» — объявление ведёт на обычную страницу с кнопкой:
рекламные площадки отклоняют ссылку, которая сразу уводит в мессенджер. Атрибуция одинаковая в обоих режимах.</p>`
      : V.emptyState('Ссылок пока нет', 'Создайте первую — на это уходит меньше минуты.')}
${recentClicks.length ? `<h2>Последние переходы</h2>
<p class="sub">Здесь видно, доехал ли идентификатор рекламной системы. Без него конверсию
не к чему привязать: Яндексу нужен <code>yclid</code>, VK — <code>rb_clickid</code>.
VK дописывает свой параметр сам, в Директе его надо добавить в объявление.</p>
<div class="tw"><table><thead><tr><th>Время</th><th>Ссылка</th><th>Источник</th><th>Устройство</th>
<th>Идентификатор рекламы</th><th>Выдана ссылка</th></tr></thead>
<tbody>${recentClicks.map((cl) => {
  const a = adId(cl.query_json);
  return `<tr${cl.status !== 'counted' ? ' class="unknown"' : ''}>
<td>${new Date(cl.ts_utc).toISOString().slice(5, 16).replace('T', ' ')}</td>
<td><code>${H.esc(cl.slug)}</code>${cl.status !== 'counted' ? ' <span class="tag none">' + H.esc(cl.filter_reason || 'отфильтрован') + '</span>' : ''}</td>
<td>${H.esc(cl.source || '—')}</td><td>${H.esc(cl.device_hint)}</td>
<td>${a.ok ? '<span class="tag det">' + H.esc(a.label) + '</span> <code>' + H.esc(a.value.slice(0, 28)) + '</code>' : '<span class="tag none">нет идентификатора</span>'}</td>
<td>${cl.external_link ? '<span class="tag det">персональная</span>' : '<span class="tag prob">обычная</span>'}</td>
</tr>`;
}).join('')}</tbody></table></div>` : ''}
${channels.length ? `<div class="panel"><h3 style="margin-top:0">Новая ссылка</h3>
<form method="post" action="/app/links">${csrf(c)}<div class="grid2">
<div class="field"><label for="ch">Канал</label><select id="ch" name="channel">${channels.map((ch) =>
  `<option value="${H.esc(ch.id)}">${H.esc(ch.title || ch.external_chat_id)} · ${H.esc(ch.platform)}</option>`).join('')}</select></div>
<div class="field"><label for="mode">Режим перехода</label><select id="mode" name="redirect_mode">
<option value="invite">Своя пригласительная ссылка — точная атрибуция (Telegram)</option>
<option value="bot">Через бота — точная атрибуция (MAX и Telegram)</option>
<option value="direct">Прямая ссылка — вероятностная атрибуция</option></select></div>
<div class="field"><label for="src">Источник</label><input id="src" name="source" placeholder="yandex_direct" required></div>
<div class="field"><label for="cmp">Кампания</label><input id="cmp" name="campaign" placeholder="autumn_sale"></div>
<div class="field"><label for="crt">Креатив</label><input id="crt" name="creative" placeholder="banner_1"></div>
<div class="field"><label for="us">utm_source</label><input id="us" name="utm_source"></div>
<div class="field"><label for="um">utm_medium</label><input id="um" name="utm_medium"></div>
<div class="field"><label for="uc">utm_campaign</label><input id="uc" name="utm_campaign"></div>
<div class="field"><label for="uco">utm_content</label><input id="uco" name="utm_content"></div>
</div><button>Создать ссылку</button>
<p class="muted" style="margin-top:12px">Для Яндекс Директа добавьте в объявление параметр <code>yclid={yclid}</code> — без него конверсию некуда привязать.</p>
</form></div>` : V.emptyState('Сначала подключите канал', 'Ссылка всегда ведёт в конкретный канал.', '/app/channels', 'Подключить канал')}`;
    page(c, { title: 'Ссылки', active: '/app/links', body });
  });

  route('POST', /^\/app\/links\/landing$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const l = one(db, 'SELECT * FROM tracking_links WHERE id = ? AND workspace_id = ?', form.link, ws.id);
      if (!l) { H.redirect(c.res, '/app/links'); return; }
      const mode = form.mode === 'page' ? 'page' : 'redirect';
      run(db, 'UPDATE tracking_links SET landing_mode = ? WHERE id = ?', mode, l.id);
      c.flash = { ok: mode === 'page'
        ? 'Ссылка теперь открывает страницу с кнопкой — так её принимают рекламные площадки.'
        : 'Ссылка снова ведёт в канал сразу.' };
      H.redirect(c.res, '/app/links');
    });
  });

  route('POST', /^\/app\/links$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async (form) => {
      const limit = accounts.checkLimit(db, ws, 'link');
      if (limit) { c.flash = { error: limit }; H.redirect(c.res, '/app/links'); return; }
      const ch = one(db, 'SELECT * FROM channels WHERE id = ? AND workspace_id = ?', form.channel, ws.id);
      if (!ch) { H.redirect(c.res, '/app/links'); return; }

      const slug = require('crypto').randomBytes(5).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 7);
      const link = tracking.createLink(db, {
        workspaceId: ws.id, channelId: ch.id, slug,
        source: form.source, campaign: form.campaign, creative: form.creative,
        redirectMode: ['invite', 'bot', 'direct'].includes(form.redirect_mode) ? form.redirect_mode : 'direct',
        platformTarget: ch.platform
      });
      run(db, 'UPDATE tracking_links SET utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_content = ? WHERE id = ?',
        form.utm_source || null, form.utm_medium || null, form.utm_campaign || null, form.utm_content || null, link.id);
      accounts.audit(db, { workspaceId: ws.id, userId: c.user.id, action: 'link.create', target: link.id });

      if (link.redirect_mode === 'invite' && ch.platform === 'telegram') {
        try {
          await invitePool.refill(db, { channel: ch, link, api: apiFor('telegram'), size: cfg.invitePoolSize });
        } catch (e) { log('warn', 'pool refill failed', { error: String(e.message) }); }
      }
      H.redirect(c.res, '/app/links');
    });
  });

  // ---------------------------------------------------------------- расходы
  route('GET', /^\/app\/spend$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const rows = all(db, 'SELECT * FROM spend_entries WHERE workspace_id = ? ORDER BY day DESC, created_at DESC LIMIT 100', ws.id);
    const sources = all(db, 'SELECT DISTINCT source k FROM tracking_links WHERE workspace_id = ? AND source IS NOT NULL', ws.id);
    const body = `<h1>Расходы</h1>
<p class="sub">Без расходов не будет ни CPS, ни стоимости живого подписчика. Импорт из рекламных кабинетов — не в MVP, вводим руками.</p>
<div class="panel"><form method="post" action="/app/spend">${csrf(c)}<div class="grid2">
<div class="field"><label for="st">Разрез</label><select id="st" name="scope_type">
<option value="source">Источник</option><option value="campaign">Кампания</option><option value="creative">Креатив</option></select></div>
<div class="field"><label for="sv">Значение</label><input id="sv" name="scope_value" list="srcs" required placeholder="yandex_direct">
<datalist id="srcs">${sources.map((s) => `<option value="${H.esc(s.k)}">`).join('')}</datalist></div>
<div class="field"><label for="dy">Дата</label><input id="dy" name="day" type="date" value="${new Date().toISOString().slice(0, 10)}" required></div>
<div class="field"><label for="am">Сумма, ₽</label><input id="am" name="amount" type="number" step="0.01" min="0" required></div>
</div><button>Добавить</button></form></div>
${rows.length ? `<div class="tw"><table><thead><tr><th>Дата</th><th>Разрез</th><th>Значение</th><th class="n">Сумма</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td>${H.esc(r.day)}</td><td>${H.esc(r.scope_type)}</td><td>${H.esc(r.scope_value)}</td>
<td class="n">${V.fmtMoney(r.amount)}</td></tr>`).join('')}</tbody></table></div>`
      : V.emptyState('Расходов пока нет', 'Добавьте хотя бы один — и появится стоимость подписчика.')}`;
    page(c, { title: 'Расходы', active: '/app/spend', body });
  });

  route('POST', /^\/app\/spend$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const amount = parseFloat(form.amount);
      if (isFinite(amount) && amount >= 0 && form.scope_value) {
        run(db, 'INSERT INTO spend_entries (id, workspace_id, scope_type, scope_value, day, amount, currency, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id('sp'), ws.id, form.scope_type || 'source', form.scope_value, form.day, amount, ws.currency || 'RUB', Date.now());
      }
      H.redirect(c.res, '/app/spend');
    });
  });

  // ------------------------------------------------------------ интеграции
  route('GET', /^\/app\/integrations$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const creds = all(db, 'SELECT * FROM ad_platform_credentials WHERE workspace_id = ?', ws.id);
    const convs = all(db, 'SELECT status, COUNT(*) c, MAX(mode) mode FROM conversions WHERE workspace_id = ? GROUP BY status', ws.id);
    const recent = all(db, 'SELECT * FROM conversions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20', ws.id);
    const locked = accounts.checkLimit(db, ws, 'conversions');
    const metrika = creds.find((x) => x.provider === 'yandex_metrika') || null;

    const body = `<h1>Передача конверсий</h1>
<p class="sub">Мы отправляем подписку офлайн-конверсией в Яндекс Метрику. Директ обучается на целях Метрики — отдельного приёмника у него нет, поэтому провайдер Директа это та же загрузка со своей целью и счётчиком.</p>
${locked ? `<div class="warn">${H.esc(locked)}. Кнопка «Сохранить» пока неактивна.
В MVP тариф включает администратор вручную — напишите нам, это займёт минуту.
Проверьте также, что вы в нужном проекте: интеграция настраивается для каждого проекта отдельно,
а конверсии уходят только по каналам этого проекта.</div>` : ''}
<div class="panel"><h3 style="margin-top:0">Настройки</h3>
<form method="post" action="/app/integrations">${csrf(c)}<div class="grid2">
<div class="field"><label for="pv">Провайдер</label><select id="pv" name="provider">
<option value="yandex_metrika" ${metrika ? 'selected' : ''}>Яндекс Метрика</option>
<option value="yandex_direct">Яндекс Директ</option>
<option value="vk_ads">VK Реклама</option></select>
<span class="muted">Директ обучается на целях Метрики — отдельного приёмника у него нет.
VK принимает события в пиксель, токен ему не нужен.</span></div>

<div class="field"><label for="ci">Счётчик Метрики или пиксель VK</label>
<input id="ci" name="counter_id" placeholder="12345678" value="${H.esc(metrika && metrika.counter_id || '')}">
<span class="muted">Для Яндекса — номер счётчика Метрики, для VK — идентификатор пикселя. Не секрет.</span></div>

<div class="field"><label for="gl">Идентификатор цели</label>
<input id="gl" name="goal_id" placeholder="tg_subscription" value="${H.esc(metrika && metrika.goal_id || '')}">
<span class="muted">Строка из настройки цели, например <code>tg_subscription</code>. Не числовой ID и <b>не токен</b>.
Для VK — название события, под которым подписка появится в пикселе.</span></div>

<div class="field"><label for="tk">Токен доступа к API Метрики</label>
<input id="tk" name="token" type="password" autocomplete="off" placeholder="${metrika && metrika.token ? 'сохранён — оставьте пустым, чтобы не менять' : 'y0_... (для VK не нужен)'}">
<span class="muted">${metrika && metrika.token
  ? 'Токен уже сохранён и зашифрован. Введите новый, только если меняете его.'
  : 'Это OAuth-токен Яндекса — он и есть доступ к API Метрики, отдельного «токена Метрики» не существует. ' +
    'Где взять: <a href="/docs/yandex" target="_blank">инструкция</a>. Единственное секретное поле на странице: ' +
    'шифруется при сохранении и больше не показывается. Без него интеграция остаётся в режиме mock и наружу ничего не уходит.'}</span></div>
</div><button ${locked ? 'disabled' : ''}>Сохранить</button></form></div>
${creds.length ? `<div class="tw"><table><thead><tr><th>Провайдер</th><th>Счётчик</th><th>Цель</th><th>Режим</th><th>Токен</th></tr></thead>
<tbody>${creds.map((cr) => `<tr><td>${H.esc(cr.provider)}</td><td>${H.esc(cr.counter_id || '—')}</td><td>${H.esc(cr.goal_id || '—')}</td>
<td><span class="tag ${cr.mode === 'real' ? 'real' : 'mock'}">${H.esc(cr.mode)}</span></td>
<td class="muted">токен: ${cr.token ? 'сохранён, зашифрован' : 'нет'}</td></tr>`).join('')}</tbody></table></div>` : ''}
${convs.length ? `<h2>Очередь конверсий</h2><div class="cards">${convs.map((s) =>
      `<div class="card"><span class="v">${s.c}</span><span class="k">${H.esc(s.status)}</span></div>`).join('')}</div>` : ''}
${recent.length ? `<div class="tw"><table><thead><tr><th>Создана</th><th>Провайдер</th><th>Вид</th><th>Статус</th><th>Режим</th><th>Ошибка</th></tr></thead>
<tbody>${recent.map((r) => `<tr><td>${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
<td>${H.esc(r.provider)}</td><td>${H.esc(r.kind)}</td>
<td>${r.status === 'sent' ? '<span class="tag det">отправлена</span>' : r.status === 'failed' ? '<span class="tag none">ошибка</span>' : r.status === 'skipped' ? '<span class="tag prob">пропущена</span>' : '<span class="tag prob">' + H.esc(r.status) + '</span>'}</td>
<td><span class="tag ${r.mode === 'real' ? 'real' : 'mock'}">${H.esc(r.mode)}</span></td>
<td class="muted">${H.esc((r.error || '').slice(0, 90))}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    page(c, { title: 'Интеграции', active: '/app/integrations', body });
  });

  route('POST', /^\/app\/integrations$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      if (accounts.checkLimit(db, ws, 'conversions')) { H.redirect(c.res, '/app/integrations'); return; }
      const ALLOWED = ['yandex_metrika', 'yandex_direct', 'vk_ads'];
      const provider = ALLOWED.includes(form.provider) ? form.provider : 'yandex_metrika';
      const existing = one(db, 'SELECT * FROM ad_platform_credentials WHERE workspace_id = ? AND provider = ?', ws.id, provider);
      // У VK авторизации нет: достаточно идентификатора пикселя. У Яндекса нужен ещё и токен.
      const hasToken = !!(form.token || (existing && existing.token));
      const mode = provider === 'vk_ads'
        ? (form.counter_id ? 'real' : 'mock')
        : (hasToken && form.counter_id ? 'real' : 'mock');
      const token = form.token ? secrets.encrypt(form.token, cfg.secretKey) : null;
      if (existing) {
        run(db, 'UPDATE ad_platform_credentials SET counter_id = ?, goal_id = ?, token = ?, mode = ? WHERE id = ?',
          form.counter_id || null, form.goal_id || null, token || existing.token, mode, existing.id);
      } else {
        run(db, 'INSERT INTO ad_platform_credentials (id, workspace_id, provider, mode, counter_id, token, goal_id, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id('cred'), ws.id, provider, mode, form.counter_id || null, token, form.goal_id || null, Date.now());
      }
      accounts.audit(db, { workspaceId: ws.id, userId: c.user.id, action: 'integration.save', target: provider, meta: { mode } });
      c.flash = { ok: mode === 'real' ? 'Сохранено. Конверсии будут уходить в Яндекс.' : 'Сохранено в режиме mock: отправки не будет, пока не появится токен и счётчик.' };
      H.redirect(c.res, '/app/integrations');
    });
  });

  // ------------------------------------------------------------------ тариф
  route('GET', /^\/app\/billing$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const plan = accounts.planOf(db, ws);
    const body = `<h1>Тариф</h1>
<p class="sub">Текущий тариф: <b>${H.esc(plan.title)}</b>${ws.plan_expires_at ? ' до ' + new Date(ws.plan_expires_at).toISOString().slice(0, 10) : ''}</p>
<div class="grid2">${Object.entries(accounts.PLANS).map(([key, p]) => `<div class="panel">
<h3 style="margin-top:0">${H.esc(p.title)}</h3><p style="font-size:22px;font-weight:700">${p.price ? p.price + ' ₽/мес' : 'бесплатно'}</p>
<ul class="muted"><li>каналов: ${p.channels}</li><li>ссылок: ${p.links}</li>
<li>передача конверсий: ${p.conversions ? 'есть' : 'нет'}</li><li>хранение данных: ${p.retentionDays} дней</li></ul>
${key === plan.key ? '<span class="tag det">текущий</span>' : '<span class="muted">Оплата в MVP включается вручную: напишите нам, тариф активирует администратор.</span>'}
</div>`).join('')}</div>
<div class="panel"><h3 style="margin-top:0">Оплата</h3>
<p class="muted">Автоматический приём платежей в MVP не подключён — это осознанное решение: на первых двадцати клиентах ручная активация быстрее и дешевле, чем интеграция с платёжным провайдером. Модель тарифов и проверка лимитов уже работают, подключение YooKassa не потребует переделки.</p></div>`;
    page(c, { title: 'Тариф', active: '/app/billing', body });
  });

  // --------------------------------------------------------------- настройки
  route('GET', /^\/app\/settings$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const body = `<h1>Настройки проекта</h1>
<div class="panel"><form method="post" action="/app/settings">${csrf(c)}<div class="grid2">
<div class="field"><label for="nm">Название</label><input id="nm" name="name" value="${H.esc(ws.name)}"></div>
<div class="field"><label for="tz">Таймзона</label><input id="tz" name="timezone" value="${H.esc(ws.timezone)}"></div>
<div class="field"><label for="aw">Окно вероятностной атрибуции, часов</label>
<input id="aw" name="window" type="number" min="1" max="168" value="${ws.attribution_window_hours}">
<span class="muted">Сколько времени назад мы имеем право искать клик, если платформа не сказала источник прямо.</span></div>
</div><button>Сохранить</button></form></div>
<div class="panel"><h3 style="margin-top:0">Демонстрационные данные</h3>
<p class="muted">Создаёт отдельный канал «DEMO» с придуманными кликами и подписками, чтобы увидеть интерфейс до первых реальных событий. Никогда не смешивается с вашими данными: демо живёт в своём канале и помечено во всех отчётах.</p>
<form method="post" action="/app/demo">${csrf(c)}
<button class="${ws.demo_mode ? 'danger' : ''}">${ws.demo_mode ? 'Удалить демо-данные' : 'Включить демо-режим'}</button></form></div>`;
    page(c, { title: 'Настройки', active: '/app/settings', body });
  });

  route('POST', /^\/app\/settings$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const w = Math.min(168, Math.max(1, parseInt(form.window || '72', 10)));
      run(db, 'UPDATE workspaces SET name = ?, timezone = ?, attribution_window_hours = ? WHERE id = ?',
        form.name || ws.name, form.timezone || ws.timezone, w, ws.id);
      c.flash = { ok: 'Сохранено' };
      H.redirect(c.res, '/app/settings');
    });
  });

  route('POST', /^\/app\/demo$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      if (ws.demo_mode) { demo.remove(db, ws); H.redirect(c.res, '/app'); return; }
      return demo.seed(db, ws).then(() => H.redirect(c.res, '/app'));
    });
  });
};
