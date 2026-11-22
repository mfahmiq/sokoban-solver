// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
// Push-based A* over box configurations: a state is the boxes plus the
// player's reachable region, every push costs 1, and the estimate is the
// cheapest assignment of boxes to goals by shortest-path distance.
// Dead squares (cells a box can never leave toward a goal) and 2x2 blocks
// prune dead states. Levels here are a hallway with rooms off it, so the
// level is split into independent rooms, each solved push-optimally from
// its door and stitched together with hallway walks; a whole-level push
// A* is the fallback when the split does not apply. All budgets are
// counts of expansions, never the clock, so two runs are byte-identical.
// Node 22, standard library only, no network.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (also outside the rows)
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Breadth-first distances from `src` over floor cells (walls block).
// When `allowed` is given, only cells in it are traversed.
// Returns an Int32Array of length w*h with -1 for unreachable cells.
function bfsDist(
  w: number,
  h: number,
  wall: Uint8Array,
  src: number,
  allowed?: Set<number>,
): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const q: number[] = [src];
  dist[src] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const x = c % w;
    const y = (c / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || dist[n] >= 0) continue;
      if (allowed && !allowed.has(n)) continue;
      dist[n] = dist[c]! + 1;
      q.push(n);
    }
  }
  return dist;
}

// Reachable set from `src` avoiding walls and the given box cells.
// When `allowed` is given, only cells in it are traversed, so a room
// search never wanders into another room (whose boxes it does not know).
// Returns the parent array (parent[src] = src, -1 = unreached) so walk
// paths can be rebuilt, and the smallest reachable cell (the canonical
// representative of the player's region).
function bfsReach(
  w: number,
  h: number,
  wall: Uint8Array,
  boxSet: Set<number>,
  src: number,
  allowed?: Set<number>,
): { parent: Int32Array; minCell: number } {
  const parent = new Int32Array(w * h).fill(-1);
  const q: number[] = [src];
  parent[src] = src;
  let minCell = src;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    if (c < minCell) minCell = c;
    const x = c % w;
    const y = (c / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || boxSet.has(n) || parent[n] >= 0) continue;
      if (allowed && !allowed.has(n)) continue;
      parent[n] = c;
      q.push(n);
    }
  }
  return { parent, minCell };
}

// Walk string from `from` to `to` using a BFS parent array.
function walkPath(w: number, parent: Int32Array, from: number, to: number): string {
  const cells: number[] = [];
  for (let c = to; c !== from; c = parent[c]!) cells.push(c);
  cells.reverse();
  let out = '';
  let prev = from;
  for (const c of cells) {
    const d = c - prev;
    out += d === -w ? 'u' : d === w ? 'd' : d === -1 ? 'l' : 'r';
    prev = c;
  }
  return out;
}

// Dead squares: floor cells a box can never be pushed from toward a goal.
// Reverse pull-reachability from the goals: a cell u is live when some
// live cell v sits next to it and the cell behind u (away from v) is
// floor, because a push from u to v needs the player standing there.
function deadSquares(lv: Level, floor: Set<number>): Set<number> {
  const live = new Set<number>(lv.goals);
  const q: number[] = [...lv.goals];
  for (let qi = 0; qi < q.length; qi++) {
    const v = q[qi]!;
    const vx = v % lv.w;
    const vy = (v / lv.w) | 0;
    for (const [dx, dy] of DIRS) {
      const ux = vx - dx;
      const uy = vy - dy;
      if (ux < 0 || uy < 0 || ux >= lv.w || uy >= lv.h) continue;
      const u = uy * lv.w + ux;
      if (!floor.has(u) || live.has(u)) continue;
      const bx = ux - dx;
      const by = uy - dy;
      if (bx < 0 || by < 0 || bx >= lv.w || by >= lv.h) continue;
      const behind = by * lv.w + bx;
      if (lv.wall[behind] || !floor.has(behind)) continue;
      live.add(u);
      q.push(u);
    }
  }
  const dead = new Set<number>();
  for (const c of floor) if (!live.has(c)) dead.add(c);
  return dead;
}

