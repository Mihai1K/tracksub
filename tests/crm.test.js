'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, run } = require('../src/db');
const auth = require('../src/auth');
const { createApp } = require('../src/server');
const V = require('../src/views');

test('CRM bridge: live director role, isolated identities, expiry and shared logout', async () => {
  const db = open(':memory:');
  const crm = { token: 'synthetic-bridge-token-32-characters-only', directorEmail: 'owner@test.local' };
  const owner = auth.createUser(db, { email: crm.directorEmail, password: 'Synthetic123', isAdmin: true });
  const other = auth.createUser(db, { email: 'other@test.local', password: 'Synthetic123', isAdmin: true });
  const session = auth.createSession(db, owner.id, {});
  const otherSession = auth.createSession(db, other.id, {});
  const app = createApp(db, { crm, log() {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (sid = session.id, token = crm.token, method = 'GET') => fetch(base + '/internal/crm/session', {
    method, headers: { authorization: 'Bearer ' + token, 'x-crm-session': sid }
  });
  try {
    assert.equal((await request(session.id, 'bad')).status, 404);
    assert.equal((await request('bad')).status, 401);
    assert.equal((await request(otherSession.id)).status, 401);
    const valid = await request();
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await valid.json(), { id: owner.id, email: owner.email });
    run(db, 'UPDATE users SET is_admin = 0 WHERE id = ?', owner.id);
    assert.equal((await request()).status, 401);
    run(db, 'UPDATE users SET is_admin = 1 WHERE id = ?', owner.id);
    run(db, 'UPDATE sessions SET expires_at = ? WHERE id = ?', Date.now() - 1, session.id);
    assert.equal((await request()).status, 401);
    const fresh = auth.createSession(db, owner.id, {});
    assert.equal((await request(fresh.id, crm.token, 'DELETE')).status, 200);
    assert.equal((await request(fresh.id)).status, 401);
    const login = await fetch(base + '/login?next=/crm');
    assert.match(await login.text(), /name="next" value="\/crm"/);
    const ordinary = await fetch(base + '/login?next=/crm', { redirect: 'manual', headers: { Cookie: 'sid=' + otherSession.id } });
    assert.equal(ordinary.status, 403, 'no redirect loop for a different admin');
    const signed = await fetch(base + '/login', { redirect: 'manual', method: 'POST', body: new URLSearchParams({ email: owner.email, password: 'Synthetic123', next: '/crm' }) });
    assert.equal(signed.headers.get('location'), '/crm');
    const external = await fetch(base + '/login', { redirect: 'manual', method: 'POST', body: new URLSearchParams({ email: owner.email, password: 'Synthetic123', next: 'https://evil.test/' }) });
    assert.equal(external.headers.get('location'), '/app');
    const html = V.layout({ title: 'Content', user: owner, ws: { name: 'Synthetic' }, active: '/app/content', body: 'Content preserved', directorCrm: true });
    for (const href of ['/crm?tab=orders', '/crm?tab=outreach', '/app/content']) assert(html.includes(`href="${href}"`));
    assert(html.includes('Content preserved'));
    const disabled = V.layout({ title: 'Content', user: owner, ws: { name: 'Synthetic' }, active: '/app/content', body: '' });
    assert(!disabled.includes('/crm?tab='));
  } finally {
    app.server.closeAllConnections();
    await new Promise(r => app.server.close(r));
    db.close();
  }
});
