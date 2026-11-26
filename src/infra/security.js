// Security primitives: stateless HS256 JWT, scrypt passwords, rate limiting,
// persistent IP blocking hooks, strict input sanitization, and HTTP security headers.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function resolveJwtSecret(dbPath) {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
    return process.env.JWT_SECRET;
  }
  if (!dbPath || dbPath === ':memory:') {
    return randomBytes(32).toString('hex');
  }
  const secretFile = join(dirname(dbPath), '.jwt_secret');
  mkdirSync(dirname(secretFile), { recursive: true });
  if (existsSync(secretFile)) {
    const existing = readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const generated = randomBytes(32).toString('hex');
  writeFileSync(secretFile, `${generated}\n`, { mode: 0o600 });
  return generated;
}

const b64u = (v) => Buffer.from(v).toString('base64url');

export function signJwt(payload, secret, ttlSec = 30 * 24 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token, secret) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  let actual;
  try {
    actual = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    if (typeof claims.exp === 'number' && Math.floor(Date.now() / 1000) >= claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('Password must be 8–128 characters');
  }
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [alg, salt, hashHex] = stored.split(':');
  if (alg !== 'scrypt' || !salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Rejects prototype pollution & non-JSON primitives cleanly. */
export function assertSafePayload(value, depth = 0) {
  if (depth > 6) throw new Error('Payload too deep');
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('Array too large');
    for (const item of value) assertSafePayload(item, depth + 1);
    return value;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 64) throw new Error('Object too large');
    for (const k of keys) {
      if (POISON_KEYS.has(k)) throw new Error('Forbidden key');
      assertSafePayload(value[k], depth + 1);
    }
    return value;
  }
  throw new Error('Unsupported value');
}

export function cleanName(n) {
  const stripped = String(n ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 16);
  return stripped || 'Player';
}

export function cleanEmail(e) {
  const s = String(e ?? '').replace(/[\r\n<>]/g, '').trim().slice(0, 80);
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

export function getClientIp(reqOrSocket) {
  const fwd = reqOrSocket.headers?.['x-forwarded-for'] ?? reqOrSocket.handshake?.headers?.['x-forwarded-for'];
  const raw = typeof fwd === 'string' ? fwd.split(',')[0].trim() : (reqOrSocket.ip ?? reqOrSocket.handshake?.address ?? reqOrSocket.socket?.remoteAddress ?? 'unknown');
  return String(raw).slice(0, 64);
}

/** Sliding-window limiter with automatic escalation into persistent IP blocks. */
export class RateLimiter {
  constructor({ store = null, maxBuckets = 25_000 } = {}) {
    this.store = store;
    this.maxBuckets = maxBuckets;
    this.windows = new Map(); // key -> { count, resetAt, strikes }
    this.memBlocks = new Map(); // ip -> blockedUntil
  }

  isBlocked(ip) {
    const now = Date.now();
    const cached = this.memBlocks.get(ip);
    if (cached && cached > now) return true;
    if (cached && cached <= now) this.memBlocks.delete(ip);
    if (this.store) {
      const row = this.store.getIpBlock(ip);
      if (row && row.blocked_until > now) {
        this.memBlocks.set(ip, row.blocked_until);
        return true;
      }
    }
    return false;
  }

  block(ip, durationMs = 5 * 60_000, reason = 'rate_abuse') {
    const until = Date.now() + durationMs;
    this.memBlocks.set(ip, until);
    this.store?.blockIp(ip, until, reason);
  }

  /**
   * Returns true if allowed, false if throttled.
   * Escalates repeat offenders (>= autoBlockStrikes violations) into temporary IP block.
   */
  allow(bucket, key, limit, windowMs, { ipForBlock = null, autoBlockStrikes = 8, blockMs = 5 * 60_000 } = {}) {
    if (ipForBlock && this.isBlocked(ipForBlock)) return false;
    const now = Date.now();
    const composite = `${bucket}:${key}`;
    let entry = this.windows.get(composite);
    if (!entry || entry.resetAt <= now) {
      if (this.windows.size >= this.maxBuckets) {
        // Evict oldest key to keep memory bounded under DDoS
        const oldest = this.windows.keys().next().value;
        if (oldest) this.windows.delete(oldest);
      }
      entry = { count: 0, resetAt: now + windowMs, strikes: entry?.strikes ?? 0 };
      this.windows.set(composite, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      entry.strikes += 1;
      if (ipForBlock && entry.strikes >= autoBlockStrikes) {
        this.block(ipForBlock, blockMs, `auto:${bucket}`);
      }
      return false;
    }
    return true;
  }
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
  next();
}

export function parseAllowedOrigins() {
  const raw = process.env.CORS_ORIGINS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
