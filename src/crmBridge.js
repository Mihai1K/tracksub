'use strict';

const crypto = require('crypto');
const auth = require('./auth');
const H = require('./http');

function enabled(crm) {
  return !!crm && typeof crm.token === 'string' && crm.token.length >= 32 && !!crm.directorEmail;
}

function isDirector(user, crm) {
  return enabled(crm) && !!user && user.is_admin === 1 && user.email === crm.directorEmail;
}

function register({ route, db, crm }) {
  for (const method of ['GET', 'DELETE']) {
    route(method, /^\/internal\/crm\/session$/, async (c) => {
      c.res.setHeader('Cache-Control', 'no-store');
      const peer = c.req.socket.remoteAddress;
      const actual = Buffer.from(String(c.req.headers.authorization || ''));
      const expected = Buffer.from('Bearer ' + (crm && crm.token || ''));
      if (!enabled(crm) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) ||
          actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        H.json(c.res, 404, { error: 'Not found' }); return;
      }
      const sid = c.req.headers['x-crm-session'];
      const session = typeof sid === 'string' && /^[A-Za-z0-9_-]{32}$/.test(sid) ? auth.getSession(db, sid) : null;
      if (!session || !isDirector(session.user, crm)) {
        H.json(c.res, 401, { error: 'Unauthorized' }); return;
      }
      if (method === 'DELETE') {
        auth.destroySession(db, sid);
        H.json(c.res, 200, { ok: true }); return;
      }
      H.json(c.res, 200, { id: session.user.id, email: session.user.email });
    });
  }
}

module.exports = { enabled, isDirector, register };
