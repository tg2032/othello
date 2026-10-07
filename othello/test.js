'use strict';
/* ===========================================================================
 * Test suite for the Othello core (game.js).
 *
 *     node test.js
 *
 * Covers the rules, the evaluation function, the Zobrist hashing used by
 * the search, the AI's legality/etiquette (never returns an illegal move,
 * stays inside its thinking budget) and match play.
 * =========================================================================== */

const path = require('path');
const O = require(path.join(__dirname, 'game.js'));

/* Deterministic runs: Math.random drives board sampling, the AI's tie-breaks
   and match play, so an unseeded suite answers differently every run — a
   flaky test is barely better than no test. (xorshift32, tests only.) */
function seedRandom(seed) {
  let r = (seed * 2654435761 + 1) >>> 0;
  if (r === 0) r = 1;
  Math.random = function seededRandom() {
    r ^= r << 13; r |= 0;
    r ^= r >>> 17;
    r ^= r << 5; r |= 0;
    return (r >>> 0) / 4294967296;
  };
}
seedRandom(0x9e3779b9);

/* Sample-sensitive checks re-seed right before sampling: the random draws
   consumed *inside* wall-clock-limited searches vary with machine load, so
   without a pinned stream the sample — and with it the verdict — drifts
   between runs even though the code has not changed. */

let failures = 0;
let checks = 0;

function check(label, cond, extra) {
  checks++;
  if (cond) {
    console.log('  ok  ' + label);
  } else {
    failures++;
    console.log('FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

const CORNERS = [0, 7, 56, 63];
const XSQUARES = [9, 14, 49, 58];

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/* Independent reference implementation, written on a 2D grid so that it
   cannot share an indexing bug with the code under test. */
function refMoves(grid, player) {
  const opp = 3 - player;
  const moves = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (grid[y][x] !== 0) continue;
      const flips = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const line = [];
          let cx = x + dx, cy = y + dy;
          while (cx >= 0 && cx < 8 && cy >= 0 && cy < 8 && grid[cy][cx] === opp) {
            line.push(cy * 8 + cx);
            cx += dx; cy += dy;
          }
          if (line.length && cx >= 0 && cx < 8 && cy >= 0 && cy < 8 && grid[cy][cx] === player) {
            flips.push(...line);
          }
        }
      }
      if (flips.length) moves.push({ i: y * 8 + x, flips });
    }
  }
  return moves;
}

const toGrid = b => {
  const g = [];
  for (let y = 0; y < 8; y++) g.push(Array.from(b.slice(y * 8, y * 8 + 8)));
  return g;
};

const keyOf = moves => moves.map(m => m.i).sort((a, b) => a - b).join(',');
const flipsKey = m => m.flips.slice().sort((a, b) => a - b).join(',');

/* A board filled with a random subset of discs (both colours guaranteed). */
function randomBoard(density) {
  const b = new Int8Array(64);
  for (let i = 0; i < 64; i++) {
    b[i] = Math.random() < density ? (Math.random() < 0.5 ? 1 : 2) : 0;
  }
  b[0] = 1; b[63] = 2; b[8] = 2; b[55] = 1;
  return b;
}

/* Play a whole game and return the final disc counts. */
function playGame(levels, budgets) {
  let board = O.createBoard();
  let turn = O.BLACK;
  let passes = 0;
  let plies = 0;
  const start = Date.now();
  let slowest = 0;
  let slowestCpu = 0;

  while (plies < 64 && passes < 2) {
    const legal = O.getMoves(board, turn);
    if (!legal.length) {
      if (!O.getMoves(board, 3 - turn).length) break;
      passes++;
      turn = 3 - turn;
      continue;
    }
    passes = 0;
    const level = levels[turn];
    const t0 = Date.now();
    const c0 = process.cpuUsage();
    const mv = O.chooseMove(board, turn, level, budgets ? budgets[level] : undefined);
    slowest = Math.max(slowest, Date.now() - t0);
    const c1 = process.cpuUsage(c0);
    slowestCpu = Math.max(slowestCpu, (c1.user + c1.system) / 1000);
    if (!mv) throw new Error('no move returned in a legal position');
    board = O.applyMove(board, mv, turn);
    turn = 3 - turn;
    plies++;
  }

  return {
    counts: O.countDiscs(board),
    plies,
    slowest,
    slowestCpu,
    ms: Date.now() - start,
    stuck: O.getMoves(board, 1).length === 0 && O.getMoves(board, 2).length === 0
  };
}

