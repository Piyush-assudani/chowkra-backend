// Every tunable rule lives here. Defaults match the 5x5 Chowkra video & audio specs.
export const DEFAULT_RULES = Object.freeze({
  boardSize: 5,
  piecesPerPlayer: 4,
  winPieces: null,
  startOnBoard: true,
  entryRolls: [4, 8],
  extraTurnRolls: [4, 8],
  extraTurnOnKill: true,
  extraTurnOnFinish: false, // Extra turns strictly on 4, 8, and Kill
  // Max 3 pieces leave home initially; 4th unlocks once 1st finishes in centre
  maxOutBeforeFirstFinish: 3,
  // Must kill an opponent before entering the inner ring (loops outer ring until then)
  killRequiredForInnerRing: true,
  wrapOuterOnLockedGate: true,
  // Pakka (Judwa / Triple) fusion + shielded stacking rules
  pakkaEnabled: true,
  // 1st finisher builds Winner Ghar trap at gate index 23; opponents roll exact key to pass
  jailOnFirstWin: true,
  gharGateIndex: 23,
  maxConsecutivePowerRolls: 0,
  timedSeconds: 0,
  botDifficulty: 'smart',
  turnSeconds: 20,
  maxTimeoutsBeforeBot: 3,
  playForAllRanks: true,
});

export function makeRules(overrides = {}) {
  return { ...DEFAULT_RULES, ...overrides, boardSize: 5 };
}

/** Game table presets (all on 5x5 Chowkra Bara). */
export const VARIANTS = Object.freeze({
  classic: {},
  quick: {
    piecesPerPlayer: 2,
    maxOutBeforeFirstFinish: 2,
    killRequiredForInnerRing: false,
    pakkaEnabled: false,
    jailOnFirstWin: false,
    turnSeconds: 12,
  },
  blitz: {
    timedSeconds: 180,
    turnSeconds: 12,
  },
  // Backward-compatible aliases mapping cleanly to 5x5 video standard
  master: {},
});
