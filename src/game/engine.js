// Server-authoritative Chowkra engine. Pure logic, no I/O.
// Implements the 5x5 board, 3-piece cap + 4th unlock, kill-gate outer loop,
// Judwa/Triple Pakka rules & protection, and Winner Ghar trap.
import { randomInt } from 'node:crypto';
import { FINISH, OFF_BOARD, OUTER_LAST, boardSpec, cellFor, isSafe, sameCell } from './board.js';
import { makeRules } from './rules.js';

export const COLORS = ['red', 'green', 'yellow', 'blue'];

export function seatsFor(count) {
  if (count === 2) return [0, 2];
  if (count === 3) return [0, 1, 2];
  return [0, 1, 2, 3];
}

/** Throw 4 cowries. true = mouth-up. 0 up = 8 (Ashta), 4 up = 4 (Chamma). */
export function throwCowries(rng = () => randomInt(2) === 1) {
  const shells = [rng(), rng(), rng(), rng()];
  const up = shells.filter(Boolean).length;
  return { shells, value: up === 0 ? 8 : up };
}

function winTarget(state, seat) {
  const count = state.players[seat].pieces.length;
  const wp = state.rules.winPieces;
  return Number.isInteger(wp) && wp >= 1 ? Math.min(wp, count) : count;
}

export function computeScore(player, finish = FINISH) {
  let score = (player.kills ?? 0) * 15;
  for (const pos of player.pieces) {
    if (pos > 0) score += pos;
    if (pos === finish) score += 20;
  }
  return score;
}

export function createGame(seats, ruleOverrides = {}) {
  const rules = makeRules(ruleOverrides);
  const spec = boardSpec();
  const players = {};
  for (const seat of seats) {
    const startPos = rules.startOnBoard ? 0 : OFF_BOARD;
    players[seat] = {
      seat,
      color: COLORS[seat],
      pieces: Array(rules.piecesPerPlayer).fill(startPos),
      pakka: Array(rules.piecesPerPlayer).fill(0),
      innerMode: Array(rules.piecesPerPlayer).fill(null), // null | 'rotate' | 'stay'
      nextPakkaId: 1,
      hasKilled: false,
      kills: 0,
      powerStreak: 0,
      score: 0,
      rank: null,
    };
    players[seat].score = computeScore(players[seat], spec.finish);
  }
  return {
    rules,
    seats: [...seats],
    players,
    turn: seats[0],
    phase: 'roll', // roll | move | jail | ended
    roll: null,
    moves: [],
    jail: null, // { creator, key, index } Winner Ghar trap
    ranks: [],
    turnNo: 1,
  };
}

function gateIndexFor(rules, spec) {
  const idx = Number.isInteger(rules.gharGateIndex) ? rules.gharGateIndex : spec.finish - 1;
  return Math.max(spec.outerLast + 1, Math.min(spec.finish - 1, idx));
}

function pakkaMembers(player, gid) {
  if (!gid) return [];
  const out = [];
  player.pakka.forEach((v, i) => {
    if (v === gid) out.push(i);
  });
  return out;
}

function canLeaveHome(player, rules, finish) {
  if (!rules.maxOutBeforeFirstFinish || rules.maxOutBeforeFirstFinish >= player.pieces.length) return true;
  const finishedCount = player.pieces.filter((p) => p === finish).length;
  if (finishedCount >= 1) return true; // 4th unlocks after at least 1 reaches centre
  const outCount = player.pieces.filter((p) => p > 0).length;
  return outCount < rules.maxOutBeforeFirstFinish;
}

function trapIndexFor(seat, ghar, spec) {
  if (!ghar || ghar.creator === seat) return -1;
  const gharCell = cellFor(ghar.creator, ghar.index);
  if (!gharCell) return -1;
  const path = spec.paths[seat];
  for (let i = 0; i < path.length - 1; i++) {
    if (sameCell(path[i], gharCell)) return i;
  }
  return -1;
}

