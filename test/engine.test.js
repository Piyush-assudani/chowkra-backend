import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINISH, PATHS, SAFE_CELLS, cellFor, isSafe } from '../src/game/board.js';
import { createGame, endTimedGame, legalMoves, move, roll, throwCowries } from '../src/game/engine.js';
import { chooseMove } from '../src/game/bot.js';

const R = (value) => ({ shells: [], value });

test('5x5 Chowkra paths: 25 unique cells, start at own home, end at centre', () => {
  const homes = [[4, 2], [2, 4], [0, 2], [2, 0]];
  PATHS.forEach((p, seat) => {
    assert.equal(p.length, 25);
    assert.equal(new Set(p.map(String)).size, 25);
    assert.deepEqual(p[0], homes[seat]);
    assert.deepEqual(p[FINISH], [2, 2]);
    for (let i = 1; i < p.length; i++) {
      const d = Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1]);
      assert.equal(d, 1, `seat ${seat} step ${i} not adjacent`);
    }
  });
  assert.equal(SAFE_CELLS.length, 5);
});

test('cowrie values: 0 up = 8, 4 up = 4', () => {
  assert.equal(throwCowries(() => false).value, 8);
  assert.equal(throwCowries(() => true).value, 4);
  let i = 0;
  assert.equal(throwCowries(() => i++ < 2).value, 2);
});

test('video rule (20.13.13): max 3 pieces out until 1 finishes; 4th unlocks after 1st reaches centre', () => {
  const g = createGame([0, 2]);
  roll(g, 0, R(1)); move(g, 0, 0);
  roll(g, 2, R(1)); move(g, 2, 0);
  roll(g, 0, R(1)); move(g, 0, 1);
  roll(g, 2, R(1)); move(g, 2, 1);
  roll(g, 0, R(1)); move(g, 0, 2);

  // Now 3 pieces of seat 0 are out (>0), piece 3 is at home (0) -> CANNOT leave!
  const blocked4th = legalMoves(g, 0, 2);
  assert.ok(!blocked4th.some((m) => m.piece === 3), '4th goti stays locked until 1st reaches centre');

  // Finish piece 0 in centre -> unlocks 4th goti!
  g.players[0].hasKilled = true;
  g.players[0].pieces[0] = 23;
  roll(g, 2, R(1)); move(g, 2, 2);
  roll(g, 0, R(1)); move(g, 0, 0); // piece 0 -> FINISH (24)
  const unlocked4th = legalMoves(g, 0, 2);
  assert.ok(unlocked4th.some((m) => m.piece === 3 && m.from === 0 && m.to === 2), '4th goti unlocks after 1st finish');
});

test('video rule (20.13.13): before kill, piece wraps outer ring instead of entering inner ring', () => {
  const g = createGame([0, 2]);
  g.players[0].pieces = [14, 0, 0, 0];
  const mBeforeKill = legalMoves(g, 0, 3);
  assert.equal(mBeforeKill[0].to, 1, '14 + 3 wraps to 1 on 16-cell outer ring while gate locked');
  g.players[0].hasKilled = true;
  const mAfterKill = legalMoves(g, 0, 3);
  assert.ok(mAfterKill.some((m) => m.from === 14 && m.to === 17), 'enters inner ring once a kill is scored');
});

test('audio (13.28.08): extra turn only on 4, 8, or kill (not on finish)', () => {
  const g = createGame([0, 2]);
  g.players[0].pieces = [22, 1, 2, FINISH];
  g.players[0].hasKilled = true;
  roll(g, 0, R(2));
  move(g, 0, 0); // finishes piece 0 on 2 -> should pass turn (no extra on finish)
  assert.equal(g.turn, 2);

  roll(g, 2, R(8));
  move(g, 2, 0);
  assert.equal(g.turn, 2, '8 grants extra turn');
  roll(g, 2, R(4));
  move(g, 2, 0);
  assert.equal(g.turn, 2, '4 grants extra turn');
});

