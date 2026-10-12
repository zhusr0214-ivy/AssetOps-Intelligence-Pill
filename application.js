import { randomUUID } from 'node:crypto';
import { permitted } from './auth.js';

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 20000) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
  try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw Object.assign(new Error('Invalid JSON object.'), { status: 400 }); }
}

export function secureApplication(handler, { auth, audit, readiness, maxActive = 12 }) {
  let active = 0, stopping = false, auditHealthy = true;
  const idle = [];
  const startedAt = new Date().toISOString();
  const application = async (req, res) => {
    const requestId = randomUUID(), start = Date.now();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (stopping || active >= maxActive) { res.setHeader('Retry-After', '5'); return json(res, 503, { error: 'Server busy or shutting down. Retry shortly.', requestId }); }
    active++;
    let path = '', user, tracked = false;
    try {
      path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/healthz' && req.method === 'GET') return json(res, auditHealthy ? 200 : 503, { status: auditHealthy ? 'ok' : 'degraded' });
      if (!path.startsWith('/api/')) return await handler(req, res);
      res.setHeader('Cache-Control', 'no-store');
      const session = await auth.session(req);
      user = session?.user;
      // No cross-origin API mutations, including login. No reverse-proxy headers are trusted.
      let foreignOrigin = false;
      if (req.headers.origin) { try { foreignOrigin = new URL(req.headers.origin).host !== req.headers.host; } catch { foreignOrigin = true; } }
      if (!['GET', 'HEAD'].includes(req.method) && (req.headers['sec-fetch-site'] === 'cross-site' || foreignOrigin)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      if (path === '/api/auth/session' && req.method === 'GET') return json(res, 200, { user: user || null, csrf: session?.csrf || null });
      if (path === '/api/auth/login' && req.method === 'POST') {
        tracked = true; await audit.write({ requestId, phase: 'attempt', method: req.method, path }); auditHealthy = true;
        const input = await body(req), result = await auth.login(input.username, input.password, req.socket.remoteAddress);
        user = result.user; res.setHeader('Set-Cookie', auth.cookie(result.id)); return json(res, 200, { user, csrf: result.csrf });
      }
      if (!user) return json(res, 401, { error: 'Sign in to continue.' });
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'Session token is missing or expired. Reload and retry.' });
      if (path === '/api/auth/logout' && req.method === 'POST') { auth.logout(session.id); res.setHeader('Set-Cookie', auth.cookie('', 0)); return json(res, 200, { ok: true }); }
      if (path === '/api/auth/password' && req.method === 'POST') {
        tracked = true; await audit.write({ requestId, phase: 'attempt', actorId: user.id, method: req.method, path });
        const input = await body(req); await auth.changePassword(user.id, input.currentPassword, input.password);
        res.setHeader('Set-Cookie', auth.cookie('', 0)); return json(res, 200, { ok: true });
      }
      tracked = true;
      if (!permitted(user, path, req.method)) return json(res, 403, { error: 'Your role does not permit this operation.' });
      await audit.write({ requestId, phase: 'attempt', actorId: user.id, method: req.method, path: path.slice(0, 500) }); auditHealthy = true;
      req.authenticatedActor = { id: user.id, name: user.name };
      req.authenticatedRoles = user.roles;
      if (path === '/api/admin/users') {
        if (req.method === 'GET') return json(res, 200, { users: await auth.list() });
        if (req.method === 'POST') return json(res, 201, { user: await auth.create(await body(req)) });
      }
      const update = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (update && req.method === 'PATCH') return json(res, 200, { user: await auth.update(update[1], await body(req)) });
      if (path === '/api/admin/health' && req.method === 'GET') return json(res, 200, { startedAt, activeRequests: active, auditHealthy, ...await readiness() });
      if (path === '/api/admin/audit' && req.method === 'GET') return json(res, 200, { events: await audit.recent() });
      await handler(req, res);
    } catch (error) {
      if (!error.status) { auditHealthy = false; console.error('Request failed', requestId, error.code || error.name); }
      if (!res.headersSent) json(res, error.status || 503, { error: error.status ? error.message : 'Service unavailable. Check server logs.', requestId });
    } finally {
      if (tracked) { try { await audit.write({ requestId, phase: 'result', actorId: user?.id || null, method: req.method, path: path.slice(0, 500), status: res.statusCode, durationMs: Date.now() - start }); } catch { auditHealthy = false; console.error('Audit persistence failed', requestId); } }
      active--;
      if (!active) idle.splice(0).forEach(resolve => resolve());
    }
  };
  application.stop = () => { stopping = true; };
  application.whenIdle = () => active ? new Promise(resolve => idle.push(resolve)) : Promise.resolve();
  return application;
}
