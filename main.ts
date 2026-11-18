// Implied Radar v3 -- token-radar-01. Node 22, standard library only, zero network.
// Reads the sealed snapshot, ranks eligible pre-token protocols by conditional
// implied value if a token were issued, and writes board.json plus the dashboard
// data the page re-derives. Deterministic: one seeded in-file PRNG, fixed seeds,
// no wall-clock dependence in any fitted or printed model number.
//
// Value model (spec v3): a global log-log power-law curve, challenged by a rung
// ladder R0-R4 (curve; + window-relative age percentile; + chain breadth; +
// guarded anonymous-group offsets; + 7-day growth) blended toward the curve in
// prediction space. Selection is nested leave-one-out with group-disjoint inner
// folds; shipping needs gates G1-G4 over nested LOO plus five walk-forward
// origins over the 68 dated comps. Launch odds never enter the primary rank
// (D1). No protocol name, slug, or grouping-field value appears in model code.
// Farm economics use the single assumption registry below; every dollar figure
// derived from it is labeled projected, not measured.
//
// Dashboard function names (the page mirrors this logic for its recompute
// proof): buildCensus, classifyProtocol, selectTradedComps, fitGlobalCurve,
// fitRungModel, selectCandidateInner, computeConformalBands, scoreProtocol,
// computeFarmEconomics, assignVerdict, buildFarmPlan, verifyRecomputeProof.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------- fixed conventions
// Every grid, threshold, fold count, and budget below is a [FIXED] convention
// from the specification, not a fitted claim. All fitted numbers are measured
// on the sealed snapshot at run time.

const FLOOR_REF = 50_000_000; // x centering: log10(tvl / $50M)
const S_GRID = [0, 0.25, 0.5, 0.75, 1];
const LAMBDA_SHIP = [8, 16, 32];
const LAMBDA_ABLATION = [0, 2, 4, 8, 16, 32, Infinity];
const GROUP_MIN_N = 3;
const GROUP_CAP = 0.3; // dex, offset bound
const BLEND_CAP = 0.35; // dex, max |s * (model - curve)|
const COEF_CAP = 0.25; // dex per IQR
const MISS_CAP = 0.15; // dex, missingness effects
const INNER_FOLDS = 5;
const N_PERMUTATIONS = 200;
const N_BOOTSTRAP = 2000;
const N_REFITS = 200;
const G1_FLOOR = 0.008; // dex materiality floor
const G1B_FLOOR = -0.05; // dex, paired-bootstrap lower90 bound
const WF_PREFIXES = [34, 41, 48, 55, 62];
const LAUNCH_SHRINK = 20;
const LAUNCH_CAP_LO = 0.75;
const LAUNCH_CAP_HI = 1.5;
const TEXT_MAX_BYTES = 65_536;

// Exclusion policy input from the kit (input README). This list lives ONLY in
// classifyProtocol; the value model never sees a name, slug, or category text.
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVATIVE_RE = /\b(wrapped|staked|staking)\b/i;

// Assumption registry (D3): the ONLY source of non-snapshot numbers. Every use
// is labeled as an assumption at the point of use in the dashboard.
const ASSUMPTIONS = {
  sizes: [1000, 5000, 10000], // tested deposit sizes, headline is $1,000
  alphaDrop: 0.06, // assumed community drop pool share of FDV
  etaDil: 1.25, // assumed campaign dilution factor on TVL
  rOpp: 0.045, // assumed benchmark yield forgone, APR
  scenarios: [
    { name: 'LOW', tvlDrop: 0.5, shareMult: 0.5, holdDays: 60 },
    { name: 'POINT', tvlDrop: 0.35, shareMult: 1.0, holdDays: 90 },
    { name: 'HIGH', tvlDrop: 0.2, shareMult: 2.0, holdDays: 120 },
  ],
};
// Gas scenarios by primary chain, labeled assumptions, never live gas data.
// The snapshot spells two entries differently from the spec table; both
// spellings map to the same tier and the mapping is disclosed on the page:
// "Binance" is the snapshot name for the spec's BNB entry, and
// "Hyperliquid L1" is the snapshot name for the spec's Hyperliquid entry.
const GAS_TIERS = [
  { names: ['Ethereum'], low: 18, base: 45, high: 110 },
  { names: ['Solana', 'BNB', 'Binance', 'Avalanche', 'Bitcoin', 'Tron', 'Sui', 'Aptos', 'Hyperliquid', 'Hyperliquid L1'], low: 1.5, base: 4, high: 12 },
  { names: ['Arbitrum', 'Optimism', 'Base', 'Polygon', 'Scroll', 'Linea', 'zkSync Era', 'Starknet', 'Blast', 'Mantle', 'Berachain', 'Sonic'], low: 0.8, base: 2.5, high: 8 },
];
const GAS_FALLBACK = { low: 2, base: 6, high: 18 };
const GAS_MULTI = { low: 3, base: 7.5, high: 18 };

// ---------------------------------------------------------------- seeded PRNG
// One xorshift32 per stream, fixed seeds, no Math.random, no Date in model
// code. Streams are independent so each diagnostic reproduces on its own.
function makePrng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function shuffledIndex(n, rand) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// ---------------------------------------------------------------- small statistics
function medianOf(a) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantileSorted(s, p) {
  // Linear-interpolation quantile on an ascending-sorted array.
  if (s.length === 0) return 0;
  if (s.length === 1) return s[0];
  const pos = p * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function quantileOf(a, p) {
  return quantileSorted([...a].sort((x, y) => x - y), p);
}
function conformalQuantile(sortedAsc, p) {
  // Finite-sample conformal quantile: index ceil((n+1)*p), clamped.
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const k = Math.min(n, Math.max(1, Math.ceil((n + 1) * p)));
  return sortedAsc[k - 1];
}
function meanOf(a) {
  return a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length;
}
function ranksWithTies(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const r = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearmanOf(xs, ys) {
  if (xs.length < 3) return 0;
  const rx = ranksWithTies(xs);
  const ry = ranksWithTies(ys);
  const mx = meanOf(rx);
  const my = meanOf(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = rx[i] - mx; const b = ry[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}
function bootstrapSe(diffs, rand, draws) {
  // SE of the mean of paired diffs by row resampling; deterministic stream.
  const n = diffs.length;
  if (n < 2) return 0;
  const means = [];
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rand() * n)];
    means.push(s / n);
  }
  const m = meanOf(means);
  return Math.sqrt(means.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, means.length - 1));
}
function bootstrapLower90(improvements, rand, draws) {
  // 10th percentile of bootstrap means: the paired 90% lower bound.
  const n = improvements.length;
  if (n < 2) return 0;
  const means = [];
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += improvements[Math.floor(rand() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return means[Math.max(0, Math.floor(0.1 * means.length))];
}
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- linear solver + Huber
function solveLinear(A, b) {
  // Gaussian elimination with partial pivoting; A is n x n, mutated copy.
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) M[piv][col] = 1e-12;
    if (piv !== col) { const t = M[col]; M[col] = M[piv]; M[piv] = t; }
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}
function wls(X, y, w, ridge) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    const wi = w[i];
    for (let a = 0; a < p; a++) {
      b[a] += wi * xi[a] * y[i];
      for (let c = a; c < p; c++) A[a][c] += wi * xi[a] * xi[c];
    }
  }
  for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
  for (let a = 1; a < p; a++) A[a][a] += ridge;
  return solveLinear(A, b);
}
// Huber IRLS in log space: tuning constant 1.345 x MAD-scaled residuals,
// 25 iterations or max parameter delta below 1e-9, convergence recorded.
function huberFit(X, y) {
  const n = X.length;
  const p = X[0].length;
  let beta = wls(X, y, new Array(n).fill(1), 1e-6);
  let converged = false;
  let iters = 0;
  for (let it = 0; it < 25; it++) {
    iters = it + 1;
    const res = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let a = 0; a < p; a++) s += X[i][a] * beta[a];
      res[i] = y[i] - s;
    }
    const med = medianOf(res);
    const mad = 1.4826 * medianOf(res.map((r) => Math.abs(r - med)));
    const scale = mad > 1e-12 ? mad : 1e-12;
    const c = 1.345 * scale;
    const w = res.map((r) => {
      const a = Math.abs(r - med);
      return a <= c ? 1 : c / Math.max(a, 1e-12);
    });
    const next = wls(X, y, w, 1e-6);
    let delta = 0;
    for (let a = 0; a < p; a++) delta = Math.max(delta, Math.abs(next[a] - beta[a]));
    beta = next;
    if (delta < 1e-9) { converged = true; break; }
  }
  return { beta, converged, iters };
}

// ---------------------------------------------------------------- snapshot + census
function parseDateDays(text) {
  // Strict YYYY-MM-DD to UTC day count; null when absent or unparseable.
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return Math.floor(ms / 86400000);
}
function parseSnapshot(text) {
  const raw = JSON.parse(text);
  const asOfDays = parseDateDays(raw.as_of);
  const protocols = [...raw.protocols].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { asOf: raw.as_of ?? null, asOfDays, source: raw.source ?? '', floorUsd: raw.floor_usd, protocols, watchlist: [...raw.watchlist] };
}
// One deterministic classifier for every protocol, applied identically to
// candidates, comps, and reference rows. Exclusion is eligibility policy only;
// it never becomes a value penalty.
function classifyProtocol(p) {
  const reasons = [];
  const hasMcap = typeof p.mcap_usd === 'number' && p.mcap_usd > 0;
  const hasId = p.gecko_id != null || p.symbol != null;
  const tokenStatus = hasMcap || hasId ? (hasMcap ? 'recorded' : 'partial') : 'pretoken';
  if (tokenStatus === 'pretoken' && p.mcap_usd != null && !(p.mcap_usd > 0)) {
    // A zero market cap with no identifier records no token.
  }
  if (p.category != null && EXCLUDED_CATEGORIES.has(p.category)) reasons.push('category');
  if (typeof p.name === 'string' && VERSION_RE.test(p.name)) reasons.push('version');
  if (typeof p.name === 'string' && DERIVATIVE_RE.test(p.name)) reasons.push('derivative');
  if (typeof p.name === 'string') {
    for (const ex of EXCHANGE_NAMES) {
      if (p.name === ex || p.name.startsWith(ex) && !/[A-Za-z0-9]/.test(p.name.charAt(ex.length))) { reasons.push('exchange'); break; }
    }
  }
  return { tokenStatus, reasons, excluded: reasons.length > 0, primary: reasons[0] ?? null };
}
function buildCensus(snap) {
  const watch = new Set(snap.watchlist);
  const buckets = {
    hold: { n: 0, tvl: 0, reasons: {} },
    watchlist: { n: 0, tvl: 0, slugs: [] },
    belowFloor: { n: 0, tvl: 0 },
    excludedCategory: { n: 0, tvl: 0 },
    excludedName: { n: 0, tvl: 0 },
    comps: { n: 0, tvl: 0 },
    liveOther: { n: 0, tvl: 0, reasons: {} },
  };
  const classified = new Map();
  for (const p of snap.protocols) {
    const c = classifyProtocol(p);
    classified.set(p.slug, c);
    const badTvl = !(typeof p.tvl_usd === 'number' && p.tvl_usd > 0);
    const badDate = p.listed_at != null && parseDateDays(p.listed_at) === null;
    if (badTvl || badDate) {
      buckets.hold.n++;
      buckets.hold.tvl += typeof p.tvl_usd === 'number' && p.tvl_usd > 0 ? p.tvl_usd : 0;
      const why = badTvl ? 'bad-tvl' : 'bad-date';
      buckets.hold.reasons[why] = (buckets.hold.reasons[why] || 0) + 1;
      continue;
    }
    if (c.tokenStatus === 'pretoken') {
      if (c.excluded) {
        const b = c.primary === 'category' ? buckets.excludedCategory : buckets.excludedName;
        b.n++; b.tvl += p.tvl_usd;
      } else if (watch.has(p.slug)) {
        buckets.watchlist.n++; buckets.watchlist.tvl += p.tvl_usd; buckets.watchlist.slugs.push(p.slug);
      } else {
        buckets.belowFloor.n++; buckets.belowFloor.tvl += p.tvl_usd;
      }
    } else {
      const screen = compScreen(p, c, snap.floorUsd);
      if (screen.ok) { buckets.comps.n++; buckets.comps.tvl += p.tvl_usd; }
      else {
        buckets.liveOther.n++; buckets.liveOther.tvl += p.tvl_usd;
        buckets.liveOther.reasons[screen.reason] = (buckets.liveOther.reasons[screen.reason] || 0) + 1;
      }
    }
  }
  const total = Object.values(buckets).reduce((s, b) => s + b.n, 0);
  return { buckets, classified, total, watchlistCovered: buckets.watchlist.n };
}
// The comp screen: recorded token + TVL floor + identical exclusion screen +
// dust/integrity filter. Counts and reasons are printed, never hidden.
function compScreen(p, c, floorUsd) {
  const cls = c ?? classifyProtocol(p);
  if (cls.tokenStatus === 'partial') return { ok: false, reason: 'missing-mcap' };
  if (cls.tokenStatus !== 'recorded') return { ok: false, reason: 'no-token' };
  if (!(typeof p.mcap_usd === 'number' && p.mcap_usd > 0) || !(p.gecko_id != null || p.symbol != null)) return { ok: false, reason: 'no-token-record' };
  if (!(p.tvl_usd >= 5000000)) return { ok: false, reason: 'below-5m' };
  if (cls.excluded) return { ok: false, reason: `excluded-${cls.primary}` };
  if (!(p.mcap_usd >= 100000)) return { ok: false, reason: 'dust-mcap' };
  const ratio = p.mcap_usd / p.tvl_usd;
  if (!(ratio >= 0.005 && ratio <= 500)) return { ok: false, reason: 'ratio-window' };
  return { ok: true, reason: '' };
}
function selectTradedComps(snap, classified) {
  const comps = [];
  const excluded = {};
  for (const p of snap.protocols) {
    const c = classified.get(p.slug);
    if (c.tokenStatus === 'pretoken') continue;
    if (!(typeof p.tvl_usd === 'number' && p.tvl_usd > 0)) continue;
    if (p.listed_at != null && parseDateDays(p.listed_at) === null) continue;
    const s = compScreen(p, c, snap.floorUsd);
    if (s.ok) comps.push(p);
    else excluded[s.reason] = (excluded[s.reason] || 0) + 1;
  }
  return { comps, excluded };
}

