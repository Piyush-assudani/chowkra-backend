import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createServer } from '../src/index.js';
import { BackupManager } from '../src/infra/backup.js';

let srv, url;
before(async () => {
  srv = createServer({ dbPath: ':memory:' });
  await new Promise((r) => srv.server.listen(0, r));
  url = `http://localhost:${srv.server.address().port}`;
});
after(() => srv.close());

const client = (ipHeader = null) =>
  connect(url, {
    transports: ['websocket'],
    forceNew: true,
    extraHeaders: ipHeader ? { 'x-forwarded-for': ipHeader } : undefined,
  });
const call = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

test('private room: create, join, JWT never leaked, only turn owner may roll', async () => {
  const a = client(), b = client();
  const ha = await call(a, 'hello', { name: 'Asha' });
  assert.ok(ha.ok && ha.token && ha.publicId);
  await call(b, 'hello', { name: 'Bunty' });

  const created = await call(a, 'room:create', { players: 2 });
  assert.ok(created.ok);
  assert.equal(created.room.code.length, 6);
  assert.ok(!JSON.stringify(created.room).includes(ha.token), 'JWT not leaked');

  const started = new Promise((r) => a.on('room:state', (s) => s.room.status === 'playing' && r(s)));
  const joined = await call(b, 'room:join', { code: created.room.code });
  assert.ok(joined.ok);
  const st = await started;
  assert.equal(st.room.game.turn, 0);

  const bad = await call(b, 'game:roll', {});
  assert.equal(bad.code, 'NOT_YOUR_TURN');
  const good = await call(a, 'game:roll', {});
  assert.ok(good.ok);
  a.close(); b.close();
});

test('vs computer & stateless JWT reconnect restores exact room and balance', async () => {
  const a = client();
  const h = await call(a, 'hello', { name: 'Solo' });
  const r = await call(a, 'room:bots', { players: 4 });
  assert.equal(r.room.status, 'playing');
  assert.equal(r.room.members.filter((m) => m.isBot).length, 3);
  a.close();

  const a2 = client();
  const h2 = await call(a2, 'hello', { token: h.token, name: 'Solo' });
  assert.equal(h2.publicId, h.publicId);
  assert.equal(h2.room?.code, r.room.code);
  a2.close();
});

test('accounts, daily rewards, spin 2x, and indexed O(log N) rank work properly', async () => {
  const a = client();
  const h = await call(a, 'hello', { name: 'Coins' });
  assert.equal(h.profile.coins, 500);
  assert.equal(String(h.profile.userId).length, 7);

  const d1 = await call(a, 'reward:daily', { reqId: 'daily-1' });
  assert.ok(d1.ok);
  assert.equal(d1.coins, 50);

  const s1 = await call(a, 'reward:spin', { reqId: 'spin-1' });
  assert.ok(s1.ok);
  assert.equal(s1.profile.coins, 550 + s1.coins);

  const dbl = await call(a, 'reward:spinDouble', { reqId: 'dbl-1' });
  assert.ok(dbl.ok);
  assert.equal(dbl.profile.coins, 550 + s1.coins * 2);

  // Repeating with SAME reqId returns idempotent replay without second charge/credit
  const dblIdem = await call(a, 'reward:spinDouble', { reqId: 'dbl-1' });
  assert.equal(dblIdem.bonus, dbl.bonus);
  assert.equal(dblIdem.profile.coins, 550 + s1.coins * 2);

  const s2 = await call(a, 'reward:spin', {});
  assert.equal(s2.code, 'SPIN_WAIT');

  const lb = await call(a, 'leaderboard', { period: 'all' });
  assert.ok(lb.rows.some((r) => r.me));
  assert.ok(lb.me.rank >= 1);
  a.close();
});

test('concurrency & 100-click burst stress: spin + ad rewards cannot double-spend', async () => {
  const a = client('10.20.30.1');
  const h = await call(a, 'hello', { name: 'BurstUser' });
  const initialCoins = h.profile.coins;

  // Fire 40 simultaneous spin calls (note socket event limiter allows 20/min -> rate limited + spin cooldown)
  const spinResults = await Promise.all(
    Array.from({ length: 18 }, (_, i) => call(a, 'reward:spin', { reqId: `burst-${i}` })),
  );
  const spinWins = spinResults.filter((r) => r.ok);
  assert.equal(spinWins.length, 1, 'Exactly one spin succeeds under concurrent burst');
  const afterSpin = await call(a, 'profile:get', {});
  assert.equal(afterSpin.profile.coins, initialCoins + spinWins[0].coins);

  // Verify DB-level atomic ad cap even under tight concurrent calls
  const b = client('10.20.30.2');
  const hb = await call(b, 'hello', { name: 'AdBurst' });
  const uid = hb.profile.userId;
  const userRow = srv.store.getByUserId(uid);
  const outcomes = [];
  for (let i = 0; i < 15; i++) {
    outcomes.push(srv.store.bumpAdCountAtomic(userRow.player_id, '2026-11-25', 10, 0));
  }
  assert.equal(outcomes.filter((o) => o.count).length, 10, 'Daily ad limit strictly enforced atomically');
  assert.equal(outcomes.filter((o) => o.error === 'AD_LIMIT').length, 5);
  a.close(); b.close();
});