test('video rules (20.13.14 & 14.19.34): Pakka Judwa only in inner ring, moves on 2/4/8, shields singles, kills only Pakka', () => {
  const g = createGame([0, 2]);
  g.players[0].hasKilled = true;
  g.players[2].hasKilled = true;

  // Outer ring: neither pair_soft nor pair_pakka is allowed outside the inner ring
  g.players[0].pieces = [5, 5, 1, 0];
  const outerMv = legalMoves(g, 0, 2);
  assert.ok(!outerMv.some((m) => m.kind === 'pair_soft'), 'pair_soft NOT allowed on outer ring');
  assert.ok(!outerMv.some((m) => m.kind === 'pair_pakka'), 'pair_pakka NOT allowed on outer ring');

  // Inner ring (index 17 -> 18): both pair_soft and pair_pakka offered
  g.players[0].pieces = [17, 17, 1, 0];
  const mv2 = legalMoves(g, 0, 2);
  const pakkaChoice = mv2.find((m) => m.kind === 'pair_pakka');
  const softChoice = mv2.find((m) => m.kind === 'pair_soft');
  assert.ok(pakkaChoice && softChoice);
  assert.equal(pakkaChoice.to, 18, 'roll 2 moves pair 1 square');

  roll(g, 0, R(2));
  move(g, 0, { moveId: pakkaChoice.id });
  assert.deepEqual(g.players[0].pieces.slice(0, 2), [18, 18]);
  assert.equal(g.players[0].pakka[0], g.players[0].pakka[1]);
  assert.ok(g.players[0].pakka[0] > 0);

  // Pakka Double cannot move on odd roll (1 or 3), moves 2 squares on roll 4
  assert.ok(!legalMoves(g, 0, 1).some((m) => m.groupPieces.includes(0)));
  assert.ok(!legalMoves(g, 0, 3).some((m) => m.groupPieces.includes(0)));
  assert.ok(legalMoves(g, 0, 4).some((m) => m.kind === 'pakka_move' && m.to === 20));

  // Add a 3rd friendly single onto same cell (index 18) -> single enemy CANNOT kill single OR Pakka Double!
  g.players[0].pieces[2] = 18;
  const enemyCell = cellFor(0, 18);
  const idx2 = PATHS[2].findIndex(([r, c]) => r === enemyCell[0] && c === enemyCell[1]);
  g.players[2].pieces = [idx2 - 2, 0, 0, 0];
  g.turn = 2;
  roll(g, 2, R(2));
  move(g, 2, 0);
  assert.equal(g.players[0].pieces[0], 18, 'Pakka Double immune to single');
  assert.equal(g.players[0].pieces[2], 18, 'Single protected by friendly Judwa!');
  assert.equal(g.turn, 0, 'no kill -> no extra turn');

  // Soft-pair un-fused DOES get killed by single enemy
  const gSoft = createGame([0, 2]);
  gSoft.players[0].pieces = [5, 5, 0, 0];
  const sc = cellFor(0, 5);
  const sIdx = PATHS[2].findIndex(([r, c]) => r === sc[0] && c === sc[1]);
  gSoft.players[2].pieces = [sIdx - 1, 0, 0, 0];
  gSoft.turn = 2;
  roll(gSoft, 2, R(1));
  move(gSoft, 2, 0);
  assert.deepEqual(gSoft.players[0].pieces.slice(0, 2), [0, 0], 'single kills both un-fused pieces');

  // Pakka Double CAN kill another Pakka Double!
  const g2 = createGame([0, 2]);
  g2.players[0].hasKilled = true;
  g2.players[2].hasKilled = true;
  g2.players[0].pieces = [18, 18, 0, 0];
  g2.players[0].pakka = [1, 1, 0, 0];
  g2.players[2].pieces = [idx2 - 1, idx2 - 1, 0, 0];
  g2.players[2].pakka = [1, 1, 0, 0];
  g2.turn = 2;
  roll(g2, 2, R(2)); // moves Pakka Double 1 square -> idx2
  const dblMove = legalMoves(g2, 2, 2).find((m) => m.kind === 'pakka_move');
  move(g2, 2, { moveId: dblMove.id });
  assert.deepEqual(g2.players[0].pieces.slice(0, 2), [0, 0], 'Pakka Double kills enemy Pakka Double');
  assert.equal(g2.turn, 2, 'Pakka kill grants extra turn');
});