// Cheapest assignment of boxes to goals by shortest-path distance.
// Brute force over permutations (rooms hold at most 4 boxes). Returns
// Infinity when some box cannot reach any goal.
function matchingCost(boxes: number[], goals: number[], goalDist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n !== goals.length) return Infinity;
  const perm = goals.map((_, i) => i);
  let best = Infinity;
  const rec = (k: number, cost: number): void => {
    if (cost >= best) return;
    if (k === n) {
      best = cost;
      return;
    }
    for (let i = k; i < n; i++) {
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      const d = goalDist[perm[k]!]![boxes[k]!];
      if (d >= 0) rec(k + 1, cost + d);
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
    }
  };
  rec(0, 0);
  return best;
}

// A 2x2 block of boxes/walls with no goal inside is a deadlock.
function has2x2Dead(
  lv: Level,
  boxes: Set<number>,
  at: number,
): boolean {
  const x = at % lv.w;
  const y = (at / lv.w) | 0;
  for (let ox = -1; ox <= 0; ox++) {
    for (let oy = -1; oy <= 0; oy++) {
      const x0 = x + ox;
      const y0 = y + oy;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= lv.w || y0 + 1 >= lv.h) continue;
      const cells = [
        y0 * lv.w + x0,
        y0 * lv.w + x0 + 1,
        (y0 + 1) * lv.w + x0,
        (y0 + 1) * lv.w + x0 + 1,
      ];
      let allBlocked = true;
      let anyGoal = false;
      for (const c of cells) {
        if (lv.goals.includes(c)) anyGoal = true;
        if (!lv.wall[c] && !boxes.has(c)) {
          allBlocked = false;
          break;
        }
      }
      if (allBlocked && !anyGoal) return true;
    }
  }
  return false;
}

interface PushProblem {
  lv: Level;
  floor: Set<number>;
  boxes: number[];
  goals: number[];
  startPlayer: number;
  // The door the player must be able to reach once every box is home
  // (so it can leave for the next room); -1 when no exit is needed.
  door: number;
  budget: number;
}

interface PushSolution {
  moves: string;
  finalPlayer: number;
}

// Push-based A*. Returns null when the budget runs out or no solution.
function solvePushes(prob: PushProblem): PushSolution | null {
  const { lv, floor } = prob;
  const goalSet = new Set(prob.goals);
  const goalDist = prob.goals.map((g) => bfsDist(lv.w, lv.h, lv.wall, g, floor));
  const dead = deadSquares(lv, floor);

  const sb: number[][] = [prob.boxes.slice()];
  const sp: number[] = [prob.startPlayer];
  const sg: number[] = [0];
  const parent: number[] = [-1];
  const seg: string[] = [''];
  const startBoxSet = new Set(prob.boxes);
  const startReach = bfsReach(lv.w, lv.h, lv.wall, startBoxSet, prob.startPlayer, floor);
  const keyOf = (boxes: number[], minCell: number): string =>
    boxes.join(',') + '|' + minCell;
  const best = new Map<string, number>([
    [keyOf(prob.boxes, startReach.minCell), 0],
  ]);

  // Heap entries: [f, g, state]. Ties: deeper g first, then older state.
  const heap: [number, number, number][] = [];
  const h0 = matchingCost(prob.boxes, prob.goals, goalDist);
  if (h0 === Infinity) return null;
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([h0, 0, 0]);

  let expanded = 0;
  while (heap.length > 0 && expanded < prob.budget) {
    const [, g, s] = heapPop();
    const boxes = sb[s]!;
    const boxSet = new Set(boxes);
    const reach = bfsReach(lv.w, lv.h, lv.wall, boxSet, sp[s]!, floor);
    if (best.get(keyOf(boxes, reach.minCell)) !== s) continue;
    // Goal: every box home, and the player able to reach the door.
    if (boxes.every((b) => goalSet.has(b))) {
      if (prob.door < 0 || reach.parent[prob.door]! >= 0) {
        let moves = '';
        for (let t = s; t > 0; t = parent[t]!) moves = seg[t] + moves;
        return { moves, finalPlayer: sp[s]! };
      }
    }
    expanded++;
    const p = sp[s]!;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      const bx = b % lv.w;
      const by = (b / lv.w) | 0;
      for (const [dx, dy, letter] of DIRS) {
        const behindX = bx - dx;
        const behindY = by - dy;
        const aheadX = bx + dx;
        const aheadY = by + dy;
        if (
          behindX < 0 || behindY < 0 || behindX >= lv.w || behindY >= lv.h ||
          aheadX < 0 || aheadY < 0 || aheadX >= lv.w || aheadY >= lv.h
        ) continue;
        const behind = behindY * lv.w + behindX;
        const ahead = aheadY * lv.w + aheadX;
        if (reach.parent[behind]! < 0) continue; // player cannot stand there
        if (lv.wall[ahead] || boxSet.has(ahead)) continue;
        const nb = boxes.slice();
        nb[bi] = ahead;
        nb.sort((a, b) => a - b);
        const nbSet = new Set(nb);
        // Deadlock: a box off its goal on a dead square, or a 2x2 block.
        let deadState = false;
        for (const c of nb) {
          if (!goalSet.has(c) && dead.has(c)) {
            deadState = true;
            break;
          }
        }
        if (!deadState && has2x2Dead(lv, nbSet, ahead)) deadState = true;
        if (deadState) continue;
        const h = matchingCost(nb, prob.goals, goalDist);
        if (h === Infinity) continue;
        const nReach = bfsReach(lv.w, lv.h, lv.wall, nbSet, b, floor);
        const k = keyOf(nb, nReach.minCell);
        const seen = best.get(k);
        if (seen !== undefined && sg[seen]! <= g + 1) continue;
        const t = sb.length;
        sb.push(nb);
        sp.push(b);
        sg.push(g + 1);
        parent.push(s);
        seg.push(walkPath(lv.w, reach.parent, p, behind) + letter);
        best.set(k, t);
        heapPush([g + 1 + h, g + 1, t]);
      }
    }
  }
  return null;
}