// ---------------------------------------------------------------- feature context
// All imputation, scaling, winsorization, percentile, group-map, and cap
// constants are recomputed from the current training fold only. The grouping
// field's values map to opaque integer ids by sorted order, rebuilt per fold;
// model code never sees a literal grouping value.
function buildContext(train, asOfDays, opts = {}) {
  const ageMode = opts.ageMode ?? 'percentile';
  const daysOf = (p) => {
    const d = parseDateDays(p.listed_at);
    if (d === null || asOfDays === null) return null;
    const days = asOfDays - d;
    return days < 0 ? null : days;
  };
  const trainDays = train.map(daysOf).filter((d) => d !== null);
  const sortedDays = [...trainDays].sort((a, b) => a - b);
  const pctOf = (d) => {
    if (sortedDays.length === 0) return 0.5;
    let k = 0;
    for (const v of sortedDays) if (v <= d) k++;
    return k / sortedDays.length;
  };
  const trainPcts = trainDays.map(pctOf);
  const ageMed = medianOf(trainPcts.length ? trainPcts : [0.5]);
  const ageQ1 = quantileOf(trainPcts.length ? trainPcts : [0.5], 0.25);
  const ageQ3 = quantileOf(trainPcts.length ? trainPcts : [0.5], 0.75);
  const ageIqr = ageQ3 - ageQ1;
  const rawAges = trainDays.map((d) => Math.log1p(d));
  const ageRawMed = medianOf(rawAges.length ? rawAges : [0]);
  const ageRawQ1 = quantileOf(rawAges.length ? rawAges : [0], 0.25);
  const ageRawQ3 = quantileOf(rawAges.length ? rawAges : [0], 0.75);
  const ageRawIqr = ageRawQ3 - ageRawQ1;
  const ageRawLo = quantileOf(rawAges.length ? rawAges : [0], 0.01);
  const ageRawHi = quantileOf(rawAges.length ? rawAges : [0], 0.99);
  const chainCount = (p) => (Array.isArray(p.chains) ? p.chains.length : null);
  const brRawAll = train.map((p) => (chainCount(p) === null ? null : Math.log1p(chainCount(p)))).filter((v) => v !== null);
  const brLo = quantileOf(brRawAll.length ? brRawAll : [0], 0.01);
  const brHi = quantileOf(brRawAll.length ? brRawAll : [0], 0.99);
  const brWin = brRawAll.map((v) => Math.min(brHi, Math.max(brLo, v)));
  const brMed = medianOf(brWin.length ? brWin : [0]);
  const brIqr = quantileOf(brWin.length ? brWin : [0], 0.75) - quantileOf(brWin.length ? brWin : [0], 0.25);
  const growths = train.map((p) => p.change_7d).filter((g) => typeof g === 'number' && Number.isFinite(g));
  const gScale = medianOf(growths.map((g) => Math.abs(g)));
  const grRawAll = growths.map((g) => Math.asinh(gScale > 0 ? g / gScale : 0));
  const grLo = quantileOf(grRawAll.length ? grRawAll : [0], 0.01);
  const grHi = quantileOf(grRawAll.length ? grRawAll : [0], 0.99);
  const grWin = grRawAll.map((v) => Math.min(grHi, Math.max(grLo, v)));
  const grMed = medianOf(grWin.length ? grWin : [0]);
  const grIqr = quantileOf(grWin.length ? grWin : [0], 0.75) - quantileOf(grWin.length ? grWin : [0], 0.25);
  const groupValues = [...new Set(train.map((p) => p.category).filter((v) => v != null))].sort();
  const groupMap = new Map(groupValues.map((v, i) => [v, i]));
  const groupCounts = new Map();
  for (const p of train) {
    const g = p.category == null ? -1 : groupMap.get(p.category);
    groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  }
  const flatMed = medianOf(train.filter((p) => typeof p.mcap_usd === 'number' && p.mcap_usd > 0).map((p) => Math.log10(p.mcap_usd / p.tvl_usd)));
  const ctx = {
    train, asOfDays, ageMode, daysOf, pctOf, ageMed, ageIqr, ageRawMed, ageRawIqr, ageRawLo, ageRawHi,
    brLo, brHi, brMed, brIqr, gScale, grLo, grHi, grMed, grIqr, groupMap, groupCounts, flatMed,
    gidOf: (p) => (p.category == null ? -1 : (groupMap.get(p.category) ?? -1)),
  };
  ctx.feat = (p) => featuresOf(p, ctx);
  // Interiority box: per-fold 5th-95th percentiles of the three standardized
  // features over the fitting window.
  const feats = train.map((p) => ctx.feat(p));
  ctx.box = {
    age: [quantileOf(feats.map((f) => f[1]), 0.05), quantileOf(feats.map((f) => f[1]), 0.95)],
    br: [quantileOf(feats.map((f) => f[3]), 0.05), quantileOf(feats.map((f) => f[3]), 0.95)],
    gr: [quantileOf(feats.map((f) => f[5]), 0.05), quantileOf(feats.map((f) => f[5]), 0.95)],
  };
  ctx.outsideBox = (f) => f[1] < ctx.box.age[0] || f[1] > ctx.box.age[1] || f[3] < ctx.box.br[0] || f[3] > ctx.box.br[1] || f[5] < ctx.box.gr[0] || f[5] > ctx.box.gr[1];
  return ctx;
}
function featuresOf(p, ctx) {
  // [x_tvl, ageStd, ageMiss, brStd, brMiss, grStd, grMiss]; gid separate.
  const x = Math.log10(p.tvl_usd / FLOOR_REF);
  const days = ctx.daysOf(p);
  let ageStd;
  let ageMiss = 0;
  if (ctx.ageMode === 'raw') {
    if (days === null) { ageStd = 0; ageMiss = 1; }
    else {
      const w = Math.min(ctx.ageRawHi, Math.max(ctx.ageRawLo, Math.log1p(days)));
      ageStd = ctx.ageRawIqr > 0 ? (w - ctx.ageRawMed) / ctx.ageRawIqr : 0;
    }
  } else {
    if (days === null) { ageStd = 0; ageMiss = 1; }
    else {
      const pct = ctx.pctOf(days);
      ageStd = ctx.ageIqr > 0 ? (pct - ctx.ageMed) / ctx.ageIqr : 0;
    }
  }
  const cc = Array.isArray(p.chains) ? p.chains.length : null;
  let brStd = 0;
  let brMiss = 0;
  if (cc === null) { brMiss = 1; }
  else {
    const w = Math.min(ctx.brHi, Math.max(ctx.brLo, Math.log1p(cc)));
    brStd = ctx.brIqr > 0 ? (w - ctx.brMed) / ctx.brIqr : 0;
  }
  let grStd = 0;
  let grMiss = 0;
  if (typeof p.change_7d !== 'number' || !Number.isFinite(p.change_7d)) { grMiss = 1; }
  else {
    const w = Math.min(ctx.grHi, Math.max(ctx.grLo, Math.asinh(ctx.gScale > 0 ? p.change_7d / ctx.gScale : 0)));
    grStd = ctx.grIqr > 0 ? (w - ctx.grMed) / ctx.grIqr : 0;
  }
  return [x, ageStd, ageMiss, brStd, brMiss, grStd, grMiss];
}
const RUNG_COLS = { 0: [0], 1: [0, 1, 2], 2: [0, 1, 2, 3, 4], 3: [0, 1, 2, 3, 4], 4: [0, 1, 2, 3, 4, 5, 6] };
const COL_KIND = ['x', 'age', 'ageMiss', 'br', 'brMiss', 'gr', 'grMiss'];
function clipBeta(beta, cols) {
  const out = [...beta];
  for (let k = 0; k < cols.length; k++) {
    const kind = COL_KIND[cols[k]];
    if (kind === 'x') continue;
    const cap = kind.endsWith('Miss') ? MISS_CAP : COEF_CAP;
    out[k + 1] = Math.min(cap, Math.max(-cap, out[k + 1]));
  }
  return out;
}
function fitGlobalCurve(train, ctx) {
  const X = train.map((p) => [1, Math.log10(p.tvl_usd / FLOOR_REF)]);
  const y = train.map((p) => Math.log10(p.mcap_usd));
  const fit = huberFit(X, y);
  return { beta: fit.beta, converged: fit.converged, iters: fit.iters };
}
function designRows(rows, ctx, cols) {
  return rows.map((p) => {
    const f = ctx.feat(p);
    return [1, ...cols.map((c) => f[c])];
  });
}
function groupOffsetsFor(train, ctx, beta, cols, lambda) {
  // Huber-weighted mean residuals per group, shrunk, support-guarded, capped.
  const X = designRows(train, ctx, cols);
  const res = train.map((p, i) => {
    let s = 0;
    for (let a = 0; a < beta.length; a++) s += X[i][a] * beta[a];
    return Math.log10(p.mcap_usd) - s;
  });
  const med = medianOf(res);
  const mad = 1.4826 * medianOf(res.map((r) => Math.abs(r - med)));
  const scale = mad > 1e-12 ? mad : 1e-12;
  const c = 1.345 * scale;
  const acc = new Map();
  train.forEach((p, i) => {
    const g = ctx.gidOf(p);
    if (g < 0) return;
    const a = Math.abs(res[i] - med);
    const w = a <= c ? 1 : c / Math.max(a, 1e-12);
    const e = acc.get(g) ?? { sw: 0, swr: 0, n: 0 };
    e.sw += w; e.swr += w * res[i]; e.n += 1;
    acc.set(g, e);
  });
  const offsets = new Map();
  for (const [g, e] of acc) {
    const support = ctx.groupCounts.get(g) ?? e.n;
    if (support < GROUP_MIN_N) { offsets.set(g, 0); continue; }
    const mean = e.sw > 0 ? e.swr / e.sw : 0;
    const u = (support / (support + lambda)) * mean;
    offsets.set(g, Math.min(GROUP_CAP, Math.max(-GROUP_CAP, u)));
  }
  return offsets;
}
// fitRungModel: base Huber fit, group effects, refit, recompute, stop (at most
// two passes). baseBeta may be supplied to share the lambda-free first pass.
function fitRungModel(train, ctx, rung, lambda, baseBeta) {
  const cols = RUNG_COLS[rung];
  const y = train.map((p) => Math.log10(p.mcap_usd));
  if (rung < 3) {
    const fit = huberFit(designRows(train, ctx, cols), y);
    return { beta: clipBeta(fit.beta, cols), offsets: null, cols, converged: fit.converged };
  }
  const beta1 = baseBeta ?? clipBeta(huberFit(designRows(train, ctx, cols), y).beta, cols);
  const off1 = groupOffsetsFor(train, ctx, beta1, cols, lambda);
  const yAdj = train.map((p, i) => y[i] - (off1.get(ctx.gidOf(p)) ?? 0));
  const fit2 = huberFit(designRows(train, ctx, cols), yAdj);
  const beta2 = clipBeta(fit2.beta, cols);
  // Recompute effects against the refit, then stop.
  const X = designRows(train, ctx, cols);
  const res2 = train.map((p, i) => {
    let s = 0;
    for (let a = 0; a < beta2.length; a++) s += X[i][a] * beta2[a];
    return y[i] - s;
  });
  const med = medianOf(res2);
  const mad = 1.4826 * medianOf(res2.map((r) => Math.abs(r - med)));
  const scale = mad > 1e-12 ? mad : 1e-12;
  const c = 1.345 * scale;
  const acc = new Map();
  train.forEach((p, i) => {
    const g = ctx.gidOf(p);
    if (g < 0) return;
    const a = Math.abs(res2[i] - med);
    const w = a <= c ? 1 : c / Math.max(a, 1e-12);
    const e = acc.get(g) ?? { sw: 0, swr: 0, n: 0 };
    e.sw += w; e.swr += w * res2[i]; e.n += 1;
    acc.set(g, e);
  });
  const offsets = new Map();
  for (const [g, e] of acc) {
    const support = ctx.groupCounts.get(g) ?? e.n;
    if (support < GROUP_MIN_N) { offsets.set(g, 0); continue; }
    const mean = e.sw > 0 ? e.swr / e.sw : 0;
    const u = (support / (support + lambda)) * mean;
    offsets.set(g, Math.min(GROUP_CAP, Math.max(-GROUP_CAP, u)));
  }
  return { beta: beta2, offsets, cols, converged: fit2.converged };
}
function scoreProtocol(p, ctx, curveBeta, rungFit, s) {
  // Prediction-space blend: curve + s * (model - curve), hard displacement
  // cap, interiority fallback to the curve outside the support box.
  const f = ctx.feat(p);
  const curve = curveBeta[0] + curveBeta[1] * f[0];
  if (!rungFit || s === 0) return { pred: curve, sEff: 0, outside: ctx.outsideBox(f) };
  let sEff = s;
  if (ctx.outsideBox(f)) sEff = 0;
  let model = rungFit.beta[0];
  for (let k = 0; k < rungFit.cols.length; k++) model += rungFit.beta[k + 1] * f[rungFit.cols[k]];
  if (rungFit.offsets) model += rungFit.offsets.get(ctx.gidOf(p)) ?? 0;
  let delta = sEff * (model - curve);
  delta = Math.min(BLEND_CAP, Math.max(-BLEND_CAP, delta));
  return { pred: curve + delta, sEff, outside: ctx.outsideBox(f) };
}

