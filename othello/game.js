/* ===========================================================================
 * Othello core — rules, evaluation and search.
 *
 * Pure logic with no DOM access, so it runs both in the browser
 * (window.Othello) and in Node (module.exports) where it is unit tested.
 *
 *   1. board helpers .... createBoard / flipsAt / getMoves / applyMove
 *   2. evaluation ........ corner-aware weights, mobility, frontier, discs
 *   3. search ............ iterative deepening + alpha-beta + transposition
 * =========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. Rules
   * ------------------------------------------------------------------ */

  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = 2;

  /* (dx, dy) pairs — coordinate maths avoids the wrap-around bugs that
     flat index arithmetic invites. */
  var DIRS = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1]
  ];

  var COLS = 'ABCDEFGH';

  function other(player) {
    return 3 - player;
  }

  function inside(x, y) {
    return x >= 0 && x < 8 && y >= 0 && y < 8;
  }

  function indexOf(x, y) {
    return y * 8 + x;
  }

  function coord(i) {
    return COLS[i % 8] + (Math.floor(i / 8) + 1);
  }

  function createBoard() {
    var b = new Int8Array(64);
    b[indexOf(3, 3)] = WHITE;
    b[indexOf(4, 4)] = WHITE;
    b[indexOf(3, 4)] = BLACK;
    b[indexOf(4, 3)] = BLACK;
    return b;
  }

  /* Discs captured by `player` at (x, y), or null when the move is illegal. */
  function flipsAt(board, player, x, y) {
    if (board[indexOf(x, y)] !== EMPTY) return null;
    var opp = other(player);
    var captured = null;
    for (var d = 0; d < 8; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];
      var cx = x + dx;
      var cy = y + dy;
      var line = null;
      while (inside(cx, cy) && board[indexOf(cx, cy)] === opp) {
        if (!line) line = [];
        line.push(indexOf(cx, cy));
        cx += dx;
        cy += dy;
      }
      if (line && inside(cx, cy) && board[indexOf(cx, cy)] === player) {
        if (!captured) captured = [];
        for (var k = 0; k < line.length; k++) captured.push(line[k]);
      }
    }
    return captured && captured.length ? captured : null;
  }

  /* Every legal move for `player`: [{ i, flips }] */
  function getMoves(board, player) {
    var moves = [];
    for (var i = 0; i < 64; i++) {
      if (board[i] !== EMPTY) continue;
      var flips = flipsAt(board, player, i % 8, Math.floor(i / 8));
      if (flips) moves.push({ i: i, flips: flips });
    }
    return moves;
  }

  function countDiscs(board) {
    var black = 0;
    var white = 0;
    for (var i = 0; i < 64; i++) {
      if (board[i] === BLACK) black++;
      else if (board[i] === WHITE) white++;
    }
    return { black: black, white: white, empty: 64 - black - white };
  }

  /* ------------------------------------------------------------------ *
   * 2. Evaluation
   * ------------------------------------------------------------------ */

  /* Base positional weights: corners are gold, the X/C squares beside an
     empty corner are poisoned — that rule is position dependent, so every
     combination of occupied corners gets its own pre-built table. */
  var BASE_WEIGHTS = [
    120, -20,  20,   5,   5,  20, -20, 120,
    -20, -40,  -5,  -5,  -5,  -5, -40, -20,
     20,  -5,  15,   3,   3,  15,  -5,  20,
      5,  -5,   3,   3,   3,   3,  -5,   5,
      5,  -5,   3,   3,   3,   3,  -5,   5,
     20,  -5,  15,   3,   3,  15,  -5,  20,
    -20, -40,  -5,  -5,  -5,  -5, -40, -20,
    120, -20,  20,   5,   5,  20, -20, 120
  ];

  /* For corner k: the diagonal X-square and the two edge C-squares. */
  var X_SQUARES = [9, 14, 49, 58];
  var C_SQUARES = [[1, 8], [6, 15], [48, 57], [55, 62]];
  /* Square values beside a corner depend on that corner's state:
     - empty  → poisoned: whoever owns them is exposed to losing the corner
     - taken  → stable: a flipping line has to run through the corner, which
                can never be flipped, so these discs are safe.
     Using "stable" rather than "neutral" when the corner falls is what keeps
     corner captures from looking worthless (the credit booked for the
     opponent's poisoned discs has to be convertible). */
  var X_POISON = -70;
  var C_POISON = -40;
  var X_STABLE = 45;
  var C_STABLE = 25;

  var WEIGHT_TABLES = (function () {
    var tables = [];
    for (var mask = 0; mask < 16; mask++) {
      var t = Int16Array.from(BASE_WEIGHTS);
      for (var k = 0; k < 4; k++) {
        var taken = (mask >> k) & 1;
        t[X_SQUARES[k]] = taken ? X_STABLE : X_POISON;
        t[C_SQUARES[k][0]] = taken ? C_STABLE : C_POISON;
        t[C_SQUARES[k][1]] = taken ? C_STABLE : C_POISON;
      }
      tables.push(t);
    }
    return tables;
  })();

  function cornerMask(board) {
    return (board[0] ? 1 : 0) | (board[7] ? 2 : 0) |
           (board[56] ? 4 : 0) | (board[63] ? 8 : 0);
  }

  function weightTable(mask) {
    return WEIGHT_TABLES[mask & 15];
  }

  /* A disc touching an empty square is "frontier" — it is exposed and can
     be flipped, so fewer frontier discs is better. */
  function onFrontier(board, i) {
    var x = i & 7;
    var y = i >> 3;
    for (var d = 0; d < 8; d++) {
      var cx = x + DIRS[d][0];
      var cy = y + DIRS[d][1];
      if (inside(cx, cy) && board[indexOf(cx, cy)] === EMPTY) return true;
    }
    return false;
  }

  /* Score from `player`'s point of view; positive means winning. */
  function evaluate(board, player) {
    var opp = other(player);
    var W = WEIGHT_TABLES[cornerMask(board)];

    var pos = 0;
    var mine = 0;
    var theirs = 0;
    var myFrontier = 0;
    var oppFrontier = 0;

    for (var i = 0; i < 64; i++) {
      var v = board[i];
      if (v === EMPTY) continue;
      if (v === player) {
        pos += W[i];
        mine++;
        if (onFrontier(board, i)) myFrontier++;
      } else {
        pos -= W[i];
        theirs++;
        if (onFrontier(board, i)) oppFrontier++;
      }
    }

    var empty = 64 - mine - theirs;
    var score = pos;

    if (empty === 0) {
      /* Full board: this is the exact result, not a guess. */
      return (mine - theirs) * TERMINAL_SCALE;
    }

    var myMoves = getMoves(board, player).length;
    var oppMoves = getMoves(board, opp).length;
    if (myMoves === 0 && oppMoves === 0) {
      /* Nobody can move and squares remain: also the exact result. */
      return (mine - theirs) * TERMINAL_SCALE;
    }

    /* Mobility decides most middle games. */
    score += 14 * (myMoves - oppMoves);
    /* Exposed discs get attacked; being lean on the frontier is good. */
    score -= 6 * (myFrontier - oppFrontier);

    if (empty <= 12) {
      /* With few squares left the disc count finally means something. */
      score += 6 * (mine - theirs);
    }
    return score;
  }

  /* Exact result once neither side can move. */
  var TERMINAL_SCALE = 1000;

  function finalScore(board, player) {
    var c = countDiscs(board);
    var mine = player === BLACK ? c.black : c.white;
    var theirs = player === BLACK ? c.white : c.black;
    return (mine - theirs) * TERMINAL_SCALE;
  }

  /* ------------------------------------------------------------------ *
   * 3. Search
   *
   * Iterative deepening over alpha-beta negamax, cut short by a wall
   * clock deadline. A transposition table keyed by a Zobrist hash makes
   * the repeated searches cheap and orders each node's moves.
   * ------------------------------------------------------------------ */

  var ABORT = { aborted: true };
  var F_EXACT = 0;
  var F_LOWER = 1;
  var F_UPPER = 2;

  var Z1 = new Int32Array(128);   /* 64 squares x 2 colours */
  var Z2 = new Int32Array(128);

  (function initZobrist() {
    var s = 0x2545f491 | 0;
    function rnd() {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5; s |= 0;
      return s;
    }
    /* Nonlinear finalizer (murmur3 fmix32). Both halves must not come from
       consecutive xorshift outputs: that transition is linear over GF(2),
       which would make Z2[k] a fixed linear function of Z1[k] — then
       h2 = A(h1) for every position, the two-level table key collapses to
       32 effective bits, and searches hit entries for unrelated positions. */
    function fmix32(x) {
      x ^= x >>> 16;
      x = Math.imul(x, 0x7feb352d);
      x ^= x >>> 15;
      x = Math.imul(x, 0x846ca68b);
      x ^= x >>> 16;
      return x | 0;
    }
    for (var k = 0; k < 128; k++) {
      Z1[k] = fmix32(rnd());
      Z2[k] = fmix32(rnd());
    }
  })();

  /* Hash of the position only — whose turn it is is folded into the
     transposition key (h2 * 3 + (player - 1)), which keeps the hash
     bookkeeping trivial and safe. */
  function hashOf(board) {
    var h1 = 0;
    var h2 = 0;
    for (var i = 0; i < 64; i++) {
      var v = board[i];
      if (v !== EMPTY) {
        var k = (i << 1) | (v - 1);
        h1 ^= Z1[k];
        h2 ^= Z2[k];
      }
    }
    return { h1: h1, h2: h2 };
  }

  /* Apply a move and update the Zobrist hash in one step. Returns a fresh
     board (positions are never mutated — undo/review rely on that). */
  function applyState(board, move, player, h1, h2) {
    var nb = board.slice();
    nb[move.i] = player;
    var place = (move.i << 1) | (player - 1);
    h1 ^= Z1[place];
    h2 ^= Z2[place];

    var opp = other(player);
    var outIdx = (player - 1) | 0;
    var inIdx = (opp - 1) | 0;
    for (var k = 0; k < move.flips.length; k++) {
      var f = move.flips[k];
      var out = (f << 1) | outIdx;
      var inn = (f << 1) | inIdx;
      h1 ^= Z1[out] ^ Z1[inn];
      h2 ^= Z2[out] ^ Z2[inn];
      nb[f] = player;
    }
    return { board: nb, h1: h1, h2: h2 };
  }

  function applyMove(board, move, player) {
    return applyState(board, move, player, 0, 0).board;
  }

  function makeContext(budgetMs, noTt) {
    return {
      tt: noTt ? null : new Map(),
      nodes: 0,
      deadline: Date.now() + budgetMs
    };
  }

  function tick(ctx) {
    if ((++ctx.nodes & 511) === 0 && Date.now() > ctx.deadline) throw ABORT;
  }

  /* Order by static value, hoisting the transposition move to the front. */
  function orderMoves(moves, ttMove, W) {
    if (moves.length > 1) {
      moves.sort(function (a, b) {
        var d = (W[b.i] + 8 * b.flips.length) - (W[a.i] + 8 * a.flips.length);
        if (d) return d;
        return a.i - b.i;
      });
    }
    if (ttMove != null) {
      for (var k = 0; k < moves.length; k++) {
        if (moves[k].i === ttMove) {
          if (k) {
            var m = moves[k];
            moves.splice(k, 1);
            moves.unshift(m);
          }
          break;
        }
      }
    }
    return moves;
  }

  /* Negamax with alpha-beta and TT. Value is from `player`'s perspective. */
  function search(board, player, depth, alpha, beta, ctx, h1, h2) {
    tick(ctx);

    if (depth <= 0) return evaluate(board, player);

    /* --- transposition table probe -------------------------------- */
    var key = h2 * 3 + (player - 1);
    var ttMove = null;
    if (ctx.tt) {
      var bucket = ctx.tt.get(h1);
      var entry = bucket ? bucket.get(key) : null;
      if (entry) {
        if (entry.d >= depth) {
          if (entry.f === F_EXACT) return entry.v;
          if (entry.f === F_LOWER && entry.v >= beta) return entry.v;
          if (entry.f === F_UPPER && entry.v <= alpha) return entry.v;
        }
        if (entry.m >= 0) ttMove = entry.m;
      }
    }

    var opp = other(player);
    var moves = getMoves(board, player);
    if (moves.length === 0) {
      if (getMoves(board, opp).length === 0) return finalScore(board, player);
      /* Pass: hand the turn over — the value stays zero-sum, so the
         result is the opponent's score negated (with an inverted window). */
      return -search(board, opp, depth, -beta, -alpha, ctx, h1, h2);
    }

    var W = WEIGHT_TABLES[cornerMask(board)];
    orderMoves(moves, ttMove, W);

    var best = -Infinity;
    var bestIdx = -1;
    var startAlpha = alpha;

    for (var k = 0; k < moves.length; k++) {
      var m = moves[k];
      var child = applyState(board, m, player, h1, h2);
      var value = -search(child.board, opp, depth - 1, -beta, -alpha,
        ctx, child.h1, child.h2);
      if (value > best) {
        best = value;
        bestIdx = m.i;
      }
      if (value > alpha) alpha = value;
      if (alpha >= beta) break;
    }

    /* --- transposition table store -------------------------------- */
    if (ctx.tt) {
      var flag = best <= startAlpha ? F_UPPER : (best >= beta ? F_LOWER : F_EXACT);
      var store = ctx.tt.get(h1);
      if (!store) {
        store = new Map();
        ctx.tt.set(h1, store);
      }
      var prev = store.get(key);
      if (!prev || prev.d <= depth) {
        store.set(key, { d: depth, v: best, f: flag, m: bestIdx });
      }
    }

    return best;
  }

  /* Exact value of a position to a fixed depth — used by the tests to
     compare the search against an independent solver. */
  function searchScore(board, player, depth, options) {
    var opts = options || {};
    var ctx = makeContext(opts.budget || 5000, opts.noTt);
    var h = hashOf(board);
    return search(board, player, depth, -Infinity, Infinity, ctx, h.h1, h.h2);
  }

  /* Root of the search: deepens until the budget runs out and returns the
     best move found by the last *completed* iteration. */
  function searchBest(board, player, moves, maxDepth, ctx) {
    var opp = other(player);
    var hash = hashOf(board);
    var W = WEIGHT_TABLES[cornerMask(board)];
    var best = moves[0];
    var previous = null;

    for (var depth = 1; depth <= maxDepth; depth++) {
      var alpha = -Infinity;
      var beta = Infinity;
      var ties = [];
      var bestValue = -Infinity;
      var aborted = false;

      var ordered = moves.slice();
      orderMoves(ordered, previous, W);

      try {
        for (var k = 0; k < ordered.length; k++) {
          var m = ordered[k];
          var child = applyState(board, m, player, hash.h1, hash.h2);
          var value = -search(child.board, opp, depth - 1, -beta, -alpha,
            ctx, child.h1, child.h2);
          /* A child that hit our beta returns an upper bound, not its true
             value — only values above alpha are exact, so only those may
             take part in the tie-break. */
          var exact = value > alpha;
          if (value > bestValue) {
            bestValue = value;
            ties = [m];
          } else if (value === bestValue && exact) {
            ties.push(m);            /* exact tie: choose one at random */
          }
          if (exact) alpha = value;
        }
      } catch (err) {
        if (err !== ABORT) throw err;
        aborted = true;
      }

      if (aborted) break;              /* keep the previous iteration */
      best = ties[(Math.random() * ties.length) | 0];
      previous = best.i;
      if (Date.now() > ctx.deadline - 15) break;  /* no time for another pass */
    }
    return best;
  }

  function randomMove(moves) {
    return moves[(Math.random() * moves.length) | 0];
  }

  /* Difficulty presets. Budgets are wall clock milliseconds. */
  var LEVELS = {
    easy:   { budget: 60,   maxDepth: 3,  exact: 4,  luck: 0.6 },
    normal: { budget: 190,  maxDepth: 9,  exact: 6,  luck: 0 },
    hard:   { budget: 750,  maxDepth: 16, exact: 13, luck: 0 }
  };

  /* Pick `player`'s move. Returns null when the side to move must pass.
     level: 'easy' | 'normal' | 'hard'
     budgetMs (optional): override the thinking budget — used by the tests
     to keep match play fast, and handy for "think longer" toggles. */
  function chooseMove(board, player, level, budgetMs) {
    var moves = getMoves(board, player);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];

    var cfg = LEVELS[level] || LEVELS.normal;

    /* Beginners win some too: mostly spontaneous play, occasionally strong. */
    if (cfg.luck && Math.random() < cfg.luck) return randomMove(moves);

    var empty = countDiscs(board).empty;
    /* Few squares left: search to the end if the budget allows it. */
    var maxDepth = empty <= cfg.exact ? empty : cfg.maxDepth;
    var budget = typeof budgetMs === 'number' ? budgetMs : cfg.budget;

    return searchBest(board, player, moves, maxDepth, makeContext(budget));
  }

  /* ------------------------------------------------------------------ */

  var api = {
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    WEIGHTS: BASE_WEIGHTS,
    other: other,
    coord: coord,
    createBoard: createBoard,
    flipsAt: flipsAt,
    getMoves: getMoves,
    applyMove: applyMove,
    countDiscs: countDiscs,
    evaluate: evaluate,
    chooseMove: chooseMove,
    searchScore: searchScore,
    /* exposed for the test suite */
    weightTable: weightTable,
    cornerMask: cornerMask,
    hashOf: hashOf,
    applyState: applyState,
    levels: LEVELS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Othello = api;
})(typeof window !== 'undefined' ? window : globalThis);