// Split a level into the hallway and the rooms off it. The hallway is
// the player's row (or column) when it runs most of the way across the
// board; rooms are the connected floor components off that line, each
// with exactly one door cell on the line. Returns null when the shape
// does not fit (a box or goal in the hallway, a room with no door).
interface Room {
  floor: Set<number>;
  boxes: number[];
  goals: number[];
  door: number;
}

function decompose(lv: Level): { rooms: Room[]; hallway: Set<number> } | null {
  const px = lv.player % lv.w;
  const py = (lv.player / lv.w) | 0;
  let horizontal = false;
  let lineCells: number[] = [];
  // The hallway runs across the board through the player's start.
  let rowCount = 0;
  for (let x = 0; x < lv.w; x++) if (!lv.wall[py * lv.w + x]) rowCount++;
  let colCount = 0;
  for (let y = 0; y < lv.h; y++) if (!lv.wall[y * lv.w + px]) colCount++;
  if (rowCount * 2 >= lv.w) {
    horizontal = true;
    for (let x = 0; x < lv.w; x++) {
      if (!lv.wall[py * lv.w + x]) lineCells.push(py * lv.w + x);
    }
  } else if (colCount * 2 >= lv.h) {
    horizontal = false;
    for (let y = 0; y < lv.h; y++) {
      if (!lv.wall[y * lv.w + px]) lineCells.push(y * lv.w + px);
    }
  } else {
    return null;
  }
  const hallway = new Set(lineCells);
  // No box or goal may sit in the hallway itself.
  for (const b of lv.boxes) if (hallway.has(b)) return null;
  for (const g of lv.goals) if (hallway.has(g)) return null;
  // Connected components of the floor off the hallway line.
  const seen = new Set<number>();
  const rooms: Room[] = [];
  const allFloor: number[] = [];
  for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) allFloor.push(i);
  for (const start of allFloor) {
    if (hallway.has(start) || seen.has(start)) continue;
    const comp: number[] = [];
    const q: number[] = [start];
    seen.add(start);
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      comp.push(c);
      const x = c % lv.w;
      const y = (c / lv.w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
        const n = ny * lv.w + nx;
        if (lv.wall[n] || hallway.has(n) || seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    // The door: hallway cells touching this component.
    const doors = new Set<number>();
    for (const c of comp) {
      const x = c % lv.w;
      const y = (c / lv.w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
        const n = ny * lv.w + nx;
        if (hallway.has(n)) doors.add(n);
      }
    }
    if (doors.size === 0) return null;
    const door = [...doors].sort((a, b) => a - b)[0]!;
    const floor = new Set(comp);
    floor.add(door);
    const boxes = lv.boxes.filter((b) => floor.has(b));
    const goals = lv.goals.filter((g) => floor.has(g));
    rooms.push({ floor, boxes, goals, door });
  }
  // Every box and goal must belong to exactly one room.
  const covered = new Set<number>();
  for (const r of rooms) {
    for (const b of r.boxes) covered.add(b);
    for (const g of r.goals) covered.add(g);
  }
  for (const b of lv.boxes) if (!covered.has(b)) return null;
  for (const g of lv.goals) if (!covered.has(g)) return null;
  // Visit rooms in door order along the hallway.
  rooms.sort((a, b) => (horizontal ? a.door - b.door : a.door - b.door));
  return { rooms, hallway };
}

const ROOM_BUDGET = 300_000;
const GLOBAL_BUDGET = 1_500_000;

function solve(text: string): string {
  const lv = parseLevel(text);
  const dec = decompose(lv);
  if (dec) {
    const { rooms, hallway } = dec;
    let moves = '';
    let player = lv.player;
    let ok = true;
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const last = ri === rooms.length - 1;
      // Walk the hallway to this room's door.
      const walk = hallwayWalk(lv, hallway, player, room.door);
      if (walk === null) {
        ok = false;
        break;
      }
      moves += walk;
      player = room.door;
      const sol = solvePushes({
        lv,
        floor: room.floor,
        boxes: room.boxes,
        goals: room.goals,
        startPlayer: room.door,
        door: last ? -1 : room.door,
        budget: ROOM_BUDGET,
      });
      if (!sol) {
        ok = false;
        break;
      }
      moves += sol.moves;
      player = sol.finalPlayer;
      if (!last) {
        // Walk back out to the door (the goal test made sure it is reachable).
        const outReach = bfsReach(
          lv.w,
          lv.h,
          lv.wall,
          new Set(solBoxes(room, sol, lv)),
          player,
          room.floor,
        );
        const out = walkPath(lv.w, outReach.parent, player, room.door);
        moves += out;
        player = room.door;
      }
    }
    if (ok) return moves;
  }
  // Fallback: one push A* over the whole level.
  const allFloor = new Set<number>();
  for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) allFloor.add(i);
  const sol = solvePushes({
    lv,
    floor: allFloor,
    boxes: lv.boxes,
    goals: lv.goals,
    startPlayer: lv.player,
    door: -1,
    budget: GLOBAL_BUDGET,
  });
  return sol ? sol.moves : '';
}