// ---------------------------------------------------------------- inner selection
function groupDisjointFolds(train, ctx) {
  // Groups dealt round-robin to folds over anonymous ids sorted by group size
  // descending, then id ascending, so large groups spread one per fold.
  // Rows with no group carry no group signal and are dealt one by one.
  const groups = new Map();
  const nullIdx = [];
  train.forEach((p, i) => {
    const g = ctx.gidOf(p);
    if (g < 0) nullIdx.push(i);
    else {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    }
  });
  const ordered = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] - b[0]));
  const folds = new Array(train.length);
  ordered.forEach(([g, idxs], k) => {
    const f = k % INNER_FOLDS;
    for (const i of idxs) folds[i] = f;
  });
  nullIdx.sort((a, b) => (train[a].slug < train[b].slug ? -1 : train[a].slug > train[b].slug ? 1 : 0));
  nullIdx.forEach((i, k) => { folds[i] = k % INNER_FOLDS; });
  return folds;
}
function foldAuditOf(train, ctx, folds) {
  const out = [];
  for (let f = 0; f < INNER_FOLDS; f++) {
    const idx = train.map((_, i) => i).filter((i) => folds[i] === f);
    const sizes = new Map();
    for (const i of idx) {
      const g = ctx.gidOf(train[i]);
      if (g >= 0) sizes.set(g, (sizes.get(g) ?? 0) + 1);
    }
    out.push({ n: idx.length, groups: sizes.size, maxGroup: sizes.size ? Math.max(...sizes.values()) : 0 });
  }
  return out;
}
function buildCombos(mode, fixed) {
  const combos = [];
  const push = (rung, lambda, s) => combos.push({ rung, lambda, s, index: combos.length });
  if (mode === 'full') {
    push(0, null, 0);
    for (const rung of [1, 2]) for (const s of S_GRID) push(rung, null, s);
    for (const rung of [3, 4]) for (const lam of LAMBDA_SHIP) for (const s of S_GRID) push(rung, lam, s);
  } else if (mode === 'lambda') {
    if (fixed.rung < 3) push(fixed.rung, null, fixed.s);
    else for (const lam of LAMBDA_SHIP) push(fixed.rung, lam, fixed.s);
  } else if (mode === 'fixed') {
    push(fixed.rung, fixed.lambda ?? null, fixed.s);
  }
  return combos;
}
function compareCombos(a, b) {
  // Inner-fold tie-breaks: median error, Spearman, fewer terms (lower rung),
  // larger lambda (more shrinkage), fixed candidate order.
  if (a.med !== b.med) return a.med - b.med;
  if (a.spear !== b.spear) return b.spear - a.spear;
  if (a.rung !== b.rung) return a.rung - b.rung;
  const la = a.lambda ?? -1;
  const lb = b.lambda ?? -1;
  if (la !== lb) return lb - la;
  return a.index - b.index;
}
// selectCandidateInner: 5-fold group-disjoint CV over the candidate menu.
// Every fit inside uses only its fold's training rows; group maps and feature
// constants are rebuilt per fold from fold-train values only.
function selectCandidateInner(train, ctx, mode, fixed) {
  const combos = buildCombos(mode, fixed);
  const folds = groupDisjointFolds(train, ctx);
  const yAll = train.map((p) => Math.log10(p.mcap_usd));
  const oof = combos.map(() => new Array(train.length).fill(0));
  for (let f = 0; f < INNER_FOLDS; f++) {
    const subTrain = train.filter((_, i) => folds[i] !== f);
    const subCtx = buildContext(subTrain, ctx.asOfDays, { ageMode: ctx.ageMode });
    const curve = fitGlobalCurve(subTrain, subCtx);
    const fits = new Map();
    const needRungs = new Set(combos.map((c) => c.rung));
    for (const rung of needRungs) {
      if (rung === 0) continue;
      const cols = RUNG_COLS[rung];
      const ySub = subTrain.map((p) => Math.log10(p.mcap_usd));
      const base = clipBeta(huberFit(designRows(subTrain, subCtx, cols), ySub).beta, cols);
      if (rung < 3) {
        fits.set(`${rung}|`, { beta: base, offsets: null, cols });
      } else {
        for (const lam of new Set(combos.filter((c) => c.rung === rung).map((c) => c.lambda))) {
          fits.set(`${rung}|${lam}`, fitRungModel(subTrain, subCtx, rung, lam, base));
        }
      }
    }
    train.forEach((p, i) => {
      if (folds[i] !== f) return;
      combos.forEach((c, ci) => {
        if (c.rung === 0) {
          oof[ci][i] = curve.beta[0] + curve.beta[1] * Math.log10(p.tvl_usd / FLOOR_REF);
        } else {
          oof[ci][i] = scoreProtocol(p, subCtx, curve.beta, fits.get(`${c.rung}|${c.lambda ?? ''}`), c.s).pred;
        }
      });
    });
  }
  const table = combos.map((c, ci) => {
    const absErrs = oof[ci].map((pr, i) => Math.abs(pr - yAll[i]));
    return { ...c, med: medianOf(absErrs), spear: spearmanOf(oof[ci], yAll) };
  });
  const sorted = [...table].sort(compareCombos);
  return { selected: sorted[0], table, foldAudit: foldAuditOf(train, ctx, folds) };
}

