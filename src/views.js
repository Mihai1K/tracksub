'use strict';

/** Server-rendered интерфейс. Без сборки, без внешних зависимостей: HTML + одна таблица стилей. */

const { esc } = require('./http');

const CSS = `
:root{--bg:#eef1f4;--surface:#fff;--surface2:#f5f7f9;--ink:#14181d;--ink2:#4a545f;--ink3:#6f7883;
--line:#d8dee4;--line2:#bcc5ce;--accent:#1b5fa6;--accent-soft:#e4eef8;--ok:#1e6a4c;--ok-soft:#e0efe8;
--warn:#8e6108;--warn-soft:#f7efdd;--bad:#b03a22;--bad-soft:#f8e8e3;--radius:6px}
@media(prefers-color-scheme:dark){:root{--bg:#0f1317;--surface:#161b21;--surface2:#1b222a;--ink:#e7ecf1;
--ink2:#aeb8c3;--ink3:#7f8a97;--line:#262f38;--line2:#39444f;--accent:#4e96d6;--accent-soft:#16222d;
--ok:#5fb893;--ok-soft:#12261f;--warn:#d6a44a;--warn-soft:#241d10;--bad:#e4795f;--bad-soft:#2c1d18}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:2px}
.top{background:var(--surface);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
.top-in{max-width:1180px;margin:0 auto;padding:0 20px;display:flex;align-items:center;gap:22px;min-height:56px;flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:-.01em;text-decoration:none;color:var(--ink);white-space:nowrap}
.brand span{color:var(--accent)}
nav.main{display:flex;gap:16px;flex-wrap:wrap}
nav.main a{color:var(--ink2);text-decoration:none;font-size:14px;padding:4px 0;border-bottom:2px solid transparent}
nav.main a.on{color:var(--ink);border-bottom-color:var(--accent)}
.spacer{flex:1}
.who{font-size:13px;color:var(--ink3)}
main{max-width:1180px;margin:0 auto;padding:26px 20px 80px}
h1{font-size:26px;line-height:1.2;margin:0 0 6px;letter-spacing:-.015em}
h2{font-size:19px;margin:34px 0 12px;letter-spacing:-.01em}
h3{font-size:15px;margin:20px 0 8px}
p{margin:0 0 14px}
.sub{color:var(--ink3);margin:0 0 22px;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin:0 0 22px}
.card{background:var(--surface);padding:15px 16px 17px}
.card .v{font-size:24px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;display:block;line-height:1.15}
.card .k{font-size:12px;color:var(--ink3);display:block;margin-top:5px;line-height:1.35}
.card .note{font-size:11px;color:var(--warn);display:block;margin-top:3px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin:0 0 20px}
table{width:100%;border-collapse:collapse;font-size:14px}
.tw{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow-x:auto;margin:0 0 22px}
th,td{padding:9px 13px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink3);font-weight:600;white-space:nowrap;background:var(--surface2)}
tbody tr:last-child td{border-bottom:none}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.unknown td{background:var(--warn-soft)}
.tag{display:inline-block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:3px;white-space:nowrap;font-weight:600}
.tag.det{color:var(--ok);background:var(--ok-soft)}
.tag.prob{color:var(--warn);background:var(--warn-soft)}
.tag.none{color:var(--bad);background:var(--bad-soft)}
.tag.mock{color:var(--bad);background:var(--bad-soft)}
.tag.real{color:var(--ok);background:var(--ok-soft)}
.tag.neutral{color:var(--ink3);background:var(--surface2)}
form.inline{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
label{display:block;font-size:12px;color:var(--ink3);margin:0 0 4px}
input,select,textarea{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--line2);border-radius:4px;padding:7px 9px;width:100%}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.field{margin:0 0 14px}
button,.btn{font:inherit;font-size:14px;font-weight:600;color:#fff;background:var(--accent);border:1px solid var(--accent);border-radius:4px;padding:8px 16px;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost,.btn.ghost{background:transparent;color:var(--accent)}
button.danger{background:var(--bad);border-color:var(--bad)}
.err{background:var(--bad-soft);color:var(--bad);border:1px solid var(--bad);border-radius:4px;padding:10px 13px;margin:0 0 16px;font-size:14px}
.ok{background:var(--ok-soft);color:var(--ok);border:1px solid var(--ok);border-radius:4px;padding:10px 13px;margin:0 0 16px;font-size:14px}
.warn{background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn);border-radius:4px;padding:10px 13px;margin:0 0 16px;font-size:14px}
.empty{text-align:center;padding:44px 20px;color:var(--ink3)}
.empty h3{color:var(--ink);margin:0 0 6px;font-size:17px}
.empty p{margin:0 0 16px}
.steps{counter-reset:s;margin:0 0 20px;padding:0;list-style:none}
.steps li{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);align-items:flex-start}
.steps li:last-child{border-bottom:none}
.dot{width:22px;height:22px;border-radius:50%;border:1.5px solid var(--line2);flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--ink3);font-weight:700}
.steps li.done .dot{background:var(--ok);border-color:var(--ok);color:#fff}
.steps b{display:block;font-size:14px}
.steps span{font-size:13px;color:var(--ink3)}
.bars{display:flex;align-items:flex-end;gap:3px;height:110px;margin:6px 0 4px}
.bars div{flex:1;background:var(--accent);opacity:.85;border-radius:2px 2px 0 0;min-height:2px}
.bars div.s{background:var(--ok)}
.axis{display:flex;justify-content:space-between;font-size:11px;color:var(--ink3)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:var(--surface2);border:1px solid var(--line);border-radius:3px;padding:1px 5px}
.copy{width:100%;font-family:ui-monospace,Menlo,monospace;font-size:13px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.muted{color:var(--ink3);font-size:13px}
.hero{padding:60px 0 30px;max-width:720px}
.hero h1{font-size:38px;line-height:1.1}
.hero p.lead{font-size:18px;color:var(--ink2)}
footer{border-top:1px solid var(--line);margin-top:50px;padding:20px;text-align:center;color:var(--ink3);font-size:13px}
`;

