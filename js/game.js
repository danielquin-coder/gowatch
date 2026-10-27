/**
 * game.js - pure Go logic (no DOM, no browser APIs).
 *
 * Coordinates: x = column (0 = left), y = row (0 = top). A board is a flat
 * Int8Array of size*size with 0 = empty, 1 = black, 2 = white (index = y*size+x).
 *
 *  - placeStone(): capture removal (flood-fill liberties) and suicide rejection
 *  - Game: move/setup node history with undo, simple-ko check, JSON persistence, SGF export
 *  - inferMove(): turn "previous known board" + "freshly detected board" into a move
 */

export const EMPTY = 0, BLACK = 1, WHITE = 2;
export const other = (c) => 3 - c;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** SGF point, e.g. (3,3) -> "dd". */
export const sgfCoord = (x, y) => LETTERS[x] + LETTERS[y];

/** Indices of orthogonal neighbours of point index i. */
export function neighborIdx(size, i) {
  const x = i % size, y = (i / size) | 0, out = [];
  if (x > 0) out.push(i - 1);
  if (x < size - 1) out.push(i + 1);
  if (y > 0) out.push(i - size);
  if (y < size - 1) out.push(i + size);
  return out;
}

/** Flood-fill the group containing index i. Returns { stones: number[], liberties: Set<number> }. */
export function groupAt(grid, size, i) {
  const color = grid[i], stones = [], libs = new Set(), seen = new Uint8Array(grid.length);
  const stack = [i];
  seen[i] = 1;
  while (stack.length) {
    const c = stack.pop();
    stones.push(c);
    for (const n of neighborIdx(size, c)) {
      if (grid[n] === EMPTY) libs.add(n);
      else if (grid[n] === color && !seen[n]) { seen[n] = 1; stack.push(n); }
    }
  }
  return { stones, liberties: libs };
}

/**
 * Place a stone on a copy of `grid`. Opponent groups left without liberties are
 * removed; a move that leaves its own group without liberties is rejected.
 * @returns {{ok:true, grid:Int8Array, captured:number[]} | {ok:false, reason:string}}
 */
export function placeStone(grid, size, color, x, y) {
  if (x < 0 || y < 0 || x >= size || y >= size) return { ok: false, reason: 'range' };
  const i = y * size + x;
  if (grid[i] !== EMPTY) return { ok: false, reason: 'occupied' };
  const g = Int8Array.from(grid);
  g[i] = color;
  const captured = [];
  for (const n of neighborIdx(size, i)) {
    if (g[n] === other(color)) {
      const grp = groupAt(g, size, n);
      if (grp.liberties.size === 0) for (const s of grp.stones) { g[s] = EMPTY; captured.push(s); }
    }
  }
  if (groupAt(g, size, i).liberties.size === 0) return { ok: false, reason: 'suicide' };
  return { ok: true, grid: g, captured };
}

const sameGrid = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/]/g, '\\]');

export class Game {
  constructor({ size = 19, komi = 6.5 } = {}) {
    this.size = size;
    this.komi = komi;
    this.root = { AB: [], AW: [] };            // setup stones in the root node (handicap / pre-placed)
    this.nodes = [];                           // {type:'move',color,x,y,captured} | {type:'pass',color} | {type:'setup',AB,AW,AE}
    this.states = [new Int8Array(size * size)]; // states[k] = board after k nodes
  }

  get grid() { return this.states[this.states.length - 1]; }
  get moveCount() { return this.nodes.filter((n) => n.type !== 'setup').length; }
  get lastMove() { for (let i = this.nodes.length - 1; i >= 0; i--) if (this.nodes[i].type !== 'setup') return this.nodes[i]; return null; }

  /** Colour expected next: opposite of last mover; White first if the root has handicap stones. */
  get toPlay() {
    const last = this.lastMove;
    if (last) return other(last.color);
    return this.root.AB.length >= 2 && this.root.AW.length === 0 ? WHITE : BLACK;
  }

  /** Play a move. Rejects occupied, suicide and simple ko (recreating the position before the last move). */
  play(color, x, y) {
    const r = placeStone(this.grid, this.size, color, x, y);
    if (!r.ok) return r;
    const prev = this.states[this.states.length - 2];
    if (prev && this.nodes.length && this.nodes[this.nodes.length - 1].type === 'move' && sameGrid(prev, r.grid)) {
      return { ok: false, reason: 'ko' };
    }
    this.nodes.push({ type: 'move', color, x, y, captured: r.captured });
    this.states.push(r.grid);
    return { ok: true, captured: r.captured, grid: r.grid };
  }

  pass(color) {
    this.nodes.push({ type: 'pass', color });
    this.states.push(Int8Array.from(this.grid));
    return { ok: true };
  }

  /**
   * Force the board to `grid`. Before any node this becomes the root setup (handicap);
   * afterwards it is recorded as a setup node (AB/AW/AE) in the SGF.
   */
  setBoard(grid) {
    const g = Int8Array.from(grid), n = this.size;
    if (this.nodes.length === 0) {
      this.root = { AB: [], AW: [] };
      for (let i = 0; i < g.length; i++) {
        if (g[i] === BLACK) this.root.AB.push(i);
        else if (g[i] === WHITE) this.root.AW.push(i);
      }
      this.states = [g];
      return 'root';
    }
    const node = { type: 'setup', AB: [], AW: [], AE: [] };
    const cur = this.grid;
    for (let i = 0; i < n * n; i++) {
      if (cur[i] === g[i]) continue;
      if (g[i] === BLACK) node.AB.push(i);
      else if (g[i] === WHITE) node.AW.push(i);
      else node.AE.push(i);
    }
    if (node.AB.length + node.AW.length + node.AE.length === 0) return 'none';
    this.nodes.push(node);
    this.states.push(g);
    return 'setup';
  }