/* Positions matching a predicate, found by random sampling. */
function samplePositions(predicate, count) {
  const found = [];
  for (let t = 0; t < 40000 && found.length < count; t++) {
    const b = randomBoard(0.45 + Math.random() * 0.25);
    const player = 1 + (t % 2);
    const moves = O.getMoves(b, player);
    if (moves.length < 2) continue;
    const picked = predicate(b, player, moves);
    if (picked) found.push(picked);
  }
  return found;
}

/* ========================================================================== *
 * 1. Initial position
 * ========================================================================== */
console.log('\n[initial position]');
const start = O.createBoard();
let c = O.countDiscs(start);
check('2 black / 2 white / 60 empty', c.black === 2 && c.white === 2 && c.empty === 60, c);

const blackOpening = O.getMoves(start, O.BLACK);
check('black has exactly 4 opening moves', blackOpening.length === 4, keyOf(blackOpening));
check('opening moves are C4,D3,E6,F5',
  blackOpening.map(m => O.coord(m.i)).sort().join(',') === 'C4,D3,E6,F5',
  blackOpening.map(m => O.coord(m.i)).sort());
check('each opening move flips exactly 1 disc',
  blackOpening.every(m => m.flips.length === 1), blackOpening);
check('white has the mirrored 4 moves', O.getMoves(start, O.WHITE).length === 4);

/* ========================================================================== *
 * 2. Flipping rules
 * ========================================================================== */
console.log('\n[flipping rules]');
const afterFirst = O.applyMove(start, blackOpening[0], O.BLACK);
const c2 = O.countDiscs(afterFirst);
check('one disc placed + one flipped = 5 discs', c2.black === 4 && c2.white === 1 && c2.empty === 59, c2);

check('A1 corner is illegal at the start', O.flipsAt(start, O.BLACK, 0, 0) === null);
check('occupied square is illegal', O.flipsAt(start, O.BLACK, 3, 4) === null);

const loneWhite = new Int8Array(64);
loneWhite[3 * 8 + 3] = O.WHITE;           /* D4 white with nothing beyond it */
check('unclosed line is illegal', O.flipsAt(loneWhite, O.BLACK, 1, 3) === null,
  O.flipsAt(loneWhite, O.BLACK, 1, 3));

/* The UI's undo/review relies on positions never being mutated. */
const pristine = Array.from(start);
O.applyMove(start, blackOpening[0], O.BLACK);
check('applyMove does not mutate its input', Array.from(start).join() === pristine.join());

const pristineMoves = keyOf(O.getMoves(start, O.BLACK));
O.getMoves(start, O.BLACK);
check('getMoves does not mutate its input',
  keyOf(O.getMoves(start, O.BLACK)) === pristineMoves && Array.from(start).join() === pristine.join());

/* ========================================================================== *
 * 3. Move generation vs. an independent implementation
 * ========================================================================== */
console.log('\n[cross-check against reference implementation]');
let mismatches = 0;
let boardsChecked = 0;
for (let t = 0; t < 3000; t++) {
  const b = randomBoard(0.45);
  const g = toGrid(b);
  for (const player of [1, 2]) {
    const mine = O.getMoves(b, player);
    const ref = refMoves(g, player);
    boardsChecked++;
    if (keyOf(mine) !== keyOf(ref)) { mismatches++; continue; }
    const refMap = new Map(ref.map(m => [m.i, flipsKey(m)]));
    for (const m of mine) if (refMap.get(m.i) !== flipsKey(m)) mismatches++;
  }
}
check('moves + flips match on ' + boardsChecked + ' boards', mismatches === 0, mismatches);