test('video rules (20.13.12 & 14.19.34): Winner Ghar is at winner gate only, shields kills, unlocks on exact key', () => {
  const g = createGame([0, 1, 2]);
  g.players[0].pieces = [FINISH, FINISH, FINISH, 22];
  g.players[0].hasKilled = true;
  // Seat 1 has a piece at the cell matching Seat 0's gate (cellFor(0, 23) = [3,2]), NOT at Seat 1's own gate
  const redGate = cellFor(0, 23);
  const oppTrapIdx = PATHS[1].findIndex(([r, c]) => r === redGate[0] && c === redGate[1]);
  g.players[1].pieces = [oppTrapIdx, 23, 0, 0];
  g.players[1].hasKilled = true;

  roll(g, 0, R(2));
  const finEv = move(g, 0, 3);
  assert.equal(g.phase, 'jail');
  assert.ok(finEv.some((e) => e.type === 'jailPrompt'));

  const gharEv = roll(g, 0, R(4));
  assert.ok(gharEv.some((e) => e.type === 'jailCreated' && e.key === 4 && e.index === 23));
  assert.equal(g.turn, 1);

  // Stepping past Winner Ghar is NOT compulsory when rolling higher than distance to trap
  const passG = createGame([0, 1, 2]);
  passG.jail = { creator: 0, key: 4, index: 23 };
  passG.players[1].pieces = [oppTrapIdx - 1, 0, 0, 0];
  passG.players[1].hasKilled = true;
  assert.ok(
    legalMoves(passG, 1, 2).some((m) => m.piece === 0 && m.to === oppTrapIdx + 1),
    'can step past Winner Ghar without stopping inside it',
  );

  // Piece at Red's Ghar cell cannot leave on 1,2,3 -> unlocks on exact key 4 and advances 4 steps along own path (not teleport to finish)
  assert.ok(!legalMoves(g, 1, 1).some((m) => m.piece === 0));
  // Piece at Seat 1's own index 23 ([2,3]) is NOT trapped because Winner Ghar is only at Red's gate!
  assert.ok(legalMoves(g, 1, 1).some((m) => m.piece === 1 && m.to === FINISH));
  const unlockMoves = legalMoves(g, 1, 4);
  assert.ok(unlockMoves.some((m) => m.piece === 0 && m.breaksJail && m.to === oppTrapIdx + 4));
  roll(g, 1, R(4));
  const brkEv = move(g, 1, 0);
  assert.ok(brkEv.some((e) => e.type === 'jailBroken'));
  assert.equal(g.players[1].pieces[0], oppTrapIdx + 4);

  // Only reaches FINISH directly if advancing key steps along own path lands on FINISH (e.g. Seat 3 at index 21 + key 3)
  const trap3 = PATHS[3].findIndex(([r, c]) => r === redGate[0] && c === redGate[1]);
  assert.equal(trap3, 21);
  const gSeat3 = createGame([0, 2, 3]);
  gSeat3.jail = { creator: 0, key: 3, index: 23 };
  gSeat3.players[3].pieces = [trap3, 0, 0, 0];
  gSeat3.players[3].hasKilled = true;
  const s3Unlock = legalMoves(gSeat3, 3, 3).find((m) => m.piece === 0);
  assert.ok(s3Unlock && s3Unlock.breaksJail && s3Unlock.to === FINISH);
});

test('X squares are safe — no kill', () => {
  const g = createGame([0, 2]);
  g.players[0].pieces[0] = 4; // (2,4) — X square
  assert.ok(isSafe(cellFor(0, 4)));
  const idx = PATHS[2].findIndex(([r, c]) => r === 2 && c === 4);
  g.players[2].pieces[0] = idx - 3;
  g.turn = 2;
  roll(g, 2, R(3));
  move(g, 2, 0);
  assert.equal(g.players[0].pieces[0], 4);
});

test('30 full 4-player bot games finish cleanly under strict video rules without deadlocks', () => {
  for (let n = 0; n < 30; n++) {
    const g = createGame([0, 1, 2, 3]);
    let steps = 0;
    while (g.phase !== 'ended' && steps++ < 25000) {
      if (g.phase === 'roll' || g.phase === 'jail') roll(g, g.turn);
      else move(g, g.turn, chooseMove(g, g.turn));
    }
    assert.equal(g.phase, 'ended', `bot game #${n} stalled after ${steps} steps`);
    assert.equal(g.ranks.length, 4);
  }
});

test('timed mode endTimedGame ranks remaining players by score', () => {
  const g = createGame([0, 1, 2], { timedSeconds: 180 });
  g.players[1].pieces = [10, 5, 0, 0];
  g.players[1].kills = 2;
  g.players[1].score = 45;
  g.players[2].pieces = [3, 0, 0, 0];
  g.players[2].score = 3;
  g.players[0].pieces = [1, 0, 0, 0];
  g.players[0].score = 1;
  const ev = endTimedGame(g);
  assert.equal(g.phase, 'ended');
  assert.deepEqual(g.ranks, [1, 2, 0]);
  assert.ok(ev.some((e) => e.type === 'gameOver' && e.timed));
});

