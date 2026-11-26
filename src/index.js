import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { GameError } from './game/engine.js';
import { VARIANTS } from './game/rules.js';
import { DAILY_REWARDS, QUICK_CHATS, SPIN_PRIZES, STAKES, adReward, applyReferral, claimDaily, publicProfile, spin, spinDouble } from './economy.js';
import { Store } from './store/db.js';
import { publicId } from './rooms/Room.js';
import { RoomManager } from './rooms/RoomManager.js';
import { BackupManager } from './infra/backup.js';
import { CacheLayer } from './infra/cache.js';
import { AsyncJobQueue } from './infra/queue.js';
import { createAdminRouter } from './infra/adminRoutes.js';
import {
  RateLimiter,
  assertSafePayload,
  cleanEmail,
  cleanName,
  getClientIp,
  parseAllowedOrigins,
  resolveJwtSecret,
  securityHeaders,
  signJwt,
  verifyJwt,
} from './infra/security.js';

export function createServer({ dbPath, corsOrigins } = {}) {
  const store = new Store(dbPath);
  const effectivePath = dbPath ?? process.env.DB_PATH ?? 'data/chowkra.db';
  const jwtSecret = resolveJwtSecret(effectivePath);
  const cache = new CacheLayer();
  const limiter = new RateLimiter({ store });
  const backup = new BackupManager(store.db, effectivePath);
  backup.startSchedule();
  const queue = new AsyncJobQueue({
    onError: (job, err) => store.recordError('error', 'JOB_FAILED', `${job}: ${err.message}`),
  });

  const allowedOrigins = corsOrigins ? new Set(corsOrigins) : parseAllowedOrigins();
  const isOriginAllowed = (origin) => {
    if (!origin) return true; // native mobile / CLI clients
    return allowedOrigins.has(origin);
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use((req, res, next) => {
    const ip = getClientIp(req);
    if (limiter.isBlocked(ip)) {
      return res.status(403).json({ ok: false, code: 'IP_BLOCKED', message: 'Temporarily blocked' });
    }
    if (!limiter.allow('http', ip, 180, 60_000, { ipForBlock: ip, autoBlockStrikes: 10 })) {
      return res.status(429).json({ ok: false, code: 'RATE_LIMITED', message: 'Too many requests' });
    }
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, code: 'BAD_JSON', message: 'Malformed JSON body' });
    }
    next(err);
  });

  const server = http.createServer(app);
  server.on('connection', (sock) => sock.setNoDelay(true));
  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    allowRequest: (req, cb) => {
      const ip = getClientIp(req);
      if (limiter.isBlocked(ip)) return cb('Temporarily blocked', false);
      if (!limiter.allow('ws_connect', ip, 60, 60_000, { ipForBlock: ip })) return cb('Rate limited', false);
      const origin = req.headers.origin;
      if (origin && !isOriginAllowed(origin)) return cb('Origin not allowed', false);
      cb(null, true);
    },
  });

  const emit = (room, event, payload) => io.to(`room:${room.code}`).emit(event, payload);
  const sockets = new Map(); // playerId -> Set<socket>
  const getCachedUser = (playerId) => {
    const key = `u:${playerId}`;
    let u = cache.get(key);
    if (u !== undefined) return u;
    u = store.get(playerId) ?? null;
    if (u) cache.set(key, u, 5_000);
    return u;
  };
  const pushProfile = (playerId) => {
    const u = store.get(playerId);
    if (u) cache.set(`u:${playerId}`, u, 5_000);
    const prof = publicProfile(u, store);
    for (const s of sockets.get(playerId) ?? []) s.emit('profile', prof);
  };
  const invalidateLb = () => cache.delPrefix('lb:');
  const rooms = new RoomManager(emit, { store, onProfile: pushProfile, onCacheInvalidate: invalidateLb });

  app.get('/config', (_req, res) => {
    let cfg = cache.get('cfg');
    if (!cfg) {
      cfg = {
        stakes: STAKES,
        spinPrizes: SPIN_PRIZES.map((p) => p.coins),
        dailyRewards: DAILY_REWARDS,
        quickChats: QUICK_CHATS,
        variants: ['classic', 'quick', 'blitz'],
        boardSize: 5,
      };
      cache.set('cfg', cfg, 60_000);
    }
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(cfg);
  });

  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const brandName = cleanName(process.env.COMPANY_NAME ?? 'Chowkra Interactive') || 'Chowkra Interactive';
  const supportMail = cleanEmail(process.env.SUPPORT_EMAIL ?? '') || '';
  const renderLegal = (file) =>
    readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url)), 'utf8')
      .replaceAll('{{COMPANY_NAME}}', brandName)
      .replaceAll('{{SUPPORT_EMAIL_LINE}}', supportMail ? `<a href="mailto:${supportMail}">${supportMail}</a>` : 'Use Help Desk in Settings inside the Chowkra app');
  const privacyHtml = renderLegal('privacy.html');
  const termsHtml = renderLegal('terms.html');

  app.get('/privacy', (_req, res) => res.setHeader('Cache-Control', 'public, max-age=3600').type('html').send(privacyHtml));
  app.get('/terms', (_req, res) => res.setHeader('Cache-Control', 'public, max-age=3600').type('html').send(termsHtml));
  app.use(express.static(publicDir, { index: false, maxAge: '1h' }));

  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      ...rooms.stats(),
      cache: cache.stats(),
      queue: queue.stats(),
    }));

  app.use('/api/admin', createAdminRouter({ store, cache, queue, backup, rooms, limiter, jwtSecret }));

  const players = (n) => parseInt(n, 10);
  const ipConnCount = new Map();

  io.use((socket, next) => {
    const ip = getClientIp(socket);
    if (limiter.isBlocked(ip)) return next(new Error('IP_BLOCKED'));
    const count = ipConnCount.get(ip) ?? 0;
    if (count >= 25) return next(new Error('TOO_MANY_CONNECTIONS'));
    ipConnCount.set(ip, count + 1);
    socket.on('disconnect', () => {
      const cur = (ipConnCount.get(ip) ?? 1) - 1;
      if (cur <= 0) ipConnCount.delete(ip);
      else ipConnCount.set(ip, cur);
    });
    next();
  });

  io.on('connection', (socket) => {
    const ip = getClientIp(socket);
    let me = null;

    const ok = (ack, data = {}) => typeof ack === 'function' && ack({ ok: true, ...data });
    const fail = (ack, err) => {
      const code = err instanceof GameError ? err.code : 'SERVER_ERROR';
      if (!(err instanceof GameError)) {
        queue.enqueue('err_log', () => store.recordError('error', code, err?.message ?? 'Unknown error', { socketId: socket.id }));
      }
      if (typeof ack === 'function') {
        ack({ ok: false, code, message: err instanceof GameError ? err.message : 'Server error, please try again' });
      }
    };

    const guard = (fn, { limit = 60, windowMs = 10_000, bucket = 'evt' } = {}) => (data = {}, ack) => {
      try {
        if (typeof data === 'function') [ack, data] = [data, {}];
        const key = me?.playerId ?? ip;
        if (!limiter.allow(bucket, key, limit, windowMs, { ipForBlock: ip, autoBlockStrikes: 12 })) {
          throw new GameError('RATE_LIMITED', 'Too many actions — slow down a moment');
        }
        try {
          assertSafePayload(data);
        } catch (err) {
          throw new GameError('BAD_INPUT', err?.message || 'Invalid request');
        }
        if (!me && fn.name !== 'hello') throw new GameError('NO_HELLO', 'Say hello first');
        if (me) {
          const fresh = getCachedUser(me.playerId);
          if (fresh && fresh.banned_until > Date.now()) {
            throw new GameError('BANNED', 'Account is temporarily suspended');
          }
        }
        fn(data && typeof data === 'object' && !Array.isArray(data) ? data : {}, ack);
      } catch (err) {
        fail(ack, err);
      }
    };

    const enter = (room, ack) => {
      for (const r of socket.rooms) if (r.startsWith('room:') && r !== `room:${room.code}`) socket.leave(r);
      socket.join(`room:${room.code}`);
      ok(ack, { room: room.snapshot() });
      socket.emit('room:state', { room: room.snapshot(), events: [] });
    };

    socket.on('hello', guard(function hello({ token, name, avatar, appVersion }, ack) {
      const authTok = token ?? socket.handshake.auth?.token;
      const claims = verifyJwt(authTok, jwtSecret);
      const id = claims?.sub && getCachedUser(claims.sub) ? claims.sub : randomUUID();
      const ver = typeof appVersion === 'string' ? appVersion.slice(0, 24) : '';
      const user = store.getOrCreate(id, {
        name: cleanName(name),
        avatar: Number.isInteger(avatar) && avatar >= 0 && avatar < 32 ? avatar : 0,
        appVersion: ver,
      });
      if (user.banned_until && user.banned_until > Date.now()) {
        throw new GameError('BANNED', 'Account is temporarily suspended');
      }
      const fields = {};
      if (name !== undefined && String(name).trim()) fields.name = cleanName(name);
      if (Number.isInteger(avatar) && avatar >= 0 && avatar < 32) fields.avatar = avatar;
      if (ver && ver !== user.app_version) fields.app_version = ver;
      const u = Object.keys(fields).length ? store.update(id, fields) : user;
      cache.set(`u:${id}`, u, 5_000);

      if (me && me.playerId !== id) sockets.get(me.playerId)?.delete(socket);
      me = { playerId: id, name: u.name, avatar: u.avatar, socketId: socket.id };
      if (!sockets.has(id)) sockets.set(id, new Set());
      sockets.get(id).add(socket);

      const room = rooms.roomOf(id);
      if (room && room.mode !== 'local') {
        const m = room.memberByPlayer(id);
        if (m) {
          m.socketId = socket.id;
          m.connected = true;
          socket.join(`room:${room.code}`);
          room.broadcast();
        }
      } else if (room) {
        socket.join(`room:${room.code}`);
      }
      const nextToken = signJwt({ sub: id, uid: u.user_id }, jwtSecret);
      ok(ack, {
        token: nextToken,
        publicId: publicId(id),
        profile: publicProfile(u, store),
        room: room ? room.snapshot() : null,
      });
    }, { bucket: 'hello', limit: 20, windowMs: 60_000 }));

    socket.on('profile:get', guard((_d, ack) => {
      const u = store.get(me.playerId);
      if (u) cache.set(`u:${me.playerId}`, u, 5_000);
      ok(ack, { profile: publicProfile(u, store) });
    }));

    socket.on('profile:update', guard(({ name, avatar, gender, email }, ack) => {
      const fields = {};
      if (name !== undefined) fields.name = cleanName(name);
      if (Number.isInteger(avatar) && avatar >= 0 && avatar < 32) fields.avatar = avatar;
      if (['male', 'female', 'other', ''].includes(gender)) fields.gender = gender;
      if (email !== undefined) {
        const e = cleanEmail(email);
        if (e === null) throw new GameError('BAD_EMAIL', 'Email looks wrong');
        fields.email = e;
      }
      const u = store.update(me.playerId, fields);
      cache.set(`u:${me.playerId}`, u, 5_000);
      me.name = u.name;
      me.avatar = u.avatar;
      invalidateLb();
      ok(ack, { profile: publicProfile(u, store) });
    }, { bucket: 'profile', limit: 25, windowMs: 60_000 }));

    socket.on('profile:transactions', guard((_d, ack) => ok(ack, { items: store.transactions(me.playerId) })));

    socket.on('account:delete', guard((_d, ack) => {
      rooms.detach(me.playerId);
      store.delete(me.playerId);
      cache.del(`u:${me.playerId}`);
      invalidateLb();
      ok(ack);
    }, { bucket: 'acct_del', limit: 5, windowMs: 60_000 }));

    const rewardProfile = () => {
      const u = store.get(me.playerId);
      if (u) cache.set(`u:${me.playerId}`, u, 5_000);
      return publicProfile(u, store);
    };

    socket.on('reward:spin', guard(({ reqId }, ack) => {
      const r = spin(store, me.playerId, Date.now(), reqId, cache);
      ok(ack, { ...r, profile: rewardProfile() });
    }, { bucket: 'reward', limit: 20, windowMs: 60_000 }));

    socket.on('reward:spinDouble', guard(({ reqId }, ack) => {
      const r = spinDouble(store, me.playerId, Date.now(), reqId, cache);
      ok(ack, { ...r, profile: rewardProfile() });
    }, { bucket: 'reward', limit: 20, windowMs: 60_000 }));

    socket.on('reward:daily', guard(({ reqId }, ack) => {
      const r = claimDaily(store, me.playerId, new Date(), reqId, cache);
      ok(ack, { ...r, profile: rewardProfile() });
    }, { bucket: 'reward', limit: 20, windowMs: 60_000 }));

    socket.on('reward:ad', guard(({ reqId }, ack) => {
      const r = adReward(store, me.playerId, reqId, cache);
      ok(ack, { ...r, profile: rewardProfile() });
    }, { bucket: 'reward', limit: 20, windowMs: 60_000 }));

    socket.on('reward:referral', guard(({ code, reqId }, ack) => {
      const r = applyReferral(store, me.playerId, code, reqId, cache);
      ok(ack, { ...r, profile: rewardProfile() });
    }, { bucket: 'reward', limit: 10, windowMs: 60_000 }));

    socket.on('leaderboard', guard(({ period }, ack) => {
      const p = ['all', 'week', 'month'].includes(period) ? period : 'all';
      let baseRows = cache.get(`lb:${p}`);
      if (!baseRows) {
        baseRows = store.leaderboard(p, 50);
        cache.set(`lb:${p}`, baseRows, 15_000);
      }
      const rows = baseRows.map((r, i) => ({
        rank: i + 1,
        userId: r.user_id,
        name: r.name,
        avatar: r.avatar,
        score: r.score,
        me: r.player_id === me.playerId,
      }));
      const rkKey = `lb:rank:${p}:${me.playerId}`;
      let mine = cache.get(rkKey);
      if (mine === undefined) {
        mine = store.rankOf(me.playerId, p) ?? null;
        cache.set(rkKey, mine, 15_000);
      }
      const u = getCachedUser(me.playerId);
      ok(ack, { rows, me: { rank: mine?.rank ?? null, score: mine?.score ?? 0, name: u?.name ?? me.name, avatar: u?.avatar ?? me.avatar } });
    }, { bucket: 'lb', limit: 30, windowMs: 60_000 }));

    socket.on('room:quick', guard(({ players: n, stake, variant, color, rules }, ack) =>
      enter(rooms.quickMatch({ ...me, color: safeColor(color) }, players(n) || 2, safeStake(stake), safeVariant(variant), safeRules(rules)), ack), { bucket: 'room', limit: 30, windowMs: 60_000 }));
    socket.on('room:create', guard(({ players: n, rules, stake, variant }, ack) =>
      enter(rooms.createPrivate(me, players(n) || 4, safeRules(rules), safeStake(stake), safeVariant(variant)), ack), { bucket: 'room', limit: 25, windowMs: 60_000 }));
    socket.on('room:join', guard(({ code }, ack) => enter(rooms.joinPrivate(me, code), ack), { bucket: 'room', limit: 30, windowMs: 60_000 }));
    socket.on('room:bots', guard(({ players: n, rules, variant, color }, ack) =>
      enter(rooms.vsComputer({ ...me, color: safeColor(color) }, players(n) || 4, safeRules(rules), safeVariant(variant)), ack), { bucket: 'room', limit: 30, windowMs: 60_000 }));
    socket.on('room:local', guard(({ names, rules, variant }, ack) => {
      const list = Array.isArray(names) ? names.slice(0, 4).map(cleanName) : [];
      if (list.length < 2) throw new GameError('BAD_PLAYERS', 'Need 2–4 names');
      enter(rooms.passAndPlay(me, list, safeRules(rules), safeVariant(variant)), ack);
    }, { bucket: 'room', limit: 30, windowMs: 60_000 }));
    socket.on('room:start', guard((_d, ack) => {
      const room = rooms.roomOf(me.playerId);
      if (!room) throw new GameError('NO_ROOM', 'Not in a room');
      if (room.hostId !== me.playerId) throw new GameError('NOT_HOST', 'Only the host can start');
      room.start();
      ok(ack);
    }, { bucket: 'room', limit: 20, windowMs: 60_000 }));
    socket.on('room:leave', guard((_d, ack) => {
      rooms.detach(me.playerId);
      ok(ack);
    }, { bucket: 'room', limit: 30, windowMs: 60_000 }));

    socket.on('game:roll', guard(({ seat }, ack) => {
      const room = rooms.roomOf(me.playerId);
      if (!room) throw new GameError('NO_ROOM', 'Not in a room');
      room.act(me.playerId, 'roll', seat);
      ok(ack);
    }, { bucket: 'game', limit: 60, windowMs: 10_000 }));

    socket.on('game:move', guard(({ seat, piece, moveId, kind }, ack) => {
      const room = rooms.roomOf(me.playerId);
      if (!room) throw new GameError('NO_ROOM', 'Not in a room');
      const arg = Number.isInteger(moveId) ? { moveId, piece, kind } : (kind ? { piece, kind } : piece);
      room.act(me.playerId, 'move', seat, arg);
      ok(ack);
    }, { bucket: 'game', limit: 60, windowMs: 10_000 }));

    socket.on('chat:emoji', guard(({ emoji }, ack) => {
      const room = rooms.roomOf(me.playerId);
      const seat = room?.memberByPlayer(me.playerId)?.seat;
      if (!room || seat === undefined) throw new GameError('NO_ROOM', 'Not in a room');
      if (typeof emoji !== 'string' || !emoji || emoji.length > 8) throw new GameError('BAD_EMOJI', 'Invalid emoji');
      io.to(`room:${room.code}`).emit('chat:emoji', { seat, emoji });
      ok(ack);
    }, { bucket: 'chat', limit: 15, windowMs: 10_000 }));

    socket.on('chat:quick', guard(({ message }, ack) => {
      const room = rooms.roomOf(me.playerId);
      const seat = room?.memberByPlayer(me.playerId)?.seat;
      if (!room || seat === undefined) throw new GameError('NO_ROOM', 'Not in a room');
      if (typeof message !== 'string' || !QUICK_CHATS.includes(message)) throw new GameError('BAD_CHAT', 'Unknown quick chat message');
      io.to(`room:${room.code}`).emit('chat:quick', { seat, message });
      ok(ack);
    }, { bucket: 'chat', limit: 15, windowMs: 10_000 }));

    socket.on('disconnect', () => {
      if (!me) return;
      sockets.get(me.playerId)?.delete(socket);
      const room = rooms.roomOf(me.playerId);
      const member = room?.memberByPlayer(me.playerId);
      if (room && member && member.socketId === socket.id) room.disconnected(me.playerId);
    });
  });

  const close = () => {
    backup.stop();
    cache.close();
    io.close();
    server.close();
    store.close();
  };

  return { app, server, io, rooms, store, cache, backup, queue, limiter, jwtSecret, close };
}