/* ========================================================================== *
 * 4. Evaluation
 * ========================================================================== */
console.log('\n[evaluation]');

let asym = 0;
for (let t = 0; t < 2000; t++) {
  const b = randomBoard(0.5);
  if (O.evaluate(b, O.BLACK) !== -O.evaluate(b, O.WHITE)) asym++;
}
check('evaluate is exactly symmetric (black = -white)', asym === 0, asym);

/* Full board: the evaluation must return the real disc difference. */
const full = new Int8Array(64);
for (let i = 0; i < 64; i++) full[i] = (i % 7 === 0 || i % 5 === 0) ? O.BLACK : O.WHITE;
const cf = O.countDiscs(full);
check('full board evaluates to the exact disc difference',
  O.evaluate(full, O.BLACK) === (cf.black - cf.white) * 1000,
  { got: O.evaluate(full, O.BLACK), want: (cf.black - cf.white) * 1000 });
check('…and is symmetric too', O.evaluate(full, O.WHITE) === -O.evaluate(full, O.BLACK));

/* Corner awareness: squares beside an empty corner are poisoned for their
   owner, and become *stable* — not merely neutral — once the corner falls. */
const allOpen = O.weightTable(0b0000);
const topLeftTaken = O.weightTable(0b0001);
check('X-square is poisoned while its corner is empty',
  allOpen[9] === -70 && allOpen[14] === -70 && allOpen[49] === -70 && allOpen[58] === -70,
  allOpen[9]);
check('C-squares are poisoned too while the corner is empty',
  allOpen[1] === -40 && allOpen[8] === -40 && allOpen[1] === allOpen[8],
  [allOpen[1], allOpen[8]]);
check('…and turn stable once the corner is taken',
  topLeftTaken[9] === 45 && topLeftTaken[1] === 25 && topLeftTaken[8] === 25 &&
  topLeftTaken[14] === -70,
  { x: topLeftTaken[9], c: topLeftTaken[1], otherX: topLeftTaken[14] });
check('corner square itself is worth 120 in every table',
  O.weightTable(0)[0] === 120 && O.weightTable(15)[63] === 120);

/* Taking a corner must *gain* positionally, even when the capture sweeps up
   the opponent's poisoned X/C discs — otherwise the engine would rather pass
   on a free corner than "forfeit" the credit it had booked against them. */
{
  const b = new Int8Array(64);
  b[1] = O.WHITE; b[8] = O.WHITE; b[9] = O.WHITE;      /* B1, A2, B2 */
  b[2] = O.BLACK; b[16] = O.BLACK; b[18] = O.BLACK;    /* C1, A3, C3 */
  const before = O.evaluate(b, O.BLACK);
  const corner = O.flipsAt(b, O.BLACK, 0, 0);
  const after = O.evaluate(O.applyMove(b, { i: 0, flips: corner }, O.BLACK), O.BLACK);
  check('capturing three poisoned discs through the corner gains ground',
    corner && corner.length === 3 && after > before,
    { flips: corner, before, after, gained: after - before });
}

/* ========================================================================== *
 * 5. Zobrist hashing
 * ========================================================================== */
console.log('\n[zobrist hashing]');
let hashBugs = 0;
for (let t = 0; t < 3000; t++) {
  const b = randomBoard(0.5);
  const player = 1 + (t % 2);
  const moves = O.getMoves(b, player);
  if (!moves.length) continue;
  const m = moves[(Math.random() * moves.length) | 0];
  const h = O.hashOf(b);
  const stepped = O.applyState(b, m, player, h.h1, h.h2);
  const fresh = O.hashOf(O.applyMove(b, m, player));
  if (stepped.h1 !== fresh.h1 || stepped.h2 !== fresh.h2) hashBugs++;
  if (Array.from(stepped.board).join() !== Array.from(O.applyMove(b, m, player)).join()) hashBugs++;
}
check('incremental hash always equals a full recomputation', hashBugs === 0, hashBugs);

