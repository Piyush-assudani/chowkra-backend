// Normalized, indexed SQLite persistence with prepared-statement cache,
// atomic BEGIN IMMEDIATE transactions, idempotency keys, RBAC tables,
// IP block persistence, and built-in error/audit logging.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from '../infra/security.js';

export const STARTING_COINS = 500;

const RBAC_ROLES = Object.freeze({
  owner: ['view_ops', 'view_audit', 'manage_economy', 'ban_user', 'trigger_backup', 'manage_roles'],
  admin: ['view_ops', 'view_audit', 'manage_economy', 'ban_user', 'trigger_backup'],
  moderator: ['view_ops', 'ban_user'],
  player: [],
});

const PERM_DESC = Object.freeze({
  view_ops: 'Inspect server health, cache metrics, and error logs',
  view_audit: 'Read administrative audit logs',
  manage_economy: 'Grant or deduct player coins inside audited ledger',
  ban_user: 'Ban or unban abusive accounts and IPs',
  trigger_backup: 'Trigger SQLite hot snapshot backups',
  manage_roles: 'Assign or revoke RBAC roles',
});

export class Store {
  constructor(path = process.env.DB_PATH ?? 'data/chowkra.db') {
    this.dbPath = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this._stmts = new Map();
    this._txDepth = 0;

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA cache_size = -16000;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS users (
        player_id   TEXT PRIMARY KEY,
        user_id     INTEGER UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        avatar      INTEGER NOT NULL DEFAULT 0,
        gender      TEXT NOT NULL DEFAULT '',
        email       TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL DEFAULT '',
        coins       INTEGER NOT NULL CHECK (coins >= 0),
        xp          INTEGER NOT NULL DEFAULT 0,
        wins        INTEGER NOT NULL DEFAULT 0,
        losses      INTEGER NOT NULL DEFAULT 0,
        referral    TEXT UNIQUE NOT NULL,
        referred_by TEXT,
        last_spin   INTEGER NOT NULL DEFAULT 0,
        last_spin_coins   INTEGER NOT NULL DEFAULT 0,
        last_spin_doubled INTEGER NOT NULL DEFAULT 0,
        daily_streak      INTEGER NOT NULL DEFAULT 0,
        last_daily_day    TEXT NOT NULL DEFAULT '',
        ad_day      TEXT NOT NULL DEFAULT '',
        ad_count    INTEGER NOT NULL DEFAULT 0,
        last_ad_at  INTEGER NOT NULL DEFAULT 0,
        banned_until INTEGER NOT NULL DEFAULT 0,
        ban_reason  TEXT NOT NULL DEFAULT '',
        app_version TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id     TEXT NOT NULL,
        amount        INTEGER NOT NULL,
        balance_after INTEGER NOT NULL DEFAULT 0,
        reason        TEXT NOT NULL,
        ref_id        TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key           TEXT PRIMARY KEY,
        player_id     TEXT NOT NULL,
        op            TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS roles (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS permissions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );

      CREATE TABLE IF NOT EXISTS user_roles (
        player_id   TEXT NOT NULL REFERENCES users(player_id) ON DELETE CASCADE,
        role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        assigned_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, role_id)
      );

      CREATE TABLE IF NOT EXISTS ip_blocks (
        ip            TEXT PRIMARY KEY,
        reason        TEXT NOT NULL DEFAULT '',
        blocked_until INTEGER NOT NULL,
        strikes       INTEGER NOT NULL DEFAULT 1,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS error_logs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        level        TEXT NOT NULL,
        code         TEXT NOT NULL,
        message      TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id     TEXT NOT NULL,
        action       TEXT NOT NULL,
        target_id    TEXT NOT NULL DEFAULT '',
        details_json TEXT NOT NULL DEFAULT '{}',
        ip           TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_coins_uid ON users(coins DESC, user_id ASC);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email != '';
      CREATE INDEX IF NOT EXISTS idx_tx_player ON transactions(player_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tx_reason_time_player ON transactions(reason, created_at, player_id, amount);
      CREATE INDEX IF NOT EXISTS idx_idem_exp ON idempotency_keys(expires_at);
      CREATE INDEX IF NOT EXISTS idx_err_time ON error_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);
    `);

    // Forward-safe migrations for existing databases
    for (const [targetTable, col] of [
      ['users', "password_hash TEXT NOT NULL DEFAULT ''"],
      ['users', 'last_spin_coins INTEGER NOT NULL DEFAULT 0'],
      ['users', 'last_spin_doubled INTEGER NOT NULL DEFAULT 0'],
      ['users', 'daily_streak INTEGER NOT NULL DEFAULT 0'],
      ['users', "last_daily_day TEXT NOT NULL DEFAULT ''"],
      ['users', "ad_day TEXT NOT NULL DEFAULT ''"],
      ['users', 'ad_count INTEGER NOT NULL DEFAULT 0'],
      ['users', 'last_ad_at INTEGER NOT NULL DEFAULT 0'],
      ['users', 'banned_until INTEGER NOT NULL DEFAULT 0'],
      ['users', "ban_reason TEXT NOT NULL DEFAULT ''"],
      ['users', "app_version TEXT NOT NULL DEFAULT ''"],
      ['users', 'updated_at INTEGER NOT NULL DEFAULT 0'],
      ['transactions', 'balance_after INTEGER NOT NULL DEFAULT 0'],
      ['transactions', "ref_id TEXT NOT NULL DEFAULT ''"],
    ]) {
      try {
        this.db.exec(`ALTER TABLE ${targetTable} ADD COLUMN ${col}`);
      } catch {
        // column already exists
      }
    }

    this._seedRbac();
  }

  stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  /** Serializes critical mutations using BEGIN IMMEDIATE; re-entrant safe within one call stack. */
  withTx(fn) {
    if (this._txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this._txDepth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback after broken tx
      }
      throw err;
    } finally {
      this._txDepth -= 1;
    }
  }

  /** Executes `fn` at most once per non-empty `key` within `ttlMs` inside an atomic transaction. */
  runIdempotent(key, playerId, op, fn, ttlMs = 24 * 3600_000) {
    if (!key || typeof key !== 'string' || key.length > 96) {
      return this.withTx(fn);
    }
    return this.withTx(() => {
      const now = Date.now();
      const cached = this.stmt('SELECT response_json, expires_at FROM idempotency_keys WHERE key = ? AND player_id = ? AND op = ?').get(key, playerId, op);
      if (cached && cached.expires_at > now) {
        return JSON.parse(cached.response_json);
      }
      const res = fn();
      this.stmt('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);
      this.stmt(
        'INSERT OR REPLACE INTO idempotency_keys (key, player_id, op, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(key, playerId, op, JSON.stringify(res), now, now + ttlMs);
      return res;
    });
  }

  // ---------- RBAC ----------
  _seedRbac() {
    this.withTx(() => {
      for (const [code, desc] of Object.entries(PERM_DESC)) {
        this.stmt('INSERT OR IGNORE INTO permissions (code, description) VALUES (?, ?)').run(code, desc);
      }
      for (const [role, perms] of Object.entries(RBAC_ROLES)) {
        this.stmt('INSERT OR IGNORE INTO roles (name) VALUES (?)').run(role);
        const rRow = this.stmt('SELECT id FROM roles WHERE name = ?').get(role);
        for (const code of perms) {
          const pRow = this.stmt('SELECT id FROM permissions WHERE code = ?').get(code);
          if (rRow && pRow) {
            this.stmt('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(rRow.id, pRow.id);
          }
        }
      }
    });
  }

  assignRole(playerId, roleName) {
    const r = this.stmt('SELECT id FROM roles WHERE name = ?').get(roleName);
    if (!r) return false;
    this.stmt('INSERT OR IGNORE INTO user_roles (player_id, role_id, assigned_at) VALUES (?, ?, ?)').run(playerId, r.id, Date.now());
    return true;
  }

  getRoles(playerId) {
    return this.stmt('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.player_id = ?')
      .all(playerId)
      .map((r) => r.name);
  }

  getPermissions(playerId) {
    return this.stmt(`
      SELECT DISTINCT p.code FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.player_id = ?
    `)
      .all(playerId)
      .map((p) => p.code);
  }

  hasPermission(playerId, code) {
    return Boolean(
      this.stmt(`
        SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.player_id = ? AND p.code = ? LIMIT 1
      `).get(playerId, code),
    );
  }

  hasAnyOwner() {
    return Boolean(
      this.stmt("SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'owner' LIMIT 1").get(),
    );
  }

  // ---------- users ----------
  getOrCreate(playerId, { name = 'Player', avatar = 0, appVersion = '' } = {}) {
    return this.withTx(() => {
      const existing = this.get(playerId);
      if (existing) return existing;
      let userId;
      do userId = randomInt(1_000_000, 10_000_000);
      while (this.stmt('SELECT 1 FROM users WHERE user_id = ?').get(userId));
      const referral = `CH${userId.toString(36).toUpperCase()}`;
      const now = Date.now();
      this.stmt(
        'INSERT INTO users (player_id, user_id, name, avatar, coins, referral, app_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(playerId, userId, name, avatar, STARTING_COINS, referral, appVersion, now, now);
      this.addTx(playerId, STARTING_COINS, 'welcome', STARTING_COINS, 'welcome');
      this.assignRole(playerId, 'player');
      return this.get(playerId);
    });
  }

  get(playerId) {
    return this.stmt('SELECT * FROM users WHERE player_id = ?').get(playerId) ?? null;
  }

  getByUserId(userId) {
    return this.stmt('SELECT * FROM users WHERE user_id = ?').get(Number(userId)) ?? null;
  }

  getByEmail(email) {
    const clean = String(email ?? '').trim().toLowerCase();
    if (!clean) return null;
    return this.stmt('SELECT * FROM users WHERE lower(email) = ? LIMIT 1').get(clean) ?? null;
  }

  setPassword(playerId, password) {
    const hash = hashPassword(password);
    this.stmt('UPDATE users SET password_hash = ?, updated_at = ? WHERE player_id = ?').run(hash, Date.now(), playerId);
  }

  authenticatePassword(email, password) {
    const u = this.getByEmail(email);
    if (!u || !u.password_hash) return null;
    return verifyPassword(password, u.password_hash) ? u : null;
  }

  update(playerId, fields) {
    const allowed = ['name', 'avatar', 'gender', 'email', 'app_version'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return this.get(playerId);
    const sql = `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE player_id = ?`;
    this.stmt(sql).run(...keys.map((k) => fields[k]), Date.now(), playerId);
    return this.get(playerId);
  }

  setBan(playerId, untilMs, reason = '') {
    this.stmt('UPDATE users SET banned_until = ?, ban_reason = ?, updated_at = ? WHERE player_id = ?')
      .run(untilMs, reason, Date.now(), playerId);
  }

  delete(playerId) {
    this.withTx(() => {
      this.stmt('DELETE FROM idempotency_keys WHERE player_id = ?').run(playerId);
      this.stmt('DELETE FROM transactions WHERE player_id = ?').run(playerId);
      this.stmt('DELETE FROM user_roles WHERE player_id = ?').run(playerId);
      this.stmt('DELETE FROM users WHERE player_id = ?').run(playerId);
    });
  }

  // ---------- coins & atomic ledger ----------
  addCoins(playerId, amount, reason, refId = '') {
    return this.withTx(() => {
      const r = this.stmt('UPDATE users SET coins = coins + ?, updated_at = ? WHERE player_id = ? AND coins + ? >= 0')
        .run(amount, Date.now(), playerId, amount);
      if (r.changes === 0) return false;
      const u = this.stmt('SELECT coins FROM users WHERE player_id = ?').get(playerId);
      this.addTx(playerId, amount, reason, u?.coins ?? 0, refId);
      return true;
    });
  }

  /** Atomically deducts `stake` from every player in `playerIds`, rolling back all if anyone lacks funds. */
  deductStakes(playerIds, stake, refId = '') {
    if (!stake || stake <= 0 || !playerIds.length) return null;
    return this.withTx(() => {
      const now = Date.now();
      for (const pid of playerIds) {
        const u = this.stmt('SELECT name, coins FROM users WHERE player_id = ?').get(pid);
        if (!u || u.coins < stake) {
          throw new Error(`NOT_ENOUGH_COINS:${u?.name ?? 'Player'}`);
        }
        this.stmt('UPDATE users SET coins = coins - ?, updated_at = ? WHERE player_id = ? AND coins >= ?')
          .run(stake, now, pid, stake);
        this.addTx(pid, -stake, 'entry', u.coins - stake, refId);
      }
      return true;
    });
  }

  addTx(playerId, amount, reason, balanceAfter = 0, refId = '') {
    this.stmt('INSERT INTO transactions (player_id, amount, balance_after, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(playerId, amount, balanceAfter, reason, refId, Date.now());
  }

  transactions(playerId, limit = 50) {
    return this.stmt('SELECT amount, reason, balance_after AS balanceAfter, created_at AS at FROM transactions WHERE player_id = ? ORDER BY id DESC LIMIT ?')
      .all(playerId, Math.min(100, Math.max(1, limit)));
  }

  addResult(playerId, won, xp) {
    this.stmt('UPDATE users SET xp = xp + ?, wins = wins + ?, losses = losses + ?, updated_at = ? WHERE player_id = ?')
      .run(xp, won ? 1 : 0, won ? 0 : 1, Date.now(), playerId);
  }

  setSpin(playerId, at, coins = 0) {
    this.stmt('UPDATE users SET last_spin = ?, last_spin_coins = ?, last_spin_doubled = 0, updated_at = ? WHERE player_id = ?')
      .run(at, coins, Date.now(), playerId);
  }

  markSpinDoubled(playerId) {
    this.stmt('UPDATE users SET last_spin_doubled = 1, updated_at = ? WHERE player_id = ?').run(Date.now(), playerId);
  }

  setDaily(playerId, streak, day) {
    this.stmt('UPDATE users SET daily_streak = ?, last_daily_day = ?, updated_at = ? WHERE player_id = ?')
      .run(streak, day, Date.now(), playerId);
  }

  /** Atomic daily ad counter bump under BEGIN IMMEDIATE (eliminates race condition). */
  bumpAdCountAtomic(playerId, day, maxPerDay, minGapMs = 1500, now = Date.now()) {
    return this.withTx(() => {
      const u = this.get(playerId);
      if (!u) return { error: 'NO_USER' };
      if (u.last_ad_at && now - u.last_ad_at < minGapMs) return { error: 'AD_TOO_FAST' };
      const count = u.ad_day === day ? u.ad_count + 1 : 1;
      if (count > maxPerDay) return { error: 'AD_LIMIT' };
      this.stmt('UPDATE users SET ad_day = ?, ad_count = ?, last_ad_at = ?, updated_at = ? WHERE player_id = ?')
        .run(day, count, now, now, playerId);
      return { count };
    });
  }

  byReferral(code) {
    return this.stmt('SELECT * FROM users WHERE referral = ?').get(String(code ?? '').trim().toUpperCase()) ?? null;
  }

  setReferredBy(playerId, code) {
    this.stmt('UPDATE users SET referred_by = ?, updated_at = ? WHERE player_id = ?').run(code, Date.now(), playerId);
  }

  // ---------- leaderboard (O(log N) SQL indexed) ----------
  leaderboard(period = 'all', limit = 50) {
    const cap = Math.min(100, Math.max(1, limit));
    if (period === 'all') {
      return this.stmt('SELECT player_id, user_id, name, avatar, coins AS score FROM users WHERE banned_until <= ? ORDER BY coins DESC, user_id ASC LIMIT ?')
        .all(Date.now(), cap);
    }
    const since = Date.now() - (period === 'week' ? 7 : 30) * 24 * 3600_000;
    return this.stmt(`
      SELECT u.player_id, u.user_id, u.name, u.avatar, SUM(t.amount) AS score
      FROM transactions t JOIN users u ON u.player_id = t.player_id
      WHERE t.reason = 'win' AND t.created_at >= ? AND u.banned_until <= ?
      GROUP BY u.player_id ORDER BY score DESC, u.user_id ASC LIMIT ?
    `).all(since, Date.now(), cap);
  }

  rankOf(playerId, period = 'all') {
    const u = this.get(playerId);
    if (!u) return null;
    if (period === 'all') {
      const ahead = this.stmt(
        'SELECT COUNT(*) AS cnt FROM users WHERE banned_until <= ? AND (coins > ? OR (coins = ? AND user_id < ?))',
      ).get(Date.now(), u.coins, u.coins, u.user_id);
      return { rank: (ahead?.cnt ?? 0) + 1, score: u.coins };
    }
    const since = Date.now() - (period === 'week' ? 7 : 30) * 24 * 3600_000;
    const mine = this.stmt("SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE reason = 'win' AND created_at >= ? AND player_id = ?")
      .get(since, playerId)?.s ?? 0;
    if (mine <= 0) return null;
    const ahead = this.stmt(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT player_id, SUM(amount) AS s FROM transactions
        WHERE reason = 'win' AND created_at >= ?
        GROUP BY player_id HAVING s > ?
      )
    `).get(since, mine);
    return { rank: (ahead?.cnt ?? 0) + 1, score: mine };
  }

