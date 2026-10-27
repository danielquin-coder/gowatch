// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, placeStone, inferMove, BLACK, WHITE, EMPTY } from '../js/game.js';

const mk = (size, rows) => { // rows: array of strings with . x o
  const g = new Int8Array(size * size);
  rows.forEach((r, y) => [...r].forEach((c, x) => { g[y * size + x] = c === 'x' ? BLACK : c === 'o' ? WHITE : EMPTY; }));
  return g;
};

test('single stone capture', () => {
  const g = new Game({ size: 9 });
  assert.ok(g.play(BLACK, 1, 0).ok);
  assert.ok(g.play(WHITE, 0, 0).ok);
  const r = g.play(BLACK, 0, 1);
  assert.ok(r.ok);
  assert.deepEqual(r.captured, [0]);
  assert.equal(g.grid[0], EMPTY);
});

test('group capture and undo restores stones', () => {
  const g = new Game({ size: 9 });
  g.play(WHITE, 0, 0); g.play(WHITE, 1, 0);
  g.play(BLACK, 2, 0); g.play(BLACK, 0, 1);
  const r = g.play(BLACK, 1, 1);
  assert.deepEqual(r.captured.sort(), [0, 1]);
  assert.equal(g.grid[0], EMPTY);
  g.undo();
  assert.equal(g.grid[0], WHITE);
  assert.equal(g.grid[1], WHITE);
  assert.equal(g.grid[10], EMPTY);
});

test('suicide is rejected, but capture-first is legal', () => {
  const grid = mk(5, ['.o...', 'o....', '.....', '.....', '.....']);
  assert.equal(placeStone(grid, 5, BLACK, 0, 0).reason, 'suicide');
  const g2 = mk(5, ['.o...', 'ox...', '.o...', '.....', '.....']);
  // Black at (0,0)? neighbours (1,0)=o and (0,1)=o -> suicide. White at (2,1) would capture x:
  const g3 = mk(5, ['.o...', 'ox...', '.o...', '.....', '.....']);
  g3[1 * 5 + 2] = EMPTY;
  const r = placeStone(g3, 5, WHITE, 2, 1);
  assert.ok(r.ok);
  assert.deepEqual(r.captured, [6]);
  assert.equal(g2[0], EMPTY);
});

test('occupied point rejected', () => {
  const g = new Game({ size: 9 });
  g.play(BLACK, 4, 4);
  assert.equal(g.play(WHITE, 4, 4).reason, 'occupied');
});

test('simple ko is rejected, allowed after a tenuki pair', () => {
  const g = new Game({ size: 5 });
  // classic ko shape around (2,1)/(2,2)
  //  . x o .
  //  x o . o      <- white to capture at (2,1)? build explicitly via setBoard
  g.setBoard(mk(5, ['.xo..', 'xo.o.', '.xo..', '.....', '.....']));
  // Black captures white at (1,1) by playing (2,1)
  const cap = g.play(BLACK, 2, 1);
  assert.ok(cap.ok);
  assert.deepEqual(cap.captured, [6]);
  // White immediately retaking at (1,1) recreates the earlier position -> ko
  assert.equal(g.play(WHITE, 1, 1).reason, 'ko');
  // After a move elsewhere by each side, the retake is legal
  assert.ok(g.play(WHITE, 4, 4).ok);
  assert.ok(g.play(BLACK, 4, 0).ok);
  assert.ok(g.play(WHITE, 1, 1).ok);
});

test('toPlay alternates and handles handicap', () => {
  const g = new Game({ size: 9 });
  assert.equal(g.toPlay, BLACK);
  g.play(BLACK, 2, 2);
  assert.equal(g.toPlay, WHITE);
  const h = new Game({ size: 9 });
  h.setBoard(mk(9, ['.........', '.........', '..x...x..', '.........', '.........', '.........', '.........', '.........', '.........']));
  assert.equal(h.toPlay, WHITE);
});

test('SGF output', () => {
  const g = new Game({ size: 19, komi: 6.5 });
  g.play(BLACK, 3, 3); g.play(WHITE, 15, 15); g.pass(BLACK);
  const sgf = g.toSGF({ playerBlack: 'Ann', playerWhite: 'Bo]b', result: 'W+R', date: '2026-10-27', app: 'GoWatch' });
  assert.match(sgf, /^\(;FF\[4\]GM\[1\]/);
  assert.match(sgf, /SZ\[19\]/);
  assert.match(sgf, /KM\[6\.5\]/);
  assert.match(sgf, /PB\[Ann\]/);
  assert.match(sgf, /PW\[Bo\\\]b\]/);
  assert.match(sgf, /DT\[2026-10-27\]/);
  assert.match(sgf, /AP\[GoWatch\]/);
  assert.match(sgf, /RE\[W\+R\]/);
  assert.match(sgf, /;B\[dd\];W\[pp\];B\[\]/);
  assert.ok(sgf.trimEnd().endsWith(')'));
});