// ---------------------------------------------------------------- nested LOO + walk-forward
const CANDIDATES = [{ rung: 0, s: 0 }];
for (const rung of [1, 2, 3, 4]) for (const s of S_GRID) CANDIDATES.push({ rung, s });
function looForCandidate(comps, rung, s) {
  const preds = new Array(comps.length);
  const flatPreds = new Array(comps.length);
  const lambdas = [];
  const y = comps.map((p) => Math.log10(p.mcap_usd));
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, k) => k !== i);
    const ctx = buildContext(train, ctxAsOf);
    const curve = fitGlobalCurve(train, ctx);
    flatPreds[i] = Math.log10(comps[i].tvl_usd) + ctx.flatMed;
    let lambda = null;
    if (rung >= 3) {
      lambda = selectCandidateInner(train, ctx, 'lambda', { rung, s }).selected.lambda;
      lambdas.push(lambda);
    }
    const fit = rung === 0 ? null : fitRungModel(train, ctx, rung, lambda);
    preds[i] = scoreProtocol(comps[i], ctx, curve.beta, fit, s).pred;
  }
  const absErrs = preds.map((pr, i) => Math.abs(pr - y[i]));
  const flatAbs = flatPreds.map((pr, i) => Math.abs(pr - y[i]));
  return { preds, absErrs, med: medianOf(absErrs), mult: Math.pow(10, medianOf(absErrs)), spear: spearmanOf(preds, y), flatMed: medianOf(flatAbs), flatSpear: spearmanOf(flatPreds, y), lambdas };
}
let ctxAsOf = null; // set once from the snapshot; the reference date only.
function looProcedure(comps) {
  const preds = new Array(comps.length);
  const selections = [];
  const y = comps.map((p) => Math.log10(p.mcap_usd));
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, k) => k !== i);
    const ctx = buildContext(train, ctxAsOf);
    const sel = selectCandidateInner(train, ctx, 'full').selected;
    selections.push(sel);
    const curve = fitGlobalCurve(train, ctx);
    const fit = sel.rung === 0 ? null : fitRungModel(train, ctx, sel.rung, sel.lambda);
    preds[i] = scoreProtocol(comps[i], ctx, curve.beta, fit, sel.s).pred;
  }
  const absErrs = preds.map((pr, i) => Math.abs(pr - y[i]));
  return { preds, absErrs, med: medianOf(absErrs), mult: Math.pow(10, medianOf(absErrs)), spear: spearmanOf(preds, y), selections };
}
function shippedModelLoo(comps, rung, lambda, s) {
  const preds = new Array(comps.length);
  const y = comps.map((p) => Math.log10(p.mcap_usd));
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, k) => k !== i);
    const ctx = buildContext(train, ctxAsOf);
    const curve = fitGlobalCurve(train, ctx);
    const fit = rung === 0 ? null : fitRungModel(train, ctx, rung, lambda);
    preds[i] = scoreProtocol(comps[i], ctx, curve.beta, fit, s).pred;
  }
  const absErrs = preds.map((pr, i) => Math.abs(pr - y[i]));
  const signed = preds.map((pr, i) => y[i] - pr);
  return { preds, absErrs, signed, med: medianOf(absErrs), mult: Math.pow(10, medianOf(absErrs)), spear: spearmanOf(preds, y) };
}
function wfForCandidate(dated, rung, s) {
  // Five expanding origins; train prefixes and test blocks are [FIXED].
  const origins = [];
  for (let o = 0; o < WF_PREFIXES.length; o++) {
    const cut = WF_PREFIXES[o];
    const train = dated.slice(0, cut);
    const test = dated.slice(cut, cut + (o < 4 ? 7 : 6));
    const ctx = buildContext(train, ctxAsOf);
    const curve = fitGlobalCurve(train, ctx);
    let lambda = null;
    if (rung >= 3) lambda = selectCandidateInner(train, ctx, 'lambda', { rung, s }).selected.lambda;
    const fit = rung === 0 ? null : fitRungModel(train, ctx, rung, lambda);
    const rows = test.map((p) => {
      const sc = scoreProtocol(p, ctx, curve.beta, fit, s);
      return { slug: p.slug, absErr: Math.abs(sc.pred - Math.log10(p.mcap_usd)), outside: sc.outside };
    });
    origins.push({ nTrain: train.length, nTest: test.length, rows, lambda });
  }
  return origins;
}
function top40Spearman(preds, y) {
  const order = preds.map((pr, i) => [pr, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 40);
  const idx = order.map((e) => e[1]);
  return spearmanOf(idx.map((i) => preds[i]), idx.map((i) => y[i]));
}
function top40Se(candPreds, r0Preds, y, rand, draws) {
  const diffs = [];
  const n = y.length;
  for (let d = 0; d < draws; d++) {
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(Math.floor(rand() * n));
    const cp = idx.map((i) => candPreds[i]);
    const rp = idx.map((i) => r0Preds[i]);
    const yy = idx.map((i) => y[i]);
    const a = top40Spearman(cp, yy);
    const b = top40Spearman(rp, yy);
    if (Number.isFinite(a) && Number.isFinite(b)) diffs.push(a - b);
  }
  if (diffs.length < 10) return 0;
  const m = meanOf(diffs);
  return Math.sqrt(diffs.reduce((s, v) => s + (v - m) * (v - m), 0) / (diffs.length - 1));
}

// ---------------------------------------------------------------- placebo + diagnostics
function permuteTargets(comps, rand) {
  const mcaps = shuffledIndex(comps.length, rand).map((i) => comps[i].mcap_usd);
  return comps.map((p, i) => ({ ...p, mcap_usd: mcaps[i] }));
}
function placeboDiagnostic(comps) {
  const rand = makePrng(0xC0FFEE);
  const gains = [];
  let ships = 0;
  for (let k = 0; k < N_PERMUTATIONS; k++) {
    const perm = permuteTargets(comps, rand);
    const ctx = buildContext(perm, ctxAsOf);
    const res = selectCandidateInner(perm, ctx, 'full');
    const r0 = res.table.find((t) => t.rung === 0);
    const gain = r0.med - res.selected.med;
    gains.push(gain);
    if (gain >= G1_FLOOR) ships++;
  }
  const sorted = [...gains].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return { gains, shipRate: ships / N_PERMUTATIONS, p95, ships };
}
function permuteGroups(comps, rand) {
  const cats = shuffledIndex(comps.length, rand).map((i) => comps[i].category);
  return comps.map((p, i) => ({ ...p, category: cats[i] }));
}
function groupPermutationDiagnostic(comps) {
  // Inner-CV error of the guarded-group procedure under permuted group ids
  // versus the real assignment. Selection machinery identical in both.
  const realCtx = buildContext(comps, ctxAsOf);
  const real = selectCandidateInner(comps, realCtx, 'lambda', { rung: 3, s: 1 }).selected.med;
  const rand = makePrng(0x9E3779B9);
  const errs = [];
  for (let k = 0; k < N_PERMUTATIONS; k++) {
    const perm = permuteGroups(comps, rand);
    const ctx = buildContext(perm, ctxAsOf);
    errs.push(selectCandidateInner(perm, ctx, 'lambda', { rung: 3, s: 1 }).selected.med);
  }
  const sorted = [...errs].sort((a, b) => a - b);
  const beats = errs.filter((e) => e < real).length;
  return { real, median: medianOf(errs), p10: quantileOf(errs, 0.1), p90: quantileOf(errs, 0.9), beatShare: beats / errs.length };
}
// Generic TVL-only inner-CV: fitter(subTrain, subCtx) returns predictor(row).
function innerCvGeneric(train, ctx, fitter) {
  const folds = groupDisjointFolds(train, ctx);
  const y = train.map((p) => Math.log10(p.mcap_usd));
  const preds = new Array(train.length);
  for (let f = 0; f < INNER_FOLDS; f++) {
    const subTrain = train.filter((_, i) => folds[i] !== f);
    const subCtx = buildContext(subTrain, ctx.asOfDays, { ageMode: ctx.ageMode });
    const predict = fitter(subTrain, subCtx);
    train.forEach((p, i) => { if (folds[i] === f) preds[i] = predict(p); });
  }
  const absErrs = preds.map((pr, i) => Math.abs(pr - y[i]));
  return { med: medianOf(absErrs), spear: spearmanOf(preds, y) };
}
function formAblations(comps, ctx) {
  // Ablation-only comparisons (non-shipping): offset forms and the elasticity
  // ladder against the global form, same folds, same metric.
  const out = { global: null, offset: [], ladder: [] };
  out.global = innerCvGeneric(comps, ctx, (subTrain) => {
    const c = fitGlobalCurve(subTrain, buildContext(subTrain, ctxAsOf));
    return (p) => c.beta[0] + c.beta[1] * Math.log10(p.tvl_usd / FLOOR_REF);
  });
  for (const q of [0, 0.25, 0.5, 1, 2]) {
    const abl = innerCvGeneric(comps, ctx, (subTrain) => {
      const medTvl = medianOf(subTrain.map((p) => p.tvl_usd));
      const C = q * medTvl;
      const X = subTrain.map((p) => [1, Math.log10((p.tvl_usd + C) / FLOOR_REF)]);
      const y = subTrain.map((p) => Math.log10(p.mcap_usd));
      const beta = huberFit(X, y).beta;
      return (p) => beta[0] + beta[1] * Math.log10((p.tvl_usd + C) / FLOOR_REF);
    });
    out.offset.push({ q, med: abl.med, spear: abl.spear });
  }
  for (const lam of [0, 0.25, 0.5, 0.75, 1]) {
    const abl = innerCvGeneric(comps, ctx, (subTrain) => {
      const xs = subTrain.map((p) => Math.log10(p.tvl_usd / FLOOR_REF)).sort((a, b) => a - b);
      const k1 = xs[Math.floor(xs.length / 3)];
      const k2 = xs[Math.floor((2 * xs.length) / 3)];
      const X = subTrain.map((p) => {
        const x = Math.log10(p.tvl_usd / FLOOR_REF);
        return [1, x, Math.max(0, x - k1), Math.max(0, x - k2)];
      });
      const y = subTrain.map((p) => Math.log10(p.mcap_usd));
      const beta = huberFit(X, y).beta;
      const curve = fitGlobalCurve(subTrain, buildContext(subTrain, ctxAsOf));
      const bbar = curve.beta[1];
      const s1 = lam * beta[1] + (1 - lam) * bbar;
      const s2 = lam * (beta[1] + beta[2]) + (1 - lam) * bbar;
      const s3 = lam * (beta[1] + beta[2] + beta[3]) + (1 - lam) * bbar;
      const atK1 = beta[0] + beta[1] * k1;
      return (p) => {
        const x = Math.log10(p.tvl_usd / FLOOR_REF);
        if (x <= k1) return atK1 + s1 * (x - k1);
        if (x <= k2) return atK1 + s2 * (x - k1);
        return atK1 + s2 * (k2 - k1) + s3 * (x - k2);
      };
    });
    out.ladder.push({ lam, med: abl.med, spear: abl.spear });
  }
  return out;
}
function capAblation(comps, ctx) {
  // The neighbor cap, ablation-only: inner-CV medians per cap strength s.
  const folds = groupDisjointFolds(comps, ctx);
  const y = comps.map((p) => Math.log10(p.mcap_usd));
  const variants = [0, 0.5, 1, 2];
  const preds = variants.map(() => new Array(comps.length));
  const uncapped = new Array(comps.length);
  for (let f = 0; f < INNER_FOLDS; f++) {
    const subTrain = comps.filter((_, i) => folds[i] !== f);
    const subCtx = buildContext(subTrain, ctxAsOf);
    const curve = fitGlobalCurve(subTrain, subCtx);
    comps.forEach((p, i) => {
      if (folds[i] !== f) return;
      const pred = curve.beta[0] + curve.beta[1] * Math.log10(p.tvl_usd / FLOOR_REF);
      uncapped[i] = pred;
      let mMax = 0;
      for (const q of subTrain) if (q.tvl_usd >= p.tvl_usd / 3 && q.tvl_usd <= p.tvl_usd * 3) mMax = Math.max(mMax, q.mcap_usd);
      variants.forEach((s, vi) => {
        preds[vi][i] = mMax > 0 ? Math.min(pred, Math.log10(mMax * (1 + s))) : pred;
      });
    });
  }
  const uncappedMed = medianOf(uncapped.map((pr, i) => Math.abs(pr - y[i])));
  const uncappedSpear = spearmanOf(uncapped, y);
  return { uncappedMed, uncappedSpear, variants: variants.map((s, vi) => ({ s, med: medianOf(preds[vi].map((pr, i) => Math.abs(pr - y[i]))), spear: spearmanOf(preds[vi], y) })) };
}
function sensitivityReport(snap, comps, classified) {
  const ctx = buildContext(comps, ctxAsOf);
  const base = fitGlobalCurve(comps, ctx);
  const baseSlope = base.beta[1];
  // Leverage from the OLS hat matrix of [1, x].
  const xs = comps.map((p) => Math.log10(p.tvl_usd / FLOOR_REF));
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const det = n * sxx - sx * sx;
  const hats = xs.map((x) => (sxx - 2 * sx * x + n * x * x) / det);
  const cut = Math.ceil(0.1 * n);
  const dropSet = new Set(hats.map((h, i) => [h, i]).sort((a, b) => b[0] - a[0]).slice(0, cut).map((e) => e[1]));
  const kept = comps.filter((_, i) => !dropSet.has(i));
  const levSlope = fitGlobalCurve(kept, buildContext(kept, ctxAsOf)).beta[1];
  // Widened integrity window [0.001, 1000].
  const wide = [];
  for (const p of snap.protocols) {
    const c = classified.get(p.slug);
    if (c.tokenStatus !== 'recorded') continue;
    if (!(typeof p.tvl_usd === 'number' && p.tvl_usd > 0)) continue;
    if (p.listed_at != null && parseDateDays(p.listed_at) === null) continue;
    if (!(p.mcap_usd >= 100000)) continue;
    if (c.excluded) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio >= 0.001 && ratio <= 1000) wide.push(p);
  }
  const wideSlope = fitGlobalCurve(wide, buildContext(wide, ctxAsOf)).beta[1];
  const levMove = Math.abs(levSlope - baseSlope) / Math.abs(baseSlope);
  const wideMove = Math.abs(wideSlope - baseSlope) / Math.abs(baseSlope);
  return { baseSlope, levSlope, levMove, levN: kept.length, wideSlope, wideMove, wideN: wide.length, fragile: levMove > 0.15 || wideMove > 0.15 };
}

// ---------------------------------------------------------------- conformal bands
function stratumOf(p, ctx) {
  // Stratum 1: complete features + calibrated group. Stratum 2: tenure present
  // but group uncalibrated, null, or growth missing. Stratum 3: tenure missing.
  const days = ctx.daysOf(p);
  if (days === null) return 2;
  const g = ctx.gidOf(p);
  const calibrated = g >= 0 && (ctx.groupCounts.get(g) ?? 0) >= GROUP_MIN_N;
  const complete = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) && Array.isArray(p.chains);
  return calibrated && complete ? 0 : 1;
}
function stratumQuantiles(residualsByStratum) {
  const global = [...residualsByStratum[0], ...residualsByStratum[1], ...residualsByStratum[2]].sort((a, b) => a - b);
  const gq = [0.1, 0.25, 0.75, 0.9].map((p) => conformalQuantile(global, p));
  const out = residualsByStratum.map((res) => {
    const sorted = [...res].sort((a, b) => a - b);
    const q = [0.1, 0.25, 0.75, 0.9].map((p) => conformalQuantile(sorted, p));
    if (res.length < 15) {
      const w = res.length / (res.length + 15);
      return q.map((v, i) => w * v + (1 - w) * gq[i]);
    }
    return q;
  });
  return { quantiles: out, globalQ: gq, counts: residualsByStratum.map((r) => r.length) };
}
function computeConformalBands(comps, loo, ctx) {
  const byStratum = [[], [], []];
  comps.forEach((p, i) => byStratum[stratumOf(p, ctx)].push(loo.signed[i]));
  return stratumQuantiles(byStratum);
}
function looCoverage(comps, loo, ctx) {
  // Nested out-of-fold quantiles: each row's quantiles exclude the row itself.
  let c80 = 0; let c50 = 0;
  for (let i = 0; i < comps.length; i++) {
    const byStratum = [[], [], []];
    comps.forEach((p, k) => { if (k !== i) byStratum[stratumOf(p, ctx)].push(loo.signed[k]); });
    const { quantiles } = stratumQuantiles(byStratum);
    const q = quantiles[stratumOf(comps[i], ctx)];
    const y = Math.log10(comps[i].mcap_usd);
    const pr = loo.preds[i];
    if (y >= pr + q[0] && y <= pr + q[3]) c80++;
    if (y >= pr + q[1] && y <= pr + q[2]) c50++;
  }
  return { cov80: c80 / comps.length, cov50: c50 / comps.length };
}
function timeSplitCoverage(dated, rung, lambda, s) {
  // Tracking-date split diagnostic (not a gate): earliest 70% fit, newest 30%
  // read once. Current caps do not reveal historical issuance outcomes.
  const cut = Math.floor(0.7 * dated.length);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const ctx = buildContext(train, ctxAsOf);
  const loo = shippedModelLoo(train, rung, lambda, s);
  const bands = computeConformalBands(train, loo, ctx);
  const curve = fitGlobalCurve(train, ctx);
  const fit = rung === 0 ? null : fitRungModel(train, ctx, rung, lambda);
  let c80 = 0; let c50 = 0;
  for (const p of test) {
    const pr = scoreProtocol(p, ctx, curve.beta, fit, s).pred;
    const q = bands.quantiles[stratumOf(p, ctx)];
    const y = Math.log10(p.mcap_usd);
    if (y >= pr + q[0] && y <= pr + q[3]) c80++;
    if (y >= pr + q[1] && y <= pr + q[2]) c50++;
  }
  return { nTrain: train.length, nTest: test.length, boundary: train[train.length - 1].listed_at, cov80: c80 / test.length, cov50: c50 / test.length };
}