const safeColor = (c) => (Number.isInteger(c) && c >= 0 && c < 4 ? c : undefined);
const safeVariant = (v) => (Object.hasOwn(VARIANTS, v) ? v : 'classic');
const safeStake = (v) => (STAKES.includes(Number(v)) ? Number(v) : 0);

function safeRules(r) {
  if (!r || typeof r !== 'object') return {};
  const out = {};
  if (Number.isInteger(r.winPieces) && r.winPieces >= 1 && r.winPieces <= 4) out.winPieces = r.winPieces;
  if (typeof r.killRequiredForInnerRing === 'boolean') out.killRequiredForInnerRing = r.killRequiredForInnerRing;
  if (typeof r.extraTurnOnFinish === 'boolean') out.extraTurnOnFinish = r.extraTurnOnFinish;
  if (typeof r.jailOnFirstWin === 'boolean') out.jailOnFirstWin = r.jailOnFirstWin;
  if (typeof r.pakkaEnabled === 'boolean') out.pakkaEnabled = r.pakkaEnabled;
  if (Number.isInteger(r.maxOutBeforeFirstFinish) && r.maxOutBeforeFirstFinish >= 1 && r.maxOutBeforeFirstFinish <= 4) {
    out.maxOutBeforeFirstFinish = r.maxOutBeforeFirstFinish;
  }
  if (Number.isInteger(r.maxConsecutivePowerRolls)) out.maxConsecutivePowerRolls = [0, 3].includes(r.maxConsecutivePowerRolls) ? r.maxConsecutivePowerRolls : 0;
  if (Number.isInteger(r.timedSeconds)) out.timedSeconds = r.timedSeconds === 0 ? 0 : Math.max(60, Math.min(600, r.timedSeconds));
  if (['smart', 'casual'].includes(r.botDifficulty)) out.botDifficulty = r.botDifficulty;
  if (Number.isInteger(r.turnSeconds)) out.turnSeconds = Math.max(10, Math.min(60, r.turnSeconds));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const { server } = createServer();
  server.listen(port, () => console.log(`Chowkra server listening on :${port}`));
}
