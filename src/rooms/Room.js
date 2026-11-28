import { createHash, randomInt } from 'node:crypto';

/** Public id derived from the secret playerId token — safe to show other players. */
export const publicId = (playerId) => createHash('sha256').update(String(playerId)).digest('hex').slice(0, 12);
import { GameError, createGame, endTimedGame, forfeit, move, roll, seatsFor } from '../game/engine.js';
import { chooseMove } from '../game/bot.js';
import { BOT_WIN_COINS, XP_LOSS, XP_WIN, potFor } from '../economy.js';

const BOT_NAMES = ['Raju', 'Meena', 'Shyam', 'Gauri', 'Bholu', 'Chintu', 'Pinky', 'Munna'];
const AVATARS = 8;

/**
 * One table. Modes:
 *  - public : quick match, fills with bots after a short wait
 *  - private: friends join with a 6-digit code, host starts
 *  - bots   : 1 human vs computer, starts immediately
 *  - local  : pass & play, one device controls every seat
 */
export class Room {
  constructor({ code, mode, maxPlayers, rules, emit, onEmpty, stake = 0, store = null, onProfile = null, onCacheInvalidate = null, variant = 'classic', firstColor = null, seats = null }) {
    this.variant = variant;
    this.fillAt = null;
    this.stake = stake;
    this.store = store;
    this.onProfile = onProfile;
    this.onCacheInvalidate = onCacheInvalidate;
    this.settled = false;
    this.code = code;
    this.mode = mode;
    this.maxPlayers = maxPlayers;
    this.ruleOverrides = rules ?? {};
    this.emit = emit; // (room, eventName, payload, toSocketId?) => void
    this.onEmpty = onEmpty;
    this.seats = Array.isArray(seats) && seats.length === maxPlayers ? [...seats] : seatsFor(maxPlayers);
    // 1-on-1: sit opposite each other, starting from the first player's colour.
    if (!Array.isArray(seats) && maxPlayers === 2 && Number.isInteger(firstColor) && firstColor >= 0 && firstColor < 4) {
      this.seats = [firstColor, (firstColor + 2) % 4];
    }
    this.members = {}; // seat -> member
    this.hostId = null;
    this.game = null;
    this.status = 'waiting'; // waiting | playing | ended
    this.timer = null;
    this.deadline = null;
    this.matchTimer = null;
    this.matchEndsAt = null;
    this.fillTimer = null;
    this.createdAt = Date.now();
  }

  get humans() {
    return Object.values(this.members).filter((m) => !m.isBot);
  }

  freeSeats() {
    return this.seats.filter((s) => !this.members[s]);
  }

  memberByPlayer(playerId) {
    return Object.values(this.members).find((m) => m.playerId === playerId);
  }

  addHuman({ playerId, name, avatar, socketId, color }) {
    const existing = this.memberByPlayer(playerId);
    if (existing && this.mode !== 'local') {
      existing.socketId = socketId;
      existing.connected = true;
      return existing;
    }
    const free = this.freeSeats();
    const seat = free.includes(color) ? color : free[0];
    if (seat === undefined) throw new GameError('ROOM_FULL', 'Room is full');
    if (this.status !== 'waiting') throw new GameError('ALREADY_STARTED', 'Game already started');
    const member = { seat, playerId, name, avatar: avatar ?? seat, socketId, isBot: false, connected: true, timeouts: 0, autoPlay: false };
    this.members[seat] = member;
    if (!this.hostId) this.hostId = playerId;
    return member;
  }

  addBot() {
    const seat = this.freeSeats()[0];
    if (seat === undefined) return null;
    const used = new Set(Object.values(this.members).map((m) => m.name));
    const name = BOT_NAMES.filter((n) => !used.has(n))[randomInt(4)] ?? 'Bot';
    this.members[seat] = { seat, playerId: `bot-${seat}-${Date.now()}`, name, avatar: randomInt(AVATARS), isBot: true, connected: true, timeouts: 0, autoPlay: true };
    return this.members[seat];
  }

  fillWithBots() {
    while (this.freeSeats().length) this.addBot();
  }

  /** Seats a socket is allowed to act for. */
  seatsControlledBy(playerId) {
    if (this.mode === 'local') return this.humans.filter((m) => m.playerId === playerId).map((m) => m.seat);
    const m = this.memberByPlayer(playerId);
    return m ? [m.seat] : [];
  }