function resolveStep(from, steps, player, rules, spec, ghar, trapIdx, unitSize = 1) {
  if (from === spec.finish) return null;
  if (from === OFF_BOARD) {
    if (unitSize !== 1 || !rules.entryRolls.includes(steps)) return null;
    return { to: 0, breaksJail: false };
  }
  if (from === 0 && !canLeaveHome(player, rules, spec.finish)) return null;

  // Stuck in Winner Ghar trap at winner's gate cell: exact key roll enters centre finish directly
  if (trapIdx >= 0 && from === trapIdx) {
    return null; // handled explicitly before resolveStep
  }

  const lockedGate = rules.killRequiredForInnerRing && !player.hasKilled;
  if (lockedGate && from <= spec.outerLast) {
    if (from + steps <= spec.outerLast) return { to: from + steps, breaksJail: false };
    if (rules.wrapOuterOnLockedGate) {
      return { to: (from + steps) % spec.outerLength, breaksJail: false };
    }
    return null;
  }

  const to = from + steps;
  if (to > spec.finish) {
    // Inner-ring overshoot: allow rotate/stay depending on piece's innerMode
    if (from > spec.outerLast && from < spec.finish) {
      const innerStart = spec.outerLast + 1;
      const innerLen = spec.finish - innerStart;
      const wrappedTo = innerStart + ((from - innerStart + steps) % innerLen);
      if (trapIdx >= 0) {
        for (let k = 1; k < steps; k++) {
          if (innerStart + ((from - innerStart + k) % innerLen) === trapIdx) return null;
        }
      }
      return { to: wrappedTo, breaksJail: false, overshoot: true };
    }
    return null;
  }
  if (trapIdx >= 0 && from < trapIdx && to > trapIdx) {
    // Cannot jump over the active Winner Ghar trap; must land at the trap cell first
    return null;
  }
  return { to, breaksJail: false };
}

function isProtectedCell(cell, ghar) {
  if (isSafe(cell)) return true;
  if (ghar && sameCell(cell, cellFor(ghar.creator, ghar.index))) {
    // Winner Ghar is only at the winner's own gate cell and shields pieces trapped there
    return true;
  }
  return false;
}

/** Compute enemy captures on `cell` given moving unit size (`1` single, `2` Pakka Double, `3` Pakka Triple). */
function victimsAt(state, seat, cell, moverSize = 1) {
  const spec = boardSpec();
  if (isProtectedCell(cell, state.jail)) return [];
  const out = [];

  for (const s of state.seats) {
    if (s === seat || state.players[s].rank !== null) continue;
    const ep = state.players[s];
    const singles = [];
    const pakkaGroups = new Map(); // gid -> piece[]

    ep.pieces.forEach((pos, piece) => {
      if (pos < 0 || pos === spec.finish) return;
      if (!sameCell(cellFor(s, pos), cell)) return;
      const gid = ep.pakka?.[piece] ?? 0;
      if (gid > 0) {
        if (!pakkaGroups.has(gid)) pakkaGroups.set(gid, []);
        pakkaGroups.get(gid).push(piece);
      } else {
        singles.push(piece);
      }
    });

    const hasEnemyPakka = pakkaGroups.size > 0;
    if (moverSize === 1) {
      // Single / un-fused only kills enemy singles, and only if NO friendly Pakka shields them
      if (!hasEnemyPakka) {
        for (const piece of singles) out.push({ seat: s, piece, from: ep.pieces[piece] });
      }
    } else {
      // Pakka Double kills enemy Pakka Double; Pakka Triple kills enemy Pakka Triple
      for (const members of pakkaGroups.values()) {
        if (members.length === moverSize) {
          for (const piece of members) out.push({ seat: s, piece, from: ep.pieces[piece] });
        }
      }
    }
  }
  return out;
}

/**
 * Compute all legal moves for `seat` given throw `value`.
 * Includes Single moves, Soft Pair (`2` together un-fused), Make Pakka (`2`->`2/4/8`, `3`->`3`),
 * Pakka moves, and Ghar unlock rolls.
 */
