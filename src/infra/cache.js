// Bounded LRU + TTL cache to minimize database reads, with optional Redis pub/sub hook.
import { createConnection } from 'node:net';

export class CacheLayer {
  constructor({ maxEntries = 10_000, redisUrl = process.env.REDIS_URL ?? '' } = {}) {
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.redisUrl = redisUrl;
    this.hits = 0;
    this.misses = 0;
    this._redis = redisUrl ? new MinimalRedisClient(redisUrl) : null;
  }

  get(key) {
    const item = this.map.get(key);
    if (!item) {
      this.misses += 1;
      return undefined;
    }
    if (item.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Refresh LRU position
    this.map.delete(key);
    this.map.set(key, item);
    this.hits += 1;
    return item.value;
  }

  set(key, value, ttlMs = 15_000) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    this._redis?.publishInvalidation(key);
  }

  del(key) {
    this.map.delete(key);
    this._redis?.publishInvalidation(key);
  }

  delPrefix(prefix) {
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix)) this.map.delete(k);
    }
  }

  stats() {
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      redisConfigured: Boolean(this.redisUrl),
      redisHealthy: this._redis ? this._redis.healthy : false,
    };
  }

  close() {
    this._redis?.close();
  }
}

/** Tiny zero-dependency RESP2 publisher for multi-instance cache invalidation when REDIS_URL is set. */
class MinimalRedisClient {
  constructor(url) {
    this.healthy = false;
    this.sock = null;
    try {
      const u = new URL(url);
      this.host = u.hostname || '127.0.0.1';
      this.port = Number(u.port || 6379);
    } catch {
      this.host = null;
      this.port = null;
    }
  }

  publishInvalidation(key) {
    if (!this.host || !this.port) return;
    if (this.sock && !this.sock.destroyed) {
      const cmd = `*3\r\n$7\r\nPUBLISH\r\n$14\r\nchowkra:inval\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`;
      this.sock.write(cmd);
      return;
    }
    try {
      const s = createConnection({ host: this.host, port: this.port, timeout: 1000 });
      s.unref();
      s.on('connect', () => { this.healthy = true; });
      s.on('error', () => { this.healthy = false; s.destroy(); });
      this.sock = s;
    } catch {
      this.healthy = false;
    }
  }

  close() {
    this.sock?.destroy();
    this.sock = null;
  }
}