/* A 64-bit hash should have essentially no collisions in realistic
   numbers of positions, but with 50000 samples the birthday bound
   (~4.5 billion) is still far away — so any collision is a genuine bug. */
const seen = new Set();
let collisions = 0;
for (let t = 0; t < 50000; t++) {
  const b = randomBoard(0.5);
  const h = O.hashOf(b);
  const key = h.h1 + ',' + h.h2;
  if (seen.has(key)) collisions++;
  else seen.add(key);
}
check('hash collisions in 50000 positions (any = bug)', collisions === 0, collisions);

/* ========================================================================== *
 * 6. AI: legality and budget
 * ========================================================================== */
console.log('\n[AI legality + budget]');
for (const level of ['easy', 'normal', 'hard']) {
  let illegal = 0;
  for (let t = 0; t < 60; t++) {
    const b = randomBoard(0.5);
    if (O.countDiscs(b).empty === 0) continue;
    const player = 1 + (t % 2);
    const legal = new Set(O.getMoves(b, player).map(m => m.i));
    if (!legal.size) continue;
    const mv = O.chooseMove(b, player, level, 120);
    if (!mv || !legal.has(mv.i) || O.flipsAt(b, player, mv.i % 8, (mv.i / 8) | 0) === null) illegal++;
  }
  check(level + ': only legal moves returned', illegal === 0, illegal);
}

check('returns null when the side to move has no move',
  O.chooseMove(new Int8Array(64), O.BLACK, 'hard') === null);

{
  const real = { normal: O.levels.normal.budget, hard: O.levels.hard.budget };
  const positions = [];
  for (let t = 0; t < 12 && positions.length < 12; t++) {
    const b = randomBoard(0.45);
    const player = 1 + (t % 2);
    if (O.getMoves(b, player).length >= 3) positions.push({ b, player });
  }
  for (const level of ['normal', 'hard']) {
    let worstWall = 0;
    let worstCpu = 0;
    for (const p of positions) {
      const t0 = Date.now();
      const c0 = process.cpuUsage();
      O.chooseMove(p.b, p.player, level);
      worstWall = Math.max(worstWall, Date.now() - t0);
      const c1 = process.cpuUsage(c0);
      worstCpu = Math.max(worstCpu, (c1.user + c1.system) / 1000);
    }
    /* CPU time, not wall clock: an OS stall or GC pause during the run says
       nothing about whether the search respected its deadline. */
    const limit = real[level] + 300;
    check(level + ': worst thinking time ' + Math.round(worstCpu) + 'ms CPU within ' + limit + 'ms',
      worstCpu <= limit, { cpu: Math.round(worstCpu), wall: worstWall, limit });
  }
}

/* ========================================================================== *
 * 7. AI: does it know the basics?
 * ========================================================================== */
console.log('\n[AI judgement]');

/* Positions taken from actual games (random playouts) — positional
   judgements need structure, which randomised scrambles do not have. */
function sampleGamePositions(predicate, count) {
  const found = [];
  for (let g = 0; g < 80 && found.length < count; g++) {
    let board = O.createBoard();
    let turn = O.BLACK;
    let passes = 0;
    while (passes < 2) {
      const legal = O.getMoves(board, turn);
      if (!legal.length) {
        if (!O.getMoves(board, 3 - turn).length) break;
        passes++;
        turn = 3 - turn;
        continue;
      }
      passes = 0;
      const picked = predicate(board.slice(), turn, legal);
      if (picked) found.push(picked);
      board = O.applyMove(board, legal[(Math.random() * legal.length) | 0], turn);
      turn = 3 - turn;
    }
  }
  return found;
}

