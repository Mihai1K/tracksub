'use strict';

/**
 * Стартовые наборы источников. Каждый канал и паблик VK проверен 10.11.2026: веб-версия / wall.get
 * открывается, посты свежие (последний - не старше 5 дней), просмотры видны.
 * Это отправная точка, а не рейтинг: лишнее убирается на странице источников.
 */

const PACKS = [
  {
    id: 'marketing', title: 'Маркетинг и реклама', niche: 'маркетинг',
    lines: ['@adindex', '@sostav', '@smmplanner', '@internetanalytics', '@vcnews', 'vk.com/cossa', 'vk.com/adindex', 'vk.com/targethunter', 'vk.com/smmplanner', 'yt: реклама у блогеров', 'yt: маркетинг для бизнеса']
  },
  {
    id: 'ai', title: 'ИИ и технологии', niche: 'ИИ',
    lines: ['@denissexy', '@seeallochnaya', '@ai_newz', '@data_secrets', '@addmeto', '@techsparks', '@neuraldeep', '@habr_com', 'vk.com/habr', 'vk.com/tproger', 'yt: нейросети для бизнеса']
  },
  {
    id: 'business', title: 'Бизнес и деньги', niche: 'бизнес',
    lines: ['@oskar_hartmann', '@theedinorogblog', '@forbesrussia', '@thebell_io', '@frank_media', '@proeconomics', '@banksta', '@bitkogan', 'vk.com/vcru', 'vk.com/rbc', 'vk.com/forbes', 'yt: как начать бизнес']
  },
  {
    id: 'hype', title: 'Инфоповоды и тренды', niche: 'тренды',
    lines: ['@breakingmash', '@bazabazon', '@shot_shot', '@trendwatching', '@rbc_news', 'vk.com/mash', 'vk.com/lentach', 'yt: тренды RU']
  }
];

module.exports = { PACKS };