export function legalMoves(state, seat, value) {
  const { rules } = state;
  const spec = boardSpec();
  const player = state.players[seat];
  const ghar = state.jail;
  const trapIdx = trapIndexFor(seat, ghar, spec);
  const moves = [];
  let nextId = 0;

  const pushMove = (mv) => {
    const cell = cellFor(seat, mv.to);
    const unitSize = mv.kind === 'pair_pakka' || mv.kind === 'triple_pakka' || mv.kind === 'pakka_move'
      ? mv.groupPieces.length
      : 1;
    const kills = mv.innerAction === 'stay' ? 0 : victimsAt(state, seat, cell, unitSize).length;
    moves.push({ id: nextId++, ...mv, kills, cell });
  };

  const pushResolved = (baseMv, res) => {
    if (!res) return;
    if (!res.overshoot) {
      pushMove({ ...baseMv, to: res.to, breaksJail: res.breaksJail });
      return;
    }
    const mode = player.innerMode?.[baseMv.piece] ?? null;
    if (mode === 'stay') return;
    const isPakka = baseMv.kind === 'pakka_move';
    pushMove({
      ...baseMv,
      kind: isPakka ? 'pakka_move' : 'inner_rotate',
      to: res.to,
      breaksJail: res.breaksJail,
      innerAction: 'rotate',
    });
    if (mode === null) {
      pushMove({
        ...baseMv,
        kind: isPakka ? 'pakka_move' : 'inner_stay',
        to: baseMv.from,
        breaksJail: false,
        innerAction: 'stay',
      });
    }
  };

  // 1. Move already-fused Pakka groups (deduped once per group)
  const seenGroups = new Set();
  const singleByPos = new Map(); // pos -> piece[] for un-fused pieces

  player.pieces.forEach((from, piece) => {
    const gid = player.pakka?.[piece] ?? 0;
    if (gid > 0) {
      if (seenGroups.has(gid)) return;
      seenGroups.add(gid);
      const grp = pakkaMembers(player, gid);
      if (from === spec.finish || grp.length < 2) return;

      if (trapIdx >= 0 && from === trapIdx) {
        if (value === ghar.key) {
          pushMove({
            piece: grp[0],
            groupPieces: grp,
            kind: 'pakka_move',
            from,
            to: spec.finish,
            breaksJail: true,
            createsPakka: false,
          });
        }
        return;
      }

      if (value % grp.length !== 0) return;
      const steps = value / grp.length;
      const res = resolveStep(from, steps, player, rules, spec, ghar, trapIdx, grp.length);
      pushResolved({
        piece: grp[0],
        groupPieces: grp,
        kind: 'pakka_move',
        from,
        createsPakka: false,
      }, res);
      return;
    }

    if (from === spec.finish) return;
    if (!singleByPos.has(from)) singleByPos.set(from, []);
    singleByPos.get(from).push(piece);

    // Ghar unlock for trapped single piece
    if (trapIdx >= 0 && from === trapIdx) {
      if (value === ghar.key) {
        pushMove({
          piece,
          groupPieces: [piece],
          kind: 'single',
          from,
          to: spec.finish,
          breaksJail: true,
          createsPakka: false,
        });
      }
      return;
    }

    const res = resolveStep(from, value, player, rules, spec, ghar, trapIdx, 1);
    pushResolved({
      piece,
      groupPieces: [piece],
      kind: 'single',
      from,
      createsPakka: false,
    }, res);
  });

  // 2. Pair / Triple options when multiple un-fused pieces share a board square (0 < from < finish)
  if (rules.pakkaEnabled) {
    for (const [from, pcs] of singleByPos) {
      if (from <= 0 || from >= spec.finish) continue;
      if (trapIdx >= 0 && from === trapIdx) continue;

      if (pcs.length >= 2 && value % 2 === 0) {
        const pair = [pcs[0], pcs[1]];
        const res = resolveStep(from, value / 2, player, rules, spec, ghar, trapIdx, 2);
        if (res && res.to < spec.finish) {
          pushMove({
            piece: pair[0],
            groupPieces: pair,
            kind: 'pair_soft',
            from,
            to: res.to,
            breaksJail: res.breaksJail,
            createsPakka: false,
          });
          // Pakka binding is only allowed inside the inner ring (never on the outer ring)
          if (res.to > spec.outerLast) {
            pushMove({
              piece: pair[0],
              groupPieces: pair,
              kind: 'pair_pakka',
              from,
              to: res.to,
              breaksJail: res.breaksJail,
              createsPakka: true,
            });
          }
        }
      }

      // Fuse 3 pieces into Pakka Triple on exact roll 3 (only inside the inner ring)
      if (pcs.length >= 3 && value === 3 && (!rules.killRequiredForInnerRing || player.hasKilled)) {
        const tri = [pcs[0], pcs[1], pcs[2]];
        const res = resolveStep(from, 1, player, rules, spec, ghar, trapIdx, 3);
        if (res && res.to > spec.outerLast && res.to < spec.finish) {
          pushMove({
            piece: tri[0],
            groupPieces: tri,
            kind: 'triple_pakka',
            from,
            to: res.to,
            breaksJail: res.breaksJail,
            createsPakka: true,
          });
        }
      }
    }

    // Also allow fusing existing Pakka Double + 1 single on the same inner-ring square into Pakka Triple on roll 3
    if (value === 3 && (!rules.killRequiredForInnerRing || player.hasKilled)) {
      const seenPakkaPos = new Set();
      player.pieces.forEach((pos, p) => {
        const gid = player.pakka?.[p] ?? 0;
        if (!gid || pos <= 0 || pos >= spec.finish || seenPakkaPos.has(gid)) return;
        const grp = pakkaMembers(player, gid);
        if (grp.length !== 2) return;
        seenPakkaPos.add(gid);
        const singlesHere = singleByPos.get(pos) ?? [];
        if (!singlesHere.length) return;
        const tri = [...grp, singlesHere[0]];
        const res = resolveStep(pos, 1, player, rules, spec, ghar, trapIdx, 3);
        if (res && res.to > spec.outerLast && res.to < spec.finish) {
          pushMove({
            piece: tri[0],
            groupPieces: tri,
            kind: 'triple_pakka',
            from: pos,
            to: res.to,
            breaksJail: res.breaksJail,
            createsPakka: true,
          });
        }
      });
    }
  }

  return moves;
}