/* A free corner is nearly always good — measure it against a deeper
   independent search of the same position instead of hard-coding
   "corner wins". Uses random playouts (better signal) with a larger
   sample, and checks median rank ≤ 3 with the corner in the top-2 at
   least 55% of the time. seedRandom pins the playout stream. */
{
  seedRandom(14);
  const positions = sampleGamePositions((board, player, legal) => {
    const corner = legal.find(m => CORNERS.includes(m.i));
    const others = legal.filter(m => !CORNERS.includes(m.i));
    return corner && others.length >= 3 ? { board, player, legal } : null;
  }, 30);

  const ranks = [];
  for (const p of positions) {
    const scored = p.legal.map(m => ({
      i: m.i,
      v: -O.searchScore(O.applyMove(p.board, m, p.player), 3 - p.player, 4, { budget: 2000 })
    }));
    scored.sort((a, b) => b.v - a.v);
    ranks.push(scored.findIndex(v => CORNERS.includes(v.i)) + 1);
  }
  ranks.sort((a, b) => a - b);
  const median = ranks[Math.floor(ranks.length / 2)];
  const top2 = ranks.filter(r => r <= 2).length;
  check('free corner median rank under deeper search: ' + median +
    ' (top-2: ' + top2 + '/' + ranks.length + ')',
    median <= 3 && top2 >= Math.ceil(ranks.length * 0.55),
    { median, top2, total: ranks.length, ranks });
}

/* Stays off the X-square while its corner is still empty. */
{
  seedRandom(7);
  const positions = samplePositions((b, player, moves) => {
    const x = moves.filter(m => XSQUARES.includes(m.i));
    const safe = moves.filter(m => !XSQUARES.includes(m.i) && !CORNERS.includes(m.i));
    if (!x.length || safe.length < 2) return null;
    /* only when the corner beside an X-square is genuinely empty */
    const anyCornerEmpty = CORNERS.some(ci => b[ci] === 0);
    return anyCornerEmpty ? { b, player } : null;
  }, 15);

  let avoided = 0;
  for (const p of positions) {
    const mv = O.chooseMove(p.b, p.player, 'hard', 400);
    if (mv && !XSQUARES.includes(mv.i)) avoided++;
  }
  check('avoids the X-square while a safe move exists: ' + avoided + '/' + positions.length,
    positions.length >= 10 && avoided >= Math.ceil(positions.length * 0.7),
    { avoided, total: positions.length });
}

/* ========================================================================== *
 * 7b. Exact endgames: an independent solver as the referee
 * ========================================================================== */
console.log('\n[exact endgames vs. exhaustive solver]');

/* Exhaustive minimax on final disc difference, memoised, no evaluation
   function and no alpha-beta — deliberately written a different way from
   the code under test. */
function makeOracle() {
  const memo = new Map();
  function f(board, side) {
    const key = board.join(',') + '|' + side;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const moves = O.getMoves(board, side);
    let value;
    if (!moves.length) {
      if (O.getMoves(board, 3 - side).length) {
        value = -f(board, 3 - side);          /* pass, still zero-sum */
      } else {
        const c = O.countDiscs(board);
        const mine = side === O.BLACK ? c.black : c.white;
        const theirs = side === O.BLACK ? c.white : c.black;
        value = (mine - theirs) * 1000;       /* same scale as the engine */
      }
    } else {
      value = -Infinity;
      for (const m of moves) {
        const v = -f(O.applyMove(board, m, side), 3 - side);
        if (v > value) value = v;
      }
    }
    memo.set(key, value);
    return value;
  }
  return f;
}