// The boxes' final cells after a room solution, for the exit walk.
// Recomputed by replaying the room's moves on its starting boxes.
function solBoxes(room: Room, sol: PushSolution, lv: Level): number[] {
  const boxes = new Set(room.boxes);
  let player = room.door;
  for (const ch of sol.moves) {
    const [dx, dy] = DIRS.find(([, , l]) => l === ch)!;
    const d = dy! * lv.w + dx!;
    const next = player + d;
    if (boxes.has(next)) {
      boxes.delete(next);
      boxes.add(next + d);
    }
    player = next;
  }
  return [...boxes];
}

// Walk along the hallway line from `from` to `to` (both on the line).
// The hallway is a straight run, so the path is just the cells between.
function hallwayWalk(
  lv: Level,
  hallway: Set<number>,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  // BFS restricted to hallway cells.
  const parent = new Int32Array(lv.w * lv.h).fill(-1);
  const q: number[] = [from];
  parent[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    if (c === to) break;
    const x = c % lv.w;
    const y = (c / lv.w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
      const n = ny * lv.w + nx;
      if (!hallway.has(n) || parent[n] >= 0) continue;
      parent[n] = c;
      q.push(n);
    }
  }
  if (parent[to]! < 0) return null;
  return walkPath(lv.w, parent, from, to);
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
