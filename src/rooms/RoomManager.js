import { randomInt } from 'node:crypto';
import { GameError } from '../game/engine.js';
import { Room } from './Room.js';
import { VARIANTS } from '../game/rules.js';

const QUICK_MATCH_WAIT_MS = Number(process.env.QUICK_MATCH_WAIT_MS ?? 30_000);
// Server-wide rule overrides, e.g. RULES_OVERRIDE='{"entryRolls":[1,2,3,4,8]}'
const SERVER_RULES = process.env.RULES_OVERRIDE ? JSON.parse(process.env.RULES_OVERRIDE) : {};

export class RoomManager {
  constructor(emit, { store = null, onProfile = null, onCacheInvalidate = null } = {}) {
    this.emit = emit;
    this.store = store;
    this.onProfile = onProfile;
    this.onCacheInvalidate = onCacheInvalidate;
    this.rooms = new Map(); // code -> Room
    this.playerRoom = new Map(); // playerId -> code
  }

  newCode() {
    let code;
    do code = String(randomInt(100000, 1000000));
    while (this.rooms.has(code));
    return code;
  }

  create(mode, maxPlayers, rules, stake = 0, variant = 'classic', firstColor = null) {
    if (![2, 3, 4].includes(maxPlayers)) throw new GameError('BAD_PLAYERS', 'Players must be 2, 3 or 4');
    const room = new Room({
      code: this.newCode(),
      mode,
      maxPlayers,
      rules: { ...SERVER_RULES, ...(VARIANTS[variant] ?? {}), ...rules, boardSize: 5 },
      stake,
      variant: VARIANTS[variant] ? variant : 'classic',
      firstColor,
      store: this.store,
      onProfile: this.onProfile,
      onCacheInvalidate: this.onCacheInvalidate,
      emit: this.emit,
      onEmpty: (r) => this.remove(r),
    });
    this.rooms.set(room.code, room);
    return room;
  }

  remove(room) {
    this.rooms.delete(room.code);
    for (const [pid, code] of this.playerRoom) if (code === room.code) this.playerRoom.delete(pid);
  }

  roomOf(playerId) {
    const code = this.playerRoom.get(playerId);
    const room = code && this.rooms.get(code);
    if (!room || room.status === 'closed') return null;
    return room;
  }

  /** Leave whatever room this player is in before joining another. */
  detach(playerId) {
    const room = this.roomOf(playerId);
    if (room) room.leave(playerId);
    this.playerRoom.delete(playerId);
  }

  join(room, player) {
    this.detach(player.playerId);
    room.addHuman(player);
    this.playerRoom.set(player.playerId, room.code);
    return room;
  }

  checkCoins(player, stake) {
    if (!stake || !this.store) return;
    const u = this.store.get(player.playerId);
    if (!u || u.coins < stake) throw new GameError('NOT_ENOUGH_COINS', `You need ${stake} coins for this table`);
  }

  quickMatch(player, maxPlayers, stake = 0, variant = 'classic', rules = {}) {
    this.checkCoins(player, stake);
    const v = VARIANTS[variant] ? variant : 'classic';
    let room = [...this.rooms.values()].find(
      (r) =>
        r.mode === 'public' &&
        r.status === 'waiting' &&
        r.maxPlayers === maxPlayers &&
        r.stake === stake &&
        r.variant === v &&
        r.freeSeats().length > 0 &&
        !r.memberByPlayer(player.playerId),
    );
    if (!room) {
      room = this.create('public', maxPlayers, rules, stake, variant, player.color);
      room.fillAt = Date.now() + QUICK_MATCH_WAIT_MS;
      room.fillTimer = setTimeout(() => {
        if (room.status !== 'waiting' || !room.humans.length) return;
        try {
          room.start();
        } catch (err) {
          console.warn('[quick %s] could not start: %s', room.code, err.message);
          room.destroy();
        }
      }, QUICK_MATCH_WAIT_MS);
    }
    this.join(room, player);
    if (room.freeSeats().length === 0) room.start();
    else room.broadcast();
    return room;
  }

  createPrivate(player, maxPlayers, rules, stake = 0, variant = 'classic') {
    this.checkCoins(player, stake);
    const room = this.create('private', maxPlayers, rules, stake, variant, player.color);
    this.join(room, player);
    room.broadcast();
    return room;
  }

  joinPrivate(player, code) {
    const room = this.rooms.get(String(code).trim());
    if (!room || room.mode !== 'private' || room.status === 'closed') throw new GameError('NO_ROOM', 'Room not found');
    if (!room.memberByPlayer(player.playerId)) this.checkCoins(player, room.stake);
    if (room.memberByPlayer(player.playerId)) {
      room.addHuman(player); // reconnect
      this.playerRoom.set(player.playerId, room.code);
    } else {
      this.join(room, player);
    }
    if (room.freeSeats().length === 0 && room.status === 'waiting') room.start();
    else room.broadcast();
    return room;
  }

  vsComputer(player, maxPlayers, rules, variant = 'classic') {
    const room = this.create('bots', maxPlayers, rules, 0, variant, player.color);
    this.join(room, player);
    room.start();
    return room;
  }

  passAndPlay(player, names, rules, variant = 'classic') {
    const room = this.create('local', names.length, rules, 0, variant);
    this.detach(player.playerId);
    names.forEach((name, i) => room.addHuman({ ...player, name: name || `Player ${i + 1}`, avatar: i }));
    this.playerRoom.set(player.playerId, room.code);
    room.start();
    return room;
  }

  stats() {
    const rooms = [...this.rooms.values()];
    return {
      rooms: rooms.length,
      playing: rooms.filter((r) => r.status === 'playing').length,
      waiting: rooms.filter((r) => r.status === 'waiting').length,
    };
  }
}