test('video rule (10.32.24): losing all active pieces on board resets hasKilled (kill down)', () => {
  const g = createGame([0, 2]);
  g.players[0].hasKilled = true;
  g.players[0].pieces = [5, 0, 0, 0];
  const c5 = cellFor(0, 5);
  const idx2 = PATHS[2].findIndex(([r, c]) => r === c5[0] && c === c5[1]);
  g.players[2].pieces = [idx2 - 1, 0, 0, 0];
  g.turn = 2;
  roll(g, 2, R(1));
  const ev = move(g, 2, 0);
  assert.equal(g.players[0].pieces[0], 0);
  assert.equal(g.players[0].hasKilled, false, 'hasKilled resets when all active pieces on board are killed');
  assert.ok(ev.some((e) => e.type === 'killReset' && e.seat === 0));

  // Seat 0 must wrap outer ring again until scoring another kill
  g.players[0].pieces = [14, 0, 0, 0];
  g.turn = 0;
  const lockedMoves = legalMoves(g, 0, 3);
  assert.equal(lockedMoves[0].to, 1);
});

test('video rule (10.32.26): inner-ring overshoot offers Rotate vs Stay on first choice and locks selection', () => {
  const g1 = createGame([0, 2]);
  g1.players[0].hasKilled = true;
  g1.players[0].pieces = [22, 0, 0, 0];
  const firstOvershoot = legalMoves(g1, 0, 3).filter((m) => m.piece === 0);
  const rotMv = firstOvershoot.find((m) => m.innerAction === 'rotate');
  const stayMv = firstOvershoot.find((m) => m.innerAction === 'stay');
  assert.ok(rotMv && stayMv, 'both Rotate and Stay offered on first inner overshoot');
  assert.equal(rotMv.to, 17);
  assert.equal(stayMv.to, 22);

  // Choosing Rotate locks piece into rotating until exact roll to centre
  roll(g1, 0, R(3));
  move(g1, 0, { moveId: rotMv.id });
  assert.equal(g1.players[0].pieces[0], 17);
  assert.equal(g1.players[0].innerMode[0], 'rotate');
  g1.players[0].pieces[0] = 23;
  const secondRotOnly = legalMoves(g1, 0, 3).filter((m) => m.piece === 0);
  assert.equal(secondRotOnly.length, 1);
  assert.equal(secondRotOnly[0].innerAction, 'rotate');
  assert.equal(secondRotOnly[0].to, 18);

  // Choosing Stay locks piece so it can never rotate on future overshoots
  const g2 = createGame([0, 2]);
  g2.players[0].hasKilled = true;
  g2.players[0].pieces = [22, 0, 0, 0];
  const stayChoice = legalMoves(g2, 0, 3).find((m) => m.piece === 0 && m.innerAction === 'stay');
  roll(g2, 0, R(3));
  move(g2, 0, { moveId: stayChoice.id });
  assert.equal(g2.players[0].pieces[0], 22);
  assert.equal(g2.players[0].innerMode[0], 'stay');
  assert.equal(legalMoves(g2, 0, 3).filter((m) => m.piece === 0).length, 0, 'stay piece cannot rotate on overshoot');
  assert.ok(legalMoves(g2, 0, 2).some((m) => m.piece === 0 && m.to === FINISH), 'stay piece can still enter centre on exact roll');
});