test('SGF with handicap root and setup node; JSON round trip', () => {
  const g = new Game({ size: 9 });
  g.setBoard(mk(9, ['.........', '.........', '..x...x..', ...Array(6).fill('.........')]));
  g.play(WHITE, 4, 4);
  g.setBoard((() => { const b = Int8Array.from(g.grid); b[0] = BLACK; b[4 * 9 + 4] = EMPTY; return b; })());
  const sgf = g.toSGF({ date: '2026-10-27' });
  assert.match(sgf, /HA\[2\]AB\[cc\]\[gc\]/);
  assert.match(sgf, /;W\[ee\]/);
  assert.match(sgf, /;AB\[aa\]AE\[ee\]/);
  const g2 = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual([...g2.grid], [...g.grid]);
  assert.equal(g2.toSGF({ date: '2026-10-27' }), sgf);
});

test('inferMove: single stone', () => {
  const prev = new Int8Array(81);
  const det = Int8Array.from(prev); det[4 * 9 + 3] = BLACK;
  const r = inferMove(prev, det, BLACK);
  assert.equal(r.type, 'move');
  assert.deepEqual([r.color, r.x, r.y, r.outOfTurn], [BLACK, 3, 4, false]);
});

test('inferMove: out of turn is flagged', () => {
  const prev = new Int8Array(81);
  const det = Int8Array.from(prev); det[0] = WHITE;
  const r = inferMove(prev, det, BLACK);
  assert.equal(r.type, 'move');
  assert.equal(r.color, WHITE);
  assert.equal(r.outOfTurn, true);
});

test('inferMove: stone with capture', () => {
  const prev = mk(5, ['xo...', '.....', '.....', '.....', '.....']);
  prev[1] = WHITE; // o at (1,0)
  const p = mk(5, ['.ox..', 'x....', '.....', '.....', '.....']);
  // White at (1,0) has neighbours (0,0) empty,(2,0)=x,(1,1) empty. Black plays (1,1)? -> not capture. Use corner instead:
  const corner = mk(5, ['o.', '..'].map((r) => r.padEnd(5, '.')).concat(Array(3).fill('.....')));
  corner[1] = BLACK; // x at (1,0)
  const det = Int8Array.from(corner); det[5] = BLACK; det[0] = EMPTY; // black (0,1) captures o (0,0)
  const r = inferMove(corner, det, BLACK);
  assert.equal(r.type, 'move');
  assert.deepEqual([r.x, r.y, r.color], [0, 1, BLACK]);
  assert.deepEqual(r.captured, [0]);
  assert.ok(prev && p);
});

test('inferMove: no change', () => {
  const b = mk(9, ['x........', ...Array(8).fill('.........')]);
  assert.equal(inferMove(b, Int8Array.from(b), WHITE).type, 'none');
});

test('inferMove: ambiguous cases', () => {
  const prev = new Int8Array(81);
  const two = Int8Array.from(prev); two[0] = BLACK; two[1] = WHITE;
  assert.equal(inferMove(prev, two, BLACK).type, 'ambiguous');
  const b = mk(9, ['x........', ...Array(8).fill('.........')]);
  const removed = new Int8Array(81); // stone vanished
  const r = inferMove(b, removed, WHITE);
  assert.equal(r.type, 'ambiguous');
  assert.equal(r.diffs.length, 1);
  const flipped = Int8Array.from(b); flipped[0] = WHITE;
  assert.equal(inferMove(b, flipped, BLACK).type, 'ambiguous');
});

test('inferMove: captured stones not yet removed -> ambiguous with pendingCaptures', () => {
  const prev = mk(5, ['ox...', '.....', '.....', '.....', '.....']);
  const det = Int8Array.from(prev); det[5] = BLACK; // black (0,1) would capture (0,0), but it's still there
  const r = inferMove(prev, det, BLACK);
  assert.equal(r.type, 'ambiguous');
  assert.equal(r.pendingCaptures, true);
});
