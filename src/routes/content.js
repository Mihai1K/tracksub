'use strict';

/**
 * Раздел «Контент»: лента трендов → сценарий → съёмка.
 * Данные живут в текущем workspace: личный блог и Blogger Market - разные пространства.
 */

const H = require('../http');
const svc = require('../content/service');
const velocity = require('../content/velocity');
const topics = require('../content/topics');
const relevance = require('../content/relevance');
const publications = require('../content/publications');
const notify = require('../content/notify');
const { parseImport } = require('../content/importer');
const scripts = require('../content/scripts');
const presets = require('../content/presets');
const accounts = require('../accounts');
const auth = require('../auth');

const esc = H.esc;
const fmtInt = (n) => (n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const PLATFORM = { telegram: 'Telegram', vk: 'VK', youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', threads: 'Threads', other: 'Другое' };
const PROVIDER = { telegram: 'сбор', vk: 'сбор', youtube: 'сбор', vidiq: 'vidIQ', virale: 'Virale', manual: 'вручную' };
const SCRIPT_STATUS = { draft: 'черновик', approved: 'к съёмке', shot: 'снято', published: 'опубликовано' };
const KIND = { channel: 'канал', search: 'поиск', trending: 'тренды' };

function ago(ts, now) {
  if (!ts) return '—';
  const m = Math.round(((now || Date.now()) - ts) / 60000);
  if (m < 60) return Math.max(m, 1) + ' мин';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' ч';
  return Math.round(h / 24) + ' дн';
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return n + ' ' + (m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many);
};
const sourcesWord = (n) => plural(n, 'источник', 'источника', 'источников');
const TREND = { up: ['↑', 'растёт'], flat: ['→', 'ровно'], down: ['↘', 'замедляется'], stop: ['■', 'остановился'] };
const fmtK = (n) => (n == null ? '—' : n >= 10000 ? (Math.round(n / 100) / 10).toString().replace('.', ',') + 'K' : fmtInt(n));

/** Мини-график просмотров по замерам: видно, растёт ли пост прямо сейчас. */
function sparkline(points) {
  if (!points || points.length < 2) return '';
  const w = 72, h = 18;
  const t0 = points[0].observed_at, t1 = points[points.length - 1].observed_at;
  const vs = points.map((p) => p.views);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const xy = points.map((p) => [
    t1 === t0 ? 0 : ((p.observed_at - t0) / (t1 - t0)) * w,
    hi === lo ? h / 2 : h - ((p.views - lo) / (hi - lo)) * (h - 2) - 1
  ]);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Рост просмотров по ${points.length} замерам" style="vertical-align:middle">` +
    `<polyline fill="none" stroke="var(--accent)" stroke-width="1.6" points="${xy.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/></svg>`;
}

function velocityLine(it, points) {
  if (it.velocity == null) return '';
  const parts = [];
  const v = `<b>⚡ ${fmtK(Math.round(it.velocity))}/ч</b>` + (it.velocity_kind === 'average' ? ' <span class="muted">в среднем с публикации</span>' : '');
  parts.push(`<span title="${esc(it.velocity_note || 'просмотров в час между последними замерами')}">${v}</span>`);
  if (it.velocity_ratio != null) {
    const cls = it.velocity_ratio >= 3 ? 'det' : it.velocity_ratio >= 1.5 ? 'prob' : 'neutral';
    parts.push(`<span class="tag ${cls}" title="скорость относительно обычной скорости свежих постов этого канала">×${String(it.velocity_ratio).replace('.', ',')} к норме канала</span>`);
  }
  if (it.trend && TREND[it.trend]) parts.push(`<span title="текущая скорость против предыдущего замера">${TREND[it.trend][0]} ${TREND[it.trend][1]}</span>`);
  if (it.delta_views != null && it.delta_hours) parts.push(`<span>+${fmtK(it.delta_views)} за ${String(it.delta_hours).replace('.', ',')} ч</span>`);
  const sp = sparkline(points);
  if (sp) parts.push(sp);
  return `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--ink2);margin:0 0 8px">${parts.join('')}</div>`;
}

/** Метка релевантности: видно, почему пост «наш» или нет (подсказка при наведении). */
function relevanceTag(it) {
  if (it.relevance == null) return '';
  const pct = Math.round(it.relevance * 100) + '%';
  const [cls, text] = it.relevance_label === 'on' ? ['det', 'наше ' + pct] : it.relevance_label === 'maybe' ? ['neutral', 'может быть ' + pct] : ['none', 'не наше'];
  return `<span class="tag ${cls}" title="${esc(it.relevance_why || '')}">${text}</span>`;
}

function outlierTag(it) {
  if (it.outlier == null) return '<span class="tag neutral" title="' + esc(it.score_note || '') + '">нет оценки</span>';
  const x = String(it.outlier).replace('.', ',');
  const cls = it.outlier >= 3 ? 'det' : it.outlier >= 1.5 ? 'prob' : 'neutral';
  return `<span class="tag ${cls}" title="${esc(it.score_note || '')}">×${esc(x)}</span>`;
}

module.exports = function mount(opts) {
  const { db, route, page, requireAuth, currentWorkspace, checkCsrf, log, cfg, fetchImpl } = opts;
  const csrf = (c) => `<input type="hidden" name="csrf" value="${esc(c.session ? c.session.csrf : '')}">`;
  const running = new Set();

  function guard(c) {
    if (!requireAuth(c)) return null;
    const ws = currentWorkspace(c);
    if (!ws) { H.redirect(c.res, '/register'); return null; }
    return ws;
  }

  async function post(c, handler) {
    const form = H.parseForm(await H.readBody(c.req, 2 * 1024 * 1024));
    if (!checkCsrf(c, form)) { c.res.writeHead(403); c.res.end('CSRF'); return null; }
    return handler(form);
  }

  function back(c, path, flash) {
    if (flash) c.flash = flash;
    H.redirect(c.res, path);
  }

  function subnav(active) {
    const tabs = [['/app/content', 'Лента трендов'], ['/app/content/topics', 'Темы'], ['/app/content/scripts', 'Сценарии'], ['/app/content/results', 'Результаты'], ['/app/content/sources', 'Источники'],
      ['/app/content/import', 'Импорт vidIQ / Virale'], ['/app/content/settings', 'Профиль автора']];
    return `<nav class="main" style="margin:0 0 20px;border-bottom:1px solid var(--line);padding-bottom:2px">${tabs.map(([h, l]) =>
      `<a href="${h}" class="${active === h ? 'on' : ''}">${esc(l)}</a>`).join('')}</nav>`;
  }

  function header(ws, active, sub) {
    return `<h1>Контент · ${esc(ws.name)}</h1><p class="sub">${sub}</p>${subnav(active)}`;
  }

  // ------------------------------------------------------------------- лента
  route('GET', /^\/app\/content$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const p = c.url.searchParams;
    const filters = {
      days: Math.min(90, Math.max(1, parseInt(p.get('days') || '14', 10))),
      platform: PLATFORM[p.get('platform')] ? p.get('platform') : '',
      status: svc.STATUSES.includes(p.get('status')) ? p.get('status') : '',
      q: String(p.get('q') || '').trim().slice(0, 80),
      sort: ['velocity', 'fresh'].includes(p.get('sort')) ? p.get('sort') : '',
      rel: ['on', 'all'].includes(p.get('rel')) ? p.get('rel') : ''
    };
    const st = svc.stats(db, ws.id);
    // Избранное хранится, пока его не убрали: фильтр периода к нему не применяем.
    const items = svc.feed(db, ws.id, Object.assign({}, filters, filters.status === 'picked' ? { days: null } : {}));
    const settings = svc.getSettings(db, ws.id);
    const now = Date.now();

    const cards = `<div class="cards">
<div class="card"><span class="v">${st.hot}</span><span class="k">залётных за 7 дней (×2 и выше)</span></div>
<div class="card"><span class="v">${st.items7d}</span><span class="k">постов собрано за 7 дней</span></div>
<div class="card"><span class="v">${st.sources}</span><span class="k">источников${st.failing ? `</span><span class="note">с ошибкой: ${st.failing}` : ''}</span></div>
<div class="card"><span class="v">${st.scripts}</span><span class="k">сценариев в работе</span></div>
<a class="card" href="/app/content?status=picked" style="text-decoration:none;color:inherit"><span class="v">★ ${st.favorites}</span><span class="k">в избранном</span></a></div>`;

    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    const filterForm = `<form class="inline panel" method="get" action="/app/content" style="padding:14px 16px">
<div><label>Период</label><select name="days">${[[3, '3 дня'], [7, '7 дней'], [14, '14 дней'], [30, '30 дней'], [90, '90 дней']].map(([v, l]) => opt(String(v), l, String(filters.days))).join('')}</select></div>
<div><label>Площадка</label><select name="platform">${opt('', 'Все', filters.platform)}${Object.entries(PLATFORM).map(([v, l]) => opt(v, l, filters.platform)).join('')}</select></div>
<div><label>Статус</label><select name="status">${opt('', 'Все, кроме архива', filters.status)}${opt('new', 'Новые', filters.status)}${opt('picked', '★ Избранное', filters.status)}${opt('archived', 'Архив', filters.status)}</select></div>
<div><label>Релевантность</label><select name="rel">${opt('', 'Без «не нашего»', filters.rel)}${opt('on', 'Только наше', filters.rel)}${opt('all', 'Все посты', filters.rel)}</select></div>
<div><label>Сортировка</label><select name="sort">${opt('', 'По залётности', filters.sort)}${opt('velocity', 'По скорости роста', filters.sort)}${opt('fresh', 'Сначала свежие', filters.sort)}</select></div>
<div style="flex:1;min-width:160px"><label>Поиск</label><input name="q" value="${esc(filters.q)}" placeholder="слово в тексте или автор"></div>
<div><button>Показать</button></div></form>`;

    const empty = !st.sources && !items.length
      ? `<div class="panel empty"><h3>Лента пока пустая</h3><p>Добавьте каналы Telegram, паблики VK и запросы YouTube - система будет собирать посты и считать, какие залетели. Или вставьте выдачу vidIQ / Virale.</p>
<a class="btn" href="/app/content/sources">Добавить источники</a> <a class="btn ghost" href="/app/content/import">Импорт</a></div>`
      : (!items.length ? '<div class="panel empty"><h3>Ничего не найдено</h3><p>Поменяйте фильтры или запустите сбор на странице источников.</p></div>' : '');

    const list = items.map((it) => `<div class="panel" style="padding:14px 18px">
<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
${outlierTag(it)}${relevanceTag(it)}<span class="tag neutral">${esc(PLATFORM[it.platform] || it.platform)}</span>
<span class="muted">${esc(it.author || it.source_handle || '')} · ${ago(it.published_at, now)} назад · ${PROVIDER[it.provider] || esc(it.provider)}</span>
${it.status === 'picked' ? '<span class="tag prob">★ избранное</span>' : ''}${it.topic_id && it.topic_sources >= 2 ? `<a class="tag det" style="text-decoration:none" href="/app/content/topics#${esc(it.topic_id)}" title="об этом пишут и другие источники">тема · ${sourcesWord(it.topic_sources)}</a>` : ''}${it.scripts ? `<span class="tag det">сценариев: ${it.scripts}</span>` : ''}</div>
<div style="font-weight:600;margin-bottom:4px"><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--ink)">${esc(it.title || it.url)}</a></div>
${it.body && it.body !== it.title ? `<div class="muted" style="white-space:pre-line;max-height:4.6em;overflow:hidden;margin-bottom:8px">${esc(it.body.slice(0, 400))}</div>` : ''}
${velocityLine(it, velocity.series(db, it.id))}
<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--ink2)">
<span>👁 ${fmtInt(it.views)}</span><span>❤ ${fmtInt(it.likes)}</span>${it.comments != null ? `<span>💬 ${fmtInt(it.comments)}</span>` : ''}${it.shares != null ? `<span>↻ ${fmtInt(it.shares)}</span>` : ''}
${it.er != null ? `<span>вовлечённость ${(it.er * 100).toFixed(1).replace('.', ',')}%</span>` : ''}
${it.score_note ? `<span class="muted">${esc(it.score_note)}</span>` : ''}
<span class="spacer" style="flex:1"></span>
<form method="post" action="/app/content/items/${esc(it.id)}/script" style="margin:0;display:flex;gap:6px">${csrf(c)}
<select name="format" style="width:auto;padding:5px 8px"><option value="short">Короткий</option><option value="long">Большой</option></select>
<button style="padding:5px 12px">Сценарий</button></form>
<a class="btn ghost" style="padding:5px 12px" href="/app/content/items/${esc(it.id)}/prompt">Промпт</a>
<form method="post" action="/app/content/items/${esc(it.id)}/rate" style="margin:0;display:flex;gap:2px">${csrf(c)}
<button class="ghost" name="v" value="up" style="padding:5px 8px" title="Наше: такие темы показывать выше" aria-label="Наше">👍</button>
<button class="ghost" name="v" value="down" style="padding:5px 8px" title="Не наше: такие темы прятать" aria-label="Не наше">👎</button></form>
<form method="post" action="/app/content/items/${esc(it.id)}/status" style="margin:0">${csrf(c)}
<input type="hidden" name="status" value="${it.status === 'picked' ? 'new' : 'picked'}"><button class="ghost" style="padding:5px 12px" title="${it.status === 'picked' ? 'Убрать из избранного' : 'Сохранить в избранное'}">${it.status === 'picked' ? '★ В избранном' : '☆ В избранное'}</button></form>
<form method="post" action="/app/content/items/${esc(it.id)}/status" style="margin:0">${csrf(c)}
<input type="hidden" name="status" value="${it.status === 'archived' ? 'new' : 'archived'}"><button class="ghost" style="padding:5px 12px">${it.status === 'archived' ? 'Вернуть' : 'В архив'}</button></form>
</div></div>`).join('');

    const profileHint = !settings.author && !settings.audience
      ? '<div class="warn">Заполните <a href="/app/content/settings">профиль автора</a>: без него сценарии получатся общими.</div>' : '';

    page(c, { title: 'Контент', active: '/app/content', body:
      header(ws, '/app/content', 'Что сейчас залетает у каналов и пабликов вашей ниши. «×3» - пост набрал в 3 раза больше просмотров, чем обычно у этого канала.') +
      profileHint + cards + filterForm + empty + list });
  });

  route('POST', /^\/app\/content\/items\/([A-Za-z0-9_-]+)\/status$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      svc.setItemStatus(db, ws.id, m[1], form.status);
      back(c, c.req.headers.referer && c.req.headers.referer.includes('/app/content') ? new URL(c.req.headers.referer).pathname + new URL(c.req.headers.referer).search : '/app/content');
    });
  });

  route('POST', /^\/app\/content\/items\/([A-Za-z0-9_-]+)\/rate$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const ok = relevance.rate(db, ws.id, m[1], form.v === 'up');
      if (ok) relevance.recompute(db, ws.id, svc.getSettings(db, ws.id));
      const ref = c.req.headers.referer && c.req.headers.referer.includes('/app/content') ? new URL(c.req.headers.referer) : null;
      back(c, ref ? ref.pathname + ref.search : '/app/content', ok ? { ok: form.v === 'up' ? 'Запомнил: такие темы - ваши' : 'Запомнил: такие темы прячу' } : { error: 'Пост не найден' });
    });
  });

  route('POST', /^\/app\/content\/items\/([A-Za-z0-9_-]+)\/script$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async (form) => {
      const item = svc.getItem(db, ws.id, m[1]);
      if (!item) { back(c, '/app/content', { error: 'Пост не найден' }); return; }
      const format = form.format === 'long' ? 'long' : 'short';
      const s = await scripts.generate(item, svc.getSettings(db, ws.id), format,
        { apiKey: cfg.content.anthropicKey, model: cfg.content.anthropicModel, fetch: fetchImpl });
      const sid = svc.createScript(db, ws.id, item.id, s, format);
      accounts.audit(db, { workspaceId: ws.id, userId: c.user.id, action: 'content.script.create', target: sid, meta: { generator: s.generator } });
      back(c, '/app/content/scripts/' + sid, s.warning ? { error: s.warning } :
        { ok: s.generator === 'llm' ? 'Сценарий написан Claude. Проверьте факты и поставьте свои примеры.' : 'Каркас сценария готов: заполните места [вставь ...] своими примерами.' });
    });
  });

  route('GET', /^\/app\/content\/items\/([A-Za-z0-9_-]+)\/prompt$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    const item = svc.getItem(db, ws.id, m[1]);
    if (!item) { back(c, '/app/content', { error: 'Пост не найден' }); return; }
    const format = c.url.searchParams.get('format') === 'long' ? 'long' : 'short';
    const settings = svc.getSettings(db, ws.id);
    const prompt = scripts.buildPrompt(item, settings, format);
    page(c, { title: 'Промпт для сценария', active: '/app/content', body: header(ws, '/app/content',
      'Скопируйте промпт в Claude или ChatGPT, ответ вставьте ниже - получится сценарий в разделе «Сценарии».') +
      `<div class="panel"><h3 style="margin-top:0">${esc(item.title || item.url)}</h3>
<p class="muted"><a href="?format=short">короткий ролик</a> · <a href="?format=long">большой ролик</a></p>
<textarea class="copy" rows="16" readonly onclick="this.select()">${esc('Правила: ' + 'не выдумывай факты и цифры, где нужен личный опыт - пиши [вставь ...]; только обычный дефис, без длинного тире.\n\n' + prompt)}</textarea></div>
<form class="panel" method="post" action="/app/content/items/${esc(item.id)}/manual">${csrf(c)}
<input type="hidden" name="format" value="${format}">
<h3 style="margin-top:0">Ответ модели</h3>
<div class="field"><label>Название</label><input name="title" required maxlength="200"></div>
<div class="field"><label>Хуки, по одному в строке</label><textarea name="hooks" rows="3"></textarea></div>
<div class="field"><label>Текст ролика</label><textarea name="body" rows="10" required></textarea></div>
<div class="field"><label>Раскадровка</label><textarea name="shot_list" rows="5"></textarea></div>
<div class="field"><label>Призыв</label><input name="cta"></div>
<button>Сохранить сценарий</button></form>` });
  });

  route('POST', /^\/app\/content\/items\/([A-Za-z0-9_-]+)\/manual$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const item = svc.getItem(db, ws.id, m[1]);
      if (!item) { back(c, '/app/content', { error: 'Пост не найден' }); return; }
      if (!String(form.title || '').trim() || !String(form.body || '').trim()) { back(c, '/app/content/items/' + item.id + '/prompt', { error: 'Нужны название и текст' }); return; }
      const sid = svc.createScript(db, ws.id, item.id, {
        title: scripts.noDash(form.title).slice(0, 200), hooks: scripts.noDash(form.hooks), body: scripts.noDash(form.body),
        shot_list: scripts.noDash(form.shot_list), cta: scripts.noDash(form.cta), generator: 'manual'
      }, form.format);
      back(c, '/app/content/scripts/' + sid, { ok: 'Сценарий сохранён' });
    });
  });

  // ------------------------------------------------------------------- темы
  route('GET', /^\/app\/content\/topics$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const days = [1, 3, 7].includes(parseInt(c.url.searchParams.get('days'), 10)) ? parseInt(c.url.searchParams.get('days'), 10) : 3;
    const archived = c.url.searchParams.get('status') === 'archived';
    const rel = ['on', 'all'].includes(c.url.searchParams.get('rel')) ? c.url.searchParams.get('rel') : '';
    const list = topics.listTopics(db, ws.id, { days, minSources: 2, status: archived ? 'archived' : 'active', rel });
    const now = Date.now();
    const cards = list.map((tp) => {
      const items = topics.topicItems(db, ws.id, tp.id);
      const fav = items.some((i) => i.status === 'picked');
      return `<div class="panel" id="${esc(tp.id)}" style="padding:14px 18px">
<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
<span class="tag det" title="температура: источники × просмотры × свежесть × разгон">🔥 ${String(Math.round(tp.heat)).replace('.', ',')}</span>
<span class="tag neutral">${sourcesWord(tp.sources_count)}</span>
${tp.platforms.split(',').filter(Boolean).map((pl) => `<span class="tag neutral">${esc(PLATFORM[pl] || pl)}</span>`).join('')}
${tp.max_ratio ? `<span class="tag ${tp.max_ratio >= 3 ? 'det' : 'prob'}" title="лучший разгон поста темы относительно нормы его канала">×${String(tp.max_ratio).replace('.', ',')} к норме</span>` : ''}
<span class="muted">первый пост ${ago(tp.first_seen_at, now)} назад, последний ${ago(tp.last_seen_at, now)} назад</span>
${fav ? '<span class="tag prob">★ избранное</span>' : ''}${tp.relevance != null ? relevanceTag({ relevance: tp.relevance, relevance_label: tp.relevance >= relevance.LABEL_ON ? 'on' : tp.relevance >= relevance.LABEL_MAYBE ? 'maybe' : 'off', relevance_why: 'по самому подходящему посту темы' }) : ''}</div>
<div style="font-weight:600;margin-bottom:6px">${esc(tp.title || 'Без заголовка')}</div>
<div style="font-size:13px;color:var(--ink2);margin-bottom:8px">👁 ${fmtK(tp.views_sum)} суммарно${tp.velocity_sum ? ` · ⚡ ${fmtK(Math.round(tp.velocity_sum))}/ч на всех` : ''}</div>
<ul style="margin:0 0 10px;padding-left:18px;font-size:14px">${items.map((i) => `<li style="margin:3px 0">
<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc((i.title || i.url).slice(0, 120))}</a>
<span class="muted"> · ${esc(i.author || i.source_handle || '')} · 👁 ${fmtK(i.views)}${i.velocity != null ? ' · ⚡ ' + fmtK(Math.round(i.velocity)) + '/ч' : ''}</span>
${`<form method="post" action="/app/content/topics/${esc(tp.id)}/split" style="display:inline;margin:0">${csrf(c)}<input type="hidden" name="item" value="${esc(i.id)}"><button class="ghost" style="padding:0 6px;font-size:12px;border:none" title="Убрать пост из темы: он про другое">не про это</button></form>`}</li>`).join('')}</ul>
<div style="display:flex;gap:8px;flex-wrap:wrap">
<form method="post" action="/app/content/topics/${esc(tp.id)}/script" style="margin:0;display:flex;gap:6px">${csrf(c)}
<select name="format" style="width:auto;padding:5px 8px"><option value="short">Короткий</option><option value="long">Большой</option></select><button style="padding:5px 12px">Сценарий по теме</button></form>
<form method="post" action="/app/content/topics/${esc(tp.id)}/favorite" style="margin:0">${csrf(c)}<input type="hidden" name="on" value="${fav ? '0' : '1'}"><button class="ghost" style="padding:5px 12px">${fav ? '★ В избранном' : '☆ В избранное'}</button></form>
<form method="post" action="/app/content/topics/${esc(tp.id)}/status" style="margin:0">${csrf(c)}<input type="hidden" name="status" value="${archived ? 'active' : 'archived'}"><button class="ghost" style="padding:5px 12px">${archived ? 'Вернуть' : 'Скрыть тему'}</button></form>
</div></div>`;
    }).join('');
    page(c, { title: 'Темы', active: '/app/content', body: header(ws, '/app/content/topics',
      'Инфоповоды, о которых пишут сразу несколько независимых источников. Чем больше источников, просмотров и разгон - тем горячее тема.') +
      `<p class="muted">${[1, 3, 7].map((d) => `<a href="/app/content/topics?days=${d}" style="margin-right:12px;${d === days && !archived ? 'font-weight:700' : ''}">за ${d === 1 ? 'сутки' : d === 3 ? '3 дня' : '7 дней'}</a>`).join('')}<a href="/app/content/topics?status=archived&days=7" style="margin-right:12px;${archived ? 'font-weight:700' : ''}">скрытые</a>
<a href="/app/content/topics?days=${days}&rel=${rel === 'all' ? '' : 'all'}">${rel === 'all' ? 'спрятать «не наше»' : 'показать и «не наше»'}</a></p>` +
      (list.length ? cards : '<div class="panel empty"><h3>Пока нет общих тем</h3><p>Тема появляется, когда минимум два разных источника пишут об одном событии. Склейка обновляется после каждого сбора.</p></div>') });
  });

  route('POST', /^\/app\/content\/topics\/([A-Za-z0-9_-]+)\/split$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const n = topics.splitItem(db, ws.id, m[1], form.item);
      back(c, '/app/content/topics#' + m[1], n ? { ok: 'Пост убран из темы и больше в неё не попадёт' } : { error: 'Не найдено' });
    });
  });

  route('POST', /^\/app\/content\/topics\/([A-Za-z0-9_-]+)\/status$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => { topics.setTopicStatus(db, ws.id, m[1], form.status); back(c, '/app/content/topics'); });
  });

  route('POST', /^\/app\/content\/topics\/([A-Za-z0-9_-]+)\/favorite$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const tp = topics.getTopic(db, ws.id, m[1]);
      if (!tp) { back(c, '/app/content/topics', { error: 'Тема не найдена' }); return; }
      // В избранное попадает главный пост темы; снять - со всех постов темы.
      if (form.on === '1') svc.setItemStatus(db, ws.id, tp.primary_item_id, 'picked');
      else for (const i of topics.topicItems(db, ws.id, tp.id)) if (i.status === 'picked') svc.setItemStatus(db, ws.id, i.id, 'new');
      back(c, '/app/content/topics#' + tp.id);
    });
  });

  route('POST', /^\/app\/content\/topics\/([A-Za-z0-9_-]+)\/script$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async (form) => {
      const tp = topics.getTopic(db, ws.id, m[1]);
      const primary = tp && svc.getItem(db, ws.id, tp.primary_item_id);
      if (!primary) { back(c, '/app/content/topics', { error: 'Тема не найдена' }); return; }
      const others = topics.topicItems(db, ws.id, tp.id).filter((i) => i.id !== primary.id);
      // Сценарий по теме: опора - главный пост, остальные источники - как контекст для модели и автора.
      const item = Object.assign({}, primary, { body: (primary.body || primary.title || '') +
        (others.length ? '\n\nОб этом же пишут:\n' + others.map((i) => '- ' + (i.author || '') + ': ' + (i.title || '') + ' (' + i.url + ')').join('\n') : '') });
      const format = form.format === 'long' ? 'long' : 'short';
      const sc = await scripts.generate(item, svc.getSettings(db, ws.id), format,
        { apiKey: cfg.content.anthropicKey, model: cfg.content.anthropicModel, fetch: fetchImpl });
      if (others.length) sc.body += '\n\nДругие источники темы:\n' + others.map((i) => '- ' + (i.author || '') + ': ' + i.url).join('\n');
      const sid = svc.createScript(db, ws.id, primary.id, sc, format, { topicId: tp.id });
      back(c, '/app/content/scripts/' + sid, sc.warning ? { error: sc.warning } : { ok: 'Сценарий по теме готов: опора - главный пост, остальные источники - внизу текста.' });
    });
  });

  // -------------------------------------------------------------- источники
  route('GET', /^\/app\/content\/sources$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const list = svc.listSources(db, ws.id);
    const now = Date.now();
    const keys = [
      ['Telegram', true, 'публичная веб-версия t.me/s, ключ не нужен' + (cfg.content.tgWebBase !== 'https://t.me' ? ' (через ' + esc(new URL(cfg.content.tgWebBase).host) + ')' : '')],
      ['VK', !!cfg.content.vkToken, cfg.content.vkToken ? 'сервисный ключ задан' : 'нужен VK_SERVICE_TOKEN'],
      ['YouTube', !!cfg.content.youtubeKey, cfg.content.youtubeKey ? 'ключ API задан' : 'нужен YOUTUBE_API_KEY'],
      ['Сценарии Claude', !!cfg.content.anthropicKey, cfg.content.anthropicKey ? 'ключ задан' : 'без ключа: каркас по шаблону + промпт для чата']
    ];
    const rows = list.map((s) => `<tr>
<td><span class="tag neutral">${esc(PLATFORM[s.platform])}</span> <span class="muted">${esc(KIND[s.kind])}</span></td>
<td><b>${esc(s.title || s.handle)}</b><br><span class="muted">${esc(s.kind === 'channel' ? s.handle : s.handle)}${s.niche ? ' · ' + esc(s.niche) : ''}</span></td>
<td class="n">${fmtInt(s.subscribers)}</td><td class="n">${fmtInt(s.items)}</td>
<td>${s.last_error ? `<span class="tag none">ошибка</span> <span class="muted">${esc(s.last_error)}</span>` : s.last_success_at ? `<span class="tag det">ок</span> <span class="muted">${ago(s.last_success_at, now)} назад, +${s.last_count}</span>` : '<span class="tag neutral">ещё не собирали</span>'}
${s.is_active ? '' : ' <span class="tag prob">на паузе</span>'}</td>
<td style="white-space:nowrap"><form method="post" action="/app/content/sources/${esc(s.id)}/collect" style="display:inline">${csrf(c)}<button class="ghost" style="padding:3px 9px">Собрать</button></form>
<form method="post" action="/app/content/sources/${esc(s.id)}/toggle" style="display:inline">${csrf(c)}<button class="ghost" style="padding:3px 9px">${s.is_active ? 'Пауза' : 'Включить'}</button></form>
<form method="post" action="/app/content/sources/${esc(s.id)}/delete" style="display:inline" onsubmit="return confirm('Убрать источник? Собранные посты останутся в ленте.')">${csrf(c)}<button class="ghost" style="padding:3px 9px">Убрать</button></form></td></tr>`).join('');

    page(c, { title: 'Источники контента', active: '/app/content', body: header(ws, '/app/content/sources',
      'Откуда собирать посты. Автоматический сбор - каждые ' + cfg.content.fetchHours + ' ч' + (cfg.content.collector ? '' : ' (сейчас выключен: CONTENT_COLLECTOR=off)') + '.') +
      `<div class="grid2"><form class="panel" method="post" action="/app/content/sources">${csrf(c)}
<h3 style="margin-top:0">Добавить источники</h3>
<div class="field"><label>По одному в строке</label><textarea name="lines" rows="7" placeholder="https://t.me/channel или @channel
https://vk.com/public_name
https://youtube.com/@channel
yt: реклама у блогеров   (поиск YouTube за 14 дней)
yt: тренды RU            (тренды YouTube по России)"></textarea></div>
<div class="field"><label>Ниша (необязательно)</label><input name="niche" placeholder="маркетинг, ИИ, бизнес…"></div>
<button>Добавить</button></form>
<div class="panel"><h3 style="margin-top:0">Подключения</h3><ul class="steps">${keys.map(([n, ok, t]) =>
  `<li class="${ok ? 'done' : ''}"><span class="dot">${ok ? '✓' : '!'}</span><span><b>${esc(n)}</b><span>${t}</span></span></li>`).join('')}</ul>
<h3>Стартовые наборы</h3><p class="muted">Проверенные публичные каналы по нишам - добавятся в этот проект, лишнее можно убрать.</p>
${presets.PACKS.map((pk) => `<form method="post" action="/app/content/sources/preset" style="display:inline-block;margin:0 6px 6px 0">${csrf(c)}<input type="hidden" name="pack" value="${esc(pk.id)}"><button class="ghost" style="padding:4px 10px">${esc(pk.title)} · ${pk.lines.length}</button></form>`).join('')}
</div></div>
<div style="display:flex;align-items:center;gap:12px;margin:10px 0 12px"><h2 style="margin:0">Источники · ${list.length}</h2>
${list.length ? `<form method="post" action="/app/content/sources/collect" style="margin:0">${csrf(c)}<button ${running.has(ws.id) ? 'disabled' : ''}>${running.has(ws.id) ? 'Сбор идёт…' : 'Собрать все сейчас'}</button></form>` : ''}</div>
${list.length ? `<div class="tw"><table><thead><tr><th>Площадка</th><th>Источник</th><th class="n">Подписчики</th><th class="n">Постов</th><th>Последний сбор</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="panel empty"><p>Источников пока нет.</p></div>'}` });
  });

  route('POST', /^\/app\/content\/sources$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const r = svc.addSources(db, ws.id, form.lines, form.niche);
      const msg = 'Добавлено: ' + r.added + (r.existed ? ', уже были: ' + r.existed : '');
      back(c, '/app/content/sources', r.bad.length ? { error: msg + '. Не распознаны: ' + r.bad.slice(0, 5).join(', ') } : { ok: msg + '. Нажмите «Собрать все сейчас» или дождитесь автосбора.' });
    });
  });

  route('POST', /^\/app\/content\/sources\/preset$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const pk = presets.PACKS.find((p) => p.id === form.pack);
      if (!pk) { back(c, '/app/content/sources', { error: 'Набор не найден' }); return; }
      const r = svc.addSources(db, ws.id, pk.lines.join('\n'), pk.niche);
      back(c, '/app/content/sources', { ok: 'Набор «' + pk.title + '»: добавлено ' + r.added + (r.existed ? ', уже были ' + r.existed : '') });
    });
  });

  function startCollect(ws, sourceId) {
    if (running.has(ws.id)) return false;
    running.add(ws.id);
    const opts = { cfg, fetch: fetchImpl, log };
    const job = sourceId
      ? (async () => { const s = svc.getSource(db, ws.id, sourceId); return s ? [await svc.collectSource(db, s, opts)] : []; })()
      : svc.collectWorkspace(db, ws.id, opts);
    const done = job.then((res) => log('info', 'content collect done', { workspace: ws.id, sources: res.length, failed: res.filter((r) => !r.ok).length }))
      .catch((e) => log('error', 'content collect failed', { workspace: ws.id, error: String(e.message) }))
      .finally(() => running.delete(ws.id));
    return done;
  }

  route('POST', /^\/app\/content\/sources\/collect$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async (form) => {
      const job = startCollect(ws);
      if (!job) { back(c, '/app/content/sources', { error: 'Сбор уже идёт' }); return; }
      if (form.wait === '1') await job; // для тестов и коротких списков
      back(c, '/app/content/sources', { ok: form.wait === '1' ? 'Сбор завершён' : 'Сбор запущен. Обновите страницу через минуту.' });
    });
  });

  route('POST', /^\/app\/content\/sources\/([A-Za-z0-9_-]+)\/collect$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async () => {
      const s = svc.getSource(db, ws.id, m[1]);
      if (!s) { back(c, '/app/content/sources', { error: 'Источник не найден' }); return; }
      if (running.has(ws.id)) { back(c, '/app/content/sources', { error: 'Сбор уже идёт' }); return; }
      running.add(ws.id);
      try {
        const r = await svc.collectSource(db, s, { cfg, fetch: fetchImpl, log });
        back(c, '/app/content/sources', r.ok ? { ok: (s.title || s.handle) + ': постов ' + r.count + (r.sampleSize != null && s.kind === 'channel' ? ', медиана по ' + r.sampleSize + ' постам: ' + fmtInt(r.baseline) : '') } : { error: (s.title || s.handle) + ': ' + r.error });
      } finally { running.delete(ws.id); }
    });
  });

  route('POST', /^\/app\/content\/sources\/([A-Za-z0-9_-]+)\/toggle$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, () => {
      const s = svc.getSource(db, ws.id, m[1]);
      if (s) svc.setSourceActive(db, ws.id, s.id, !s.is_active);
      back(c, '/app/content/sources');
    });
  });

  route('POST', /^\/app\/content\/sources\/([A-Za-z0-9_-]+)\/delete$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, () => {
      const n = svc.deleteSource(db, ws.id, m[1]);
      back(c, '/app/content/sources', n ? { ok: 'Источник убран, посты остались в ленте' } : { error: 'Источник не найден' });
    });
  });

  // ------------------------------------------------------------------ импорт
  route('GET', /^\/app\/content\/import$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    page(c, { title: 'Импорт референсов', active: '/app/content', body: header(ws, '/app/content/import',
      'vidIQ и ChatPlace Virale без API-ключа: вставьте их выдачу сюда. Посты попадут в общую ленту и получат оценку залётности.') +
      `<div class="grid2"><form class="panel" method="post" action="/app/content/import">${csrf(c)}
<div class="field"><label>Откуда</label><select name="provider"><option value="vidiq">vidIQ</option><option value="virale">ChatPlace Virale</option><option value="manual">Другое / свои ссылки</option></select></div>
<div class="field"><label>Данные: JSON, CSV/TSV с заголовком или ссылки построчно</label><textarea name="data" rows="14" required placeholder='[{"url":"https://youtube.com/watch?v=…","title":"…","views":120000,"subscribers":8000}]'></textarea></div>
<button>Импортировать</button></form>
<div class="panel"><h3 style="margin-top:0">Как забрать данные</h3>
<p><b>vidIQ.</b> В чате с подключённым vidIQ попросите: «найди outliers по теме … за 14 дней и выдай JSON: url, title, views, subscribers, published_at, outlier». Ответ вставьте слева.</p>
<p><b>ChatPlace Virale.</b> Скопируйте ссылки понравившихся роликов из ленты (по одной в строке, можно с заметкой после ссылки) или таблицу, если есть экспорт. Когда появится API-ключ, подключим ленту напрямую.</p>
<p class="muted">Колонки понимаются гибко: url/link, title/caption, views/plays, likes, comments, author/channel, subscribers/followers, published_at/date, score/outlier. Повторная вставка обновляет цифры, а не дублирует.</p></div></div>` });
  });

  route('POST', /^\/app\/content\/import$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const provider = ['vidiq', 'virale', 'manual'].includes(form.provider) ? form.provider : 'manual';
      let parsed;
      try { parsed = parseImport(form.data, provider); } catch (e) { back(c, '/app/content/import', { error: e.message }); return; }
      if (!parsed.items.length) { back(c, '/app/content/import', { error: 'Не нашлось ни одной ссылки' + (parsed.skipped ? ' (пропущено строк: ' + parsed.skipped + ')' : '') }); return; }
      const n = svc.importItems(db, ws.id, parsed, provider);
      accounts.audit(db, { workspaceId: ws.id, userId: c.user.id, action: 'content.import', meta: { provider, count: n } });
      back(c, '/app/content?days=90', { ok: 'Импортировано: ' + n + (parsed.skipped ? ', пропущено без ссылки: ' + parsed.skipped : '') });
    });
  });

  // --------------------------------------------------------------- сценарии
  route('GET', /^\/app\/content\/scripts$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const status = c.url.searchParams.get('status') || '';
    const list = svc.listScripts(db, ws.id, status);
    const rows = list.map((s) => `<tr><td><a href="/app/content/scripts/${esc(s.id)}"><b>${esc(s.title)}</b></a><br>
<span class="muted">${s.format === 'long' ? 'большой' : 'короткий'} · ${s.generator === 'llm' ? 'Claude' : s.generator === 'manual' ? 'вручную' : 'шаблон'}${s.item_platform ? ' · по ' + esc(PLATFORM[s.item_platform] || s.item_platform) : ''}</span></td>
<td><span class="tag ${s.status === 'approved' ? 'det' : s.status === 'draft' ? 'prob' : 'neutral'}">${esc(SCRIPT_STATUS[s.status])}</span></td>
<td>${esc(s.shoot_date || '—')}</td><td>${s.published_url ? `<a href="${esc(s.published_url)}" target="_blank" rel="noopener noreferrer">ролик</a>` : '—'}</td></tr>`).join('');
    page(c, { title: 'Сценарии', active: '/app/content', body: header(ws, '/app/content/scripts', 'От идеи до опубликованного ролика: черновик → к съёмке → снято → опубликовано.') +
      `<p class="muted">${['', ...svc.SCRIPT_STATUSES].map((s) => `<a href="/app/content/scripts${s ? '?status=' + s : ''}" style="margin-right:12px;${s === status ? 'font-weight:700' : ''}">${s ? esc(SCRIPT_STATUS[s]) : 'все'}</a>`).join('')}</p>` +
      (list.length ? `<div class="tw"><table><thead><tr><th>Сценарий</th><th>Статус</th><th>Съёмка</th><th>Публикация</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="panel empty"><h3>Сценариев пока нет</h3><p>Выберите залетевший пост в ленте и нажмите «Сценарий».</p><a class="btn" href="/app/content">К ленте</a></div>') });
  });

  route('GET', /^\/app\/content\/scripts\/([A-Za-z0-9_-]+)\.md$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    const s = svc.getScript(db, ws.id, m[1]);
    if (!s) { c.res.writeHead(404); c.res.end('not found'); return; }
    const item = s.item_id ? svc.getItem(db, ws.id, s.item_id) : null;
    c.res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="scenario-' + s.id + '.md"', 'x-content-type-options': 'nosniff' });
    c.res.end(scripts.toMarkdown(s, item));
  });

  route('GET', /^\/app\/content\/scripts\/([A-Za-z0-9_-]+)$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    const s = svc.getScript(db, ws.id, m[1]);
    if (!s) { back(c, '/app/content/scripts', { error: 'Сценарий не найден' }); return; }
    const item = s.item_id ? svc.getItem(db, ws.id, s.item_id) : null;
    const opt = (v) => `<option value="${v}" ${s.status === v ? 'selected' : ''}>${esc(SCRIPT_STATUS[v])}</option>`;
    page(c, { title: s.title, active: '/app/content', body: header(ws, '/app/content/scripts', '<a href="/app/content/scripts">← все сценарии</a>') +
      (item ? `<div class="panel" style="padding:12px 16px"><span class="muted">Референс:</span> ${outlierTag(item)} <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title || item.url)}</a> <span class="muted">· ${esc(item.author || '')} · 👁 ${fmtInt(item.views)}</span></div>` : '') +
      `<form class="panel" method="post" action="/app/content/scripts/${esc(s.id)}">${csrf(c)}
<div class="field"><label>Название</label><input name="title" value="${esc(s.title)}" required maxlength="200"></div>
<div class="field"><label>Хуки - первые 3 секунды, по одному в строке</label><textarea name="hooks" rows="3">${esc(s.hooks)}</textarea></div>
<div class="field"><label>Текст ролика</label><textarea name="body" rows="14">${esc(s.body)}</textarea></div>
<div class="field"><label>Раскадровка</label><textarea name="shot_list" rows="6">${esc(s.shot_list)}</textarea></div>
<div class="field"><label>Призыв</label><input name="cta" value="${esc(s.cta)}"></div>
<div class="grid2"><div class="field"><label>Статус</label><select name="status">${svc.SCRIPT_STATUSES.map(opt).join('')}</select></div>
<div class="field"><label>Дата съёмки</label><input type="date" name="shoot_date" value="${esc(s.shoot_date || '')}"></div></div>
<button>Сохранить</button> <a class="btn ghost" href="/app/content/scripts/${esc(s.id)}.md">Скачать .md</a></form>
${publicationsPanel(c, s, publications.listForScript(db, ws.id, s.id))}
<form method="post" action="/app/content/scripts/${esc(s.id)}/delete" onsubmit="return confirm('Удалить сценарий?')">${csrf(c)}<button class="ghost danger" style="color:var(--bad);background:transparent">Удалить сценарий</button></form>` });
  });

  route('POST', /^\/app\/content\/scripts\/([A-Za-z0-9_-]+)$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      for (const k of ['title', 'hooks', 'body', 'shot_list', 'cta']) if (form[k] != null) form[k] = scripts.noDash(form[k]);
      const n = svc.updateScript(db, ws.id, m[1], form);
      back(c, '/app/content/scripts/' + m[1], n ? { ok: 'Сохранено' } : { error: 'Сценарий не найден' });
    });
  });

  route('POST', /^\/app\/content\/scripts\/([A-Za-z0-9_-]+)\/delete$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, () => {
      svc.deleteScript(db, ws.id, m[1]);
      back(c, '/app/content/scripts', { ok: 'Сценарий удалён' });
    });
  });

  // ------------------------------------------------------------- публикации
  function publicationsPanel(c, s, pubs) {
    const hooks = String(s.hooks || '').split('\n').map((h) => h.trim()).filter(Boolean).slice(0, 3);
    const today = new Date().toISOString().slice(0, 10);
    const rows = pubs.map((p) => `<div style="border-top:1px solid var(--line);padding:10px 0">
<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
<span class="tag neutral">${esc(PLATFORM[p.platform] || p.platform)}</span>
<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</a>
<span class="muted">${new Date(p.published_at).toLocaleDateString('ru-RU')}${p.hook_index ? ' · хук ' + p.hook_index : p.hook_text ? ' · свой хук' : ''}</span>
<span class="tag ${p.auto ? 'det' : 'neutral'}" title="${p.auto ? 'цифры собираются сами' : 'эту площадку мерим вручную'}">${p.auto ? 'автозамер' : 'вручную'}</span>
${p.last_error ? `<span class="tag none" title="${esc(p.last_error)}">ошибка замера</span>` : ''}</div>
<div style="font-size:13px;color:var(--ink2);margin:6px 0">👁 ${fmtInt(p.views)} сейчас · 24 ч: ${fmtInt(p.v24)} · 72 ч: ${fmtInt(p.v72)} · 7 дн: ${fmtInt(p.v7d)}${p.likes ? ' · ❤ ' + fmtInt(p.likes) : ''}${p.leads ? ' · заявок: ' + fmtInt(p.leads) : ''}</div>
<form class="inline" method="post" action="/app/content/publications/${esc(p.id)}/metrics" style="gap:6px">${csrf(c)}
<div><label>Просмотры</label><input name="views" inputmode="numeric" style="width:110px"></div>
<div><label>Лайки</label><input name="likes" inputmode="numeric" style="width:90px"></div>
<div><label>Переходы</label><input name="clicks" inputmode="numeric" style="width:90px"></div>
<div><label>Заявки</label><input name="leads" inputmode="numeric" style="width:80px"></div>
<div><button class="ghost" style="padding:6px 12px">Внести цифры</button></div></form>
<div style="display:flex;gap:6px;margin-top:6px">${p.auto ? `<form method="post" action="/app/content/publications/${esc(p.id)}/refresh" style="margin:0">${csrf(c)}<button class="ghost" style="padding:3px 10px">Обновить сейчас</button></form>` : ''}
<form method="post" action="/app/content/publications/${esc(p.id)}/delete" style="margin:0" onsubmit="return confirm('Убрать публикацию и её цифры?')">${csrf(c)}<button class="ghost" style="padding:3px 10px;color:var(--bad)">Убрать</button></form></div></div>`).join('');
    return `<div class="panel"><h3 style="margin-top:0">Публикации</h3>
<p class="muted">Ссылка на вышедший ролик или пост. YouTube, Telegram и посты VK мерятся сами: первые 3 дня каждые 6 часов, потом раз в сутки. Instagram, TikTok, клипы VK - цифры вручную. Результаты по всем роликам - во вкладке «Результаты».</p>
${rows}
<form method="post" action="/app/content/scripts/${esc(s.id)}/publications" style="border-top:1px solid var(--line);padding-top:12px">${csrf(c)}
<div class="grid2"><div class="field"><label>Ссылка на ролик или пост</label><input name="url" required placeholder="https://" value="${pubs.length ? '' : esc(s.published_url || '')}"></div>
<div class="field"><label>Дата публикации</label><input type="date" name="published" value="${today}"></div></div>
<div class="field"><label>Какой хук использован</label><select name="hook">${hooks.map((h, i) => `<option value="${i + 1}">${i + 1}. ${esc(h.slice(0, 90))}</option>`).join('')}<option value="0">Свой хук</option></select></div>
<div class="field"><label>Свой хук (если не из списка)</label><input name="hook_text" maxlength="300"></div>
<button>Добавить публикацию</button></form></div>`;
  }

  route('POST', /^\/app\/content\/scripts\/([A-Za-z0-9_-]+)\/publications$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async (form) => {
      const s = svc.getScript(db, ws.id, m[1]);
      if (!s) { back(c, '/app/content/scripts', { error: 'Сценарий не найден' }); return; }
      const hooks = String(s.hooks || '').split('\n').map((h) => h.trim()).filter(Boolean);
      const hi = parseInt(form.hook, 10);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(form.published || '') ? Date.parse(form.published + 'T12:00:00+03:00') : Date.now();
      try {
        const pid = publications.addPublication(db, ws.id, s.id, {
          url: form.url, publishedAt: Math.min(day, Date.now()),
          hookIndex: hi >= 1 && hi <= 3 ? hi : 0,
          hookText: hi >= 1 && hi <= 3 ? hooks[hi - 1] : form.hook_text
        });
        relevance.logEvent(db, ws.id, { itemId: s.item_id, topicId: s.topic_id, kind: 'publish' });
        // первый замер сразу, чтобы было от чего считать
        const pub = db.prepare('SELECT * FROM content_publications WHERE id = ?').get(pid);
        let note = '';
        if (pub.auto) {
          try { publications.addMetrics(db, ws.id, pid, Object.assign({ source: 'auto' }, await publications.fetchMetrics(pub.url, { fetch: fetchImpl, cfg }))); note = ' Первый замер сделан.'; } catch (e) { note = ' Замер не удался: ' + e.message; }
        }
        back(c, '/app/content/scripts/' + s.id, { ok: 'Публикация добавлена.' + note });
      } catch (e) { back(c, '/app/content/scripts/' + s.id, { error: e.message }); }
    });
  });

  function pubScript(ws, pubId) {
    return db.prepare('SELECT p.*, sc.id sid FROM content_publications p JOIN content_scripts sc ON sc.id = p.script_id WHERE p.id = ? AND p.workspace_id = ?').get(pubId, ws.id);
  }

  route('POST', /^\/app\/content\/publications\/([A-Za-z0-9_-]+)\/metrics$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const p = pubScript(ws, m[1]);
      if (!p) { back(c, '/app/content/results', { error: 'Публикация не найдена' }); return; }
      const ok = publications.addMetrics(db, ws.id, p.id, { views: form.views, likes: form.likes, clicks: form.clicks, leads: form.leads });
      back(c, '/app/content/scripts/' + p.sid, ok ? { ok: 'Цифры сохранены' } : { error: 'Введите хотя бы одно число' });
    });
  });

  route('POST', /^\/app\/content\/publications\/([A-Za-z0-9_-]+)\/refresh$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async () => {
      const p = pubScript(ws, m[1]);
      if (!p) { back(c, '/app/content/results', { error: 'Публикация не найдена' }); return; }
      try {
        publications.addMetrics(db, ws.id, p.id, Object.assign({ source: 'auto' }, await publications.fetchMetrics(p.url, { fetch: fetchImpl, cfg })));
        db.prepare('UPDATE content_publications SET last_error = NULL WHERE id = ?').run(p.id);
        back(c, '/app/content/scripts/' + p.sid, { ok: 'Цифры обновлены' });
      } catch (e) { back(c, '/app/content/scripts/' + p.sid, { error: 'Не удалось: ' + e.message }); }
    });
  });

  route('POST', /^\/app\/content\/publications\/([A-Za-z0-9_-]+)\/delete$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, () => {
      const p = pubScript(ws, m[1]);
      if (p) publications.deletePublication(db, ws.id, p.id);
      back(c, p ? '/app/content/scripts/' + p.sid : '/app/content/results', p ? { ok: 'Публикация убрана' } : { error: 'Не найдено' });
    });
  });

  // ------------------------------------------------------------- результаты
  route('GET', /^\/app\/content\/results$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const rows = publications.results(db, ws.id);
    const HOOKS = { 1: 'хук 1', 2: 'хук 2', 3: 'хук 3', 0: 'свой хук' };
    const table = (title, hint, list) => list.length ? `<h2>${title}</h2><p class="muted">${hint}</p><div class="tw"><table><thead><tr><th></th><th class="n">Роликов</th><th class="n">Медиана просмотров к 72 ч</th><th class="n">Заявки</th></tr></thead><tbody>${list.map((g) =>
      `<tr><td>${esc(String(g.key))}${g.few ? ' <span class="tag neutral" title="меньше 3 роликов - выводы делать рано">мало данных</span>' : ''}</td><td class="n">${g.count}</td><td class="n">${fmtInt(g.median72)}</td><td class="n">${g.leads || '—'}</td></tr>`).join('')}</tbody></table></div>` : '';
    const list = rows.map((r) => `<tr><td><a href="/app/content/scripts/${esc(r.script_id)}"><b>${esc(r.script_title)}</b></a><br><span class="muted">${esc(PLATFORM[r.platform] || r.platform)} · ${new Date(r.published_at).toLocaleDateString('ru-RU')} · ${r.format === 'long' ? 'большой' : 'короткий'}${r.hook_index != null ? ' · ' + HOOKS[r.hook_index] : ''}${r.source_name ? ' · тема из ' + esc(r.source_name) : ''}</span></td>
<td class="n">${fmtInt(r.v24)}</td><td class="n">${fmtInt(r.v72)}</td><td class="n">${fmtInt(r.v7d)}</td><td class="n">${fmtInt(r.views)}</td><td class="n">${r.leads || '—'}</td></tr>`).join('');
    page(c, { title: 'Результаты', active: '/app/content', body: header(ws, '/app/content/results',
      'Как работают ваши ролики: просмотры через 24 часа, 72 часа и 7 дней после выхода. Вехи сравнимы между роликами разного возраста.') +
      (rows.length ? `<div class="tw"><table><thead><tr><th>Ролик</th><th class="n">24 ч</th><th class="n">72 ч</th><th class="n">7 дн</th><th class="n">Сейчас</th><th class="n">Заявки</th></tr></thead><tbody>${list}</tbody></table></div>` +
        table('Откуда темы', 'Источники, из чьих постов выросли ролики. Подсказывает, кого читать внимательнее.', publications.breakdown(rows, (r) => r.source_name || (r.item_provider ? PROVIDER[r.item_provider] || r.item_provider : null))) +
        table('Хуки', 'Какой из трёх хуков сценария вы брали.', publications.breakdown(rows, (r) => (r.hook_index == null ? null : HOOKS[r.hook_index]))) +
        table('Формат', '', publications.breakdown(rows, (r) => (r.format === 'long' ? 'большой ролик' : 'короткий ролик'))) +
        table('Площадка', '', publications.breakdown(rows, (r) => PLATFORM[r.platform] || r.platform)) +
        table('Тема из нескольких источников', 'Ролики по склеенным темам против одиночных постов.', publications.breakdown(rows, (r) => (r.topic_sources >= 2 ? 'тема от ' + sourcesWord(r.topic_sources) : 'одиночный пост'))) +
        '<p class="muted">Медиана по вехе 72 ч; если ролику меньше трёх суток, берутся текущие просмотры. Меньше трёх роликов в группе - «мало данных».</p>'
        : '<div class="panel empty"><h3>Пока нет публикаций</h3><p>Откройте сценарий, по которому вышел ролик, и добавьте ссылку в блоке «Публикации».</p><a class="btn" href="/app/content/scripts">К сценариям</a></div>') });
  });

  // ------------------------------------------------------------- Telegram
  function telegramPanel(c, ws) {
    const subs = notify.subscriptions(db, ws.id);
    const bot = cfg.telegram.botName;
    const hours = (cur) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === cur ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
    return `<div class="panel" style="max-width:720px"><h3 style="margin-top:0">Сводка и алерты в Telegram</h3>
<p class="muted">Каждое утро - горячие темы за сутки. Днём - алерт, если пост разгоняется в 5+ раз быстрее нормы своего канала или тему подхватили 3+ источника. Не больше ${notify.ALERTS_PER_DAY} алертов в день, ночью тихо. Кнопки в сообщениях сразу добавляют в избранное или пишут сценарий.</p>
${subs.map((sub) => `<form class="inline" method="post" action="/app/content/telegram/${esc(sub.chat_id)}" style="border-top:1px solid var(--line);padding-top:10px;margin-bottom:10px">${csrf(c)}
<div><label>Чат</label><span class="mono">${esc(sub.chat_id)}</span></div>
<div><label><input type="checkbox" name="digest_on" value="1" ${sub.digest_on ? 'checked' : ''} style="width:auto"> Утренняя сводка</label><select name="digest_hour" style="width:auto">${hours(sub.digest_hour)}</select></div>
<div><label><input type="checkbox" name="alerts_on" value="1" ${sub.alerts_on ? 'checked' : ''} style="width:auto"> Алерты о залётах</label></div>
<div><button class="ghost" style="padding:6px 12px">Сохранить</button> <button class="ghost" name="action" value="test" style="padding:6px 12px">Прислать сводку сейчас</button> <button class="ghost" name="action" value="delete" style="padding:6px 12px;color:var(--bad)">Отключить</button></div></form>`).join('')}
${bot ? `<form method="post" action="/app/content/telegram/link" style="margin:0">${csrf(c)}<button>${subs.length ? 'Подключить ещё один чат' : 'Подключить Telegram'}</button></form>
<p class="muted" style="margin:8px 0 0">Откроется бот @${esc(bot)}: нажмите «Запустить», и сводка этого пространства начнёт приходить вам в личку.</p>`
    : '<p class="muted">Бот TrackSub не настроен на этом сервере (нет TELEGRAM_BOT_NAME).</p>'}</div>`;
  }

  route('POST', /^\/app\/content\/telegram\/link$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, () => {
      if (!cfg.telegram.botName) { back(c, '/app/content/settings', { error: 'Бот не настроен' }); return; }
      const code = notify.createLinkCode(db, ws.id, c.user.id);
      H.redirect(c.res, 'https://t.me/' + encodeURIComponent(cfg.telegram.botName) + '?start=cos_' + code);
    });
  });

  route('POST', /^\/app\/content\/telegram\/(-?\d{1,20})$/, async (c, m) => {
    const ws = guard(c); if (!ws) return;
    await post(c, async (form) => {
      const sub = notify.subscriptions(db, ws.id).find((x) => x.chat_id === m[1]);
      if (!sub) { back(c, '/app/content/settings', { error: 'Чат не найден' }); return; }
      if (form.action === 'delete') { notify.unsubscribe(db, ws.id, sub.chat_id); back(c, '/app/content/settings', { ok: 'Сводка в этот чат отключена' }); return; }
      if (form.action === 'test') {
        const d = notify.buildDigest(db, cfg, ws.id);
        if (!d) { back(c, '/app/content/settings', { error: 'Сейчас нечего прислать: за сутки нет общих тем и быстрых постов' }); return; }
        try {
          const { TelegramApi } = require('../platform/telegramApi');
          const api = opts.telegramApi || new TelegramApi({ token: cfg.telegram.token, mode: cfg.telegram.mode });
          await api.sendMessage(sub.chat_id, d.text, { reply_markup: { inline_keyboard: d.buttons } });
          back(c, '/app/content/settings', { ok: 'Сводка отправлена в Telegram' });
        } catch (e) { back(c, '/app/content/settings', { error: 'Не отправилось: ' + e.message }); }
        return;
      }
      notify.updateSubscription(db, ws.id, sub.chat_id, { digestOn: form.digest_on === '1', alertsOn: form.alerts_on === '1', digestHour: form.digest_hour });
      back(c, '/app/content/settings', { ok: 'Настройки Telegram сохранены' });
    });
  });

  /**
   * Кнопки из Telegram: подписанная ссылка выполняет действие после входа.
   * Подпись связывает действие, объект, пространство и срок - подделать или переиспользовать для чужого нельзя.
   */
  route('GET', /^\/app\/content\/go\/(fav|script)\/(topic|item)\/([A-Za-z0-9_-]+)$/, async (c, m) => {
    if (!requireAuth(c)) return;
    const [, action, kind, ref] = m;
    const q = c.url.searchParams;
    const wsId = q.get('w') || '';
    if (!notify.verifyLink(cfg, { action, kind, ref, workspaceId: wsId, exp: q.get('e'), sig: q.get('s') })) {
      back(c, '/app/content', { error: 'Ссылка из Telegram устарела или повреждена' }); return;
    }
    const ws = accounts.workspacesOf(db, c.user.id).find((w) => w.id === wsId);
    if (!ws) { back(c, '/app/content', { error: 'Это пространство вам недоступно' }); return; }
    c.res.setHeader('set-cookie', H.setCookie('ws', ws.id, { secure: cfg.secureCookies, maxAge: auth.SESSION_TTL_MS }));
    const tp = kind === 'topic' ? topics.getTopic(db, ws.id, ref) : null;
    const item = kind === 'item' ? svc.getItem(db, ws.id, ref) : tp && svc.getItem(db, ws.id, tp.primary_item_id);
    if (!item) { back(c, '/app/content', { error: 'Пост или тема больше не найдены' }); return; }
    if (action === 'fav') {
      svc.setItemStatus(db, ws.id, item.id, 'picked');
      back(c, tp ? '/app/content/topics#' + tp.id : '/app/content?status=picked', { ok: '★ Добавлено в избранное' });
      return;
    }
    const others = tp ? topics.topicItems(db, ws.id, tp.id).filter((i) => i.id !== item.id) : [];
    const base = others.length ? Object.assign({}, item, { body: (item.body || item.title || '') + '\n\nОб этом же пишут:\n' +
      others.map((i) => '- ' + (i.author || '') + ': ' + (i.title || '') + ' (' + i.url + ')').join('\n') }) : item;
    const sc = await scripts.generate(base, svc.getSettings(db, ws.id), 'short', { apiKey: cfg.content.anthropicKey, model: cfg.content.anthropicModel, fetch: fetchImpl });
    if (others.length) sc.body += '\n\nДругие источники темы:\n' + others.map((i) => '- ' + (i.author || '') + ': ' + i.url).join('\n');
    const sid = svc.createScript(db, ws.id, item.id, sc, 'short', { topicId: tp ? tp.id : null });
    back(c, '/app/content/scripts/' + sid, { ok: 'Сценарий из Telegram готов: заполните места [вставь ...]' });
  });

  // ---------------------------------------------------------------- профиль
  route('GET', /^\/app\/content\/settings$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    const s = svc.getSettings(db, ws.id);
    const f = (name, label, ph, rows) => `<div class="field"><label>${label}</label>${rows
      ? `<textarea name="${name}" rows="${rows}" placeholder="${esc(ph)}">${esc(s[name])}</textarea>`
      : `<input name="${name}" value="${esc(s[name])}" placeholder="${esc(ph)}">`}</div>`;
    page(c, { title: 'Профиль автора', active: '/app/content', body: header(ws, '/app/content/settings',
      'Под кого пишутся сценарии в этом проекте. У каждого проекта свой профиль: личный блог и бренд не смешиваются.') +
      `<form class="panel" method="post" action="/app/content/settings" style="max-width:720px">${csrf(c)}
${f('author', 'Кто в кадре', 'Михаил, основатель Blogger Market, говорит от первого лица')}
${f('audience', 'Для кого', 'предприниматели и маркетологи малого бизнеса')}
${f('topics', 'Темы', 'реклама у блогеров, ИИ в бизнесе, продажи', 2)}
${f('tone', 'Тон', 'дружелюбно, на «ты», коротко и по делу')}
${f('cta', 'Призыв в конце', 'подпишись, чтобы не пропустить разборы')}
<div class="field"><label>Стоп-темы - через запятую, такие посты помечаются «не наше»</label><textarea name="stop_topics" rows="2" placeholder="${esc(relevance.DEFAULT_STOP)}">${esc(s.stop_topics == null ? relevance.DEFAULT_STOP : s.stop_topics)}</textarea></div>
<button>Сохранить</button></form>
${(() => {
  const d = relevance.describe(s, db, ws.id);
  const chips = (list) => list.length ? list.map((t) => `<code>${esc(t)}</code>`).join(' ') : '<span class="muted">пока нет</span>';
  return `<div class="panel" style="max-width:720px"><h3 style="margin-top:0">Как система понимает ваши темы</h3>
<p class="muted">Релевантность считается по словам ниже: из полей «Темы» и «Для кого» плюс близкие слова ниши. Кнопки 👍/👎 в ленте добавляют свои слова. Проценты - ориентир, не вероятность успеха.</p>
<p><b>Ищу:</b> ${chips(d.terms.slice(0, 60))}</p>
<p><b>Прячу:</b> ${chips(d.stop)}</p>
<p><b>Выучил «наше»:</b> ${chips(d.learnedUp)}</p>
<p style="margin:0"><b>Выучил «не наше»:</b> ${chips(d.learnedDown)}</p></div>`;
})()}
${telegramPanel(c, ws)}
<form class="panel" method="post" action="/app/content/workspace" style="max-width:720px">${csrf(c)}
<h3 style="margin-top:0">Отдельное пространство</h3>
<p class="muted">Для другого автора или бренда (например, «Личный блог» и «Blogger Market»): свои источники, лента, сценарии и профиль. Переключение - в шапке.</p>
<div class="field"><label>Название</label><input name="name" required maxlength="80" placeholder="Blogger Market"></div>
<button class="ghost">Создать пространство</button></form>` });
  });

  route('POST', /^\/app\/content\/workspace$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => {
      const name = String(form.name || '').trim().slice(0, 80);
      if (!name) { back(c, '/app/content/settings', { error: 'Нужно название' }); return; }
      if (accounts.workspacesOf(db, c.user.id).length >= 10) { back(c, '/app/content/settings', { error: 'Не больше 10 пространств' }); return; }
      const created = accounts.createWorkspaceFor(db, c.user, { name, timezone: ws.timezone, currency: ws.currency });
      c.res.setHeader('set-cookie', [
        H.setCookie('ws', created.id, { secure: cfg.secureCookies, maxAge: auth.SESSION_TTL_MS }),
        H.setCookie('flash', JSON.stringify({ ok: 'Пространство «' + name + '» создано и открыто. Заполните профиль автора.' }), { secure: cfg.secureCookies, maxAge: 30000 })
      ]);
      H.redirect(c.res, '/app/content/settings');
    });
  });

  route('POST', /^\/app\/content\/settings$/, async (c) => {
    const ws = guard(c); if (!ws) return;
    await post(c, (form) => { svc.saveSettings(db, ws.id, form); back(c, '/app/content/settings', { ok: 'Профиль сохранён' }); });
  });
};
