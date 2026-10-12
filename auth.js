import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const scrypt = promisify(derive);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const roles = ['admin', 'operator', 'expert', 'reviewer', 'viewer'];
const publicUser = ({ id, username, name, roles, disabled }) => ({ id, username, name, roles, disabled });
const token = () => randomBytes(32).toString('hex');
export function requiredRole(path, method) {
  if (path.startsWith('/api/admin/')) return ['admin'];
  if (method === 'GET') return roles;
  if (/^\/api\/review\/[^/]+$/.test(path) || /^\/api\/library\//.test(path) || /\/learning\/[^/]+\/[^/]+\/[^/]+\/review$/.test(path) || /^\/api\/studio\/[^/]+\/(publish|return|review-evaluation)$/.test(path)) return ['reviewer'];
  if (/^\/api\/studio(?:\/|$)/.test(path) || /\/learning\/[^/]+\/[^/]+\/[^/]+\/apply$/.test(path)) return ['expert'];
  if (/^\/api\/cases\/[^/]+\/tasks\/[^/]+$/.test(path)) return ['operator', 'reviewer'];
  if (/^\/api\/(incidents|intake|triage|cases)(?:\/|$)/.test(path)) return ['operator'];
  return [];
}
export function permitted(user, path, method) {
  return !user.disabled && (user.roles.includes('admin') || requiredRole(path, method).some(role => user.roles.includes(role)));
}

export function createAuth(file, { clock = Date.now, secure = process.env.COOKIE_SECURE === 'true', ttl = 8 * 3600000, persistence } = {}) {
  let queue = Promise.resolve();
  const sessions = persistence?.sessions || new Map(), attempts = new Map();
  async function read() { if (persistence) return persistence.read('users'); try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  async function mutate(fn) {
    if (persistence) return persistence.mutate('users', () => [], fn);
    const pending = queue.then(async () => {
      const users = await read(), result = await fn(users);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(users, null, 2), { mode: 0o600 }); await rename(tmp, file);
      return result;
    });
    queue = pending.catch(() => {}); return pending;
  }
  async function passwordHash(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail('Password must contain 12 to 128 characters.');
    const salt = token(); return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
  }
  function validate(input) {
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(input.username || '') || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw fail('Use a lowercase username (3-64 characters) and a display name.');
    if (!Array.isArray(input.roles) || !input.roles.length || input.roles.some(r => !roles.includes(r))) throw fail('Select valid roles.');
  }
  const cookie = (value, age = ttl / 1000) => `assetops_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const revoke = id => { for (const [key, session] of sessions) if (session.userId === id) sessions.delete(key); };
  return {
    cookie,
    async list() { await queue; return (await read()).map(publicUser); },
    async create(input, bootstrap = false) {
      validate(input); const credentials = await passwordHash(input.password);
      return mutate(users => {
        if (bootstrap && users.length) throw fail('An account already exists; use an administrator to add users.', 409);
        if (users.some(u => u.username === input.username)) throw fail('Username already exists.', 409);
        const user = { id: randomUUID(), username: input.username, name: input.name.trim(), roles: [...new Set(input.roles)], disabled: false, ...credentials };
        users.push(user); return publicUser(user);
      });
    },
    async update(id, input) {
      const credentials = input.password ? await passwordHash(input.password) : null;
      return mutate(users => {
        const user = users.find(u => u.id === id); if (!user) throw fail('User not found.', 404);
        const next = { ...user, name: input.name ?? user.name, roles: input.roles ?? user.roles, disabled: input.disabled ?? user.disabled };
        validate(next); if (typeof next.disabled !== 'boolean') throw fail('Invalid account state.');
        if (!users.some(u => u.id !== id && !u.disabled && u.roles.includes('admin')) && (next.disabled || !next.roles.includes('admin'))) throw fail('Keep at least one active administrator.', 409);
        Object.assign(user, next, credentials || {}); revoke(id); return publicUser(user);
      });
    },
    async changePassword(id, oldPassword, newPassword) {
      const credentials = await passwordHash(newPassword);
      return mutate(async users => {
        const user = users.find(u => u.id === id && !u.disabled);
        if (!user || typeof oldPassword !== 'string' || oldPassword.length > 128 || !timingSafeEqual(await scrypt(oldPassword, user.salt, 64), Buffer.from(user.hash, 'hex'))) throw fail('Current password is incorrect.', 403);
        Object.assign(user, credentials); revoke(id);
      });
    },
    async login(username, password, address = 'local') {
      for (const [key, value] of attempts) if (value.until <= clock()) attempts.delete(key);
      for (const [key, value] of sessions) if (value.expires <= clock()) sessions.delete(key);
      const key = address, attempt = attempts.get(key) || { count: 0, until: clock() + 15 * 60000 };
      if (persistence) persistence.consumeLoginAttempt(address, clock());
      if (attempt.count >= 10 || attempts.size >= 10000 || sessions.size >= 10000) throw fail('Too many attempts. Try again later.', 429);
      attempt.count++; attempts.set(key, attempt);
      await queue; const user = (await read()).find(u => u.username === username);
      const supplied = typeof password === 'string' && password.length <= 128 ? password : '';
      const computed = await scrypt(supplied, user?.salt || 'assetops-invalid-user', 64);
      if (!user || user.disabled || !timingSafeEqual(computed, Buffer.from(user.hash, 'hex'))) throw fail('Invalid username or password.', 401);
      await queue;
      const current = (await read()).find(u => u.id === user.id);
      if (!current || current.disabled || current.hash !== user.hash || JSON.stringify(current.roles) !== JSON.stringify(user.roles)) throw fail('Account changed. Sign in again.', 401);
      attempts.delete(key);
      persistence?.clearLoginAttempts(address);
      const id = token(), csrf = token(); sessions.set(id, { userId: user.id, csrf, expires: clock() + ttl, accountVersion: JSON.stringify([user.hash, user.roles, user.name]) });
      return { id, csrf, user: publicUser(user) };
    },
    async session(req) {
      const id = /(?:^|;\s*)assetops_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = sessions.get(id);
      if (!session || session.expires <= clock()) { sessions.delete(id); return null; }
      await queue; const user = (await read()).find(u => u.id === session.userId && !u.disabled);
      return user && session.accountVersion === JSON.stringify([user.hash, user.roles, user.name]) ? { ...session, id, user: publicUser(user) } : null;
    },
    logout(id) { sessions.delete(id); }
  };
}
