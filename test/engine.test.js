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

test('video rules (20.13.14 & 14.19.34): Pakka Judwa moves only on 2/4/8, shields singles, kills only Pakka', () => {
  const g = createGame([0, 2]);
  g.players[0].hasKilled = true;
  g.players[2].hasKilled = true;
  g.players[0].pieces = [5, 5, 1, 0];

  // Un-fused pair on index 5 gets both pair_soft and pair_pakka on roll 2
  const mv2 = legalMoves(g, 0, 2);
  const pakkaChoice = mv2.find((m) => m.kind === 'pair_pakka');
  const softChoice = mv2.find((m) => m.kind === 'pair_soft');
  assert.ok(pakkaChoice && softChoice);
  assert.equal(pakkaChoice.to, 6, 'roll 2 moves pair 1 square');

  roll(g, 0, R(2));
  move(g, 0, { moveId: pakkaChoice.id });
  assert.deepEqual(g.players[0].pieces.slice(0, 2), [6, 6]);
  assert.equal(g.players[0].pakka[0], g.players[0].pakka[1]);
  assert.ok(g.players[0].pakka[0] > 0);

  // Pakka Double cannot move on odd roll (1 or 3), moves 2 squares on roll 4
  assert.ok(!legalMoves(g, 0, 1).some((m) => m.groupPieces.includes(0)));
  assert.ok(!legalMoves(g, 0, 3).some((m) => m.groupPieces.includes(0)));
  assert.ok(legalMoves(g, 0, 4).some((m) => m.kind === 'pakka_move' && m.to === 8));

  // Add a 3rd friendly single onto same cell (index 6) -> single enemy CANNOT kill single OR Pakka Double!
  g.players[0].pieces[2] = 6;
  const enemyCell = cellFor(0, 6);
  const idx2 = PATHS[2].findIndex(([r, c]) => r === enemyCell[0] && c === enemyCell[1]);
  g.players[2].pieces = [idx2 - 2, 0, 0, 0];
  g.turn = 2;
  roll(g, 2, R(2));
  move(g, 2, 0);
  assert.equal(g.players[0].pieces[0], 6, 'Pakka Double immune to single');
  assert.equal(g.players[0].pieces[2], 6, 'Single protected by friendly Judwa!');
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
  g2.players[0].pieces = [6, 6, 0, 0];
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

test('video rules (20.13.12 & 14.19.34): Winner Ghar traps at index 23, shields kills, unlocks on exact key', () => {
  const g = createGame([0, 1, 2]);
  g.players[0].pieces = [FINISH, FINISH, FINISH, 22];
  g.players[0].hasKilled = true;
  g.players[1].pieces = [23, 0, 0, 0];
  g.players[1].hasKilled = true;

  roll(g, 0, R(2));
  const finEv = move(g, 0, 3);
  assert.equal(g.phase, 'jail');
  assert.ok(finEv.some((e) => e.type === 'jailPrompt'));

  const gharEv = roll(g, 0, R(4));
  assert.ok(gharEv.some((e) => e.type === 'jailCreated' && e.key === 4 && e.index === 23));
  assert.equal(g.turn, 1);

  // Piece at Ghar index 23 cannot leave on 1,2,3 -> can only leave on exact key 4
  assert.ok(!legalMoves(g, 1, 1).some((m) => m.piece === 0));
  const unlockMoves = legalMoves(g, 1, 4);
  assert.ok(unlockMoves.some((m) => m.piece === 0 && m.breaksJail && m.to === FINISH));
  roll(g, 1, R(4));
  const brkEv = move(g, 1, 0);
  assert.ok(brkEv.some((e) => e.type === 'jailBroken'));
  assert.equal(g.players[1].pieces[0], FINISH);
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
