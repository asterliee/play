/*
 * Star Battle (1 star) engine
 * ---------------------------------------------------------------
 * Rules: an N x N grid split into N regions. Place one star in every row,
 * every column and every region; no two stars may touch, not even
 * diagonally.
 *
 * 1. Deduction engine (findAll / findDeduction)
 *    Solves a board the way a person does: one sound step at a time, always
 *    the cheapest one available. A step's price estimates how hard it is for a
 *    person to spot:
 *      Last cell    0.1  a row, column or region has a single spot left
 *      Locked line  0.5  a region fits in one row/column (rest of the line is
 *                        empty), or a row/column fits inside one region
 *      Squeeze      2    a cell that would rule out every remaining spot of
 *                        some row, column or region is empty
 *      Count             k units of one kind whose spots lie in exactly k units
 *                        of another kind own those units (Hall / pigeonhole).
 *                        5, 12, 25, 35 for k = 2..5, times what you have to see:
 *                        x0.8 when the rows/columns form one band touching an
 *                        edge, x2 when they are scattered, x2 for rows against
 *                        columns. Solved lines inside a band don't break it.
 *                        Each count is priced in its easier form (a count and
 *                        its complement rule out the same cells).
 *      What-if           suppose a star in a cell of a row, column or region
 *                        with at most 3 open cells (where a person would try
 *                        one) and follow the moves it forces, a round at a
 *                        time: last cells and locked lines. If a unit runs out
 *                        of room, or two units need the same one, the cell is
 *                        empty. 8, 14, 22, 32 after 0-3 rounds.
 *    Steps priced above 40 are not in the game: scattered counts of four or
 *    more, scattered rows-against-columns of three or more, what-ifs deeper
 *    than three rounds.
 *    On equal prices the count wins: a what-if is used only when cheaper.
 *    Every step is sound, so a board the engine finishes has exactly one solution.
 *
 * 2. Grading (route / bottlenecks / gradeOf)
 *    Measured so the order a solver picks doesn't matter. The rules are
 *    monotone (ruling out more cells never hides a step), so applying every
 *    step below a price reaches the same state in any order.
 *      ceiling      the hardest step no solving order can avoid: the highest
 *                   price on the easiest route (each round applies every step
 *                   at the lowest price available)
 *      bottlenecks  how often a solver must use a step priced p or more, in any
 *                   order: apply everything cheaper until stuck, then every
 *                   step priced p or more at once; the rounds counted are a
 *                   lower bound on such steps in any solve
 *    Easy    only last cells and locked lines
 *    Medium  squeezes and pair counts in a band, at most two pair-count
 *            bottlenecks (one on small boards)
 *    Hard    anything harder, with at most one expert step
 *    Expert  two or more expert bottlenecks (steps priced 20+: big counts in a
 *            band, scattered triples, what-ifs two rounds deep).
 *            Small boards top out at Hard.
 *
 * 3. Exact solver (countSolutions): bitmask backtracking, used as an
 *    independent uniqueness check.
 *
 * 4. Generator (anneal / generate): simulated annealing over region layouts
 *    around a fixed random star placement. Each move hands one border cell
 *    to a neighbouring region (regions stay connected and keep their star).
 *    The objective steers the price of the easiest route (the sum of its
 *    rounds) toward the tier's target, minus a small boundary-length penalty
 *    for natural-looking shapes;
 *    layouts the engine can't finish are penalised by how much is left. Only
 *    boards the engine solves completely are ever kept, so every board is
 *    deterministic and unique.
 *
 * Works in browsers (window / Web Worker) and in Node.
 */