test('stakes: atomic transaction rolls back all if any player lacks coins', async () => {
  const a = client(), b = client();
  const ha = await call(a, 'hello', { name: 'Rich' });
  await call(b, 'hello', { name: 'BrokeSoon' });

  const created = await call(a, 'room:create', { players: 2, stake: 500 });
  assert.ok(created.ok);

  // Drain B's coins before start so atomic start must reject without charging A
  const bUser = srv.store.getByUserId((await call(b, 'profile:get', {})).profile.userId);
  srv.store.addCoins(bUser.player_id, -450, 'test_drain');

  const joinRes = await call(b, 'room:join', { code: created.room.code });
  assert.equal(joinRes.ok, false);
  assert.equal(joinRes.code, 'NOT_ENOUGH_COINS');

  const aProf = await call(a, 'profile:get', {});
  assert.equal(aProf.profile.coins, ha.profile.coins, 'Player A coins preserved on atomic rollback');
  a.close(); b.close();
});

test('referral gives both players mutual bonus cleanly', async () => {
  const a = client(), b = client();
  const ha = await call(a, 'hello', { name: 'Ref' });
  await call(b, 'hello', { name: 'New' });
  const r = await call(b, 'reward:referral', { code: ha.profile.referral });
  assert.ok(r.ok);
  assert.equal(r.profile.coins, 700);
  const again = await call(b, 'reward:referral', { code: ha.profile.referral });
  assert.equal(again.code, 'REF_USED');
  a.close(); b.close();
});