  /** Remove the last node. Returns it, or null if there is nothing to undo. */
  undo() {
    if (!this.nodes.length) return null;
    this.states.pop();
    return this.nodes.pop();
  }

  toJSON() { return { size: this.size, komi: this.komi, root: this.root, nodes: this.nodes }; }

  static fromJSON(o) {
    const g = new Game({ size: o.size, komi: o.komi });
    const rootGrid = new Int8Array(o.size * o.size);
    for (const i of o.root?.AB || []) rootGrid[i] = BLACK;
    for (const i of o.root?.AW || []) rootGrid[i] = WHITE;
    g.root = { AB: [...(o.root?.AB || [])], AW: [...(o.root?.AW || [])] };
    g.states = [rootGrid];
    for (const n of o.nodes || []) {
      const cur = g.grid;
      if (n.type === 'move') {
        const r = placeStone(cur, g.size, n.color, n.x, n.y);
        g.nodes.push(n);
        g.states.push(r.ok ? r.grid : Int8Array.from(cur));
      } else if (n.type === 'pass') {
        g.nodes.push(n); g.states.push(Int8Array.from(cur));
      } else {
        const ng = Int8Array.from(cur);
        for (const i of n.AB) ng[i] = BLACK;
        for (const i of n.AW) ng[i] = WHITE;
        for (const i of n.AE) ng[i] = EMPTY;
        g.nodes.push(n); g.states.push(ng);
      }
    }
    return g;
  }

  /**
   * Serialise to SGF (FF[4]).
   * @param {{komi?:number, playerBlack?:string, playerWhite?:string, result?:string, date?:Date|string, app?:string}} o
   */
  toSGF(o = {}) {
    const n = this.size, pt = (i) => `[${sgfCoord(i % n, (i / n) | 0)}]`;
    const d = o.date instanceof Date ? o.date : o.date ? new Date(o.date) : new Date();
    const ds = typeof o.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(o.date) ? o.date
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let head = `(;FF[4]GM[1]CA[UTF-8]AP[${esc(o.app || 'GoWatch')}]SZ[${n}]KM[${o.komi ?? this.komi}]`;
    head += `PB[${esc(o.playerBlack || 'Black')}]PW[${esc(o.playerWhite || 'White')}]DT[${ds}]`;
    if (o.result) head += `RE[${esc(o.result)}]`;
    if (this.root.AB.length >= 2 && !this.root.AW.length) head += `HA[${this.root.AB.length}]`;
    if (this.root.AB.length) head += 'AB' + this.root.AB.map(pt).join('');
    if (this.root.AW.length) head += 'AW' + this.root.AW.map(pt).join('');
    const parts = this.nodes.map((nd) => {
      if (nd.type === 'move') return `;${nd.color === BLACK ? 'B' : 'W'}[${sgfCoord(nd.x, nd.y)}]`;
      if (nd.type === 'pass') return `;${nd.color === BLACK ? 'B' : 'W'}[]`;
      return ';' + (nd.AB.length ? 'AB' + nd.AB.map(pt).join('') : '') + (nd.AW.length ? 'AW' + nd.AW.map(pt).join('') : '')
        + (nd.AE.length ? 'AE' + nd.AE.map(pt).join('') : '');
    });
    let body = '';
    parts.forEach((p, i) => { body += p + (i % 10 === 9 ? '\n' : ''); });
    return head + '\n' + body + ')\n';
  }
}

/**
 * Decide what happened between the last known board and a freshly detected one.
 *  - {type:'none'}       identical
 *  - {type:'move', color, x, y, captured, outOfTurn, recolored}
 *       exactly one new stone, and every other difference equals the captures that
 *       stone makes. If the detected colour doesn't fit the captures but the other
 *       colour does, the other colour is used (recolored:true). Otherwise the
 *       detected colour wins; `outOfTurn` is set when it isn't `expectedColor`.
 *  - {type:'ambiguous', diffs, pendingCaptures}  anything else
 *       (pendingCaptures: one new stone that would capture, but the captured stones are still on the board)
 */
export function inferMove(prev, det, expectedColor = BLACK) {
  const size = Math.round(Math.sqrt(prev.length));
  const diffs = [];
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== det[i]) diffs.push({ i, x: i % size, y: (i / size) | 0, from: prev[i], to: det[i] });
  }
  if (!diffs.length) return { type: 'none' };
  const added = diffs.filter((d) => d.from === EMPTY && d.to !== EMPTY);
  const flips = diffs.filter((d) => d.from !== EMPTY && d.to !== EMPTY);
  if (added.length === 1 && flips.length === 0) {
    const a = added[0];
    for (const [k, color] of [a.to, other(a.to)].entries()) {
      const r = placeStone(prev, size, color, a.x, a.y);
      if (!r.ok || (k === 1 && !r.captured.length)) continue; // recolor only if captures explain it
      let same = true;
      for (let i = 0; i < prev.length; i++) if (i !== a.i && r.grid[i] !== det[i]) { same = false; break; }
      if (same) {
        return {
          type: 'move', color, x: a.x, y: a.y, captured: r.captured, diffs,
          outOfTurn: color !== expectedColor, recolored: k === 1,
        };
      }
    }
    const r = placeStone(prev, size, a.to, a.x, a.y);
    return { type: 'ambiguous', diffs, pendingCaptures: !!(r.ok && r.captured.length && diffs.length === 1) };
  }
  return { type: 'ambiguous', diffs, pendingCaptures: false };
}