  // ---------- IP blocks, error tracker, audit ----------
  getIpBlock(ip) {
    return this.stmt('SELECT * FROM ip_blocks WHERE ip = ?').get(ip) ?? null;
  }

  blockIp(ip, blockedUntil, reason = '') {
    this.stmt(`
      INSERT INTO ip_blocks (ip, reason, blocked_until, strikes, updated_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, blocked_until = excluded.blocked_until, strikes = strikes + 1, updated_at = excluded.updated_at
    `).run(ip, reason, blockedUntil, Date.now());
  }

  recordError(level, code, message, context = {}) {
    try {
      this.stmt('INSERT INTO error_logs (level, code, message, context_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(level, String(code).slice(0, 64), String(message).slice(0, 500), JSON.stringify(context).slice(0, 2000), Date.now());
      this.stmt('DELETE FROM error_logs WHERE id NOT IN (SELECT id FROM error_logs ORDER BY id DESC LIMIT 500)').run();
    } catch {
      // avoid throwing from error logger
    }
  }

  recentErrors(limit = 50) {
    return this.stmt('SELECT id, level, code, message, context_json AS context, created_at AS at FROM error_logs ORDER BY id DESC LIMIT ?')
      .all(Math.min(100, limit));
  }

  recordAudit(actorId, action, targetId = '', details = {}, ip = '') {
    this.stmt('INSERT INTO audit_logs (actor_id, action, target_id, details_json, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actorId, action, targetId, JSON.stringify(details).slice(0, 2000), ip, Date.now());
  }

  recentAudits(limit = 50) {
    return this.stmt('SELECT id, actor_id AS actorId, action, target_id AS targetId, details_json AS details, ip, created_at AS at FROM audit_logs ORDER BY id DESC LIMIT ?')
      .all(Math.min(100, limit));
  }

  close() {
    this.db.close();
  }
}