function activeSeats(state) {
  return state.seats.filter((s) => state.players[s].rank === null);
}

function nextSeat(state, from) {
  const order = state.seats;
  let i = order.indexOf(from);
  for (let step = 0; step < order.length; step++) {
    i = (i + 1) % order.length;
    if (state.players[order[i]].rank === null) return order[i];
  }
  return from;
}

function endTurn(state, events, extra) {
  state.roll = null;
  state.moves = [];
  if (state.phase === 'ended' || state.phase === 'jail') return;
  const current = state.turn;
  const stillPlaying = state.players[current].rank === null;
  if (extra && stillPlaying) {
    events.push({ type: 'extraTurn', seat: current });
  } else {
    state.players[current].powerStreak = 0;
    state.turn = nextSeat(state, current);
    state.turnNo += 1;
    events.push({ type: 'turn', seat: state.turn });
  }
  state.phase = 'roll';
}

export function roll(state, seat, forced = null) {
  if (state.phase === 'ended') throw new GameError('GAME_OVER', 'Game is over');
  if (state.turn !== seat) throw new GameError('NOT_YOUR_TURN', 'Not your turn');
  if (state.phase !== 'roll' && state.phase !== 'jail') {
    throw new GameError('WRONG_PHASE', 'Move a piece first');
  }

  const result = forced ?? throwCowries();
  state.roll = result;
  const events = [{ type: 'roll', seat, shells: result.shells, value: result.value }];

  if (state.phase === 'jail') {
    const spec = boardSpec();
    const idx = gateIndexFor(state.rules, spec);
    state.jail = { creator: seat, key: result.value, index: idx };
    events.push({ type: 'jailCreated', seat, key: result.value, index: idx });
    state.phase = 'roll';
    endTurn(state, events, false);
    return events;
  }

  const player = state.players[seat];
  const isPower = state.rules.extraTurnRolls.includes(result.value);
  player.powerStreak = isPower ? (player.powerStreak ?? 0) + 1 : 0;

  if (state.rules.maxConsecutivePowerRolls > 0 && player.powerStreak >= state.rules.maxConsecutivePowerRolls) {
    player.powerStreak = 0;
    events.push({ type: 'streakForfeit', seat, count: state.rules.maxConsecutivePowerRolls });
    endTurn(state, events, false);
    return events;
  }

  const moves = legalMoves(state, seat, result.value);
  if (moves.length === 0) {
    events.push({ type: 'noMove', seat });
    endTurn(state, events, isPower);
    return events;
  }
  state.moves = moves;
  state.phase = 'move';
  return events;
}