// ---------------------------------------------------------------- rank intervals
function rankPercentileErrors(fitRows, calRows, rung, lambda, s) {
  const ctx = buildContext(fitRows, ctxAsOf);
  const curve = fitGlobalCurve(fitRows, ctx);
  const fit = rung === 0 ? null : fitRungModel(fitRows, ctx, rung, lambda);
  const preds = calRows.map((p) => scoreProtocol(p, ctx, curve.beta, fit, s).pred);
  const ys = calRows.map((p) => Math.log10(p.mcap_usd));
  const pct = (arr, v) => arr.filter((a) => a <= v).length / arr.length;
  const errs = calRows.map((_, i) => Math.abs(pct(preds, preds[i]) - pct(ys, ys[i])));
  return { errs, preds, ys, ctx, curve, fit };
}
function rankConformal(comps, rung, lambda, s, nBoard) {
  const rand = makePrng(0x51ED5EED);
  const order = shuffledIndex(comps.length, rand);
  const foldOf = new Array(comps.length);
  order.forEach((idx, k) => { foldOf[idx] = k % 5; });
  let covered = 0;
  let total = 0;
  const widths = [];
  for (let f = 0; f < 5; f++) {
    const rest = comps.filter((_, i) => foldOf[i] !== f);
    const restOrder = shuffledIndex(rest.length, rand);
    const fitN = Math.floor(0.6 * rest.length);
    const fitRows = restOrder.slice(0, fitN).map((i) => rest[i]);
    const calRows = restOrder.slice(fitN).map((i) => rest[i]);
    const { errs, preds, ys, ctx, curve, fit } = rankPercentileErrors(fitRows, calRows, rung, lambda, s);
    const q = conformalQuantile([...errs].sort((a, b) => a - b), 0.8);
    const pctIn = (arr, v) => arr.filter((a) => a <= v).length / arr.length;
    comps.forEach((p, i) => {
      if (foldOf[i] !== f) return;
      const pr = scoreProtocol(p, ctx, curve.beta, fit, s).pred;
      const pp = pctIn(preds, pr);
      const ap = pctIn(ys, Math.log10(p.mcap_usd));
      const lo = Math.max(0, pp - q);
      const hi = Math.min(1, pp + q);
      if (ap >= lo && ap <= hi) covered++;
      total++;
      widths.push((hi - lo) * nBoard);
    });
  }
  // Shipped quantile: one final seeded 60/40 fit/calibration split on all comps.
  const allOrder = shuffledIndex(comps.length, rand);
  const fitN = Math.floor(0.6 * comps.length);
  const fitRows = allOrder.slice(0, fitN).map((i) => comps[i]);
  const calRows = allOrder.slice(fitN).map((i) => comps[i]);
  const { errs } = rankPercentileErrors(fitRows, calRows, rung, lambda, s);
  const qShip = conformalQuantile([...errs].sort((a, b) => a - b), 0.8);
  return { coverage: covered / total, widthMedian: medianOf(widths), widthP90: quantileOf(widths, 0.9), qShip };
}
function refitCores(comps, boardRows, rung, lambda, s, ctxFull, curveFull, fitFull) {
  // 200 deterministic bootstrap refits of the SELECTED model, form and
  // hyperparameters frozen; the board is re-ranked per refit. Parameter
  // stability only: not a coverage claim, not a forecast.
  const rand = makePrng(0xB0015);
  const ranks = boardRows.map(() => []);
  const n = comps.length;
  for (let k = 0; k < N_REFITS; k++) {
    const sample = [];
    for (let i = 0; i < n; i++) sample.push(comps[Math.floor(rand() * n)]);
    const ctx = buildContext(sample, ctxAsOf);
    const curve = fitGlobalCurve(sample, ctx);
    const fit = rung === 0 ? null : fitRungModel(sample, ctx, rung, lambda);
    const scored = boardRows.map((p, idx) => ({ idx, p, pred: scoreProtocol(p, ctx, curve.beta, fit, s).pred }));
    scored.sort((a, b) => (b.pred - a.pred) || (b.p.tvl_usd - a.p.tvl_usd) || (a.p.slug < b.p.slug ? -1 : 1));
    scored.forEach((e, r) => ranks[e.idx].push(r + 1));
  }
  const cores = ranks.map((rs) => {
    const lo = Math.round(quantileOf(rs, 0.1));
    const hi = Math.round(quantileOf(rs, 0.9));
    return [Math.max(1, lo), Math.min(boardRows.length, Math.max(lo, hi))];
  });
  const widths = cores.map(([lo, hi]) => hi - lo);
  return { cores, widthMedian: medianOf(widths), widthP90: quantileOf(widths, 0.9) };
}

// ---------------------------------------------------------------- launch table
function ageBucket(days) {
  if (days === null) return -1;
  return days < 365 ? 0 : days < 730 ? 1 : 2;
}
function tvlBucket(tvl) {
  return tvl < 25_000_000 ? 0 : tvl <= 150_000_000 ? 1 : 2;
}
function fitLaunchTable(rows, compSet, asOfDays) {
  const dated = rows.filter((p) => parseDateDays(p.listed_at) !== null && asOfDays - parseDateDays(p.listed_at) >= 0);
  const globalRate = rows.filter((p) => compSet.has(p.slug)).length / Math.max(1, rows.length);
  const ageRates = [0, 1, 2].map((b) => {
    const rs = dated.filter((p) => ageBucket(asOfDays - parseDateDays(p.listed_at)) === b);
    return rs.length ? rs.filter((p) => compSet.has(p.slug)).length / rs.length : globalRate;
  });
  const tvlRates = [0, 1, 2].map((b) => {
    const rs = rows.filter((p) => tvlBucket(p.tvl_usd) === b);
    return rs.length ? rs.filter((p) => compSet.has(p.slug)).length / rs.length : globalRate;
  });
  const cells = [];
  for (let a = 0; a < 3; a++) {
    for (let t = 0; t < 3; t++) {
      const rs = dated.filter((p) => ageBucket(asOfDays - parseDateDays(p.listed_at)) === a && tvlBucket(p.tvl_usd) === t);
      const raw = rs.length ? rs.filter((p) => compSet.has(p.slug)).length / rs.length : 0;
      const add = Math.min(0.999, Math.max(0.001, ageRates[a] + tvlRates[t] - globalRate));
      const shrunk = (rs.length * raw + LAUNCH_SHRINK * add) / (rs.length + LAUNCH_SHRINK);
      cells.push({ age: a, tvl: t, n: rs.length, raw, add, shrunk, weight: rs.length / (rs.length + LAUNCH_SHRINK) });
    }
  }
  return { globalRate, ageRates, tvlRates, cells };
}
function launchProb(p, table, asOfDays) {
  const d = parseDateDays(p.listed_at);
  const days = d === null || asOfDays === null ? null : asOfDays - d;
  const ab = ageBucket(days === null || days < 0 ? null : days);
  const tb = tvlBucket(p.tvl_usd);
  if (ab < 0) return { p: table.tvlRates[tb], cell: -1, undated: true };
  const cell = table.cells[ab * 3 + tb];
  return { p: cell.shrunk, cell: ab * 3 + tb, undated: false };
}
function logisticFit(xs, ys) {
  // 1-D TVL-only logistic baseline, Newton iterations, tiny ridge.
  let b0 = Math.log((meanOf(ys) + 1e-6) / (1 - meanOf(ys) + 1e-6));
  let b1 = 0;
  const xbar = meanOf(xs);
  const xsd = Math.sqrt(meanOf(xs.map((x) => (x - xbar) * (x - xbar)))) || 1;
  for (let it = 0; it < 25; it++) {
    let g0 = 0; let g1 = 0; let h00 = 1e-6; let h01 = 0; let h11 = 1e-6;
    for (let i = 0; i < xs.length; i++) {
      const z = (xs[i] - xbar) / xsd;
      const pr = 1 / (1 + Math.exp(-(b0 + b1 * z)));
      const r = ys[i] - pr;
      const w = Math.max(1e-6, pr * (1 - pr));
      g0 += r; g1 += r * z;
      h00 += w; h01 += w * z; h11 += w * z * z;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const d0 = (h11 * g0 - h01 * g1) / det;
    const d1 = (h00 * g1 - h01 * g0) / det;
    b0 += d0; b1 += d1;
    if (Math.max(Math.abs(d0), Math.abs(d1)) < 1e-9) break;
  }
  return (x) => 1 / (1 + Math.exp(-(b0 + b1 * ((x - xbar) / xsd))));
}
function launchTableGate(snap, compSet) {
  // 5 folds grouped by cohort (9 cells + the undated cohort) over all rows.
  const rows = snap.protocols;
  const cohortOf = (p) => {
    const d = parseDateDays(p.listed_at);
    const days = d === null || snap.asOfDays === null ? null : snap.asOfDays - d;
    const ab = ageBucket(days === null || days < 0 ? null : days);
    return ab < 0 ? 9 : ab * 3 + tvlBucket(p.tvl_usd);
  };
  const cohorts = new Map();
  rows.forEach((p, i) => {
    const c = cohortOf(p);
    if (!cohorts.has(c)) cohorts.set(c, []);
    cohorts.get(c).push(i);
  });
  const ordered = [...cohorts.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] - b[0]));
  const foldOf = new Array(rows.length);
  ordered.forEach(([c, idxs], k) => {
    const f = k % 5;
    for (const i of idxs) foldOf[i] = f;
  });
  const foldBrier = [];
  for (let f = 0; f < 5; f++) {
    const train = rows.filter((_, i) => foldOf[i] !== f);
    const test = rows.filter((_, i) => foldOf[i] === f);
    const table = fitLaunchTable(train, compSet, snap.asOfDays);
    const baseRate = train.filter((p) => compSet.has(p.slug)).length / train.length;
    const logFit = logisticFit(train.map((p) => Math.log10(p.tvl_usd)), train.map((p) => (compSet.has(p.slug) ? 1 : 0)));
    let bT = 0; let bA = 0; let bB = 0;
    for (const p of test) {
      const y = compSet.has(p.slug) ? 1 : 0;
      const pt = launchProb(p, table, snap.asOfDays).p;
      const pb = logFit(Math.log10(p.tvl_usd));
      bT += (pt - y) * (pt - y);
      bA += (baseRate - y) * (baseRate - y);
      bB += (pb - y) * (pb - y);
    }
    foldBrier.push({ table: bT / test.length, baseA: bA / test.length, baseB: bB / test.length, n: test.length });
  }
  const total = (k) => foldBrier.reduce((s, fb) => s + fb[k] * fb.n, 0) / rows.length;
  const brierTable = total('table');
  const brierA = total('baseA');
  const brierB = total('baseB');
  const signs = foldBrier.map((fb) => fb.table < fb.baseB);
  const signCount = signs.filter(Boolean).length;
  const gatePass = brierTable < brierB - 0.003 && signCount >= 4;
  return { foldBrier, brierTable, brierA, brierB, signs, signCount, gatePass };
}

