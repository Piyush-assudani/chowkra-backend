// Probability-weighted Chowkra bot aware of 3-piece cap, inner-ring kill gate,
// Pakka (Judwa / Triple) safety & matching captures, and Winner Ghar unlocking.
import { OFF_BOARD, boardSpec, cellFor, isSafe, sameCell } from './board.js';

const THROW_PROBS = [
  [1, 4 / 16],
  [2, 6 / 16],
  [3, 4 / 16],
  [4, 1 / 16],
  [8, 1 / 16],
];

function threatProb(state, seat, cell, spec, unitSize = 1) {
  if (!cell || isSafe(cell)) return 0;
  if (state.jail) {
    for (const s of state.seats) {
      if (s !== state.jail.creator && sameCell(cell, cellFor(s, state.jail.index))) return 0;
    }
  }

  // Friendly Pakka Double on the same cell shields singles
  const my = state.players[seat];
  if (unitSize === 1 && my.pakka) {
    const hasFriendlyPakka = my.pieces.some((pos, i) => pos > 0 && pos < spec.finish && my.pakka[i] > 0 && sameCell(cellFor(seat, pos), cell));
    if (hasFriendlyPakka) return 0;
  }

  let prob = 0;
  for (const s of state.seats) {
    if (s === seat || state.players[s].rank !== null) continue;
    const ep = state.players[s];
    const locked = state.rules.killRequiredForInnerRing && !ep.hasKilled;
    ep.pieces.forEach((pos, idx) => {
      if (pos === OFF_BOARD || pos === spec.finish) return;
      const gid = ep.pakka?.[idx] ?? 0;
      const eSize = gid > 0 ? ep.pakka.filter((v) => v === gid).length : 1;
      if (unitSize !== eSize) return; // only matching strength can kill (1->1, 2->2, 3->3)

      for (const [d, p] of THROW_PROBS) {
        if (d % eSize !== 0) continue;
        const step = d / eSize;
        let to = pos + step;
        if (locked && pos <= spec.outerLast && to > spec.outerLast) {
          to = (pos + step) % spec.outerLength;
        }
        if (to > spec.finish) continue;
        if (sameCell(cellFor(s, to), cell)) prob += p;
      }
    });
  }
  return Math.min(1, prob);
}

function chaseProb(state, seat, to, spec, unitSize = 1) {
  if (to === spec.finish || to < 0) return 0;
  const player = state.players[seat];
  const locked = state.rules.killRequiredForInnerRing && !player.hasKilled;
  let best = 0;

  for (const [d, p] of THROW_PROBS) {
    if (d % unitSize !== 0) continue;
    const step = d / unitSize;
    let nextIdx = to + step;
    if (locked && to <= spec.outerLast && nextIdx > spec.outerLast) {
      nextIdx = (to + step) % spec.outerLength;
    }
    if (nextIdx >= spec.finish) continue;
    const targetCell = cellFor(seat, nextIdx);
    if (isSafe(targetCell)) continue;
    for (const s of state.seats) {
      if (s === seat || state.players[s].rank !== null) continue;
      const ep = state.players[s];
      ep.pieces.forEach((pos, idx) => {
        if (pos < 0 || pos === spec.finish) return;
        const gid = ep.pakka?.[idx] ?? 0;
        const eSize = gid > 0 ? ep.pakka.filter((v) => v === gid).length : 1;
        if (eSize === unitSize && sameCell(cellFor(s, pos), targetCell)) {
          best += p;
        }
      });
    }
  }
  return Math.min(1, best);
}

export function chooseMove(state, seat) {
  const moves = state.moves;
  if (!moves.length) return null;
  const { rules } = state;
  const diff = rules.botDifficulty === 'casual' ? 'easy' : (rules.botDifficulty || 'medium');

  // Easy: beginner bot — often picks random moves and ignores threat/chase math.
  if (diff === 'easy' && Math.random() < 0.45) {
    const m = moves[Math.floor(Math.random() * moves.length)];
    return { moveId: m.id, piece: m.piece, kind: m.kind };
  }

  const spec = boardSpec();
  const player = state.players[seat];
  const homeCount = player.pieces.filter((p) => p <= 0).length;
  const finishedCount = player.pieces.filter((p) => p === spec.finish).length;
  const winNeed = Number.isInteger(rules.winPieces) && rules.winPieces >= 1 ? Math.min(rules.winPieces, player.pieces.length) : player.pieces.length;

  let best = moves[0];
  let bestScore = -Infinity;

  for (const m of moves) {
    const unitSize = m.kind === 'pair_pakka' || m.kind === 'triple_pakka' || m.kind === 'pakka_move'
      ? (m.groupPieces?.length ?? 1)
      : 1;
    let score = (m.to / spec.finish) * 35;

    if (diff === 'easy') {
      if (m.kills > 0) score += 110 * m.kills;
      if (m.to === spec.finish) score += 140;
      if (m.from === OFF_BOARD) score += 75;
      score += Math.random() * 140;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
      continue;
    }

    const tacticalScale = diff === 'medium' ? 0.55 : 1.0;

    if (m.kills > 0) {
      score += (diff === 'medium' ? 280 : 500) * m.kills;
      if (rules.killRequiredForInnerRing && !player.hasKilled) score += 260 * tacticalScale;
    }
    if (m.to === spec.finish) {
      score += diff === 'medium' ? 280 : 440;
      if (finishedCount === 0 && rules.maxOutBeforeFirstFinish > 0) score += 160 * tacticalScale; // unlocks 4th piece
      if (finishedCount + 1 >= winNeed) score += 320 * tacticalScale;
    }
    if (m.breaksJail) score += 360 * tacticalScale;
    if (m.from === OFF_BOARD) score += 130;
    else if (m.from === 0 && homeCount >= 2) score += 95 * tacticalScale;

    // Avoid outer-ring looping slightly when inner entry is unlocked, favour progress after kill
    if (!player.hasKilled && rules.killRequiredForInnerRing && m.to < m.from) score -= 12;

    const fromCell = m.from >= 0 ? cellFor(seat, m.from) : null;
    const destCell = cellFor(seat, m.to);
    const fromThreat = fromCell ? threatProb(state, seat, fromCell, spec, unitSize) : 0;
    const destSafe = isSafe(destCell);
    const destThreat = destSafe ? 0 : threatProb(state, seat, destCell, spec, unitSize);

    if (destSafe && m.to > 0 && m.to < spec.finish) {
      score += 150 * tacticalScale;
    } else if (!destSafe) {
      score -= 260 * tacticalScale * destThreat * (1 + m.to / spec.finish);
    }
    if (fromThreat > 0) score += 210 * tacticalScale * fromThreat * (1 + m.from / spec.finish);

    // Pakka formation & pair heuristics: fuse Double when chased or near inner ring; avoid Triple trap before kill
    if (m.kind === 'pair_pakka') {
      score += (player.hasKilled ? 65 : 20) * tacticalScale;
      if (fromThreat > 0.25) score += 90 * tacticalScale;
    } else if (m.kind === 'pair_soft') {
      score += 15 * tacticalScale;
    } else if (m.kind === 'triple_pakka') {
      score += 12 * tacticalScale; // slower to move (needs 3), so only fuse when helpful
    }

    const chase = chaseProb(state, seat, m.to, spec, unitSize);
    if (chase > 0) score += (rules.killRequiredForInnerRing && !player.hasKilled ? 170 : 105) * tacticalScale * chase;

    score += Math.random() * (diff === 'medium' ? 55 : 3);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { moveId: best.id, piece: best.piece, kind: best.kind };
}