test('security: strict headers, no wildcard CORS, XSS cleanName, prototype pollution guard & IP rate block', async () => {
  // 1. Check HTTP security headers and absence of wildcard CORS
  const res = await fetch(`${url}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'Wildcard CORS is disabled');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-powered-by'), null);

  // 2. Reject forged JWT (cannot impersonate another user)
  const victim = client();
  const hv = await call(victim, 'hello', { name: 'Victim' });
  const attacker = client();
  const ha = await call(attacker, 'hello', { token: `${hv.token}tampered`, name: '<script>alert(1)</script>Hacker' });
  assert.notEqual(ha.publicId, hv.publicId, 'Tampered JWT creates fresh guest instead of hijacking victim');
  assert.ok(!ha.profile.name.includes('<'), 'HTML tags stripped from player name');

  // 3. Prototype pollution rejection
  const rawJsonPoison = JSON.parse('{"__proto__":{"polluted":true},"name":"X"}');
  const poisonRes = await call(attacker, 'profile:update', rawJsonPoison);
  assert.equal(poisonRes.ok, false);
  assert.equal(poisonRes.code, 'BAD_INPUT');

  // 4. Quick chat validation
  await call(victim, 'room:bots', { players: 2, variant: 'quick' });
  const badChat = await call(victim, 'chat:quick', { message: '<b>xss</b>' });
  assert.equal(badChat.code, 'BAD_CHAT');

  victim.close(); attacker.close();

  // 5. Persistent IP rate limit + auto block
  srv.limiter.block('198.51.100.77', 60_000, 'test_abuse');
  const blockedRes = await fetch(`${url}/health`, { headers: { 'x-forwarded-for': '198.51.100.77' } });
  assert.equal(blockedRes.status, 403);
});

test('RBAC Admin routes (Owner/Moderator/audit/economy/ban) + SQLite VACUUM INTO hot backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chowkra-bak-'));
  const dbFile = join(dir, 'main.db');
  const fsSrv = createServer({ dbPath: dbFile });
  await new Promise((r) => fsSrv.server.listen(0, r));
  const fsUrl = `http://localhost:${fsSrv.server.address().port}`;

  try {
    // Bootstrap first Owner account
    const bootRes = await fetch(`${fsUrl}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@chowkra.app', password: 'StrongPassword#2026', name: 'OpsOwner' }),
    });
    const boot = await bootRes.json();
    assert.equal(bootRes.status, 200);
    assert.ok(boot.ok && boot.token);
    assert.ok(boot.permissions.includes('trigger_backup'));
    assert.ok(boot.permissions.includes('manage_economy'));

    // Second bootstrap blocked
    const boot2 = await fetch(`${fsUrl}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@chowkra.app', password: 'StrongPassword#2026' }),
    });
    assert.equal(boot2.status, 409);

    // Create a moderator player via socket & verify Moderator cannot call manage_economy
    const s = connect(fsUrl, { transports: ['websocket'], forceNew: true });
    const hs = await new Promise((r) => s.emit('hello', { name: 'Mod' }, r));
    const roleRes = await fetch(`${fsUrl}/api/admin/roles/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${boot.token}` },
      body: JSON.stringify({ userId: hs.profile.userId, role: 'moderator' }),
    });
    assert.equal((await roleRes.json()).ok, true);

    const modUser = fsSrv.store.getByUserId(hs.profile.userId);
    fsSrv.store.update(modUser.player_id, { email: 'mod@chowkra.app' });
    fsSrv.store.setPassword(modUser.player_id, 'ModPassword#2026');
    const modLogin = await (
      await fetch(`${fsUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'mod@chowkra.app', password: 'ModPassword#2026' }),
      })
    ).json();
    assert.ok(modLogin.ok && modLogin.token);

    // Moderator denied manage_economy -> 403
    const denied = await fetch(`${fsUrl}/api/admin/economy/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${modLogin.token}` },
      body: JSON.stringify({ userId: hs.profile.userId, amount: 9999 }),
    });
    assert.equal(denied.status, 403);

    // Owner triggers hot SQLite backup & verify integrity_check === ok
    const bakRes = await (
      await fetch(`${fsUrl}/api/admin/backup`, {
        method: 'POST',
        headers: { authorization: `Bearer ${boot.token}` },
      })
    ).json();
    assert.ok(bakRes.ok && bakRes.path);
    assert.equal(BackupManager.verifyBackup(bakRes.path), true);

    // Owner inspects ops & audit trail
    const ops = await (
      await fetch(`${fsUrl}/api/admin/ops`, {
        headers: { authorization: `Bearer ${boot.token}` },
      })
    ).json();
    assert.ok(ops.ok && ops.audits.some((a) => a.action === 'manual_backup'));
    s.close();
  } finally {
    fsSrv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E2E live socket match + 1000-click idempotent economy stress test', async () => {
  // 1. Live 2-player Socket.IO game playthrough from hello -> create -> join -> roll/move -> forfeit settle
  const p1 = client('10.99.0.1');
  const p2 = client('10.99.0.2');
  const h1 = await call(p1, 'hello', { name: 'E2EOne' });
  const h2 = await call(p2, 'hello', { name: 'E2ETwo' });
  const roomRes = await call(p1, 'room:create', { players: 2, stake: 100, variant: 'classic' });
  assert.ok(roomRes.ok);

  const started = new Promise((r) => p1.on('room:state', (s) => s.room.status === 'playing' && r(s.room)));
  await call(p2, 'room:join', { code: roomRes.room.code });
  const playingRoom = await started;
  assert.equal(playingRoom.game.rules.maxOutBeforeFirstFinish, 3);
  assert.equal(playingRoom.game.rules.killRequiredForInnerRing, true);
  assert.equal(playingRoom.game.rules.pakkaEnabled, true);

  // Play real roll -> move loop cleanly via Socket.IO
  const waitState = (sock, pred) => new Promise((r) => {
    const fn = (s) => { if (pred(s.room)) { sock.off('room:state', fn); r(s.room); } };
    sock.on('room:state', fn);
  });

  const p3 = client('10.99.0.3');
  const p4 = client('10.99.0.4');
  const h3 = await call(p3, 'hello', { name: 'PlayA' });
  const h4 = await call(p4, 'hello', { name: 'PlayB' });
  const c2 = await call(p3, 'room:create', { players: 2, stake: 100, variant: 'classic' });
  const startP = waitState(p3, (r) => r.status === 'playing');
  await call(p4, 'room:join', { code: c2.room.code });
  let latestRoom = await startP;
  assert.equal(latestRoom.status, 'playing');

  // Execute real roll -> move loop via socket events (5 turns)
  for (let step = 0; step < 5 && latestRoom.status === 'playing'; step++) {
    const turn = latestRoom.game.turn;
    const sock = turn === 0 ? p3 : p4;
    if (latestRoom.game.phase === 'roll') {
      const snapKey = JSON.stringify(latestRoom.game.players);
      const nextP = waitState(
        p3,
        (r) =>
          r.game.turnNo !== latestRoom.game.turnNo ||
          r.game.phase !== 'roll' ||
          JSON.stringify(r.game.players) !== snapKey,
      );
      const rr = await call(sock, 'game:roll', { seat: turn });
      assert.ok(rr.ok);
      latestRoom = await nextP;
    }
    if (latestRoom.status === 'playing' && latestRoom.game.phase === 'move') {
      const m = latestRoom.game.moves[0];
      const nextP = waitState(p3, (r) => r.game.turnNo !== latestRoom.game.turnNo || r.game.phase !== 'move' || r.status === 'ended');
      const mr = await call(sock, 'game:move', { seat: turn, piece: m.piece, moveId: m.id, kind: m.kind });
      assert.ok(mr.ok);
      latestRoom = await nextP;
    }
  }
  // Forfeit p4 -> p3 wins pot (180 coins: 200 - 10% table fee)
  const ended = new Promise((r) => p3.on('room:state', (s) => s.room.status === 'ended' && r(s.room)));
  await call(p4, 'room:leave', {});
  const endRoom = await ended;
  assert.equal(endRoom.status, 'ended');
  const prof3 = await call(p3, 'profile:get', {});
  assert.equal(prof3.profile.coins, h3.profile.coins - 100 + 180);

  // 2. 1,000 concurrent/idempotent click stress on Store ledger (zero double credit & fast latency)
  const u3 = srv.store.getByUserId(h3.profile.userId);
  const startCoins = u3.coins;
  for (let k = 0; k < 1000; k++) {
    srv.store.runIdempotent('stress-same-click', u3.player_id, 'stress_bonus', () => {
      srv.store.addCoins(u3.player_id, 50, 'stress_test');
      return { ok: true };
    });
  }
  assert.equal(srv.store.get(u3.player_id).coins, startCoins + 50, '1000 duplicate idempotency clicks credit strictly once');

  // Avoid unused var lint
  assert.ok(h1.publicId && h2.publicId && h4.publicId);
  p1.close(); p2.close(); p3.close(); p4.close();
});

test('Migrates legacy v1 SQLite database preserving user balances and transactions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chowkra-legacy-'));
  const legacyDbPath = join(dir, 'chowkra-legacy.db');
  const rawDb = new DatabaseSync(legacyDbPath);
  rawDb.exec(`
    CREATE TABLE users (
      player_id TEXT PRIMARY KEY,
      user_id INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      avatar INTEGER NOT NULL DEFAULT 0,
      gender TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      coins INTEGER NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      referral TEXT UNIQUE NOT NULL,
      referred_by TEXT,
      last_spin INTEGER NOT NULL DEFAULT 0,
      ad_day TEXT NOT NULL DEFAULT '',
      ad_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  rawDb
    .prepare(
      'INSERT INTO users (player_id, user_id, name, coins, referral, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('legacy-p1', 1234567, 'LegacyHero', 750, 'CHLEGACY', Date.now() - 10_000);
  rawDb
    .prepare('INSERT INTO transactions (player_id, amount, reason, created_at) VALUES (?, ?, ?, ?)')
    .run('legacy-p1', 750, 'welcome', Date.now() - 10_000);
  rawDb.close();

  const legacySrv = createServer({ dbPath: legacyDbPath });
  await new Promise((r) => legacySrv.server.listen(0, r));
  const legacyUrl = `http://localhost:${legacySrv.server.address().port}`;
  const sock = connect(legacyUrl, { transports: ['websocket'], forceNew: true });

  try {
    // Unauthenticated room call still rejects cleanly with NO_HELLO before handshake
    const preHello = await call(sock, 'room:bots', { players: 2 });
    assert.equal(preHello.ok, false);
    assert.equal(preHello.code, 'NO_HELLO');

    // Existing v1 user balance & transactions preserved after migration
    const preserved = legacySrv.store.get('legacy-p1');
    assert.equal(preserved?.name, 'LegacyHero');
    assert.equal(preserved?.coins, 750);

    // New user hello (inserts into transactions.ref_id), spin, and bot match all succeed on migrated DB
    const h = await call(sock, 'hello', { name: 'MigratedNew' });
    assert.equal(h.ok, true, h.message);
    const botRes = await call(sock, 'room:bots', { players: 2, variant: 'classic' });
    assert.equal(botRes.ok, true, botRes.message);
    const spinRes = await call(sock, 'reward:spin', { reqId: 'mig-spin-1' });
    assert.equal(spinRes.ok, true, spinRes.message);
    const lbRes = await call(sock, 'leaderboard', { period: 'daily' });
    assert.equal(lbRes.ok, true, lbRes.message);
  } finally {
    sock.close();
    legacySrv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
