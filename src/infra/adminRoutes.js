// Audited Admin RBAC REST endpoints for server ops, backups, bans, and ledger adjustments.
import { randomUUID } from 'node:crypto';
import express from 'express';
import { cleanEmail, cleanName, getClientIp, signJwt, verifyJwt } from './security.js';

export function createAdminRouter({ store, cache, queue, backup, rooms, limiter, jwtSecret }) {
  const router = express.Router();

  const authAdmin = (req, res, next) => {
    const hdr = req.headers.authorization ?? '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
    const claims = verifyJwt(token, jwtSecret);
    if (!claims || typeof claims.sub !== 'string') {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Valid bearer token required' });
    }
    const u = store.get(claims.sub);
    if (!u || (u.banned_until && u.banned_until > Date.now())) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', message: 'Account unavailable' });
    }
    req.actor = u;
    next();
  };

  const requirePerm = (perm) => (req, res, next) => {
    if (!store.hasPermission(req.actor.player_id, perm)) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', message: `Missing permission: ${perm}` });
    }
    next();
  };

  /** One-time Owner account bootstrap (only works when zero owner accounts exist). */
  router.post('/bootstrap', (req, res) => {
    const ip = getClientIp(req);
    if (!limiter.allow('admin_boot', ip, 10, 60_000, { ipForBlock: ip })) {
      return res.status(429).json({ ok: false, code: 'RATE_LIMITED', message: 'Too many requests' });
    }
    if (store.hasAnyOwner()) {
      return res.status(409).json({ ok: false, code: 'ALREADY_BOOTSTRAPPED', message: 'Owner account already exists' });
    }
    const expectedKey = process.env.ADMIN_BOOTSTRAP_KEY;
    if (expectedKey && req.body?.bootstrapKey !== expectedKey) {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', message: 'Invalid bootstrap key' });
    }
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    if (!email) return res.status(400).json({ ok: false, code: 'BAD_EMAIL', message: 'Valid email required' });
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ ok: false, code: 'BAD_PASSWORD', message: 'Password must be 8–128 characters' });
    }
    const playerId = randomUUID();
    const u = store.withTx(() => {
      const created = store.getOrCreate(playerId, { name: cleanName(req.body?.name ?? 'Owner') });
      store.update(playerId, { email });
      store.setPassword(playerId, password);
      store.assignRole(playerId, 'owner');
      store.recordAudit(playerId, 'owner_bootstrap', playerId, { email }, ip);
      return created;
    });
    const token = signJwt({ sub: u.player_id, roles: store.getRoles(u.player_id) }, jwtSecret);
    res.json({ ok: true, token, roles: store.getRoles(u.player_id), permissions: store.getPermissions(u.player_id) });
  });

  router.post('/login', (req, res) => {
    const ip = getClientIp(req);
    if (!limiter.allow('admin_login', ip, 12, 60_000, { ipForBlock: ip })) {
      return res.status(429).json({ ok: false, code: 'RATE_LIMITED', message: 'Too many login attempts' });
    }
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password ?? '');
    if (!email || !password) return res.status(400).json({ ok: false, code: 'BAD_CREDENTIALS', message: 'Email and password required' });
    const u = store.authenticatePassword(email, password);
    if (!u || (u.banned_until && u.banned_until > Date.now())) {
      return res.status(401).json({ ok: false, code: 'BAD_CREDENTIALS', message: 'Invalid credentials' });
    }
    const roles = store.getRoles(u.player_id);
    const token = signJwt({ sub: u.player_id, roles }, jwtSecret);
    res.json({ ok: true, token, userId: u.user_id, roles, permissions: store.getPermissions(u.player_id) });
  });

  router.get('/ops', authAdmin, requirePerm('view_ops'), (req, res) => {
    const canAudit = store.hasPermission(req.actor.player_id, 'view_audit');
    res.json({
      ok: true,
      rooms: rooms.stats(),
      cache: cache.stats(),
      queue: queue.stats(),
      lastBackupAt: backup.lastBackupAt,
      errors: store.recentErrors(30),
      audits: canAudit ? store.recentAudits(30) : [],
    });
  });

  router.post('/backup', authAdmin, requirePerm('trigger_backup'), (req, res) => {
    const ip = getClientIp(req);
    const path = backup.runBackup();
    store.recordAudit(req.actor.player_id, 'manual_backup', '', { path }, ip);
    res.json({ ok: true, path, at: Date.now() });
  });

  router.post('/economy/grant', authAdmin, requirePerm('manage_economy'), (req, res) => {
    const ip = getClientIp(req);
    const targetUserId = Number(req.body?.userId);
    const amount = Number(req.body?.amount);
    const reason = cleanName(req.body?.reason ?? 'admin_adjust');
    const idemKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null;
    if (!Number.isInteger(targetUserId) || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
      return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'Valid userId and non-zero integer amount required' });
    }
    const target = store.getByUserId(targetUserId);
    if (!target) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'User not found' });

    const out = store.runIdempotent(idemKey, req.actor.player_id, `admin_grant:${targetUserId}`, () => {
      const ok = store.addCoins(target.player_id, amount, 'admin_adjust', reason);
      if (!ok) return { ok: false, code: 'NEGATIVE_BALANCE', message: 'Cannot reduce coins below zero' };
      store.recordAudit(req.actor.player_id, 'economy_grant', target.player_id, { targetUserId, amount, reason }, ip);
      const updated = store.get(target.player_id);
      return { ok: true, userId: targetUserId, coins: updated.coins };
    });
    cache.del(`u:${target.player_id}`);
    cache.delPrefix('lb:');
    res.status(out.ok ? 200 : 400).json(out);
  });

  router.post('/users/ban', authAdmin, requirePerm('ban_user'), (req, res) => {
    const ip = getClientIp(req);
    const targetUserId = Number(req.body?.userId);
    const minutes = Number(req.body?.minutes ?? 60);
    const reason = String(req.body?.reason ?? 'policy').slice(0, 120);
    if (!Number.isInteger(targetUserId) || !Number.isFinite(minutes) || minutes < 0) {
      return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'Valid userId and minutes >= 0 required' });
    }
    const target = store.getByUserId(targetUserId);
    if (!target) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'User not found' });
    const until = minutes === 0 ? 0 : Date.now() + Math.floor(minutes * 60_000);
    store.setBan(target.player_id, until, reason);
    cache.del(`u:${target.player_id}`);
    store.recordAudit(req.actor.player_id, minutes === 0 ? 'unban_user' : 'ban_user', target.player_id, { targetUserId, minutes, reason }, ip);
    res.json({ ok: true, userId: targetUserId, bannedUntil: until });
  });

  router.post('/roles/assign', authAdmin, requirePerm('manage_roles'), (req, res) => {
    const ip = getClientIp(req);
    const targetUserId = Number(req.body?.userId);
    const role = String(req.body?.role ?? '').trim();
    if (!Number.isInteger(targetUserId) || !['owner', 'admin', 'moderator', 'player'].includes(role)) {
      return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'Valid userId and role required' });
    }
    const target = store.getByUserId(targetUserId);
    if (!target) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'User not found' });
    store.assignRole(target.player_id, role);
    store.recordAudit(req.actor.player_id, 'assign_role', target.player_id, { targetUserId, role }, ip);
    res.json({ ok: true, userId: targetUserId, roles: store.getRoles(target.player_id) });
  });

  return router;
}
