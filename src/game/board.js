// Chowka Bara / Chowkra 5x5 board geometry.
// Cells are [row, col] with (0,0) top-left. Seat 0 sits at the bottom.

export const SIZE = 5;
export const FINISH = 24;
export const OUTER_LAST = 15;
export const OFF_BOARD = -1;

// Rotate a cell 90° anticlockwise around the centre of a 5x5 board.
function rotate([r, c]) {
  return [SIZE - 1 - c, r];
}

function rotateTimes(cell, times) {
  let out = cell;
  for (let i = 0; i < times; i++) out = rotate(out);
  return out;
}

// 5x5 path for seat 0 (bottom): outer ring (16 CCW) -> inner ring (8 CW) -> centre (24).
const PATH_0 = [
  [4, 2], [4, 3], [4, 4], [3, 4], [2, 4], [1, 4], [0, 4], [0, 3],
  [0, 2], [0, 1], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1],
  [3, 1], [2, 1], [1, 1], [1, 2], [1, 3], [2, 3], [3, 3], [3, 2],
  [2, 2],
];

export const PATHS = [0, 1, 2, 3].map((s) => PATH_0.map((c) => rotateTimes(c, s)));
export const HOME_CELLS = PATHS.map((p) => p[0]);
export const SAFE_CELLS = [[4, 2], [2, 4], [0, 2], [2, 0], [2, 2]];

const SAFE_SET = new Set(SAFE_CELLS.map((c) => `${c[0]},${c[1]}`));

export const BOARD_5 = Object.freeze({
  size: SIZE,
  paths: PATHS,
  homeCells: HOME_CELLS,
  safeCells: SAFE_CELLS,
  safeSet: SAFE_SET,
  outerLast: OUTER_LAST,
  outerLength: OUTER_LAST + 1,
  finish: FINISH,
  center: [2, 2],
});

export function boardSpec() {
  return BOARD_5;
}

export function cellFor(seat, index) {
  if (index < 0 || index >= FINISH + 1) return null;
  return PATHS[seat][index];
}

export function isSafe(cell) {
  return !!cell && SAFE_SET.has(`${cell[0]},${cell[1]}`);
}

export function sameCell(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}
