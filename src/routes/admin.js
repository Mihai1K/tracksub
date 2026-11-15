'use strict';

/** Админка: только для пользователей с флагом is_admin. */

const { one, all } = require('../db');
const H = require('../http');
const V = require('../views');
const dispatcher = require('../conversions/dispatcher');
const pipeline = require('../pipeline');

module.exports = function mount({ db, route, page, requireAuth, checkCsrf, log }) {
  const csrf = (c) => `<input type="hidden" name="csrf" value="${H.esc(c.session ? c.session.csrf : '')}">`;

  function guard(c) {
    if (!requireAuth(c)) return false;
    if (!c.user.is_admin) { c.res.writeHead(403); c.res.end('Доступ только для администратора'); return false; }
    return true;
  }

  route('GET', /^\/admin$/, async (c) => {
    if (!guard(c)) return;
    const counts = {
      'пользователи': one(db, 'SELECT COUNT(*) c FROM users').c,
      'проекты': one(db, 'SELECT COUNT(*) c FROM workspaces').c,
      'каналы': one(db, 'SELECT COUNT(*) c FROM channels').c,
      'подписки': one(db, 'SELECT COUNT(*) c FROM subscriptions').c,
      'события': one(db, 'SELECT COUNT(*) c FROM webhook_events').c,
      'ошибки событий': one(db, 'SELECT COUNT(*) c FROM webhook_events WHERE status = \'failed\'').c,
      'конверсии': one(db, 'SELECT COUNT(*) c FROM conversions').c,
      'конверсии с ошибкой': one(db, 'SELECT COUNT(*) c FROM conversions WHERE status IN (\'failed\',\'retrying\')').c
    };
    const workspaces = all(db,
      'SELECT w.*, (SELECT COUNT(*) FROM channels ch WHERE ch.workspace_id = w.id) channels, ' +
      '(SELECT COUNT(*) FROM subscriptions s JOIN channels ch2 ON ch2.id = s.channel_id WHERE ch2.workspace_id = w.id) subs, ' +
      '(SELECT email FROM users u JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = w.id LIMIT 1) owner ' +
      'FROM workspaces w ORDER BY w.created_at DESC LIMIT 100');
    const failed = all(db, 'SELECT * FROM webhook_events WHERE status = \'failed\' ORDER BY received_at DESC LIMIT 20');
    const convs = all(db, 'SELECT * FROM conversions WHERE status IN (\'failed\',\'retrying\') ORDER BY created_at DESC LIMIT 20');

    const body = `<h1>Админка</h1>
<div class="cards">${Object.entries(counts).map(([k, v]) =>
      `<div class="card"><span class="v">${v}</span><span class="k">${H.esc(k)}</span></div>`).join('')}</div>
<h2>Проекты</h2>
<div class="tw"><table><thead><tr><th>Проект</th><th>Владелец</th><th>Тариф</th><th class="n">каналов</th><th class="n">подписок</th><th></th></tr></thead>
<tbody>${workspaces.map((w) => `<tr><td>${H.esc(w.name)}${w.demo_mode ? ' <span class="tag prob">demo</span>' : ''}</td>
<td class="muted">${H.esc(w.owner || '')}</td><td>${H.esc(w.plan)}</td><td class="n">${w.channels}</td><td class="n">${w.subs}</td>
<td><form method="post" action="/admin/plan" style="margin:0;display:flex;gap:6px">${csrf(c)}
<input type="hidden" name="workspace" value="${H.esc(w.id)}">
<select name="plan"><option value="free">free</option><option value="pro">pro</option><option value="agency">agency</option></select>
<button class="ghost" style="padding:4px 10px">Выдать</button></form></td></tr>`).join('')}</tbody></table></div>
<h2>Упавшие события</h2>
${failed.length ? `<div class="tw"><table><thead><tr><th>Когда</th><th>Ошибка</th><th class="n">попыток</th><th></th></tr></thead>
<tbody>${failed.map((f) => `<tr><td>${new Date(f.received_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
<td class="muted">${H.esc((f.error || '').slice(0, 120))}</td><td class="n">${f.attempts}</td>
<td><form method="post" action="/admin/replay" style="margin:0">${csrf(c)}<input type="hidden" name="raw" value="${H.esc(f.id)}">
<button class="ghost" style="padding:4px 10px">Повторить</button></form></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Упавших событий нет.</p>'}
<h2>Проблемные конверсии</h2>
${convs.length ? `<div class="tw"><table><thead><tr><th>Провайдер</th><th>Статус</th><th class="n">попыток</th><th>Ошибка</th><th></th></tr></thead>
<tbody>${convs.map((cv) => `<tr><td>${H.esc(cv.provider)}</td><td>${H.esc(cv.status)}</td><td class="n">${cv.attempts}</td>
<td class="muted">${H.esc((cv.error || '').slice(0, 100))}</td>
<td><form method="post" action="/admin/conversion-retry" style="margin:0">${csrf(c)}<input type="hidden" name="conversion" value="${H.esc(cv.id)}">
<button class="ghost" style="padding:4px 10px">Повторить</button></form></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Проблемных конверсий нет.</p>'}`;
    page(c, { title: 'Админка', body, ws: null });
  });

  route('POST', /^\/admin\/plan$/, async (c) => {
    if (!guard(c)) return;
    const form = H.parseForm(await H.readBody(c.req));
    if (!checkCsrf(c, form)) { c.res.writeHead(403); c.res.end('CSRF'); return; }
    require('../accounts').setPlan(db, form.workspace, form.plan, form.plan === 'free' ? null : 1, c.user.id);
    H.redirect(c.res, '/admin');
  });

  route('POST', /^\/admin\/replay$/, async (c) => {
    if (!guard(c)) return;
    const form = H.parseForm(await H.readBody(c.req));
    if (!checkCsrf(c, form)) { c.res.writeHead(403); c.res.end('CSRF'); return; }
    const raw = one(db, 'SELECT * FROM webhook_events WHERE id = ?', form.raw);
    if (raw) {
      // Платформу берём из записи события. Угадывание по заголовку ломалось на long polling:
      // там секретного заголовка нет, и телеграмное событие разбиралось адаптером MAX.
      pipeline.process(db, raw.id, pipeline.adapterFor(raw));
    }
    H.redirect(c.res, '/admin');
  });

  route('POST', /^\/admin\/conversion-retry$/, async (c) => {
    if (!guard(c)) return;
    const form = H.parseForm(await H.readBody(c.req));
    if (!checkCsrf(c, form)) { c.res.writeHead(403); c.res.end('CSRF'); return; }
    dispatcher.retry(db, form.conversion);
    await dispatcher.processQueue(db, { limit: 5 });
    H.redirect(c.res, '/admin');
  });
};