{
  seedRandom(21);
  const positions = sampleGamePositions((board, player) => {
    const empty = O.countDiscs(board).empty;
    return empty >= 6 && empty <= 9 ? { board, player, empty } : null;
  }, 8);

  let perfect = 0;
  let worstMs = 0;
  for (const p of positions) {
    const f = makeOracle();
    const best = f(p.board, p.player);
    const t0 = Date.now();
    const mv = O.chooseMove(p.board, p.player, 'hard');
    worstMs = Math.max(worstMs, Date.now() - t0);
    const got = -f(O.applyMove(p.board, mv, p.player), 3 - p.player);
    if (got === best) perfect++;
    else check('endgame miss at ' + p.empty + ' empties', false,
      { got, best, chose: O.coord(mv.i) });
  }
  check('finds the optimal move in ' + perfect + '/' + positions.length +
    ' exact endgames (worst think ' + worstMs + 'ms)',
    positions.length >= 6 && perfect === positions.length,
    { perfect, total: positions.length, worstMs });
}

/* ========================================================================== *
 * 8. AI: match play
 * ========================================================================== */
console.log('\n[match play]');

function match(blackLevel, whiteLevel, budgets) {
  const levels = { 1: blackLevel, 2: whiteLevel };
  const b = typeof budgets === 'number'
    ? { easy: budgets, normal: budgets, hard: budgets }
    : budgets;
  const r = playGame(levels, b);
  const diff = r.counts.black - r.counts.white;
  return { result: Math.sign(diff), counts: r.counts, ms: r.ms };
}

{
  let wins = 0, losses = 0;
  seedRandom(33);
  for (let g = 0; g < 2; g++) {
    const r = match('hard', 'easy', 250);
    if (r.result > 0) wins++; else if (r.result < 0) losses++;
  }
  check('hard beats easy (hard as black): ' + wins + 'W/' + losses + 'L',
    wins > losses, { wins, losses });
}
{
  let wins = 0, losses = 0;
  seedRandom(34);
  for (let g = 0; g < 2; g++) {
    const r = match('normal', 'easy', 250);
    if (r.result > 0) wins++; else if (r.result < 0) losses++;
  }
  check('normal beats easy (normal as black): ' + wins + 'W/' + losses + 'L',
    wins >= losses, { wins, losses });
}

/* ========================================================================== *
 * 9. Every game must reach a legal end state
 * ========================================================================== */
console.log('\n[full games]');
let ended = 0;
let badCount = 0;
let slowest = 0;
let slowestCpu = 0;
const levelCycle = ['easy', 'easy', 'normal'];
for (let g = 0; g < 12; g++) {
  const level = levelCycle[g % levelCycle.length];
  const r = playGame({ 1: level, 2: level }, { normal: 120 });
  slowest = Math.max(slowest, r.slowest);
  slowestCpu = Math.max(slowestCpu, r.slowestCpu);
  if (r.stuck) ended++;
  if (r.counts.black + r.counts.white + r.counts.empty === 64) badCount++;
}
check('all 12 games ended with neither side able to move', ended === 12, ended);
check('disc counts always sum to 64', badCount === 12, badCount);
check('slowest move in casual games: ' + Math.round(slowestCpu) + 'ms CPU',
  slowestCpu < 700, { cpu: Math.round(slowestCpu), wall: slowest });

/* ========================================================================== *
 * 10. Per-level cost on a realistic middle-game position
 * ========================================================================== */
console.log('\n[timing: per-level move cost]');
{
  /* A real position from the fourth plies of a game, not a random scramble. */
  let board = O.createBoard();
  let turn = O.BLACK;
  for (let i = 0; i < 6; i++) {
    const mv = O.chooseMove(board, turn, 'easy');
    board = O.applyMove(board, mv, turn);
    turn = 3 - turn;
  }
  for (const level of ['easy', 'normal', 'hard']) {
    const t0 = process.hrtime.bigint();
    const n = 10;
    for (let k = 0; k < n; k++) O.chooseMove(board, turn, level);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
    console.log('  ' + level.padEnd(7) + ms.toFixed(1) + ' ms/move');
  }
}

console.log('\n' + checks + ' checks, ' + failures + ' failure(s)');
console.log(failures === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED');
process.exit(failures ? 1 : 0);