(function (root, factory) {
  var E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.SBEngine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 4; // 4 x 32-bit words -> boards up to 128 cells (11x11)

  function popcnt(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24);
  }
  function ctz(x) { return 31 - Math.clz32(x & -x); }

  // Small fast seeded RNG (mulberry32)
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------
  // Geometry shared by every board of size N
  // ------------------------------------------------------------------
  var GEOS = {};
  function geometry(N) {
    if (GEOS[N]) return GEOS[N];
    var NN = N * N, i, w, m;
    var row = new Int8Array(NN), col = new Int8Array(NN);
    for (i = 0; i < NN; i++) { row[i] = (i / N) | 0; col[i] = i % N; }
    var ROWM = new Int32Array(N * W), COLM = new Int32Array(N * W);
    var NEIM = new Int32Array(NN * W), STAT = new Int32Array(NN * W);
    var nei8 = [], nei4 = [];
    for (i = 0; i < NN; i++) {
      var r = row[i], c = col[i];
      ROWM[r * W + (i >> 5)] |= 1 << (i & 31);
      COLM[c * W + (i >> 5)] |= 1 << (i & 31);
      var n8 = [], n4 = [];
      for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
        var j = rr * N + cc;
        n8.push(j);
        if (!dr || !dc) n4.push(j);
        NEIM[i * W + (j >> 5)] |= 1 << (j & 31);
      }
      nei8.push(n8); nei4.push(n4);
    }
    for (i = 0; i < NN; i++) {
      for (w = 0; w < W; w++) STAT[i * W + w] = ROWM[row[i] * W + w] | COLM[col[i] * W + w] | NEIM[i * W + w];
      STAT[i * W + (i >> 5)] &= ~(1 << (i & 31));
    }
    var M = 1 << N;
    var UROW = new Int32Array(M * W), UCOL = new Int32Array(M * W);
    for (m = 1; m < M; m++) {
      var b = ctz(m), p = (m & (m - 1)) * W;
      for (w = 0; w < W; w++) {
        UROW[m * W + w] = UROW[p + w] | ROWM[b * W + w];
        UCOL[m * W + w] = UCOL[p + w] | COLM[b * W + w];
      }
    }
    var FULL = new Int32Array(W);
    for (i = 0; i < NN; i++) FULL[i >> 5] |= 1 << (i & 31);
    var g = { N: N, NN: NN, M: M, row: row, col: col, ROWM: ROWM, COLM: COLM, NEIM: NEIM, STAT: STAT,
      nei8: nei8, nei4: nei4, UROW: UROW, UCOL: UCOL, FULL: FULL };
    GEOS[N] = g;
    return g;
  }

  // ------------------------------------------------------------------
  // Layout: one particular split of the grid into regions
  // ------------------------------------------------------------------
  function Layout(N) {
    var G = geometry(N);
    this.N = N; this.G = G;
    this.reg = new Int8Array(G.NN);
    this.REGM = new Int32Array(N * W);
    this.ATT = new Int32Array(G.NN * W);   // cells a star at i rules out
    this.UREG = new Int32Array(G.M * W);   // union of region masks for each subset
    this.UM = [G.ROWM, G.COLM, this.REGM];
    this.UU = [G.UROW, G.UCOL, this.UREG];
  }
  Layout.prototype.set = function (regions) {
    var G = this.G, N = this.N, NN = G.NN, i, m, o, go;
    var reg = this.reg, REGM = this.REGM, ATT = this.ATT, UREG = this.UREG, STAT = G.STAT;
    REGM.fill(0);
    for (i = 0; i < NN; i++) { var g = regions[i]; reg[i] = g; REGM[g * W + (i >> 5)] |= 1 << (i & 31); }
    for (i = 0; i < NN; i++) {
      o = i * W; go = reg[i] * W;
      ATT[o] = STAT[o] | REGM[go]; ATT[o + 1] = STAT[o + 1] | REGM[go + 1];
      ATT[o + 2] = STAT[o + 2] | REGM[go + 2]; ATT[o + 3] = STAT[o + 3] | REGM[go + 3];
      ATT[o + (i >> 5)] &= ~(1 << (i & 31));
    }
    for (m = 1; m < G.M; m++) {
      var b = ctz(m) * W, p = (m & (m - 1)) * W; o = m * W;
      UREG[o] = UREG[p] | REGM[b]; UREG[o + 1] = UREG[p + 1] | REGM[b + 1];
      UREG[o + 2] = UREG[p + 2] | REGM[b + 2]; UREG[o + 3] = UREG[p + 3] | REGM[b + 3];
    }
    return this;
  };

  // ------------------------------------------------------------------
  // Solving state (candidates + placed stars)
  // ------------------------------------------------------------------
  // Hit tables: H[(a*3+b)*N + u] = set of kind-b units touched by the
  // candidates of kind-a unit u. Kinds: 0 row, 1 column, 2 region.
  function State(L) {
    var N = L.N;
    this.L = L;
    this.cand = new Int32Array(W);
    this.stars = new Int32Array(W);
    this.nStars = 0;
    this.done = new Int32Array(3);
    this.H = new Int32Array(9 * N);
    this.cnt = new Int32Array(3 * N);
    this.owner = new Int32Array(N);
  }
  State.prototype.reset = function () {
    var F = this.L.G.FULL;
    this.cand[0] = F[0]; this.cand[1] = F[1]; this.cand[2] = F[2]; this.cand[3] = F[3];
    this.stars.fill(0); this.nStars = 0; this.done.fill(0);
    return this;
  };
  State.prototype.copyFrom = function (o) {
    this.cand.set(o.cand); this.stars.set(o.stars); this.nStars = o.nStars; this.done.set(o.done);
    return this;
  };
  State.prototype.isCand = function (i) { return (this.cand[i >> 5] >>> (i & 31)) & 1; };
  State.prototype.isStar = function (i) { return (this.stars[i >> 5] >>> (i & 31)) & 1; };
  State.prototype.place = function (i) {
    var L = this.L, A = L.ATT, o = i * W, c = this.cand;
    c[0] &= ~A[o]; c[1] &= ~A[o + 1]; c[2] &= ~A[o + 2]; c[3] &= ~A[o + 3];
    c[i >> 5] &= ~(1 << (i & 31));
    this.stars[i >> 5] |= 1 << (i & 31);
    this.nStars++;
    this.done[0] |= 1 << L.G.row[i]; this.done[1] |= 1 << L.G.col[i]; this.done[2] |= 1 << L.reg[i];
  };
  State.prototype.eliminate = function (e) {
    var c = this.cand; c[0] &= ~e[0]; c[1] &= ~e[1]; c[2] &= ~e[2]; c[3] &= ~e[3];
  };
  State.prototype.candCount = function () {
    var c = this.cand; return popcnt(c[0]) + popcnt(c[1]) + popcnt(c[2]) + popcnt(c[3]);
  };
  State.prototype.computeHits = function () {
    var L = this.L, G = L.G, N = L.N, H = this.H, cnt = this.cnt, row = G.row, col = G.col, reg = L.reg;
    var cand = this.cand;
    H.fill(0); cnt.fill(0);
    var N1 = N, N2 = 2 * N, N3 = 3 * N, N5 = 5 * N, N6 = 6 * N, N7 = 7 * N;
    for (var w = 0; w < W; w++) {
      var x = cand[w];
      while (x !== 0) {
        var lb = x & -x; x ^= lb;
        var i = (w << 5) | (31 - Math.clz32(lb));
        var r = row[i], c = col[i], g = reg[i];
        H[N1 + r] |= 1 << c;  // row -> cols
        H[N3 + c] |= 1 << r;  // col -> rows
        H[N2 + r] |= 1 << g;  // row -> regions
        H[N6 + g] |= 1 << r;  // region -> rows
        H[N5 + c] |= 1 << g;  // col -> regions
        H[N7 + g] |= 1 << c;  // region -> cols
        cnt[r]++; cnt[N + c]++; cnt[N2 + g]++;
      }
    }
  };

  function firstBit4(a0, a1, a2, a3) {
    if (a0) return ctz(a0);
    if (a1) return 32 + ctz(a1);
    if (a2) return 64 + ctz(a2);
    if (a3) return 96 + ctz(a3);
    return -1;
  }
  function maskCells(e) {
    var out = [];
    for (var w = 0; w < W; w++) {
      var x = e[w];
      while (x !== 0) { var lb = x & -x; x ^= lb; out.push((w << 5) | (31 - Math.clz32(lb))); }
    }
    return out;
  }
  function bits(m) { var out = []; while (m) { var lb = m & -m; m ^= lb; out.push(31 - Math.clz32(lb)); } return out; }
  function maskOf(i) { var e = [0, 0, 0, 0]; e[i >> 5] = 1 << (i & 31); return e; }

  // Pairs of (source kind, target kind): the first four are region <-> line,
  // the last two rows <-> columns
  var PA = [2, 2, 0, 1, 0, 1];
  var PB = [0, 1, 2, 2, 1, 0];
  var KORD = [2, 0, 1];      // regions first, then rows, then columns

  // ------------------------------------------------------------------
  // Prices
  // ------------------------------------------------------------------
  var P_SINGLE = 0.1, P_CONFINE = 0.5, P_SQUEEZE = 2;
  var COUNT = [0, 0, 5, 12, 25, 35, 45, 55, 65, 75, 85, 95];   // a count of k units, by k
  var EDGE = 0.8, SPREAD = 2, CROSS = 2;     // a band at an edge, scattered lines, rows against columns
  var WHATIF = [8, 14, 22, 32, 45, 60, 80];  // a what-if, by rounds of forced moves to the dead end
  var IN_GAME = 40;                          // steps priced above this are not in the game
  var PAIR = 4, EXPERT = 20;                 // grading lines (see gradeOf)

  // Options: { maxPrice: only steps up to this price, full: also steps priced above
  // IN_GAME, which are not in the game }
  var GAME = {}, FULL = { full: true };

  // ------------------------------------------------------------------
  // Easy steps
  // ------------------------------------------------------------------
  function emptyUnit(st) {
    var N = st.L.N, cnt = st.cnt, done = st.done;
    for (var k = 0; k < 3; k++) for (var u = 0; u < N; u++)
      if (!((done[k] >> u) & 1) && cnt[k * N + u] === 0) return { kind: k, units: [u] };
    return null;
  }
  // Last cell: a row, column or region with one open cell
  function singles(st, out) {
    var L = st.L, N = L.N, cnt = st.cnt, done = st.done, cand = st.cand;
    for (var ki = 0; ki < 3; ki++) {
      var k = KORD[ki], UM = L.UM[k];
      for (var u = 0; u < N; u++) {
        if (((done[k] >> u) & 1) || cnt[k * N + u] !== 1) continue;
        var o = u * W, cell = firstBit4(cand[0] & UM[o], cand[1] & UM[o + 1], cand[2] & UM[o + 2], cand[3] & UM[o + 3]);
        out.push({ tech: 'single', price: P_SINGLE, place: cell, A: { kind: k, units: [u] } });
      }
    }
  }
  // Locked line: a region inside one row/column, or a row/column inside one region
  function confines(st, out) {
    var L = st.L, N = L.N, H = st.H, done = st.done, cand = st.cand;
    for (var t = 0; t < 4; t++) {
      var a = PA[t], b = PB[t], base = (a * 3 + b) * N, UA = L.UM[a], UB = L.UM[b];
      for (var u = 0; u < N; u++) {
        if ((done[a] >> u) & 1) continue;
        var hm = H[base + u];
        if (hm === 0 || (hm & (hm - 1)) !== 0) continue;
        var v = ctz(hm), ob = v * W, oa = u * W;
        var e0 = cand[0] & UB[ob] & ~UA[oa], e1 = cand[1] & UB[ob + 1] & ~UA[oa + 1];
        var e2 = cand[2] & UB[ob + 2] & ~UA[oa + 2], e3 = cand[3] & UB[ob + 3] & ~UA[oa + 3];
        if (e0 | e1 | e2 | e3) out.push({ tech: 'confine', price: P_CONFINE, place: -1, elim: [e0, e1, e2, e3],
          A: { kind: a, units: [u] }, B: { kind: b, units: [v] } });
      }
    }
  }
  // Squeeze: cells that would rule out every open cell of a unit
  function squeezes(st, out) {
    var L = st.L, N = L.N, cand = st.cand, done = st.done, cnt = st.cnt, ATT = L.ATT;
    for (var ki = 0; ki < 3; ki++) {
      var k = KORD[ki], UM = L.UM[k];
      for (var u = 0; u < N; u++) {
        if (((done[k] >> u) & 1) || cnt[k * N + u] < 2) continue;
        var x = squeezeOf(cand, UM, u * W, ATT);
        if (!x) continue;
        var e0 = x[0] & cand[0], e1 = x[1] & cand[1], e2 = x[2] & cand[2], e3 = x[3] & cand[3];
        if (e0 | e1 | e2 | e3) out.push({ tech: 'squeeze', price: P_SQUEEZE, place: -1, elim: [e0, e1, e2, e3], A: { kind: k, units: [u] } });
      }
    }
  }
  var SQ = [0, 0, 0, 0];
  // Cells that see every open cell of the unit at UM[o..o+3] (null if none)
  function squeezeOf(cand, UM, o, ATT) {
    var x0 = -1, x1 = -1, x2 = -1, x3 = -1;
    for (var w = 0; w < W; w++) {
      var x = cand[w] & UM[o + w];
      while (x !== 0) {
        var lb = x & -x; x ^= lb;
        var y = ((w << 5) | (31 - Math.clz32(lb))) * W;
        x0 &= ATT[y]; x1 &= ATT[y + 1]; x2 &= ATT[y + 2]; x3 &= ATT[y + 3];
        if ((x0 | x1 | x2 | x3) === 0) return null;
      }
    }
    SQ[0] = x0; SQ[1] = x1; SQ[2] = x2; SQ[3] = x3;
    return SQ;
  }

  // ------------------------------------------------------------------
  // Counts (pigeonhole): k units of kind A whose open cells lie inside exactly
  // k units of kind B. Those B units get their stars from the A units, so every
  // other open cell in them is empty.
  // ------------------------------------------------------------------
  // How a set of lines looks: 0 scattered, 1 one band, 2 one band touching an
  // edge. Solved lines count as part of a band.
  function lineBand(m, done, N) {
    var lo = ctz(m), hi = 31 - Math.clz32(m);
    var span = ((1 << (hi + 1)) - 1) & ~((1 << lo) - 1);
    if (span & ~(m | done)) return 0;
    var below = (1 << lo) - 1, above = ((1 << N) - 1) & ~((1 << (hi + 1)) - 1);
    return (below & ~done) === 0 || (above & ~done) === 0 ? 2 : 1;
  }
  function formPrice(a, b, S, T, k, done, N) {
    var base = k < COUNT.length ? COUNT[k] : 100, bb;
    if (a !== 2 && b !== 2) {
      bb = lineBand(S, done[a], N) && lineBand(T, done[b], N) ? 1 : 0;
      return { a: a, b: b, S: S, T: T, k: k, band: bb, price: base * CROSS * (bb ? 1 : SPREAD) };
    }
    bb = a === 2 ? lineBand(T, done[b], N) : lineBand(S, done[a], N);
    return { a: a, b: b, S: S, T: T, k: k, band: bb, price: base * (bb === 2 ? EDGE : bb === 1 ? 1 : SPREAD) };
  }
  // A count and its complement (the other units of each kind, swapped) rule out
  // the same cells; a person can spot either, so it costs the easier one.
  function countForm(st, a, b, S, T, k) {
    var N = st.L.N, done = st.done, full = (1 << N) - 1, m = N - st.nStars;
    var f1 = formPrice(a, b, S, T, k, done, N);
    var f2 = formPrice(b, a, full & ~done[b] & ~T, full & ~done[a] & ~S, m - k, done, N);
    return f2.price < f1.price ? f2 : f1;
  }
  // Every count with something to rule out, up to maxPrice: those at the lowest
  // price (all = false) or all of them (all = true). Hits must be fresh.
  function counts(st, maxPrice, full, all) {
    var L = st.L, N = L.N, cand = st.cand, H = st.H, done = st.done;
    var K = (N - st.nStars) >> 1, out = [], best = full ? maxPrice : Math.min(maxPrice, IN_GAME);
    if (K < 2) return out;
    var list = st.pl || (st.pl = new Int32Array(N));
    var idx = st.pi || (st.pi = new Int32Array(N + 1)), Hs = st.ph || (st.ph = new Int32Array(N + 1)),
      Ss = st.ps || (st.ps = new Int32Array(N + 1));
    for (var t = 0; t < 6; t++) {
      var a = PA[t], b = PB[t], base = (a * 3 + b) * N, UA = L.UU[a], UB = L.UU[b];
      var floor = t >= 4 ? CROSS : EDGE;        // the cheapest a count of this pair can be, per unit of base price
      if (COUNT[2] * floor > best) continue;
      var n = 0;
      for (var u = 0; u < N; u++) if (!((done[a] >> u) & 1)) list[n++] = u;
      // depth-first over subsets, pruned when the hit set outgrows K
      var sp = 0;
      idx[0] = 0; Hs[0] = 0; Ss[0] = 0;
      while (sp >= 0) {
        if (idx[sp] >= n) { sp--; if (sp >= 0) idx[sp]++; continue; }
        var uu = list[idx[sp]];
        var H2 = Hs[sp] | H[base + uu], S2 = Ss[sp] | (1 << uu), size = sp + 1, pc = popcnt(H2);
        if (pc > K) { idx[sp]++; continue; }
        if (pc === size && size >= 2) {
          var oh = H2 * W, os = S2 * W;
          var e0 = cand[0] & UB[oh] & ~UA[os], e1 = cand[1] & UB[oh + 1] & ~UA[os + 1];
          var e2 = cand[2] & UB[oh + 2] & ~UA[os + 2], e3 = cand[3] & UB[oh + 3] & ~UA[os + 3];
          if (e0 | e1 | e2 | e3) {
            var f = countForm(st, a, b, S2, H2, size);
            if (f.price <= best) {
              if (!all && f.price < best) { out.length = 0; best = f.price; }
              out.push({ tech: 'pigeon', k: f.k, price: f.price, band: f.band, place: -1,
                elim: [e0, e1, e2, e3], A: { kind: f.a, units: bits(f.S) }, B: { kind: f.b, units: bits(f.T) } });
            }
          }
        }
        if (size < K && COUNT[size + 1] * floor <= best) {
          sp++;
          idx[sp] = idx[sp - 1] + 1; Hs[sp] = H2; Ss[sp] = S2;
        } else {
          idx[sp]++;
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // What-ifs: suppose a star in an open cell and follow the moves it forces,
  // a round at a time (every last cell and locked line at once). A dead end -
  // a unit with no room, or two units that both need the same single unit of
  // another kind - shows the cell is empty. Only cells in a row, column or
  // region with at most TRY open cells are tried: that is where a person looks.
  // ------------------------------------------------------------------
  var TRY = 3;
  function deadEnd(st) {
    var L = st.L, N = L.N, done = st.done, H = st.H, owner = st.owner;
    var e = emptyUnit(st);
    if (e) return e;
    for (var t = 0; t < 6; t++) {
      var a = PA[t], b = PB[t], base = (a * 3 + b) * N, seen = 0;
      for (var u = 0; u < N; u++) {
        if ((done[a] >> u) & 1) continue;
        var hm = H[base + u];
        if ((hm & (hm - 1)) !== 0) continue;
        if (seen & hm) return { kind: a, units: [owner[ctz(hm)], u], into: b, unit: ctz(hm) };
        seen |= hm; owner[ctz(hm)] = u;
      }
    }
    return null;
  }
  // One round of forced moves on fresh hits. Stars placed go onto trail.
  // Returns false when nothing is forced.
  function forcedRound(st, trail) {
    var L = st.L, N = L.N, cnt = st.cnt, done = st.done, cand = st.cand, H = st.H;
    var put = st.put || (st.put = new Int32Array(3 * N)), np = 0, e0 = 0, e1 = 0, e2 = 0, e3 = 0, k, u, o;
    for (k = 0; k < 3; k++) {
      var UM = L.UM[k];
      for (u = 0; u < N; u++) {
        if (((done[k] >> u) & 1) || cnt[k * N + u] !== 1) continue;
        o = u * W;
        put[np++] = firstBit4(cand[0] & UM[o], cand[1] & UM[o + 1], cand[2] & UM[o + 2], cand[3] & UM[o + 3]);
      }
    }
    for (var t = 0; t < 4; t++) {
      var a = PA[t], b = PB[t], base = (a * 3 + b) * N, UA = L.UM[a], UB = L.UM[b];
      for (u = 0; u < N; u++) {
        if ((done[a] >> u) & 1) continue;
        var hm = H[base + u];
        if (hm === 0 || (hm & (hm - 1)) !== 0) continue;
        var ob = ctz(hm) * W, oa = u * W;
        e0 |= UB[ob] & ~UA[oa]; e1 |= UB[ob + 1] & ~UA[oa + 1]; e2 |= UB[ob + 2] & ~UA[oa + 2]; e3 |= UB[ob + 3] & ~UA[oa + 3];
      }
    }
    e0 &= cand[0]; e1 &= cand[1]; e2 &= cand[2]; e3 &= cand[3];
    if (!np && !(e0 | e1 | e2 | e3)) return false;
    cand[0] &= ~e0; cand[1] &= ~e1; cand[2] &= ~e2; cand[3] &= ~e3;
    // a forced star on a cell that was just ruled out is skipped; its unit is then empty
    for (var i = 0; i < np; i++) { var p = put[i]; if (st.isCand(p)) { st.place(p); trail.push(p); } }
    return true;
  }
  // Open cells in a row, column or region with at most TRY open cells (hits fresh)
  function tryCells(st) {
    var L = st.L, G = L.G, N = L.N, cnt = st.cnt, cand = st.cand, out = [];
    for (var w = 0; w < W; w++) {
      var x = cand[w];
      while (x !== 0) {
        var lb = x & -x; x ^= lb;
        var i = (w << 5) | (31 - Math.clz32(lb));
        if (cnt[G.row[i]] <= TRY || cnt[N + G.col[i]] <= TRY || cnt[2 * N + L.reg[i]] <= TRY) out.push(i);
      }
    }
    return out;
  }
  // The cells whose what-if reaches a dead end within maxDepth rounds: those at
  // the smallest depth (all = false) or every one (all = true). Hits must be fresh.
  function whatIfs(st, maxDepth, all) {
    var L = st.L, N = L.N, xs = tryCells(st), pool = L._pool || (L._pool = []);
    var items = [], out = [], i, d;
    for (i = 0; i < xs.length; i++) {
      var s = pool[i] || (pool[i] = new State(L));
      s.copyFrom(st); s.place(xs[i]);
      items.push({ X: xs[i], s: s, trail: [], live: true });
    }
    for (d = 0; d <= maxDepth; d++) {
      for (i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it.live) continue;
        it.s.computeHits();
        var dead = deadEnd(it.s);
        if (dead) {
          it.live = false;
          out.push({ tech: 'whatif', price: WHATIF[d], depth: d, place: -1, elim: maskOf(it.X), cell: it.X,
            stars: it.trail.slice(), clash: dead.into != null, A: { kind: dead.kind, units: dead.units },
            B: dead.into != null ? { kind: dead.into, units: [dead.unit] } : null });
          continue;
        }
        if (d === maxDepth || it.s.nStars === N || !forcedRound(it.s, it.trail)) it.live = false;
      }
      if (out.length && !all) break;
    }
    return out;
  }
  // The deepest what-if that is cheaper than `below` and within the options
  function whatIfDepth(below, maxPrice, full) {
    var d = -1, cap = full ? maxPrice : Math.min(maxPrice, IN_GAME);
    while (d + 1 < WHATIF.length && WHATIF[d + 1] < below && WHATIF[d + 1] <= cap) d++;
    return d;
  }

  // ------------------------------------------------------------------
  // Step search
  // ------------------------------------------------------------------
  // Every step at the lowest price available (up to opts.maxPrice), as an array;
  // null if there is none; [{ contradiction: true }] if the state is impossible.
  function findAll(st, opts) {
    var maxPrice = opts && opts.maxPrice != null ? opts.maxPrice : Infinity, full = !!(opts && opts.full);
    st.computeHits();
    var e = emptyUnit(st);
    if (e) return [{ contradiction: true, A: e }];
    var out = [];
    if (maxPrice >= P_SINGLE) { singles(st, out); if (out.length) return out; }
    if (maxPrice >= P_CONFINE) { confines(st, out); if (out.length) return out; }
    if (maxPrice >= P_SQUEEZE) { squeezes(st, out); if (out.length) return out; }
    var cs = counts(st, maxPrice, full, false), best = cs.length ? cs[0].price : Infinity;
    var dmax = whatIfDepth(best, maxPrice, full);
    if (dmax >= 0) {
      var ws = whatIfs(st, dmax, false);
      if (ws.length) return ws;
    }
    return cs.length ? cs : null;
  }
  // The single cheapest step (the first found among equals), or null
  function findDeduction(st, opts) {
    var all = findAll(st, opts);
    return all ? all[0] : null;
  }
  function applyDeduction(st, d) {
    if (d.place >= 0) { if (st.isCand(d.place)) st.place(d.place); }
    else st.eliminate(d.elim);
  }

  // ------------------------------------------------------------------
  // Grading
  // ------------------------------------------------------------------
  function scratch(L) {
    var s = L._st || (L._st = new State(L));
    return s.reset();
  }
  // The easiest route: each round applies every step at the lowest price available.
  // Returns { solved, rounds: [price per round], score (sum), ceiling (highest price),
  //   steps, techs (steps of each technique), remaining, solution?, log? (the steps of each round) }
  function route(L, opts, record) {
    var st = scratch(L), N = L.N, rounds = [], log = record ? [] : null, score = 0, ceiling = 0, steps = 0;
    var techs = { single: 0, confine: 0, squeeze: 0, pigeon: 0, whatif: 0 };
    while (st.nStars < N) {
      var ds = findAll(st, opts);
      if (!ds || ds[0].contradiction) {
        return { solved: false, contradiction: !!ds, rounds: rounds, score: score, ceiling: ceiling, steps: steps, techs: techs,
          remaining: st.candCount() + (N - st.nStars), stars: st.nStars, log: log };
      }
      var p = ds[0].price;
      for (var i = 0; i < ds.length; i++) { applyDeduction(st, ds[i]); techs[ds[i].tech]++; }
      rounds.push(p); score += p; steps += ds.length;
      if (p > ceiling) ceiling = p;
      if (log) log.push(ds);
    }
    var sol = [];
    for (var j = 0; j < L.G.NN; j++) if (st.isStar(j)) sol.push(j);
    return { solved: true, rounds: rounds, score: score, ceiling: ceiling, steps: steps, techs: techs, remaining: 0, solution: sol, log: log };
  }
  // How many times a solver must use a step priced `lo` or more, whatever order
  // it solves in (Infinity if the board can't be finished).
  function bottlenecks(L, lo, opts) {
    var st = scratch(L), N = L.N, n = 0, full = !!(opts && opts.full);
    var maxPrice = opts && opts.maxPrice != null ? opts.maxPrice : Infinity, below = { maxPrice: Math.min(lo - 1e-9, maxPrice), full: full };
    for (;;) {
      for (;;) {
        if (st.nStars === N) return n;
        var ds = findAll(st, below);
        if (!ds) break;
        if (ds[0].contradiction) return Infinity;
        for (var i = 0; i < ds.length; i++) applyDeduction(st, ds[i]);
      }
      // stuck below lo: every remaining step is priced lo or more; take them all
      st.computeHits();
      var hard = counts(st, maxPrice, full, true), dmax = whatIfDepth(Infinity, maxPrice, full);
      if (dmax >= 0) hard = hard.concat(whatIfs(st, dmax, true));
      if (!hard.length) return Infinity;
      for (var j = 0; j < hard.length; j++) applyDeduction(st, hard[j]);
      n++;
    }
  }
  // Grade figures for a board: the route plus the bottleneck counts the tiers need
  function profile(L, opts, record) {
    var r = route(L, opts, record);
    if (!r.solved) return r;
    r.pairs = r.ceiling >= PAIR && r.ceiling <= 5 ? bottlenecks(L, PAIR, opts) : 0;
    r.experts = r.ceiling >= EXPERT ? bottlenecks(L, EXPERT, opts) : 0;
    return r;
  }
  // Difficulty label from a profile (made with the game's steps)
  function gradeOf(p, n) {
    if (!p.solved) return 'Unsolvable';
    if (p.ceiling <= P_CONFINE) return 'Easy';
    if (p.ceiling <= 5 && p.pairs <= (small(n) ? 1 : 2)) return 'Medium';
    if (small(n)) return 'Hard';                                // small boards top out at Hard
    if (p.experts >= 2) return 'Expert';
    return 'Hard';
  }

  // ------------------------------------------------------------------
  // Exact solver: counts solutions (stops at `limit`)
  // ------------------------------------------------------------------
  function countSolutions(N, reg, limit) {
    limit = limit || 2;
    var full = (1 << N) - 1, i;
    var regRowMask = new Int32Array(N);
    for (i = 0; i < N * N; i++) regRowMask[reg[i]] |= 1 << ((i / N) | 0);
    var count = 0, sol = new Int8Array(N), first = null, nodes = 0;
    function rec(r, usedC, usedG, prev) {
      nodes++;
      if (r === N) { count++; if (!first) first = Array.prototype.slice.call(sol); return count >= limit; }
      var rowsLeft = full & ~((1 << r) - 1);
      for (var g = 0; g < N; g++) if (!((usedG >> g) & 1) && !(regRowMask[g] & rowsLeft)) return false;
      var avail = full & ~usedC;
      if (prev >= 0) avail &= ~((7 << prev) >> 1);
      var base = r * N;
      while (avail) {
        var b = avail & -avail; avail ^= b;
        var c = 31 - Math.clz32(b);
        var gg = reg[base + c];
        if ((usedG >> gg) & 1) continue;
        sol[r] = c;
        if (rec(r + 1, usedC | b, usedG | (1 << gg), c)) return true;
      }
      return false;
    }
    rec(0, 0, 0, -1);
    return { count: count, solution: first, nodes: nodes };
  }

  // ------------------------------------------------------------------
  // Generator
  // ------------------------------------------------------------------
  function shuffle(a, rng) {
    for (var i = a.length - 1; i > 0; i--) { var j = (rng() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // Random placement of N non-touching stars, one per row and column
  function randomSolution(N, rng) {
    var p = new Int8Array(N), used = new Uint8Array(N);
    function rec(r) {
      if (r === N) return true;
      var order = shuffle(Array.from({ length: N }, function (_, i) { return i; }), rng);
      for (var k = 0; k < N; k++) {
        var c = order[k];
        if (used[c]) continue;
        if (r > 0 && Math.abs(c - p[r - 1]) <= 1) continue;
        p[r] = c; used[c] = 1;
        if (rec(r + 1)) return true;
        used[c] = 0;
      }
      return false;
    }
    rec(0);
    return p;
  }

  // Grow N regions from the star cells (region g owns the star of row g)
  function growRegions(N, sol, rng, style) {
    var G = geometry(N), NN = N * N, reg = new Int8Array(NN).fill(-1), size = new Int32Array(N);
    var i, g;
    for (g = 0; g < N; g++) { reg[g * N + sol[g]] = g; size[g] = 1; }
    var left = NN - N;
    var weight = new Float64Array(N);
    for (g = 0; g < N; g++) weight[g] = style === 1 ? 0.3 + rng() * 2.5 : 1;
    while (left > 0) {
      // pick a frontier cell
      var fr = [];
      for (i = 0; i < NN; i++) {
        if (reg[i] !== -1) continue;
        var nb = G.nei4[i];
        for (var k = 0; k < nb.length; k++) if (reg[nb[k]] !== -1) { fr.push(i); break; }
      }
      // choose cell, then a neighbouring region (weighted)
      var cell = fr[(rng() * fr.length) | 0];
      var opts = [], tot = 0;
      var nb2 = G.nei4[cell];
      for (k = 0; k < nb2.length; k++) {
        var gg = reg[nb2[k]];
        if (gg === -1) continue;
        var wgt = weight[gg] / (style === 2 ? Math.sqrt(size[gg]) : 1);
        opts.push(gg); opts.push(wgt); tot += wgt;
      }
      var rr = rng() * tot, pick = opts[0];
      for (k = 0; k < opts.length; k += 2) { rr -= opts[k + 1]; if (rr <= 0) { pick = opts[k]; break; } }
      reg[cell] = pick; size[pick]++; left--;
    }
    return reg;
  }

  // Is region g still connected if cell x is removed?
  function connectedWithout(N, reg, g, x, starCell, size, buf) {
    var G = geometry(N), nb = G.nei4[x], same = 0, k;
    for (k = 0; k < nb.length; k++) if (reg[nb[k]] === g) same++;
    if (same <= 1) return true;
    // BFS from the star cell
    var seen = buf.seen, q = buf.q, stamp = ++buf.stamp;
    var head = 0, tail = 0;
    q[tail++] = starCell; seen[starCell] = stamp; seen[x] = stamp;
    var cntv = 1;
    while (head < tail) {
      var c = q[head++], nn = G.nei4[c];
      for (k = 0; k < nn.length; k++) {
        var y = nn[k];
        if (seen[y] === stamp || reg[y] !== g) continue;
        seen[y] = stamp; q[tail++] = y; cntv++;
      }
    }
    return cntv === size - 1;
  }

  // Simulated annealing over region layouts.
  // opts: { N, seed|rng, iters, T0, T1, maxPrice (steps allowed), full,
  //         objective(res) -> number, shape (boundary weight), minSize, maxSize,
  //         accept(res, f, L) -> bool (stop early), deadline (ms timestamp), solution, regions }
  function anneal(opts) {
    var N = opts.N || 10, rng = opts.rng || makeRng(opts.seed || ((Math.random() * 4294967296) >>> 0));
    var NN = N * N, G = geometry(N), nei4 = G.nei4;
    var iters = opts.iters || 20000, T0 = opts.T0 != null ? opts.T0 : 8, T1 = opts.T1 != null ? opts.T1 : 0.3;
    var steps = { maxPrice: opts.maxPrice != null ? opts.maxPrice : Infinity, full: !!opts.full };
    var objective = opts.objective || function (res) { return res.score; };
    var lamB = opts.shape != null ? opts.shape : 0, minS = opts.minSize || 1, maxS = opts.maxSize || NN;
    var sol = opts.solution || randomSolution(N, rng);
    var reg = opts.regions ? Int8Array.from(opts.regions) : null;
    if (!reg) {
      // grow a starting layout whose region sizes are within bounds (best effort)
      for (var tries = 0; tries < 60; tries++) {
        reg = growRegions(N, sol, rng, opts.style != null ? opts.style : (tries < 30 ? (rng() * 3) | 0 : 2));
        var sz = new Int32Array(N), okSz = true;
        for (var q = 0; q < NN; q++) sz[reg[q]]++;
        for (q = 0; q < N; q++) if (sz[q] < (opts.minSize || 1) || sz[q] > (opts.maxSize || NN)) okSz = false;
        if (okSz) break;
      }
    }
    var starCell = new Int32Array(N), size = new Int32Array(N), isStar = new Uint8Array(NN), i, g, k;
    for (i = 0; i < NN; i++) size[reg[i]]++;
    for (g = 0; g < N; g++) { starCell[g] = g * N + sol[g]; isStar[g * N + sol[g]] = 1; }
    for (g = 0; g < N; g++) if (reg[starCell[g]] !== g) throw new Error('region labels must follow solution rows');
    var boundary = 0;
    for (i = 0; i < NN; i++) for (k = 0; k < nei4[i].length; k++) if (nei4[i][k] > i && reg[nei4[i][k]] !== reg[i]) boundary++;
    function sizePen() {
      var p = 0;
      for (var q = 0; q < N; q++) { if (size[q] < minS) p += minS - size[q]; if (size[q] > maxS) p += size[q] - maxS; }
      return p;
    }
    var L = new Layout(N);
    var buf = { seen: new Int32Array(NN), q: new Int32Array(NN), stamp: 0 };
    var evals = 0;
    function evaluate() {
      L.set(reg); evals++;
      var res = route(L, steps, false);
      var f = res.solved ? objective(res) : -10 - res.remaining * 0.6;
      f -= lamB * boundary + 25 * sizePen();
      return { f: f, res: res, ok: res.solved && sizePen() === 0 };
    }
    var cur = evaluate(), best = null, bestF = -Infinity;
    if (cur.ok) { best = { regions: Int8Array.from(reg), res: cur.res, f: cur.f }; bestF = cur.f; }
    var deadline = opts.deadline || Infinity, it;
    for (it = 0; it < iters; it++) {
      if ((it & 31) === 0 && Date.now() > deadline) break;
      var T = T0 * Math.pow(T1 / T0, it / iters);
      // propose: move a border cell into a neighbouring region
      var x = (rng() * NN) | 0;
      if (isStar[x]) continue;
      var nb = nei4[x], y = nb[(rng() * nb.length) | 0];
      var from = reg[x], to = reg[y];
      if (from === to) continue;
      if (size[from] - 1 < minS || size[to] + 1 > maxS) continue;
      if (!connectedWithout(N, reg, from, x, starCell[from], size[from], buf)) continue;
      var dB = 0;
      for (k = 0; k < nb.length; k++) { var rn = reg[nb[k]]; dB += (rn !== to ? 1 : 0) - (rn !== from ? 1 : 0); }
      reg[x] = to; size[from]--; size[to]++; boundary += dB;
      var nxt = evaluate();
      if (nxt.f >= cur.f || rng() < Math.exp((nxt.f - cur.f) / T)) {
        cur = nxt;
        if (nxt.ok && nxt.f > bestF) {
          bestF = nxt.f; best = { regions: Int8Array.from(reg), res: nxt.res, f: nxt.f, boundary: boundary };
          if (opts.accept && opts.accept(nxt.res, nxt.f, L)) { it++; break; }
        }
      } else {
        reg[x] = from; size[from]++; size[to]--; boundary -= dB;
      }
    }
    if (best) { best.solution = sol; best.iters = it; best.evals = evals; }
    return best;
  }

  // ------------------------------------------------------------------
  // Difficulty tiers + one-call generator (used by the game and the batch tool)
  // ------------------------------------------------------------------
  var TIERS = {
    // steps allowed (price cap), route-price target, acceptance
    Easy:   { maxPrice: P_CONFINE, target: 2.5, lo: 1.5, iters: 150000, T0: 2, T1: 0.1,
              extra: function (r) { return r.techs.confine >= 3; } },
    Medium: { maxPrice: 5, target: 13, lo: 7, iters: 120000, T0: 4, T1: 0.2,
              extra: function (r) { return r.techs.squeeze + r.techs.pigeon >= 4; } },
    Hard:   { maxPrice: IN_GAME, target: 50, lo: 20, iters: 160000, T0: 6, T1: 0.25,
              extra: function (r) { return r.ceiling >= 8; } },
    Expert: { maxPrice: IN_GAME, target: 100, lo: 70, iters: 400000, T0: 12, T1: 0.3,
              extra: function (r) { return r.ceiling >= EXPERT; } }
  };
  // Small boards (6×6) get their own targets: everything scales down, and they top out at
  // Hard, which there means "needs counts or short what-ifs".
  var TIERS_SMALL = {
    Easy:   { maxPrice: P_CONFINE, target: 1.5, lo: 1, iters: 40000, T0: 2, T1: 0.1,
              extra: function (r) { return r.techs.confine >= 1; } },
    Medium: { maxPrice: 5, target: 6, lo: 3, iters: 40000, T0: 3, T1: 0.2,
              extra: function (r) { return r.techs.squeeze + r.techs.pigeon >= 1; } },
    Hard:   { maxPrice: 14, target: 20, lo: 8, iters: 50000, T0: 6, T1: 0.3,
              extra: function (r) { return r.ceiling > 5; } }
  };
  function small(n) { return !!n && n < 9; }
  function tiersFor(n) { return small(n) ? TIERS_SMALL : TIERS; }
  // Does a solved route (made with the game's steps on layout L) belong to this tier?
  function tierAccepts(name, res, L, n) {
    n = n || (L && L.N) || 10;
    var T = tiersFor(n)[name];
    if (!T || !res.solved || res.score < T.lo || !T.extra(res)) return false;
    var p = { solved: true, ceiling: res.ceiling, pairs: 0, experts: 0 };
    if (p.ceiling >= PAIR && p.ceiling <= 5) p.pairs = bottlenecks(L, PAIR, GAME);
    if (!small(n) && p.ceiling >= EXPERT) p.experts = bottlenecks(L, EXPERT, GAME);
    return gradeOf(p, n) === name;
  }
  // generate(tierName, {rng|seed, deadline, N}) -> board or null (if the deadline hit first)
  // board = { regions:Int8Array, solution:[col per row], score, ceiling, grade }
  function generate(name, opts) {
    opts = opts || {};
    var N = opts.N || 10, T = tiersFor(N)[name];
    if (!T) return null;
    var rng = opts.rng || makeRng(opts.seed || ((Math.random() * 4294967296) >>> 0));
    var deadline = opts.deadline || Infinity;
    while (Date.now() < deadline) {
      var best = anneal({
        N: N, rng: rng, iters: T.iters, T0: T.T0, T1: T.T1, maxPrice: T.maxPrice,
        minSize: N >= 9 ? 4 : 3, maxSize: small(N) ? Math.round(N * 1.9) : Math.round(N * N * 0.18), shape: 0.7, deadline: deadline,
        objective: T.maximize ? null : function (res) { return 100 - Math.abs(res.score - T.target); },
        accept: T.maximize ? null : function (res, f, L) { return tierAccepts(name, res, L, N); }
      });
      if (!best) continue;
      // grade with the game's full set of steps (that is what the player and hints use)
      var L = new Layout(N).set(best.regions);
      var res = route(L, GAME, false);
      if (!tierAccepts(name, res, L, N)) continue;
      var sol = [];
      for (var k = 0; k < res.solution.length; k++) sol.push(res.solution[k] % N);
      return { regions: best.regions, solution: sol, score: res.score, ceiling: res.ceiling, grade: name };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Board helpers: encoding, symmetry, ids
  // ------------------------------------------------------------------
  function encode(reg) { var s = ''; for (var i = 0; i < reg.length; i++) s += reg[i].toString(36); return s; }
  function decode(s) { var a = new Int8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = parseInt(s[i], 36); return a; }

  // Canonical relabel: regions numbered in order of first appearance
  function canonical(reg) {
    var map = {}, next = 0, out = new Int8Array(reg.length);
    for (var i = 0; i < reg.length; i++) { var g = reg[i]; if (!(g in map)) map[g] = next++; out[i] = map[g]; }
    return out;
  }
  // Dihedral transform t in 0..7
  function transform(reg, N, t) {
    var out = new Int8Array(N * N);
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      var rr = r, cc = c, tmp;
      if (t & 4) { tmp = rr; rr = cc; cc = tmp; }
      if (t & 1) rr = N - 1 - rr;
      if (t & 2) cc = N - 1 - cc;
      out[rr * N + cc] = reg[r * N + c];
    }
    return out;
  }
  function boardId(reg) {
    var h = 0x811c9dc5, s = encode(canonical(reg));
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    var h2 = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    var A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ', out = '';
    var v = h >>> 0;
    for (i = 0; i < 4; i++) { out += A[v & 31]; v >>>= 5; }
    out += '-';
    v = h2;
    for (i = 0; i < 4; i++) { out += A[v & 31]; v >>>= 5; }
    return out;
  }

  // Analyse a board fully: route, bottlenecks and grade
  function analyse(regions, N, record) {
    N = N || Math.round(Math.sqrt(regions.length));
    var L = new Layout(N).set(regions);
    var res = profile(L, GAME, record);
    res.grade = gradeOf(res, N);
    return res;
  }

  // Build a State from a player's marks: stars[] and dots[] (cell lists)
  function stateFrom(L, stars, dots) {
    var st = new State(L).reset();
    for (var i = 0; i < stars.length; i++) {
      if (!st.isCand(stars[i])) return null; // stars already conflict
      st.place(stars[i]);
    }
    for (i = 0; i < dots.length; i++) { var c = dots[i]; st.cand[c >> 5] &= ~(1 << (c & 31)); }
    return st;
  }

  return {
    W: W, popcnt: popcnt, makeRng: makeRng, geometry: geometry, Layout: Layout, State: State,
    findAll: findAll, findDeduction: findDeduction, applyDeduction: applyDeduction,
    route: route, bottlenecks: bottlenecks, profile: profile, gradeOf: gradeOf,
    countSolutions: countSolutions, randomSolution: randomSolution, growRegions: growRegions, anneal: anneal,
    encode: encode, decode: decode, canonical: canonical, transform: transform, boardId: boardId,
    analyse: analyse, stateFrom: stateFrom, maskCells: maskCells, bits: bits,
    GAME: GAME, FULL: FULL, PRICES: { single: P_SINGLE, confine: P_CONFINE, squeeze: P_SQUEEZE, count: COUNT,
      edge: EDGE, spread: SPREAD, cross: CROSS, whatIf: WHATIF, inGame: IN_GAME, pair: PAIR, expert: EXPERT },
    TIERS: TIERS, TIERS_SMALL: TIERS_SMALL, generate: generate, tierAccepts: tierAccepts
  };
});