// ---------------------------------------------------------------- money + economics
function trimNum(v) {
  let s = String(v);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
function fmtUsd(n) {
  const neg = n < 0;
  const a = Math.abs(n);
  const s = a >= 1e9 ? trimNum(Number((a / 1e9).toFixed(2))) + 'B'
    : a >= 1e6 ? trimNum(Number((a / 1e6).toFixed(2))) + 'M'
    : a >= 1e3 ? trimNum(Number((a / 1e3).toFixed(1))) + 'k'
    : a >= 100 ? String(Math.round(a))
    : a.toFixed(2);
  return (neg ? '-$' : '$') + s;
}
function fmt2sf(n) {
  if (!(n > 0)) return '$0';
  const units = ['', 'k', 'M', 'B', 'T'];
  let u = 0;
  let v = n;
  while (v >= 1000 && u < 4) { v /= 1000; u++; }
  let r = Number(v.toPrecision(2));
  if (r >= 1000 && u < 4) { r /= 1000; u++; }
  return '$' + trimNum(r) + units[u];
}
function fmtOdds(p) {
  if (!(p <= 1)) return '>100%';
  if (p <= 0) return '0.0%';
  return (p * 100).toFixed(1) + '%';
}
function prettify(slug) {
  return slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function gasFor(p) {
  const chains = Array.isArray(p.chains) ? p.chains : [];
  const primary = chains[0] ?? null;
  let tier = GAS_FALLBACK;
  let tierName = 'Other / fallback';
  const tierNames = ['Ethereum L1', 'High-cost alt-L1', 'Major rollups / L2s'];
  GAS_TIERS.forEach((t, i) => {
    if (primary !== null && t.names.includes(primary)) { tier = t; tierName = tierNames[i]; }
  });
  const multi = chains.length >= 2;
  return {
    low: tier.low + (multi ? GAS_MULTI.low : 0),
    base: tier.base + (multi ? GAS_MULTI.base : 0),
    high: tier.high + (multi ? GAS_MULTI.high : 0),
    tierName, primary, multi,
  };
}
function holdDaysFor(days) {
  if (days === null || days < 365) return 45;
  if (days < 730) return 60;
  return 75;
}
function hoursFor(p) {
  const n = Array.isArray(p.chains) ? p.chains.length : 1;
  return Math.min(3.0, 1.5 + 0.25 * Math.max(0, n - 1));
}
// Archetypes: six numeric cells, TVL tier x growth sign, fixed order. The
// category label is a human hint in plan headers only; it never enters money.
const ARCHETYPES = [
  { key: 'incentive-campaign', action: 'deposit into the campaign pool and keep the receipt token', risk: 'points may convert below the assumed rate' },
  { key: 'LP-pair', action: 'provide liquidity in the main pair within a tight range', risk: 'impermanent loss if the pair moves sharply' },
  { key: 'stable-pool', action: 'deposit stable assets into the highest-TVL stable pool', risk: 'pool incentives may end before the hold ends' },
  { key: 'vault', action: 'deposit into the vault and hold the vault receipt', risk: 'vault strategy drift can change the return profile' },
  { key: 'lending-supply', action: 'supply assets to the lending market within safe limits', risk: 'borrow demand shifts can cut supply yield fast' },
  { key: 'bridge-incentive', action: 'bridge the minimum qualifying amount and hold on the destination', risk: 'bridge incentives may be capped per wallet' },
];
function archetypeOf(p) {
  const tier = p.tvl_usd < 50_000_000 ? 0 : p.tvl_usd <= 500_000_000 ? 1 : 2;
  const up = typeof p.change_7d === 'number' && p.change_7d > 0;
  return tier * 2 + (up ? 0 : 1);
}
function computeFarmEconomics(p, implied, p25val, days, scoreAtTvl, noPeer) {
  const gas = gasFor(p);
  const hold = holdDaysFor(days);
  const hours = hoursFor(p);
  const shareAt = (D, tvl) => D / (tvl * ASSUMPTIONS.etaDil);
  const gross50 = implied * ASSUMPTIONS.alphaDrop * shareAt(1000, p.tvl_usd);
  const gross25 = p25val * ASSUMPTIONS.alphaDrop * shareAt(1000, p.tvl_usd);
  const opp = 1000 * ASSUMPTIONS.rOpp * (hold / 365);
  const costBase = gas.base + opp;
  const costHigh = gas.high + opp;
  const net50 = gross50 - costBase;
  const net25 = gross25 - costHigh;
  const pBe = gross50 > 0 ? Math.min(1, costBase / gross50) : Infinity;
  const alphaBe = costBase / (implied * shareAt(1000, p.tvl_usd));
  const fdvBe = costBase / (ASSUMPTIONS.alphaDrop * shareAt(1000, p.tvl_usd));
  const dMin = (2 * gas.base * p.tvl_usd * ASSUMPTIONS.etaDil) / (implied * ASSUMPTIONS.alphaDrop);
  const dMax = Math.min(0.005 * p.tvl_usd, 50000);
  // Scenario nets: LOW/POINT/HIGH at the three tested sizes, plus tier nets
  // with the emission share halved when the category has no traded peer.
  const scen = [];
  const tierScen = [];
  for (const D of ASSUMPTIONS.sizes) {
    const rowNets = [];
    const rowTier = [];
    for (const sc of ASSUMPTIONS.scenarios) {
      const tvlS = p.tvl_usd * (1 - sc.tvlDrop);
      const impliedS = Math.pow(10, scoreAtTvl(tvlS));
      const alphaS = ASSUMPTIONS.alphaDrop * sc.shareMult;
      const grossS = impliedS * alphaS * shareAt(D, tvlS);
      const netS = grossS - (gas.base + D * ASSUMPTIONS.rOpp * (sc.holdDays / 365));
      rowNets.push({ net: netS, netHr: netS / hours });
      const grossT = impliedS * alphaS * (noPeer ? 0.5 : 1) * shareAt(D, tvlS);
      const netT = grossT - (gas.base + D * ASSUMPTIONS.rOpp * (sc.holdDays / 365));
      rowTier.push({ net: netT, netHr: netT / hours });
    }
    scen.push(rowNets);
    tierScen.push(rowTier);
  }
  // Pays-from: smallest tested size with LOW net above zero, else the exact
  // linear break-even size rounded up to the next $50.
  let paysFrom = null;
  let paysInterp = false;
  for (let si = 0; si < ASSUMPTIONS.sizes.length; si++) {
    if (scen[si][0].net > 0) { paysFrom = ASSUMPTIONS.sizes[si]; break; }
  }
  if (paysFrom === null) {
    const sc = ASSUMPTIONS.scenarios[0];
    const tvlS = p.tvl_usd * (1 - sc.tvlDrop);
    const impliedS = Math.pow(10, scoreAtTvl(tvlS));
    const marginal = (impliedS * ASSUMPTIONS.alphaDrop * sc.shareMult) / (tvlS * ASSUMPTIONS.etaDil);
    const oppRate = ASSUMPTIONS.rOpp * (sc.holdDays / 365);
    if (marginal > oppRate) {
      const star = gas.base / (marginal - oppRate);
      paysFrom = Math.ceil(star / 50) * 50;
      paysInterp = true;
    } else {
      paysFrom = Infinity;
    }
  }
  return {
    gas, hold, hours, gross50, gross25, opp, costBase, costHigh, net50, net25,
    netHr: net50 / hours, pBe, alphaBe, fdvBe, dMin, dMax, scen, tierScen, paysFrom, paysInterp,
  };
}
function assignVerdict(econ, noPeer, missingInput) {
  // Tier rule on base-size ($1,000) break-even odds + tier-net signs.
  // Thresholds are an operating policy, labeled as such, never probabilities.
  if (missingInput) return { tier: 'THIN-UNPRICED', missing: missingInput };
  const pBe = econ.pBe;
  const low = econ.tierScen[0][0].net;
  const point = econ.tierScen[0][1].net;
  const high = econ.tierScen[0][2].net;
  if (pBe <= 0.10 && low >= 0) return { tier: 'ROBUST', missing: null };
  if (pBe <= 0.25 && point > 0) return { tier: 'FARM', missing: null };
  if (pBe > 0.50 || high <= 0) return { tier: 'SKIP', missing: null };
  return { tier: 'THIN', missing: null };
}
function trendText(p) {
  if (typeof p.change_7d !== 'number' || !Number.isFinite(p.change_7d)) return 'unreported';
  return (p.change_7d >= 0 ? '+' : '') + p.change_7d.toFixed(1) + '%';
}
function buildFarmPlan(p, econ, verdict, archIdx, days) {
  const arch = ARCHETYPES[archIdx];
  const gas = econ.gas;
  const exitGas = gas.base / 2;
  const tenure = days === null ? 'unknown (imputed median)' : days + ' days tracked';
  const steps = [];
  steps.push(`1. Check eligibility and dilution (10 min, $0). Snapshot TVL ${fmtUsd(p.tvl_usd)}; keep the deposit inside ${fmtUsd(econ.dMin)}-${fmtUsd(econ.dMax)} (at most 0.5% of the pool). Evidence: snapshot tvl_usd. Stop: abort if TVL dilutes past 2x or a non-retroactive cutoff is announced.`);
  let s2 = `2. Stage capital and the gas budget (15 min, ${fmtUsd(gas.base)} assumed gas, low ${fmtUsd(gas.low)} / high ${fmtUsd(gas.high)}). Stage the deposit on ${gas.primary ?? 'the primary chain'}; keep a reserve to the high scenario. Evidence: snapshot chains[0]. Stop: abort if a real quote exceeds ${fmtUsd(gas.high)} before depositing.`;
  if (gas.multi) s2 += ' Multi-chain: budget the cross-chain overhead on each extra chain.';
  steps.push(s2);
  const tier = verdict.tier;
  if (tier === 'SKIP') {
    steps.push(`3. Dry-run only (20 min, $0 committed). Verify the flow read-only; commit no capital while the verdict is Skip. Category hint: ${p.category ?? 'none recorded'}. 7-day trend ${trendText(p)}. Evidence: snapshot category and change_7d. Stop: stay out unless the verdict changes.`);
  } else if (tier === 'THIN') {
    steps.push(`3. Core interaction, small size (20 min, cost inside gas + opportunity cost). Small size ($250): ${arch.action}. Category hint: ${p.category ?? 'none recorded'}. 7-day trend ${trendText(p)}. Evidence: snapshot category and change_7d. Stop: exit if 7-day TVL drops over 35%.`);
  } else {
    steps.push(`3. Core interaction (20 min, cost inside gas + opportunity cost). ${arch.action.charAt(0).toUpperCase() + arch.action.slice(1)}. Category hint: ${p.category ?? 'none recorded'}. 7-day trend ${trendText(p)}. Evidence: snapshot category and change_7d. Stop: exit if 7-day TVL drops over 35%.`);
  }
  steps.push(`4. Tenure and retention (${econ.hold}-day hold, 10 min/week, ${fmtUsd(econ.opp)} assumed opportunity cost at 4.5% APR). Maintain the position across ${econ.hold} days; avoid dust churning. Evidence: DefiLlama tracking tenure ${tenure}. Stop: withdraw if the break-even FDV hurdle exceeds the P75 upside.`);
  steps.push(`5. Break-even and stress audit (10 min, $0). Conditional slice ${fmtUsd(econ.gross50)} at P50 vs ${fmtUsd(econ.gross25)} at P25 stress; break-even launch odds ${fmtOdds(econ.pBe)}, break-even drop share ${(econ.alphaBe * 100).toFixed(1)}%, net ${fmtUsd(econ.netHr)}/hr. Evidence: fitted P25-P75 + hurdles. Stop: reclassify to Skip if dilution cuts net below $0.`);
  if (tier === 'SKIP') {
    steps.push(`6. Monitor only (15 min, $0). Deploy zero capital; monitor for a verdict change. Exit triggers if already held: TVL drops over 35%, or the break-even hurdle exceeds P75. Risk: ${arch.risk}. Stop: unwind immediately on either trigger.`);
  } else if (tier === 'THIN') {
    steps.push(`6. Small exit plan (15 min, ${fmtUsd(exitGas)} exit gas). Size $250, shorter hold, one claim cycle; unwind at the first claim or the ${econ.hold}-day cap. Risk: ${arch.risk}. Stop: exit if the claim value falls below gas.`);
  } else if (tier === 'THIN-UNPRICED') {
    steps.push(`6. Price it first (15 min, $0). Missing input: ${verdict.missing}. Do not size a position until it is known; monitor only. Risk: ${arch.risk}. Stop: abort sizing until the input exists.`);
  } else {
    steps.push(`6. Exit and unwind (15 min, ${fmtUsd(exitGas)} exit gas). Execute the verdict: farm at the planned size. Unwind at the TGE announcement or the ${econ.hold}-day cap. Risk: ${arch.risk}. Stop: mandatory unwind at the ${econ.hold}-day cap.`);
  }
  return steps;
}
function chipsFor(p, days, groupSmall, noPeer, noSupport) {
  const chips = [];
  if (days === null) { chips.push('no tenure'); chips.push('tenure missing - default hold used'); }
  if (typeof p.change_7d !== 'number' || !Number.isFinite(p.change_7d)) chips.push('archetype inferred');
  if (groupSmall) chips.push('small group');
  if (noPeer) chips.push('no peer rate');
  if (noSupport) chips.push('no support - curve only');
  if (p.category == null) chips.push('category missing - generic plan');
  return chips;
}

// ---------------------------------------------------------------- main
function argOf(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}
function r3(x) {
  return Number.isFinite(x) ? Number(x.toFixed(3)) : null;
}
function r4(x) {
  return Number.isFinite(x) ? Number(x.toFixed(4)) : null;
}
function r6(x) {
  return Number.isFinite(x) ? Number(x.toFixed(6)) : null;
}
function main() {
  const tStart = performance.now();
  const inputArg = argOf('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(`token radar: no snapshot at ${inputFile}\n`);
    process.exit(2);
  }
  const out = argOf('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const snap = parseSnapshot(readFileSync(inputFile, 'utf8'));
  ctxAsOf = snap.asOfDays;
  const tParse = performance.now();

  const census = buildCensus(snap);
  if (census.total !== snap.protocols.length) throw new Error(`census sums to ${census.total}, snapshot has ${snap.protocols.length}`);
  if (census.watchlistCovered !== snap.watchlist.length) throw new Error(`watchlist coverage ${census.watchlistCovered}/${snap.watchlist.length}`);
  const { comps, excluded } = selectTradedComps(snap, census.classified);
  const compSet = new Set(comps.map((p) => p.slug));
  const dated = comps.filter((p) => p.listed_at != null).sort((a, b) => (a.listed_at < b.listed_at ? -1 : a.listed_at > b.listed_at ? 1 : (a.slug < b.slug ? -1 : 1)));
  const fullCtx = buildContext(comps, ctxAsOf);
  const fullInner = selectCandidateInner(comps, fullCtx, 'full');

  // Nested LOO for every candidate, R0 first as the paired baseline.
  const looByCand = CANDIDATES.map((c) => looForCandidate(comps, c.rung, c.s));
  const r0loo = looByCand[0];
  const wfByCand = CANDIDATES.map((c) => wfForCandidate(dated, c.rung, c.s));
  const r0wf = wfByCand[0];
  const placebo = placeboDiagnostic(comps);
  const groupPerm = groupPermutationDiagnostic(comps);
  const rawCtx = buildContext(comps, ctxAsOf, { ageMode: 'raw' });
  const agePct = selectCandidateInner(comps, fullCtx, 'fixed', { rung: 1, s: 1 }).table[0];
  const ageRaw = selectCandidateInner(comps, rawCtx, 'fixed', { rung: 1, s: 1 }).table[0];
  const forms = formAblations(comps, fullCtx);
  const capAbl = capAblation(comps, fullCtx);
  const lambdaAbl = LAMBDA_ABLATION.map((lam) => {
    const t = selectCandidateInner(comps, fullCtx, 'fixed', { rung: 3, lambda: lam, s: 1 }).table[0];
    return { lam: lam === Infinity ? 'inf' : lam, med: t.med, spear: t.spear };
  });
  const sens = sensitivityReport(snap, comps, census.classified);

  // Shipping gates G1-G4 per candidate.
  const y = comps.map((p) => Math.log10(p.mcap_usd));
  const r0Top40 = top40Spearman(r0loo.preds, y);
  const ledger = CANDIDATES.map((c, ci) => {
    const loo = looByCand[ci];
    const gain = r0loo.med - loo.med;
    const improvements = r0loo.absErrs.map((e, i) => e - loo.absErrs[i]);
    const lower90 = bootstrapLower90(improvements, makePrng(0x1000 + ci), N_BOOTSTRAP);
    const g1 = ci !== 0 && gain >= Math.max(G1_FLOOR, placebo.p95) && lower90 > G1B_FLOOR;
    const wf = wfByCand[ci];
    const pooledDiffs = [];
    const origins = wf.map((o, oi) => {
      const r0map = new Map(r0wf[oi].rows.map((r) => [r.slug, r.absErr]));
      const diffs = o.rows.map((r) => r.absErr - r0map.get(r.slug));
      pooledDiffs.push(...diffs);
      const mean = meanOf(diffs);
      const se = bootstrapSe(diffs, makePrng(0x3000 + ci * 10 + oi), N_BOOTSTRAP);
      return { nTrain: o.nTrain, nTest: o.nTest, mean, se, red: mean > 2 * se };
    });
    const pooledMean = meanOf(pooledDiffs);
    const pooledSe = bootstrapSe(pooledDiffs, makePrng(0x2000 + ci), N_BOOTSTRAP);
    const g2 = pooledMean <= 1.0 * pooledSe;
    const g3 = origins.every((o) => o.mean <= 1.5 * o.se);
    const candTop40 = top40Spearman(loo.preds, y);
    const seTop = top40Se(loo.preds, r0loo.preds, y, makePrng(0x4000 + ci), N_BOOTSTRAP);
    const g4 = candTop40 >= r0Top40 - 1.0 * seTop;
    let lambda = null;
    if (c.rung >= 3) lambda = selectCandidateInner(comps, fullCtx, 'lambda', { rung: c.rung, s: c.s }).selected.lambda;
    return {
      ...c, index: ci, lambda, looMed: loo.med, looMult: loo.mult, spear: loo.spear, top40: candTop40,
      gain, lower90, pooledMean, pooledSe, origins, g1, g2, g3, g4, eligible: ci !== 0 && g1 && g2 && g3 && g4,
    };
  });
  const eligible = ledger.filter((l) => l.eligible).sort((a, b) => (a.looMed - b.looMed) || (b.s - a.s) || (b.rung - a.rung) || ((b.lambda ?? -1) - (a.lambda ?? -1)) || (a.index - b.index));
  const gateFailed = eligible.length === 0;
  const shipped = gateFailed ? { rung: 0, s: 0, lambda: null } : { rung: eligible[0].rung, s: eligible[0].s, lambda: eligible[0].lambda };
  const shippedLedger = gateFailed ? ledger[0] : eligible[0];
  const tSelect = performance.now();

  const procLoo = looProcedure(comps);
  const shipLoo = shippedModelLoo(comps, shipped.rung, shipped.lambda, shipped.s);
  const curveFull = fitGlobalCurve(comps, fullCtx);
  const fitFull = shipped.rung === 0 ? null : fitRungModel(comps, fullCtx, shipped.rung, shipped.lambda);
  const bands = computeConformalBands(comps, shipLoo, fullCtx);
  const coverage = looCoverage(comps, shipLoo, fullCtx);
  const tsCov = timeSplitCoverage(dated, shipped.rung, shipped.lambda, shipped.s);
  const compTvlMin = Math.min(...comps.map((p) => p.tvl_usd));
  const compTvlMax = Math.max(...comps.map((p) => p.tvl_usd));

  // Board: every eligible pre-token protocol, ranked by implied value.
  const boardProtocols = snap.protocols.filter((p) => {
    const c = census.classified.get(p.slug);
    if (c.tokenStatus !== 'pretoken' || c.excluded) return false;
    if (!(typeof p.tvl_usd === 'number' && p.tvl_usd > 0)) return false;
    if (p.listed_at != null && parseDateDays(p.listed_at) === null) return false;
    return true;
  });
  const scored = boardProtocols.map((p) => {
    const sc = scoreProtocol(p, fullCtx, curveFull.beta, fitFull, shipped.s);
    return { p, pred: sc.pred, sEff: sc.sEff, outside: sc.outside };
  });
  scored.sort((a, b) => (b.pred - a.pred) || (b.p.tvl_usd - a.p.tvl_usd) || (a.p.slug < b.p.slug ? -1 : 1));
  const nBoard = scored.length;
  const wfFallback = r0wf.reduce((s, o) => s + o.rows.filter((r) => r.outside).length, 0);
  const wfTestN = r0wf.reduce((s, o) => s + o.rows.length, 0);
  const shipFallback = scored.filter((e) => e.outside).length;
  const rankCal = rankConformal(comps, shipped.rung, shipped.lambda, shipped.s, nBoard);
  const halfW = rankCal.qShip * nBoard;
  const cores = refitCores(comps, scored.map((e) => e.p), shipped.rung, shipped.lambda, shipped.s);
  const launchTable = fitLaunchTable(snap.protocols, compSet, snap.asOfDays);
  const launchGate = launchTableGate(snap, compSet);

  // Peer tokenization rates over eligible protocols, per category.
  const eligibleRows = snap.protocols.filter((p) => {
    const c = census.classified.get(p.slug);
    if (c.excluded) return false;
    if (!(typeof p.tvl_usd === 'number' && p.tvl_usd > 0)) return false;
    if (p.listed_at != null && parseDateDays(p.listed_at) === null) return false;
    return true;
  });
  const pGlobal = comps.length / Math.max(1, eligibleRows.length);
  const peerByCat = new Map();
  for (const p of eligibleRows) {
    if (p.category == null) continue;
    const e = peerByCat.get(p.category) ?? { n: 0, k: 0 };
    e.n++;
    if (compSet.has(p.slug)) e.k++;
    peerByCat.set(p.category, e);
  }
  const peerInfo = (p) => {
    if (p.category == null) return { rate: pGlobal, noPeer: false };
    const e = peerByCat.get(p.category);
    if (!e) return { rate: pGlobal, noPeer: false };
    return { rate: (e.k + 5 * pGlobal) / (e.n + 5), noPeer: e.k === 0 };
  };

  const watchSet = new Set(snap.watchlist);
  let coreFlags = 0;
  const top10Counts = { yes: 0, possible: 0, no: 0 };
  const boardRows = scored.map((e, i) => {
    const rank = i + 1;
    const p = e.p;
    const days = fullCtx.daysOf(p);
    const strat = stratumOf(p, fullCtx);
    let q = bands.quantiles[strat];
    const extrapolated = p.tvl_usd < compTvlMin || p.tvl_usd > compTvlMax;
    if (extrapolated) {
      q = [Math.min(q[0], bands.globalQ[0]), Math.min(q[1], bands.globalQ[1]), Math.max(q[2], bands.globalQ[2]), Math.max(q[3], bands.globalQ[3])];
    }
    const implied = Math.pow(10, e.pred);
    const p25val = Math.pow(10, e.pred + q[1]);
    const bandLo = Math.max(1, Math.round(rank - halfW));
    const bandHi = Math.min(nBoard, Math.round(rank + halfW));
    const band = [Math.min(bandLo, rank), Math.max(bandHi, rank)];
    const core = cores.cores[i];
    if (core[0] < band[0] || core[1] > band[1]) coreFlags++;
    const top10 = core[1] <= 10 ? 'Yes' : band[0] <= 10 ? 'Possible' : 'No';
    top10Counts[top10 === 'Yes' ? 'yes' : top10 === 'Possible' ? 'possible' : 'no']++;
    const peer = peerInfo(p);
    const scoreAtTvl = (tvlS) => scoreProtocol({ ...p, tvl_usd: tvlS }, fullCtx, curveFull.beta, fitFull, shipped.s).pred;
    const econ = computeFarmEconomics(p, implied, p25val, days, scoreAtTvl, peer.noPeer);
    const missing = !Number.isFinite(implied) || !Number.isFinite(p25val) ? 'implied value' : null;
    const verdict = assignVerdict(econ, peer.noPeer, missing);
    const archIdx = archetypeOf(p);
    const steps = buildFarmPlan(p, econ, verdict, archIdx, days);
    for (const s of steps) {
      if (s.length < 60 || s.length > 420) throw new Error(`farm step length ${s.length} out of [60,420] for ${p.slug}: ${s.slice(0, 60)}`);
    }
    const g = fullCtx.gidOf(p);
    const groupSmall = g < 0 || (fullCtx.groupCounts.get(g) ?? 0) < GROUP_MIN_N;
    const chips = chipsFor(p, days, groupSmall, peer.noPeer, e.outside);
    const lp = launchProb(p, launchTable, snap.asOfDays);
    const pUsed = Math.min(LAUNCH_CAP_HI * launchTable.globalRate, Math.max(LAUNCH_CAP_LO * launchTable.globalRate, lp.p));
    const pBeMargin = Number.isFinite(econ.pBe) ? econ.pBe : 1;
    const margin = pBeMargin > 0 ? pUsed / pBeMargin : Infinity;
    return {
      p, rank, pred: e.pred, strat, q, implied, p25val, band, core, top10, econ, verdict, archIdx, steps,
      chips, days, gid: g, peer, launch: lp, pUsed, margin, extrapolated, watch: watchSet.has(p.slug),
      digest: fnv1a(steps.join('\n')),
    };
  });
  // Cap ablation on the board: does the neighbor cap bind anywhere?
  const capBinds = (() => {
    let binds = 0;
    for (const e of scored) {
      let mMax = 0;
      for (const q of comps) if (q.tvl_usd >= e.p.tvl_usd / 3 && q.tvl_usd <= e.p.tvl_usd * 3) mMax = Math.max(mMax, q.mcap_usd);
      if (mMax > 0 && e.pred > Math.log10(mMax * (1 + 0))) binds++;
    }
    return binds;
  })();
  const tValidate = performance.now();

  // Portfolio + sensitivity over the $1,000 headline size.
  const deployed = boardRows.filter((r) => r.verdict.tier !== 'SKIP');
  const sum = (arr, f) => arr.reduce((s, r) => s + f(r), 0);
  const boardTotal = {
    n: deployed.length,
    deployedUsd: deployed.length * 1000,
    netLow: sum(deployed, (r) => r.econ.scen[0][0].net),
    netPoint: sum(deployed, (r) => r.econ.scen[0][1].net),
    hours: sum(deployed, (r) => r.econ.hours),
  };
  boardTotal.netHrPoint = boardTotal.hours > 0 ? boardTotal.netPoint / boardTotal.hours : 0;
  const byNetHr = [...boardRows].sort((a, b) => b.econ.scen[0][1].netHr - a.econ.scen[0][1].netHr).slice(0, 12);
  const practical = {
    n: byNetHr.length,
    deployedUsd: byNetHr.length * 1000,
    netPoint: sum(byNetHr, (r) => r.econ.scen[0][1].net),
    hours: sum(byNetHr, (r) => r.econ.hours),
  };
  practical.netHrPoint = practical.hours > 0 ? practical.netPoint / practical.hours : 0;
  const warned = deployed.filter((r) => r.chips.length > 0);
  const warnedLine = {
    n: warned.length,
    netHrPoint: sum(warned, (r) => r.econ.hours) > 0 ? sum(warned, (r) => r.econ.scen[0][1].net) / sum(warned, (r) => r.econ.hours) : 0,
  };
  const netHrs = boardRows.map((r) => r.econ.scen[0][1].netHr);
  const sortedNetHr = [...netHrs].sort((a, b) => a - b);
  const positive = netHrs.filter((v) => v > 0);
  const sensitivity = {
    hurdles: [5, 10, 15, 25].map((h) => ({ h, count: netHrs.filter((v) => v >= h).length })),
    quartiles: [quantileSorted(sortedNetHr, 0.25), medianOf(netHrs), quantileSorted(sortedNetHr, 0.75)],
    medianAll: medianOf(netHrs),
    medianPositive: positive.length ? medianOf(positive) : null,
    positiveN: positive.length,
  };
  const tierCounts = {};
  for (const r of boardRows) tierCounts[r.verdict.tier] = (tierCounts[r.verdict.tier] ?? 0) + 1;

  // Board file rows.
  const outRows = boardRows.map((r) => ({
    slug: r.p.slug,
    name: r.p.name,
    rank: r.rank,
    implied_value_usd: Math.min(100000000000000, Math.max(1, Math.round(r.implied))),
    farm_steps: r.steps,
    tier: r.verdict.tier,
    p_be: Number.isFinite(r.econ.pBe) ? r4(r.econ.pBe) : null,
    net_per_hour: r4(r.econ.scen[0][1].netHr),
    band_usd: [Math.round(Math.pow(10, r.pred + r.q[0])), Math.round(Math.pow(10, r.pred + r.q[3]))],
    rank_interval: r.band,
    refit_core: r.core,
    top10: r.top10,
    pays_from: Number.isFinite(r.econ.paysFrom) ? r.econ.paysFrom : null,
    margin: Number.isFinite(r.margin) ? r4(r.margin) : null,
  }));
  // Gate-shape self-checks: fail loudly, never hand-edit outputs.
  if (outRows.length < 100 || outRows.length > 4000) throw new Error(`board has ${outRows.length} rows`);
  for (let i = 0; i < outRows.length; i++) {
    if (outRows[i].rank !== i + 1) throw new Error('ranks are not exactly 1..N');
    if (i > 0 && outRows[i].implied_value_usd > outRows[i - 1].implied_value_usd) throw new Error('implied values rise with rank');
  }
  const boardSlugs = new Set(outRows.map((r) => r.slug));
  for (const s of snap.watchlist) if (!boardSlugs.has(s)) throw new Error(`watchlist slug missing from board: ${s}`);
  const outsideWatch = outRows.filter((r) => !watchSet.has(r.slug)).length;
  if (outsideWatch < 60) throw new Error(`only ${outsideWatch} rows outside the watchlist`);
  const boardJson = `${JSON.stringify({ rows: outRows })}\n`;
  const runHash = createHash('sha256').update(boardJson).digest('hex').slice(0, 16);

  // Dashboard data: compact row records + embedded selected parameters so the
  // page re-derives every value, band, rank, verdict, and farm step.
  const catDict = [...new Set(boardRows.map((r) => r.p.category).filter((v) => v != null))].sort();
  const catIdx = new Map(catDict.map((v, i) => [v, i]));
  const chainDict = [...new Set(boardRows.map((r) => (Array.isArray(r.p.chains) && r.p.chains.length ? r.p.chains[0] : null)).filter((v) => v != null))].sort();
  const chainIdx = new Map(chainDict.map((v, i) => [v, i]));
  const chainCode = (p) => {
    const ch = Array.isArray(p.chains) ? p.chains : [];
    const pi = ch.length ? chainIdx.get(ch[0]) : -1;
    return `${pi === undefined ? -1 : pi}:${ch.length}`;
  };
  const sortedDays = comps.map((p) => fullCtx.daysOf(p)).filter((d) => d !== null).sort((a, b) => a - b);
  const groupOff = {};
  if (fitFull && fitFull.offsets) {
    for (const [g, off] of fitFull.offsets) groupOff[g] = [off, fullCtx.groupCounts.get(g) ?? 0];
  }
  const groupCountsAll = {};
  for (const [g, n] of fullCtx.groupCounts) groupCountsAll[g] = n;
  const shippedWidths = boardRows.map((r) => r.band[1] - r.band[0]);
  const D = {
    meta: {
      asOf: snap.asOf, nProto: snap.protocols.length, nWatch: snap.watchlist.length,
      nBoard, nComp: comps.length, nDated: dated.length,
      runHash, gateFailed, shippedRung: shipped.rung, shippedS: shipped.s, shippedLambda: shipped.lambda,
      wfFallback, wfTestN, shipFallback,
      wfGeom: WF_PREFIXES.map((cut, o) => [cut, o < 4 ? 7 : 6]),
    },
    cats: catDict,
    chains: chainDict,
    rows: boardRows.map((r) => [
      r.p.slug, prettify(r.p.slug) === r.p.name ? '' : r.p.name, r.p.category == null ? -1 : catIdx.get(r.p.category),
      chainCode(r.p),
      r.p.tvl_usd, r.p.change_7d, r.days, r.gid, r6(r.pred), r.strat, r.core[0], r.core[1], r.digest,
      (r.watch ? 1 : 0) | (r.peer.noPeer ? 2 : 0),
    ]),
    P: {
      rung: shipped.rung, lam: shipped.lambda, s: shipped.s,
      curve: [curveFull.beta[0], curveFull.beta[1]],
      beta: fitFull ? [...fitFull.beta] : null,
      cols: fitFull ? fitFull.cols : null,
      off: groupOff, groupCounts: groupCountsAll,
      feat: {
        ageMed: fullCtx.ageMed, ageIqr: fullCtx.ageIqr, daysSorted: sortedDays,
        brLo: fullCtx.brLo, brHi: fullCtx.brHi, brMed: fullCtx.brMed, brIqr: fullCtx.brIqr,
        gScale: fullCtx.gScale, grLo: fullCtx.grLo, grHi: fullCtx.grHi, grMed: fullCtx.grMed, grIqr: fullCtx.grIqr,
      },
      box: [[fullCtx.box.age[0], fullCtx.box.age[1]], [fullCtx.box.br[0], fullCtx.box.br[1]], [fullCtx.box.gr[0], fullCtx.box.gr[1]]],
      quants: bands.quantiles.map((q) => [...q]),
      gq: [...bands.globalQ],
      rankQ: rankCal.qShip,
      tvlRange: [compTvlMin, compTvlMax],
      launchCells: launchTable.cells.map((c) => r6(c.shrunk)),
      launchTvlRates: launchTable.tvlRates.map(r6),
    },
    L: {
      candidates: ledger.map((l) => [l.rung, l.s, l.lambda, r4(l.looMed), r4(l.spear), r4(l.top40), r4(l.gain), r4(l.lower90), r4(l.pooledMean), r4(l.pooledSe), l.g1 ? 1 : 0, l.g2 ? 1 : 0, l.g3 ? 1 : 0, l.g4 ? 1 : 0, l.eligible ? 1 : 0, l.origins.map((o) => [r3(o.mean), r3(o.se), o.red ? 1 : 0])]),
      placebo: { shipRate: r4(placebo.shipRate), ships: placebo.ships, n: N_PERMUTATIONS, p95: r4(placebo.p95), shippedGain: r4(shippedLedger.gain) },
      twoLoo: {
        nested: { med: r4(procLoo.med), spear: r4(procLoo.spear) },
        shipped: { med: r4(shipLoo.med), spear: r4(shipLoo.spear) },
      },
      flat: { med: r4(r0loo.flatMed), spear: r4(r0loo.flatSpear) },
      foldAudit: fullInner.foldAudit,
      groupPerm: { real: r4(groupPerm.real), median: r4(groupPerm.median), p10: r4(groupPerm.p10), p90: r4(groupPerm.p90), beatShare: r4(groupPerm.beatShare) },
      ageAblation: { pct: [r4(agePct.med), r4(agePct.spear)], raw: [r4(ageRaw.med), r4(ageRaw.spear)] },
      forms: { global: [r4(forms.global.med), r4(forms.global.spear)], offset: forms.offset.map((o) => [o.q, r4(o.med), r4(o.spear)]), ladder: forms.ladder.map((o) => [o.lam, r4(o.med), r4(o.spear)]) },
      cap: { uncapped: [r4(capAbl.uncappedMed), r4(capAbl.uncappedSpear)], variants: capAbl.variants.map((v) => [v.s, r4(v.med), r4(v.spear)]), binds: capBinds },
      lambdaAblation: lambdaAbl.map((o) => [o.lam, r4(o.med), r4(o.spear)]),
      modelSensitivity: { baseSlope: r4(sens.baseSlope), levSlope: r4(sens.levSlope), levMove: r4(sens.levMove), levN: sens.levN, wideSlope: r4(sens.wideSlope), wideMove: r4(sens.wideMove), wideN: sens.wideN, fragile: sens.fragile ? 1 : 0 },
      bands: {
        cov80: r4(coverage.cov80), cov50: r4(coverage.cov50),
        tsCov80: r4(tsCov.cov80), tsCov50: r4(tsCov.cov50), tsN: [tsCov.nTrain, tsCov.nTest],
        widthMedian: medianOf(shippedWidths), widthP90: quantileOf(shippedWidths, 0.9),
        diagWidthMedian: r4(rankCal.widthMedian), diagWidthP90: r4(rankCal.widthP90), diagCoverage: r4(rankCal.coverage),
      },
      refit: { widthMedian: cores.widthMedian, widthP90: cores.widthP90, coreFlags },
      top10: top10Counts,
      launch: {
        cells: launchTable.cells.map((c) => [c.n, r4(c.raw), Number(c.weight.toFixed(2))]),
        globalRate: r4(launchTable.globalRate),
        brier: [r4(launchGate.brierTable), r4(launchGate.brierA), r4(launchGate.brierB)],
        signs: launchGate.signs.map((s) => (s ? 1 : 0)), signCount: launchGate.signCount, gatePass: launchGate.gatePass ? 1 : 0,
      },
      tiers: tierCounts, sensitivity, portfolio: { board: boardTotal, practical, warned: warnedLine },
      census: {
        buckets: Object.fromEntries(Object.entries(census.buckets).map(([k, b]) => [k, [b.n, b.tvl]])),
        compExcluded: excluded,
      },
    },
    A: { alpha: ASSUMPTIONS.alphaDrop, eta: ASSUMPTIONS.etaDil, ropp: ASSUMPTIONS.rOpp, sizes: ASSUMPTIONS.sizes, scenarios: ASSUMPTIONS.scenarios.map((s) => [s.tvlDrop, s.shareMult, s.holdDays]) },
  };
  const dataJs = `const D=${JSON.stringify(D)};\n`;

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), boardJson);
  const dashOut = join(out, 'dashboard');
  mkdirSync(dashOut, { recursive: true });
  for (const name of readdirSync(join(here, 'dashboard'))) {
    if (name.startsWith('.')) continue;
    const src = join(here, 'dashboard', name);
    if (statSync(src).isFile()) copyFileSync(src, join(dashOut, name));
  }
  writeFileSync(join(dashOut, 'data.js'), dataJs);
  const shotsOut = join(out, 'screenshots');
  mkdirSync(shotsOut, { recursive: true });
  const shots = [];
  for (const name of readdirSync(join(here, 'screenshots'))) {
    if (name.startsWith('.')) continue;
    const src = join(here, 'screenshots', name);
    if (statSync(src).isFile()) { copyFileSync(src, join(shotsOut, name)); shots.push(name); }
  }
  if (shots.length < 3) throw new Error(`screenshots/ holds ${shots.length} images: hand in 3`);
  const dossierBytes = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } });
  writeFileSync(join(out, 'dossier.json'), dossierBytes);
  const dossier = JSON.parse(Buffer.from(dossierBytes).toString('utf8'));
  const textBytes = Buffer.byteLength(dossier.text, 'utf8');
  if (dossier.text.includes('[Cut at')) throw new Error(`dossier text was cut at ${TEXT_MAX_BYTES} bytes: dashboard source over budget`);
  if (textBytes > TEXT_MAX_BYTES - 400) throw new Error(`dossier text ${textBytes} bytes leaves under 400 bytes spare`);
  if (dossierBytes.length > 1572864) throw new Error(`dossier ${dossierBytes.length} bytes over the 1.5 MiB cap`);
  const tRender = performance.now();

  const secs = (a, b) => ((b - a) / 1000).toFixed(2);
  process.stdout.write(
    `token radar v3: ${snap.protocols.length} protocols, ${comps.length} comps (${dated.length} dated), ${nBoard} board rows\n` +
    `shipped: R${shipped.rung} lambda=${shipped.lambda} s=${shipped.s}${gateFailed ? ' (Gate Failed; Fallback to Global Power Law)' : ''}\n` +
    `nested LOO (selection included): ${procLoo.med.toFixed(4)} dex / ${procLoo.mult.toFixed(2)}x; shipped-model LOO: ${shipLoo.med.toFixed(4)} dex / ${shipLoo.mult.toFixed(2)}x\n` +
    `flat baseline LOO: ${r0loo.flatMed.toFixed(4)} dex; R0 LOO: ${r0loo.med.toFixed(4)} dex / Spearman ${r0loo.spear.toFixed(4)}\n` +
    `placebo: ship-rate ${(placebo.shipRate * 100).toFixed(1)}% under ${N_PERMUTATIONS} permutations, P95_null ${placebo.p95.toFixed(4)} dex, shipped gain ${shippedLedger.gain.toFixed(4)} dex\n` +
    `fallback: walk-forward ${wfFallback}/${wfTestN} held-out rows outside their fold box (challengers collapse to the curve); shipped mask ${shipFallback}/${nBoard} board rows outside the full box\n` +
    `bands: LOO coverage P50 ${coverage.cov50.toFixed(3)} / P80 ${coverage.cov80.toFixed(3)}; rank coverage ${rankCal.coverage.toFixed(3)}, shipped median width ${medianOf(shippedWidths)} rows\n` +
    `launch gate: ${launchGate.gatePass ? 'PASS' : 'FAIL'} (Brier table ${launchGate.brierTable.toFixed(4)} vs TVL-logistic ${launchGate.brierB.toFixed(4)} vs base ${launchGate.brierA.toFixed(4)}, signs ${launchGate.signCount}/5)\n` +
    `tiers: ${JSON.stringify(tierCounts)}; top-10 flags: ${JSON.stringify(top10Counts)}; dossier text ${textBytes} bytes (${TEXT_MAX_BYTES - textBytes} spare), dossier ${dossierBytes.length} bytes\n` +
    `timing: parse ${secs(tStart, tParse)}s / fit+select ${secs(tParse, tSelect)}s / validation ${secs(tSelect, tValidate)}s / render ${secs(tValidate, tRender)}s / total ${secs(tStart, tRender)}s (ceiling 120s)\n`,
  );
}

main();