/** Current player executes a move (`moveArg` can be `moveId`, `piece`, or `{ moveId, piece, kind }`). */
export function move(state, seat, moveArg) {
  assertTurn(state, seat, 'move');
  const spec = boardSpec();

  let mv;
  if (typeof moveArg === 'object' && moveArg !== null) {
    if (Number.isInteger(moveArg.moveId)) mv = state.moves.find((m) => m.id === moveArg.moveId);
    else if (moveArg.kind) mv = state.moves.find((m) => m.piece === moveArg.piece && m.kind === moveArg.kind);
    else mv = state.moves.find((m) => m.piece === moveArg.piece);
  } else {
    // Support passing piece index (backward-compatible) or exact id when matched via Room
    mv = state.moves.find((m) => m.piece === moveArg) ?? state.moves.find((m) => m.id === moveArg);
  }
  if (!mv) throw new GameError('ILLEGAL_MOVE', 'That move is not allowed');

  const player = state.players[seat];
  if (!player.pakka) player.pakka = Array(player.pieces.length).fill(0);
  if (!player.innerMode) player.innerMode = Array(player.pieces.length).fill(null);
  const events = [];

  let extra = state.rules.extraTurnRolls.includes(state.roll.value);

  if (mv.innerAction === 'stay') {
    for (const p of mv.groupPieces) {
      player.innerMode[p] = 'stay';
      events.push({ type: 'move', seat, piece: p, from: mv.from, to: mv.from, kind: 'inner_stay' });
    }
    endTurn(state, events, extra);
    return events;
  }

  if (mv.innerAction === 'rotate') {
    for (const p of mv.groupPieces) player.innerMode[p] = 'rotate';
  }

  if (mv.createsPakka) {
    const newId = player.nextPakkaId ?? 1;
    player.nextPakkaId = newId + 1;
    for (const p of mv.groupPieces) player.pakka[p] = newId;
    events.push({ type: 'pakkaFormed', seat, pieces: [...mv.groupPieces], size: mv.groupPieces.length, at: mv.to });
  }

  for (const p of mv.groupPieces) {
    player.pieces[p] = mv.to;
    events.push({ type: 'move', seat, piece: p, from: mv.from, to: mv.to, kind: mv.kind });
  }

  if (mv.breaksJail && state.jail) {
    events.push({ type: 'jailBroken', seat, piece: mv.piece, key: state.jail.key });
  }

  const unitSize = mv.kind === 'pair_pakka' || mv.kind === 'triple_pakka' || mv.kind === 'pakka_move'
    ? mv.groupPieces.length
    : 1;
  const cell = cellFor(seat, mv.to);

  if (!isProtectedCell(cell, state.jail)) {
    const victims = victimsAt(state, seat, cell, unitSize);
    const back = state.rules.startOnBoard ? 0 : OFF_BOARD;
    const victimSeats = new Set();
    for (const v of victims) {
      const vp = state.players[v.seat];
      vp.pieces[v.piece] = back;
      if (vp.pakka) vp.pakka[v.piece] = 0;
      if (vp.innerMode) vp.innerMode[v.piece] = null;
      vp.score = computeScore(vp, spec.finish);
      victimSeats.add(v.seat);
      events.push({ type: 'kill', seat, victimSeat: v.seat, victimPiece: v.piece, from: v.from, to: back });
    }
    for (const vs of victimSeats) {
      const vp = state.players[vs];
      const hasActiveOnBoard = vp.pieces.some((pos) => pos > 0 && pos < spec.finish);
      if (vp.hasKilled && !hasActiveOnBoard) {
        vp.hasKilled = false;
        events.push({ type: 'killReset', seat: vs });
      }
    }
    if (victims.length) {
      player.hasKilled = true;
      player.kills = (player.kills ?? 0) + victims.length;
      if (state.rules.extraTurnOnKill) extra = true;
    }
  } else if (mv.to > 0 && mv.to < spec.finish) {
    events.push({ type: 'safe', seat, piece: mv.piece, index: mv.to });
  }

  player.score = computeScore(player, spec.finish);

  if (mv.to === spec.finish) {
    for (const p of mv.groupPieces) {
      if (player.pakka) player.pakka[p] = 0;
      events.push({ type: 'home', seat, piece: p });
    }
    if (state.rules.extraTurnOnFinish) extra = true;
    const finishedCount = player.pieces.filter((p) => p === spec.finish).length;
    if (finishedCount >= winTarget(state, seat)) {
      player.rank = state.ranks.length + 1;
      state.ranks.push(seat);
      events.push({ type: 'finished', seat, rank: player.rank });
      checkGameOver(state, events);
      if (
        state.phase !== 'ended' &&
        player.rank === 1 &&
        state.rules.jailOnFirstWin &&
        !state.jail &&
        activeSeats(state).length >= 2
      ) {
        state.phase = 'jail';
        state.roll = null;
        state.moves = [];
        events.push({ type: 'jailPrompt', seat });
        return events;
      }
    }
  }
  endTurn(state, events, extra);
  return events;
}