test('audio (10.31.21 / 07.25.04): Triple mirrors Double in inner ring (triple_soft + triple_pakka, moves on 3, kills only Triple)', () => {
  const g = createGame([0, 2]);
  g.players[0].hasKilled = true;
  g.players[0].pieces = [5, 5, 5, 0];
  assert.ok(!legalMoves(g, 0, 3).some((m) => m.kind === 'triple_pakka' || m.kind === 'triple_soft'), 'Triple NOT allowed on outer ring');

  g.players[0].pieces = [17, 17, 17, 0];
  const mvs = legalMoves(g, 0, 3);
  const softTri = mvs.find((m) => m.kind === 'triple_soft');
  const triMv = mvs.find((m) => m.kind === 'triple_pakka');
  assert.ok(softTri && softTri.to === 18 && !softTri.createsPakka, 'triple_soft moves 3 un-fused 1 step');
  assert.ok(triMv && triMv.to === 18 && triMv.createsPakka, 'triple_pakka binds 3 and moves 1 step');
  roll(g, 0, R(3));
  move(g, 0, { moveId: triMv.id });
  assert.deepEqual(g.players[0].pieces.slice(0, 3), [18, 18, 18]);

  // Enemy single cannot kill Pakka Triple, and Pakka Triple does not kill enemy single
  const c18 = cellFor(0, 18);
  const idx2 = PATHS[2].findIndex(([r, c]) => r === c18[0] && c === c18[1]);
  g.players[2].hasKilled = true;
  g.players[2].pieces = [idx2, 0, 0, 0];
  g.players[0].pieces = [17, 17, 17, 0];
  g.players[0].pakka = [1, 1, 1, 0];
  const mvAt18 = legalMoves(g, 0, 3).find((m) => m.kind === 'pakka_move');
  assert.equal(mvAt18.kills, 0, 'Pakka Triple does not kill enemy single');
  assert.ok(!legalMoves(g, 0, 2).some((m) => m.groupPieces.includes(0)), 'triple cannot move on 2');
  assert.equal(mvAt18.to, 18, 'triple moves 1 on 3 (17 -> 18)');
});

test('audio (07.25.07): Quick 4-piece preset configures 4 unlocked pieces with fast 12s turns', async () => {
  const { VARIANTS } = await import('../src/game/rules.js');
  const g = createGame([0, 2], VARIANTS.quick4);
  assert.equal(g.players[0].pieces.length, 4);
  assert.equal(g.rules.maxOutBeforeFirstFinish, 4);
  assert.equal(g.rules.killRequiredForInnerRing, false);
  assert.equal(g.rules.turnSeconds, 12);
});

test('video (10.32.32): soft pair cannot kill 1 single, kills 2 separated enemy pieces, cannot kill Pakka Double', () => {
  // 2 moving together soft cannot kill 1 enemy single
  const g1 = createGame([0, 2]);
  g1.players[0].hasKilled = true;
  g1.players[2].hasKilled = true;
  g1.players[0].pieces = [17, 17, 0, 0];
  const targetCell = cellFor(0, 19);
  const idx2 = PATHS[2].findIndex(([r, c]) => r === targetCell[0] && c === targetCell[1]);
  g1.players[2].pieces = [idx2, 0, 0, 0];
  const pairSoftOn1 = legalMoves(g1, 0, 4).find((m) => m.kind === 'pair_soft' && m.to === 19);
  assert.equal(pairSoftOn1.kills, 0, 'pair_soft (2) must NOT kill 1 enemy single');
  roll(g1, 0, R(4));
  move(g1, 0, { moveId: pairSoftOn1.id });
  assert.equal(g1.players[2].pieces[0], idx2, 'enemy single survives pair_soft');

  // 2 moving together soft DOES kill 2 un-fused enemy pieces sharing that square
  const g2 = createGame([0, 2]);
  g2.players[0].hasKilled = true;
  g2.players[2].hasKilled = true;
  g2.players[0].pieces = [17, 17, 0, 0];
  g2.players[2].pieces = [idx2, idx2, 0, 0];
  const pairSoftOn2 = legalMoves(g2, 0, 4).find((m) => m.kind === 'pair_soft' && m.to === 19);
  assert.equal(pairSoftOn2.kills, 2, 'pair_soft kills 2 separated enemy singles');
  roll(g2, 0, R(4));
  move(g2, 0, { moveId: pairSoftOn2.id });
  assert.deepEqual(g2.players[2].pieces.slice(0, 2), [0, 0]);

  // 2 moving together soft does NOT kill enemy Pakka Double
  const g3 = createGame([0, 2]);
  g3.players[0].hasKilled = true;
  g3.players[2].hasKilled = true;
  g3.players[0].pieces = [17, 17, 0, 0];
  g3.players[2].pieces = [idx2, idx2, 0, 0];
  g3.players[2].pakka = [1, 1, 0, 0];
  const pairSoftOnPakka = legalMoves(g3, 0, 4).find((m) => m.kind === 'pair_soft' && m.to === 19);
  assert.equal(pairSoftOnPakka.kills, 0, 'pair_soft cannot kill enemy Pakka Double');
});
