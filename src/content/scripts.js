'use strict';

/**
 * Сценарий ролика из тренда.
 *
 * Три пути:
 * - template: структура ролика по теме тренда и профилю пространства. Факты не выдумываются:
 *   где нужен личный опыт или цифры, стоит пометка [вставь ...].
 * - llm: Claude по ANTHROPIC_API_KEY, если ключ задан. Ответ строго по JSON-схеме.
 * - prompt: готовый промпт, который можно вставить в Claude/ChatGPT вручную, а ответ - в форму.
 *
 * В тексте сценария только обычный дефис: длинное тире выдаёт машинный текст.
 */

const { firstLine } = require('./collectors');

const fmtInt = (n) => (n == null ? '?' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const lower = (s) => (/^[A-ZА-ЯЁ][a-zа-яё]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const noDash = (s) => String(s || '').replace(/[—–]/g, '-');

/**
 * Короткая тема из заголовка поста: первая фраза, без эмодзи в начале и без метки источника
 * («WSJ:», «Срочно:»), обрезка по границе слова до ~70 знаков.
 */
function topicOf(item) {
  let t = String(item.title || item.body || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  t = t.replace(/^[^\p{L}\p{N}«"]+/u, '').replace(/…$/, '');
  const label = t.match(/^([^:]{1,14}):\s+(.+)$/);
  if (label) t = label[2];
  const sentence = t.match(/^(.{20,}?[.!?])(\s|$)/);
  if (sentence) t = sentence[1];
  t = t.replace(/[.!?…]+$/, '');
  if (t.length > 70) {
    const cut = t.slice(0, 70);
    const clause = cut.search(/[,;:—-]\s[^,;:—-]*$/);
    t = clause > 30 ? cut.slice(0, clause) : cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 70);
  }
  return t.trim() || 'эта тема';
}

function evidenceLine(item) {
  const parts = [];
  if (item.views != null) parts.push(fmtInt(item.views) + ' просмотров');
  if (item.outlier != null) parts.push('×' + String(item.outlier).replace('.', ',') + (item.score_note && item.score_note.includes('подписчик') ? ' к подписчикам' : ' к медиане канала'));
  return (item.author ? item.author + ': ' : '') + (parts.join(', ') || 'без метрик') + '. ' + item.url;
}

function buildTemplate(item, settings, format) {
  const s = settings || {};
  const topic = topicOf(item);
  const aud = s.audience ? s.audience.trim() : 'моих зрителей';
  const cta = s.cta ? s.cta.trim() : '[вставь призыв: подписка, ссылка, бриф]';
  const hooks = [
    `${topic}. Что это значит для ${aud} - объясню за минуту.`,
    `Об этом сейчас говорят все, но главное упускают: ${lower(topic)}.`,
    `${topic}. Три вещи, которые важно понять - и одна ошибка, которую делают почти все.`
  ];
  const long = format === 'long';
  const body = long ? [
    '0:00-0:30. Хук и обещание: что зритель поймёт к концу. Показать результат сразу.',
    `0:30-2:00. Контекст: ${lower(topic)} - что произошло и почему об этом говорят сейчас. Своими словами, источник - в описании.`,
    '2:00-6:00. Разбор по шагам: три ключевых момента. [вставь свой пример или кейс на каждый]',
    '6:00-8:00. Что из этого следует для зрителя: как применить завтра. [вставь конкретное действие]',
    '8:00-9:00. Ошибки и ограничения: где это не сработает. Без обещаний результата.',
    '9:00-10:00. Итог одной фразой и призыв.'
  ].join('\n\n') : [
    `Контекст (3-10 сек): коротко, что произошло: ${lower(topic)}. Своими словами, без пересказа чужого текста.`,
    'Суть (10-35 сек): три пункта.\n1. [вставь главный факт или наблюдение - только проверенное]\n2. [вставь свой пример, кейс или цифру из своей практики]\n3. [вставь, что это меняет для зрителя]',
    'Вывод (35-45 сек): одна мысль, которую зритель унесёт. [вставь формулировку]'
  ].join('\n\n');
  const shots = long
    ? 'Говорящая голова + экран. Вставки: скрин источника (без чужих логотипов крупно), свои примеры, итоговый слайд с тремя пунктами.'
    : '0-3 сек: крупный план, хук текстом на экране.\n3-10: скрин или b-roll по теме.\n10-35: смена плана на каждый пункт, пункт текстом.\n35-45: снова крупно, вывод.\nФинал: призыв текстом + голосом.';
  return {
    title: noDash(firstLine(topic, 80)) + (long ? ' - большой разбор' : ' - короткий ролик'),
    hooks: noDash(hooks.join('\n')),
    body: noDash(body + '\n\nОпора: ' + evidenceLine(item) + '\nБерём тему и механику подачи, текст и примеры свои.'),
    shot_list: noDash(shots),
    cta: noDash(cta),
    generator: 'template'
  };
}

const SYSTEM = [
  'Ты сценарист коротких вертикальных роликов на русском языке.',
  'Пишешь сценарий для конкретного автора по теме, которая сейчас набирает просмотры.',
  'Правила: не выдумывай факты, цифры, кейсы и цитаты. Где нужен личный опыт автора или проверенная цифра, ставь пометку [вставь ...].',
  'Не пересказывай текст источника - бери тему и механику подачи, слова свои.',
  'Используй только обычный дефис, никогда длинное или среднее тире.',
  'Разговорный живой язык, без канцелярита и без обещаний результата.'
].join(' ');

function buildPrompt(item, settings, format) {
  const s = settings || {};
  return [
    'Автор: ' + (s.author || '[не задан]'),
    'Аудитория: ' + (s.audience || '[не задана]'),
    'Темы автора: ' + (s.topics || '[не заданы]'),
    'Тон: ' + (s.tone || 'дружелюбно, по делу'),
    'Призыв в конце: ' + (s.cta || '[придумай уместный, без ссылок на оплату]'),
    'Формат: ' + (format === 'long' ? 'большой ролик 8-12 минут, план по таймкодам' : 'короткий ролик 30-60 секунд'),
    '',
    'Тренд-референс (' + (item.platform || '') + '): ' + evidenceLine(item),
    'Текст или описание референса:',
    String(item.body || item.title || '').slice(0, 2500),
    '',
    'Нужно: название, три разных хука по одной строке, текст ролика, раскадровка по секундам, призыв.'
  ].join('\n');
}

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    hooks: { type: 'array', items: { type: 'string' } },
    body: { type: 'string' },
    shot_list: { type: 'string' },
    cta: { type: 'string' }
  },
  required: ['title', 'hooks', 'body', 'shot_list', 'cta'],
  additionalProperties: false
};

/**
 * Claude через Messages API. Проект без зависимостей, поэтому обычный fetch.
 * Ошибку не глотаем: вызывающий код откатится на шаблон и покажет причину.
 */
async function generateLlm(item, settings, format, { apiKey, model, fetch: fetchFn }) {
  const res = await (fetchFn || fetch)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    body: JSON.stringify({
      model: model || 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: buildPrompt(item, settings, format) }]
    }),
    signal: AbortSignal.timeout(180000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + ((data.error && data.error.message) || 'ошибка'));
  if (data.stop_reason === 'refusal') throw new Error('Claude отказался писать сценарий по этой теме');
  if (data.stop_reason === 'max_tokens') throw new Error('Claude не уложился в лимит ответа');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = JSON.parse(text);
  return {
    title: noDash(out.title).slice(0, 200),
    hooks: noDash((out.hooks || []).slice(0, 3).join('\n')),
    body: noDash(out.body + '\n\nОпора: ' + evidenceLine(item)),
    shot_list: noDash(out.shot_list),
    cta: noDash(out.cta),
    generator: 'llm'
  };
}

async function generate(item, settings, format, opts) {
  const o = opts || {};
  if (o.apiKey) {
    try {
      return await generateLlm(item, settings, format, o);
    } catch (e) {
      const t = buildTemplate(item, settings, format);
      t.warning = 'Claude недоступен (' + e.message + '), собран шаблон';
      return t;
    }
  }
  return buildTemplate(item, settings, format);
}

function toMarkdown(script, item) {
  return noDash([
    '# ' + script.title,
    '',
    'Формат: ' + (script.format === 'long' ? 'большой ролик' : 'короткий ролик') + ' · статус: ' + script.status +
      (script.shoot_date ? ' · съёмка: ' + script.shoot_date : ''),
    '',
    '## Хуки', script.hooks.split('\n').filter(Boolean).map((h, i) => (i + 1) + '. ' + h).join('\n'),
    '', '## Текст', script.body,
    '', '## Раскадровка', script.shot_list,
    '', '## Призыв', script.cta,
    item ? '\n## Референс\n' + evidenceLine(item) : ''
  ].join('\n')) + '\n';
}

module.exports = { buildTemplate, buildPrompt, generate, generateLlm, toMarkdown, topicOf, noDash, SCHEMA };
