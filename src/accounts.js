'use strict';

/** Workspace, участники, тарифы, аудит. */

const { id } = require('./ids');
const { one, all, run } = require('./db');

const PLANS = {
  free: { title: 'Free', price: 0, channels: 1, links: 5, conversions: false, retentionDays: 30 },
  pro: { title: 'PRO', price: 1490, channels: 10, links: 500, conversions: true, retentionDays: 365 },
  agency: { title: 'Agency', price: 7900, channels: 100, links: 5000, conversions: true, retentionDays: 730 }
};

/**
 * Служебный доступ: проект, в котором состоит администратор сервиса, тарифом не ограничен.
 * Владелец сервиса не должен выписывать подписку сам себе, чтобы открыть собственную админку.
 */
const SERVICE_PLAN = {
  title: 'Служебный', price: 0, channels: 1000, links: 100000, conversions: true, retentionDays: 3650
};

function hasAdminMember(db, workspaceId) {
  return !!one(db,
    'SELECT 1 x FROM workspace_members m JOIN users u ON u.id = m.user_id ' +
    'WHERE m.workspace_id = ? AND u.is_admin = 1 LIMIT 1', workspaceId);
}

function audit(db, { workspaceId, userId, action, target, meta }) {
  run(db, 'INSERT INTO audit_logs (id, workspace_id, user_id, action, target, meta_json, ts_utc) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id('al'), workspaceId || null, userId || null, action, target || null, JSON.stringify(meta || {}), Date.now());
}

function createWorkspaceFor(db, user, { name, timezone, currency }) {
  const wsId = id('ws');
  run(db, 'INSERT INTO workspaces (id, name, timezone, attribution_window_hours, created_at, currency, plan, created_by) ' +
    'VALUES (?, ?, ?, 72, ?, ?, \'free\', ?)',
    wsId, name || 'Мой проект', timezone || 'Europe/Moscow', Date.now(), currency || 'RUB', user.id);
  run(db, 'INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, \'owner\', ?)',
    id('wm'), wsId, user.id, Date.now());
  audit(db, { workspaceId: wsId, userId: user.id, action: 'workspace.create', target: wsId });
  return one(db, 'SELECT * FROM workspaces WHERE id = ?', wsId);
}

function workspacesOf(db, userId) {
  return all(db,
    'SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id ' +
    'WHERE m.user_id = ? ORDER BY w.created_at ASC', userId);
}

function memberRole(db, workspaceId, userId) {
  const m = one(db, 'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  return m ? m.role : null;
}

function planOf(db, workspace) {
  if (hasAdminMember(db, workspace.id)) return Object.assign({ key: 'service', isService: true }, SERVICE_PLAN);
  const key = workspace.plan && PLANS[workspace.plan] ? workspace.plan : 'free';
  const expired = workspace.plan_expires_at && workspace.plan_expires_at < Date.now();
  return expired ? Object.assign({ key: 'free', expired: true }, PLANS.free) : Object.assign({ key }, PLANS[key]);
}

/** Проверка лимита тарифа. Возвращает null, если можно, или текст ошибки. */
function checkLimit(db, workspace, what) {
  const plan = planOf(db, workspace);
  if (what === 'channel') {
    const n = one(db, 'SELECT COUNT(*) c FROM channels WHERE workspace_id = ?', workspace.id).c;
    if (n >= plan.channels) return 'Тариф ' + plan.title + ': не больше ' + plan.channels + ' каналов';
  }
  if (what === 'link') {
    const n = one(db, 'SELECT COUNT(*) c FROM tracking_links WHERE workspace_id = ? AND is_archived = 0', workspace.id).c;
    if (n >= plan.links) return 'Тариф ' + plan.title + ': не больше ' + plan.links + ' ссылок';
  }
  if (what === 'conversions' && !plan.conversions) {
    return 'Передача конверсий доступна на тарифе PRO';
  }
  return null;
}

function setPlan(db, workspaceId, plan, months, actorId) {
  const expires = months ? Date.now() + months * 30 * 24 * 3600 * 1000 : null;
  run(db, 'UPDATE workspaces SET plan = ?, plan_expires_at = ? WHERE id = ?', plan, expires, workspaceId);
  audit(db, { workspaceId, userId: actorId, action: 'billing.set_plan', target: plan, meta: { months } });
  return one(db, 'SELECT * FROM workspaces WHERE id = ?', workspaceId);
}

module.exports = { PLANS, SERVICE_PLAN, hasAdminMember, createWorkspaceFor, workspacesOf, memberRole, planOf, checkLimit, setPlan, audit };