export function endTimedGame(state) {
  if (state.phase === 'ended') return [];
  const spec = boardSpec();
  const left = activeSeats(state);
  left.sort((a, b) => {
    const pa = state.players[a];
    const pb = state.players[b];
    if (pb.score !== pa.score) return pb.score - pa.score;
    const fa = pa.pieces.filter((p) => p === spec.finish).length;
    const fb = pb.pieces.filter((p) => p === spec.finish).length;
    if (fb !== fa) return fb - fa;
    if ((pb.kills ?? 0) !== (pa.kills ?? 0)) return (pb.kills ?? 0) - (pa.kills ?? 0);
    return state.seats.indexOf(a) - state.seats.indexOf(b);
  });
  for (const s of left) {
    state.players[s].rank = state.ranks.length + 1;
    state.ranks.push(s);
  }
  state.phase = 'ended';
  state.roll = null;
  state.moves = [];
  state.jail = null;
  return [{ type: 'gameOver', ranks: [...state.ranks], timed: true }];
}

function checkGameOver(state, events) {
  const left = activeSeats(state);
  if (!state.rules.playForAllRanks || left.length <= 1) {
    for (const s of left) {
      state.players[s].rank = state.ranks.length + 1;
      state.ranks.push(s);
    }
    state.phase = 'ended';
    state.jail = null;
    events.push({ type: 'gameOver', ranks: [...state.ranks] });
  }
}

export function forfeit(state, seat) {
  const events = [];
  const player = state.players[seat];
  if (!player || player.rank !== null || state.phase === 'ended') return events;
  const spec = boardSpec();
  player.pieces = player.pieces.map(() => OFF_BOARD);
  if (player.pakka) player.pakka = player.pakka.map(() => 0);
  player.score = computeScore(player, spec.finish);
  player.rank = 0;
  events.push({ type: 'forfeit', seat });
  const left = activeSeats(state);
  if (left.length <= 1) {
    for (const s of left) {
      state.players[s].rank = state.ranks.length + 1;
      state.ranks.push(s);
    }
    state.phase = 'ended';
    state.jail = null;
    events.push({ type: 'gameOver', ranks: [...state.ranks] });
  } else if (state.turn === seat) {
    state.phase = 'roll';
    endTurn(state, events, false);
  }
  return events;
}

function assertTurn(state, seat, phase) {
  if (state.phase === 'ended') throw new GameError('GAME_OVER', 'Game is over');
  if (state.turn !== seat) throw new GameError('NOT_YOUR_TURN', 'Not your turn');
  if (state.phase !== phase) throw new GameError('WRONG_PHASE', phase === 'roll' ? 'Move a piece first' : 'Throw first');
}

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