  leave(playerId) {
    const mine = Object.values(this.members).filter((m) => m.playerId === playerId);
    if (!mine.length) return;
    if (this.status === 'waiting') {
      for (const m of mine) delete this.members[m.seat];
      if (this.hostId === playerId) this.hostId = this.humans[0]?.playerId ?? null;
      this.broadcast();
    } else if (this.status === 'playing') {
      const events = [];
      for (const m of mine) {
        m.connected = false;
        m.left = true;
        if (this.store && this.mode !== 'local' && !m.recorded) {
          m.recorded = true;
          this.store.addResult(m.playerId, false, 0);
          this.onProfile?.(m.playerId);
        }
        events.push(...forfeit(this.game, m.seat));
      }
      this.afterEvents(events);
    }
    if (!this.humans.some((m) => !m.left) || this.humans.length === 0) this.destroy();
  }

  disconnected(playerId) {
    for (const m of Object.values(this.members)) {
      if (m.playerId === playerId) m.connected = false;
    }
    if (this.status === 'waiting') {
      this.leave(playerId);
      return;
    }
    this.broadcast();
    if (this.status === 'playing' && !this.humans.some((m) => m.connected)) {
      // Everyone is gone: keep the room a little for reconnects, then drop it.
      clearTimeout(this.emptyTimer);
      this.emptyTimer = setTimeout(() => {
        if (!this.humans.some((m) => m.connected)) this.destroy();
      }, 120_000);
    }
  }

  start() {
    if (this.status !== 'waiting') return;
    if (this.mode !== 'private') this.fillWithBots();
    const occupied = this.seats.filter((s) => this.members[s]);
    if (occupied.length < 2) throw new GameError('NOT_ENOUGH_PLAYERS', 'Need at least 2 players');
    this.seats = occupied;
    clearTimeout(this.fillTimer);
    if (this.stake > 0 && this.store) {
      try {
        this.store.deductStakes(
          this.humans.map((m) => m.playerId),
          this.stake,
          this.code,
        );
      } catch (err) {
        const who = String(err.message).replace('NOT_ENOUGH_COINS:', '') || 'Player';
        throw new GameError('NOT_ENOUGH_COINS', `${who} does not have ${this.stake} coins`);
      }
      for (const m of this.humans) this.onProfile?.(m.playerId);
      this.onCacheInvalidate?.();
    }
    this.game = createGame(this.seats, this.ruleOverrides);
    this.status = 'playing';
    if (this.game.rules.timedSeconds > 0) {
      const ms = this.game.rules.timedSeconds * 1000;
      this.matchEndsAt = Date.now() + ms;
      this.matchTimer = setTimeout(() => this.endByTimer(), ms);
    }
    this.afterEvents([{ type: 'start', seats: this.seats }, { type: 'turn', seat: this.game.turn }]);
  }

  endByTimer() {
    if (this.status !== 'playing' || !this.game) return;
    const events = endTimedGame(this.game);
    this.afterEvents(events);
  }

  act(playerId, action, seatHint, moveArg) {
    if (this.status !== 'playing') throw new GameError('NOT_PLAYING', 'Game not running');
    const allowed = this.seatsControlledBy(playerId);
    const seat = this.game.turn;
    if (!allowed.includes(seat)) throw new GameError('NOT_YOUR_TURN', 'Not your turn');
    if (seatHint !== undefined && seatHint !== null && seatHint !== seat) throw new GameError('NOT_YOUR_TURN', 'Not your turn');
    const member = this.members[seat];
    member.timeouts = 0;
    if (member.autoPlay && !member.isBot) member.autoPlay = false; // back in control
    const events = action === 'roll' ? roll(this.game, seat) : move(this.game, seat, moveArg);
    this.afterEvents(events);
  }