function layout({ title, user, ws, active, body, flash, demo, workspaces, csrf, directorCrm = false }) {
  const nav = user && ws ? [
    ['/app', 'Обзор'], ['/app/sources', 'Источники'], ['/app/campaigns', 'Кампании'],
    ['/app/creatives', 'Креативы'], ['/app/links', 'Ссылки'], ['/app/channels', 'Каналы'],
    ['/app/spend', 'Расходы'], ['/app/integrations', 'Интеграции'], [directorCrm ? '/crm' : '/app/content', directorCrm ? 'CRM' : 'Контент'], ['/app/billing', 'Тариф']
  ] : [['/', 'Продукт'], ['/pricing', 'Тарифы'], ['/docs', 'Документация']];

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><div class="top-in">
<a class="brand" href="${user ? '/app' : '/'}">Откуда<span>·</span>трафик</a>
<nav class="main">${nav.map(([href, label]) =>
  `<a href="${href}" class="${(active === href || (directorCrm && href === '/crm' && String(active || '').startsWith('/app/content'))) ? 'on' : ''}">${esc(label)}</a>`).join('')}</nav>
<div class="spacer"></div>
${user ? `${workspaces && workspaces.length > 1 ? `<form method="post" action="/app/workspace" style="margin:0">
<input type="hidden" name="csrf" value="${esc(csrf || '')}">
<select name="workspace" onchange="this.form.submit()" style="width:auto;padding:4px 8px;font-size:13px">
${workspaces.map((w) => `<option value="${esc(w.id)}" ${ws && w.id === ws.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
</select></form>` : `<span class="who">${esc(ws ? ws.name : '')}</span>`}
<span class="who">${esc(user.email)}</span>
${user.is_admin ? '<a class="who" href="/admin">админка</a>' : ''}
<form method="post" action="/logout" style="margin:0"><button class="ghost" style="padding:4px 10px">Выйти</button></form>`
  : `<a class="who" href="/login">Войти</a> <a class="btn" href="/register">Начать</a>`}
</div></header>
<main>
${demo ? '<div class="warn"><b>DEMO MODE.</b> В этом workspace включены демонстрационные данные. Цифры не настоящие — они нужны, чтобы увидеть интерфейс до первых событий. Выключить можно в настройках.</div>' : ''}
${flash && flash.error ? `<div class="err">${esc(flash.error)}</div>` : ''}
${flash && flash.ok ? `<div class="ok">${esc(flash.ok)}</div>` : ''}
${directorCrm && String(active || '').startsWith('/app/content') ? '<nav class="main" aria-label="Разделы CRM" style="margin-bottom:24px"><a href="/crm?tab=orders">Заказы</a><a href="/crm?tab=outreach">Рассылки</a><a class="on" href="/app/content">Контент</a></nav>' : ''}
${body}
</main>
<footer>Откуда трафик · <a href="/docs">документация</a> · <a href="/docs/privacy">приватность</a> · <a href="/health">статус</a></footer>
</body></html>`;
}

const fmtInt = (n) => (n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const fmtMoney = (n) => (n == null ? '—' : fmtInt(n) + ' ₽');
const fmtPct = (x) => (x == null ? '—' : (x * 100).toFixed(1).replace('.', ',') + '%');

function attrTag(type) {
  if (type === 'deterministic') return '<span class="tag det">точно</span>';
  if (type === 'probabilistic') return '<span class="tag prob">вероятно</span>';
  return '<span class="tag none">неизвестно</span>';
}

function retentionCell(r) {
  if (!r || r.value == null) return '<td class="n muted">нет зрелой когорты</td>';
  return `<td class="n">${fmtPct(r.value)}${r.isEstimate ? ' <span class="tag prob">прогноз</span>' : ''}</td>`;
}

function statCards(o) {
  const r30 = o.retention.d30;
  return `<div class="cards">
<div class="card"><span class="v">${fmtInt(o.clicks)}</span><span class="k">кликов</span></div>
<div class="card"><span class="v">${fmtInt(o.subscriptions)}</span><span class="k">подписок${o.repeat ? ', из них ' + fmtInt(o.repeat) + ' повторных' : ''}</span></div>
<div class="card"><span class="v">${fmtInt(o.unsubscriptionsLeft)}</span><span class="k">отписались сами</span></div>
<div class="card"><span class="v">${fmtPct(o.cr)}</span><span class="k">клик → подписка<br><span style="opacity:.7">органика не учитывается</span></span></div>
<div class="card"><span class="v">${fmtMoney(o.spend)}</span><span class="k">расход, введён вручную</span></div>
<div class="card"><span class="v">${fmtMoney(o.cps)}</span><span class="k">стоимость подписчика${o.paidAcquisition ? ' (по ' + fmtInt(o.paidAcquisition) + ' с известным источником)' : ''}</span></div>
<div class="card"><span class="v">${r30.value == null ? '—' : fmtPct(r30.value)}</span><span class="k">удержание 30 дней</span>${r30.isEstimate && r30.value != null ? '<span class="note">когорта меньше 20 — прогноз</span>' : ''}</div>
<div class="card"><span class="v">${fmtMoney(o.retainedCps)}</span><span class="k">стоимость живого подписчика</span></div>
</div>`;
}

function attributionQuality(o) {
  const total = o.subscriptions || 0;
  if (!total) return '';
  const a = o.attribution;
  return `<div class="panel"><h3 style="margin-top:0">Качество атрибуции</h3>
<p class="muted" style="margin-bottom:10px">Мы не выдаём догадку за факт. Точная атрибуция — когда платформа сама сказала, по какой ссылке пришёл человек. Вероятностная — когда мы сопоставили по времени.</p>
<table><tbody>
<tr><td>${attrTag('deterministic')} точная</td><td class="n">${fmtInt(a.deterministic)}</td><td class="n">${fmtPct(a.deterministic / total)}</td></tr>
<tr><td>${attrTag('probabilistic')} вероятностная</td><td class="n">${fmtInt(a.probabilistic)}</td><td class="n">${fmtPct(a.probabilistic / total)}</td></tr>
<tr><td>${attrTag('unattributed')} источник неизвестен</td><td class="n">${fmtInt(a.unattributed)}</td><td class="n">${fmtPct(a.unattributed / total)}</td></tr>
${a.ambiguous ? `<tr><td class="muted">из них спорных</td><td class="n">${fmtInt(a.ambiguous)}</td><td class="n">${fmtPct(a.ambiguous / total)}</td></tr>` : ''}
</tbody></table></div>`;
}

function chart(series) {
  if (!series.length) return '';
  const max = Math.max(1, ...series.map((d) => Math.max(d.clicks, d.subscriptions)));
  return `<div class="panel"><h3 style="margin-top:0">Динамика</h3>
<div class="bars">${series.map((d) =>
    `<div title="${esc(d.day)}: ${d.clicks} кликов" style="height:${Math.round((d.clicks / max) * 100)}%"></div>` +
    `<div class="s" title="${esc(d.day)}: ${d.subscriptions} подписок" style="height:${Math.round((d.subscriptions / max) * 100)}%"></div>`
  ).join('')}</div>
<div class="axis"><span>${esc(series[0].day)}</span><span class="muted">синие — клики, зелёные — подписки</span><span>${esc(series[series.length - 1].day)}</span></div></div>`;
}

function filterBar(filters, channels, action) {
  return `<form class="inline panel" method="get" action="${action}">
<div><label for="days">Период</label><select id="days" name="days">
${[7, 14, 30, 90].map((d) => `<option value="${d}" ${String(filters.days) === String(d) ? 'selected' : ''}>${d} дней</option>`).join('')}
</select></div>
<div><label for="channel">Канал</label><select id="channel" name="channel">
<option value="">Все каналы</option>
${channels.map((c) => `<option value="${esc(c.id)}" ${filters.channelId === c.id ? 'selected' : ''}>${esc(c.title || c.external_chat_id)}</option>`).join('')}
</select></div>
<button>Показать</button></form>`;
}

function breakdownTable(rows, dimLabel) {
  if (!rows.length) return emptyState('Пока нет данных', 'Создайте ссылку и разместите её в рекламе.', '/app/links', 'Создать ссылку');
  return `<div class="tw"><table>
<thead><tr><th>${esc(dimLabel)}</th><th class="n">клики</th><th class="n">подписки</th><th class="n">новые</th><th class="n">CR</th>
<th class="n">расход</th><th class="n">CPS</th><th class="n">удержание 30д</th><th class="n">живой CPS</th><th>атрибуция</th></tr></thead>
<tbody>${rows.map((r) => `<tr class="${r.isUnknown ? 'unknown' : ''}">
<td>${esc(r.label)}</td><td class="n">${fmtInt(r.clicks)}</td><td class="n">${fmtInt(r.subscriptions)}</td>
<td class="n">${fmtInt(r.newSubscriptions)}</td><td class="n">${fmtPct(r.cr)}</td><td class="n">${fmtMoney(r.spend)}</td><td class="n">${fmtMoney(r.cps)}</td>
${retentionCell(r.retentionD30)}<td class="n">${fmtMoney(r.retainedCps)}</td>
<td>${r.isUnknown ? '<span class="tag none">нет источника</span>' : `${r.deterministic ? '<span class="tag det">' + r.deterministic + '</span> ' : ''}${r.probabilistic ? '<span class="tag prob">' + r.probabilistic + '</span>' : ''}`}</td>
</tr>`).join('')}</tbody></table></div>`;
}

/**
 * Страница перехода в канал.
 *
 * Мгновенный 302 на приглашение Telegram рекламные площадки отклоняют: VK показывает
 * «Некорректная ссылка» и не даёт опубликовать объявление. Поэтому по адресу объявления
 * отдаём обычную страницу, а в канал человек уходит по кнопке. Приглашение из пула
 * выдаётся только на нажатие — проверяющий робот площадки не расходует пул.
 */
function vkPixel(pixelId) {
  if (!pixelId || !/^\d+$/.test(String(pixelId))) return '';
  // Счётчик top.mail.ru — он же пиксель VK Рекламы. Без него VK не видит на домене
  // трафика и не даёт выбрать оптимизацию по событию: кампания учится только на кликах.
  return `<script type="text/javascript">
var _tmr = window._tmr || (window._tmr = []);
_tmr.push({id: "${esc(String(pixelId))}", type: "pageView", start: (new Date()).getTime()});
(function (d, w, id) {
  if (d.getElementById(id)) return;
  var ts = d.createElement("script"); ts.type = "text/javascript"; ts.async = true; ts.id = id;
  ts.src = "https://top-fwz1.mail.ru/js/code.js";
  var f = function () { var s = d.getElementsByTagName("script")[0]; s.parentNode.insertBefore(ts, s); };
  if (w.opera == "[object Opera]") { d.addEventListener("DOMContentLoaded", f, false); } else { f(); }
})(document, window, "tmr-code");
</script>
<noscript><div><img src="https://top-fwz1.mail.ru/counter?id=${esc(String(pixelId))};js=na" style="position:absolute;left:-9999px" alt="" /></div></noscript>`;
}

function landingPage({ channelTitle, channelUrl, goUrl, note, vkPixelId }) {
  const title = esc(channelTitle || 'Телеграм-канал');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="robots" content="noindex">
<style>${CSS}
.land{max-width:560px;margin:0 auto;padding:48px 16px;text-align:center}
.land h1{font-size:28px;line-height:1.2;margin:0 0 12px}
.land p{margin:0 0 28px}
.land .btn{display:inline-block;font-size:17px;padding:14px 32px}
.land .foot{margin-top:40px;font-size:13px}
</style></head><body>
<div class="land">
<h1>${title}</h1>
<p class="muted">${esc(note || 'Нажмите кнопку — откроется Telegram, и вы вступите в канал по личной ссылке.')}</p>
<a class="btn" href="${esc(goUrl)}">Открыть канал в Telegram</a>
<p class="foot muted">Ссылка персональная и одноразовая.${channelUrl ? ' Канал: ' + esc(channelUrl) : ''}<br>
Переход считает сервис аналитики <a href="/">Откуда трафик</a> · <a href="/docs/privacy">как мы обращаемся с данными</a></p>
</div>
${vkPixel(vkPixelId)}
</body></html>`;
}

function emptyState(title, text, href, cta) {
  return `<div class="panel empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${href ? `<a class="btn" href="${href}">${esc(cta)}</a>` : ''}</div>`;
}

function onboarding(progress) {
  const steps = [
    ['Подключите канал', 'Telegram или MAX', progress.channel, '/app/channels'],
    ['Добавьте бота в канал администратором', 'без прав бот не увидит подписки', progress.bot, '/app/channels'],
    ['Создайте tracking-ссылку', 'источник, кампания, креатив', progress.link, '/app/links'],
    ['Разместите ссылку в рекламе', 'и дождитесь первого перехода', progress.click, '/app/links'],
    ['Получите первую подписку', 'она появится здесь автоматически', progress.subscription, '/app'],
    ['Подключите передачу конверсий', 'Метрика или Директ', progress.conversion, '/app/integrations']
  ];
  const done = steps.filter((s) => s[2]).length;
  if (done === steps.length) return '';
  return `<div class="panel"><h3 style="margin-top:0">Настройка: ${done} из ${steps.length}</h3>
<ul class="steps">${steps.map(([t, s, ok, href], i) => `<li class="${ok ? 'done' : ''}">
<span class="dot">${ok ? '✓' : i + 1}</span><span><b>${esc(t)}</b><span>${esc(s)}</span></span>
<span class="spacer"></span>${ok ? '' : `<a href="${href}">перейти</a>`}</li>`).join('')}</ul></div>`;
}

module.exports = {
  layout, statCards, attributionQuality, chart, filterBar, breakdownTable, emptyState, landingPage,
  onboarding, attrTag, retentionCell, fmtInt, fmtMoney, fmtPct, CSS
};