  afterEvents(events) {
    this.clearTurnTimer();
    if (this.game) {
      // Auto-move only when there is a single unambiguous destination and no Pakka / inner choice.
      if (this.game.phase === 'move') {
        const hasChoice = this.game.moves.some(
          (m) => m.createsPakka || m.kind === 'pair_soft' || m.kind === 'triple_soft' || m.innerAction,
        );
        const dests = new Set(this.game.moves.map((m) => `${m.from}>${m.to}`));
        if (!hasChoice && dests.size === 1) {
          const auto = move(this.game, this.game.turn, { moveId: this.game.moves[0].id });
          events = events.concat(auto.map((e) => ({ ...e, auto: true })));
        }
      }
      if (this.game.phase === 'ended') {
        this.status = 'ended';
        this.settle();
      }
    }
    // Schedule first so the snapshot carries the new turn's deadline.
    if (this.status === 'playing') this.scheduleTurn(events);
    else this.deadline = null;
    this.broadcast(events);
    if (this.status === 'ended') {
      clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => this.destroy(), 10 * 60_000);
    }
  }

  /** Pay the winner and record wins/losses + XP atomically inside one SQLite tx. Runs once per game. */
  settle() {
    if (this.settled || !this.store || this.mode === 'local' || !this.game) return;
    this.settled = true;
    const winner = this.game.ranks[0];
    this.store.withTx(() => {
      for (const m of this.humans) {
        if (m.recorded) continue;
        m.recorded = true;
        const won = m.seat === winner && !m.left;
        if (won) {
          const prize = this.stake > 0 ? potFor(this.stake, this.seats.length) : this.mode === 'bots' ? BOT_WIN_COINS : 0;
          if (prize > 0) this.store.addCoins(m.playerId, prize, 'win', this.code);
          this.prize = prize;
        }
        this.store.addResult(m.playerId, won, won ? XP_WIN : XP_LOSS);
      }
    });
    for (const m of this.humans) this.onProfile?.(m.playerId);
    this.onCacheInvalidate?.();
  }

  scheduleTurn(events) {
    const seat = this.game.turn;
    const member = this.members[seat];
    // Match client animation durations (~420ms toss + 140ms read pause, ~75ms/step flight, ~260ms kill).
    const hasRoll = events.some((e) => e.type === 'roll');
    const moveSteps = events
      .filter((e) => e.type === 'move')
      .reduce((sum, e) => sum + Math.max(1, Math.min(12, Math.abs((e.to ?? 0) - (e.from ?? 0)))), 0);
    const kills = events.filter((e) => e.type === 'kill').length;
    const animMs = Math.min(1800, (hasRoll ? 560 : 90) + moveSteps * 75 + kills * 260);
    if (member.isBot || member.autoPlay || member.left) {
      this.deadline = null;
      // Natural human-like pause so opponent rolls and piece choices are easy to follow.
      const thinkMs = 520 + randomInt(360);
      this.timer = setTimeout(() => this.autoAct(false), animMs + thinkMs);
    } else {
      const ms = this.game.rules.turnSeconds * 1000 + animMs;
      this.deadline = Date.now() + ms;
      this.timer = setTimeout(() => this.autoAct(true), ms);
    }
  }

  autoAct(isTimeout) {
    if (this.status !== 'playing') return;
    const seat = this.game.turn;
    const member = this.members[seat];
    if (isTimeout && !member.isBot && this.mode !== 'bots' && this.mode !== 'local') {
      member.timeouts += 1;
      if (member.timeouts >= this.game.rules.maxTimeoutsBeforeBot) member.autoPlay = true;
    }
    try {
      const events = this.game.phase === 'roll' || this.game.phase === 'jail'
        ? roll(this.game, seat)
        : move(this.game, seat, chooseMove(this.game, seat));
      this.afterEvents(events.map((e) => ({ ...e, auto: true })));
    } catch (err) {
      console.error('[room %s] auto-act failed', this.code, err);
    }
  }

  clearTurnTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  destroy() {
    this.clearTurnTimer();
    clearTimeout(this.matchTimer);
    clearTimeout(this.fillTimer);
    clearTimeout(this.emptyTimer);
    clearTimeout(this.endTimer);
    this.status = 'closed';
    this.onEmpty?.(this);
  }

  snapshot() {
    const maxLives = this.game?.rules.maxTimeoutsBeforeBot ?? 3;
    return {
      code: this.code,
      mode: this.mode,
      status: this.status,
      maxPlayers: this.maxPlayers,
      stake: this.stake,
      variant: this.variant,
      fillAt: this.status === 'waiting' ? this.fillAt : null,
      pot: this.stake > 0 ? potFor(this.stake, this.status === 'waiting' ? this.maxPlayers : this.seats.length) : 0,
      prize: this.prize ?? 0,
      hostId: this.hostId && publicId(this.hostId),
      seats: this.seats,
      deadline: this.deadline,
      matchEndsAt: this.status === 'playing' ? this.matchEndsAt : null,
      serverTime: Date.now(),
      members: Object.values(this.members).map(({ seat, playerId, name, avatar, isBot, connected, autoPlay, left, timeouts }) => ({
        seat,
        id: isBot ? null : publicId(playerId),
        name,
        avatar,
        isBot,
        connected,
        autoPlay,
        left: !!left,
        livesLeft: isBot ? null : Math.max(0, maxLives - (timeouts ?? 0)),
        maxLives,
      })),
      game: this.game && {
        turn: this.game.turn,
        phase: this.game.phase,
        roll: this.game.roll,
        jail: this.game.jail,
        moves: this.game.moves.map(({ id, piece, groupPieces, kind, innerAction, from, to, kills, breaksJail, createsPakka }) => ({
          id,
          piece,
          groupPieces,
          kind,
          innerAction: innerAction ?? null,
          from,
          to,
          kills,
          breaksJail: !!breaksJail,
          createsPakka: !!createsPakka,
        })),
        ranks: this.game.ranks,
        turnNo: this.game.turnNo,
        players: this.game.players,
        rules: this.game.rules,
      },
    };
  }

  broadcast(events = []) {
    this.emit(this, 'room:state', { room: this.snapshot(), events });
  }
}
