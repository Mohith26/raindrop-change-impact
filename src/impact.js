// Change Impact: anytime-valid, seasonality- and mix-adjusted before/after
// estimates for every merged PR, with attribution across stacked merges.
//
// Pure functions, no DOM. Used by the browser app (index.html), the data
// generator / backtest (scripts/*.mjs) and the unit tests (test/*.mjs).
//
// Data layout (see data/project.json):
//   cal.key[h]        season key of hour h: local hour-of-day + 24 * isWeekend
//   cells.n[s][h]     events of segment s in hour h
//   cells.m[id].y[s][h]   sum of the metric over those events (count for signals, $ for cost)
//   cells.m[id].y2[s][h]  sum of squares (only stored for continuous metrics; binary uses y)
//
// Method (per PR p merged at hour t0, metric k):
//   1. Profile: rate[s,key] = a[s] * b[key] fitted by raking (Poisson log-linear
//      model, two-way multiplicative) on the 28 days before t0.
//   2. Level: L = observed / profile-expected over the 48 h before t0. Hours that
//      ran on an earlier PR's code are rescaled by that PR's own estimated ratio
//      (stacked-merge attribution), so an earlier change is not blamed on this one.
//   3. Counterfactual for every post-merge cell: L * a[s] * b[key] (adjusts for
//      hour-of-day, weekend and traffic-mix differences between windows).
//   4. S_t = O_t - E_t over the commit-scoped post window. Two error sources:
//        sampling: Gaussian-mixture confidence sequence on S_t with intrinsic
//        time V_t = phi * sum n * var (phi = overdispersion fitted on the baseline);
//        baseline: E_t * eps, eps ~ N(0, var_rel) from the profile/level fit.
//      Radius = CS(V_t; alpha/2) + z(1 - alpha/4) * E_t * sqrt(var_rel), with
//      alpha = familyAlpha / (#metrics) so all metrics hold simultaneously at
//      every hourly look (Ville's inequality + Bonferroni).

export const SEASON_KEYS = 48;

// ---------- small numeric helpers ----------
export function normInv(p) {
  // Acklam's rational approximation, |rel err| < 1.2e-9
  if (p <= 0 || p >= 1) throw new RangeError('p must be in (0,1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf, |err| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// Two-sided Gaussian-mixture boundary (Robbins; Howard et al. 2021):
// P(exists t: |S_t| >= r(V_t)) <= alpha for a process whose increments are
// (approximately) conditionally Gaussian with variance increments dV.
export function mixtureRadius(V, rho, alpha) {
  const v = Math.max(V, 0) + rho;
  return Math.sqrt(v * Math.log(v / (rho * alpha * alpha)));
}

// rho that minimises the boundary at intrinsic time Vstar.
export function tuneRho(Vstar, alpha) {
  const l = -2 * Math.log(alpha);
  return Math.max(Vstar, 1e-9) / (l + Math.log(1 + l));
}

// ---------- metric helpers ----------
export function isBinary(metric) { return metric.kind !== 'cost'; }

function cellVar(metric, n, y, y2) {
  // per-event variance in a cell (binary: p(1-p); continuous: sample variance)
  if (n <= 0) return 0;
  const mean = y / n;
  if (isBinary(metric)) return Math.max(mean * (1 - mean), 0);
  return Math.max(y2 / n - mean * mean, 0);
}

// ---------- 1. seasonal x segment profile (raking) ----------
export function fitProfile(cal, cells, metric, from, to, opts = {}) {
  const S = cells.n.length;
  const K = SEASON_KEYS;
  const iters = opts.iters ?? 25;
  const mc = cells.m[metric.id];
  const N = Array.from({ length: S }, () => new Float64Array(K));
  const Y = Array.from({ length: S }, () => new Float64Array(K));
  const Y2 = Array.from({ length: S }, () => new Float64Array(K));
  for (let s = 0; s < S; s++) {
    for (let h = Math.max(0, from); h < to; h++) {
      const k = cal.key[h];
      N[s][k] += cells.n[s][h];
      Y[s][k] += mc.y[s][h];
      if (mc.y2) Y2[s][k] += mc.y2[s][h];
    }
  }
  const a = new Float64Array(S).fill(1);
  const b = new Float64Array(K).fill(1);
  // init a with segment means
  for (let s = 0; s < S; s++) {
    let n = 0, y = 0; for (let k = 0; k < K; k++) { n += N[s][k]; y += Y[s][k]; }
    a[s] = n > 0 ? Math.max(y / n, 1e-12) : 1e-12;
  }
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < K; k++) {
      let num = 0, den = 0;
      for (let s = 0; s < S; s++) { num += Y[s][k]; den += N[s][k] * a[s]; }
      b[k] = den > 0 ? Math.max(num / den, 1e-6) : 1;
    }
    // normalise b to weighted mean 1 so a carries the level
    let wb = 0, w = 0;
    for (let k = 0; k < K; k++) { let nk = 0; for (let s = 0; s < S; s++) nk += N[s][k]; wb += nk * b[k]; w += nk; }
    const mb = w > 0 ? wb / w : 1;
    for (let k = 0; k < K; k++) b[k] /= mb;
    for (let s = 0; s < S; s++) {
      let num = 0, den = 0;
      for (let k = 0; k < K; k++) { num += Y[s][k]; den += N[s][k] * b[k]; }
      a[s] = den > 0 ? Math.max(num / den, 1e-12) : a[s];
    }
  }
  // per-event variance by segment (pooled), used for phi and variances
  const segVar = new Float64Array(S);
  for (let s = 0; s < S; s++) {
    let n = 0, y = 0, y2 = 0;
    for (let k = 0; k < K; k++) { n += N[s][k]; y += Y[s][k]; y2 += mc.y2 ? Y2[s][k] : Y[s][k]; }
    segVar[s] = cellVar(metric, n, y, y2);
  }
  const rateAt = (s, k) => a[s] * b[k];
  const perEventVar = (s, k) => {
    if (isBinary(metric)) { const p = Math.min(rateAt(s, k), 0.999); return p * (1 - p); }
    // continuous: keep the segment's coefficient of variation, scale by mean
    const segMean = a[s];
    const cv2 = segMean > 0 ? segVar[s] / (segMean * segMean) : 0;
    const m = rateAt(s, k); return cv2 * m * m;
  };
  // overdispersion phi: Pearson X2 over hourly cells / dof
  let X2 = 0, cnt = 0;
  for (let s = 0; s < S; s++) {
    for (let h = Math.max(0, from); h < to; h++) {
      const n = cells.n[s][h]; if (n < 1) continue;
      const k = cal.key[h];
      const e = n * rateAt(s, k);
      const v = n * perEventVar(s, k);
      if (v <= 0) continue;
      const r = mc.y[s][h] - e;
      X2 += r * r / v; cnt++;
    }
  }
  const dof = Math.max(cnt - (S + K - 1), 1);
  const phi = Math.max(1, X2 / dof);
  // relative (log-scale) variances of a[s] and b[k]
  const varLnB = new Float64Array(K), varLnA = new Float64Array(S);
  for (let k = 0; k < K; k++) {
    let v = 0, e = 0;
    for (let s = 0; s < S; s++) { v += N[s][k] * perEventVar(s, k); e += N[s][k] * rateAt(s, k); }
    varLnB[k] = e > 0 ? phi * v / (e * e) : 0;
  }
  for (let s = 0; s < S; s++) {
    let v = 0, e = 0;
    for (let k = 0; k < K; k++) { v += N[s][k] * perEventVar(s, k); e += N[s][k] * rateAt(s, k); }
    varLnA[s] = e > 0 ? phi * v / (e * e) : 0;
  }
  return { a: Array.from(a), b: Array.from(b), phi, varLnA: Array.from(varLnA), varLnB: Array.from(varLnB), rateAt, perEventVar, from, to };
}

// variance of day-over-day changes in log(observed/expected), net of sampling
// noise. Uses 24 h blocks at four phase offsets (0/6/12/18 h) for stability and
// skips block pairs that straddle another merge (a real level shift, not drift).
export function estimateDrift(cal, cells, metric, prof, from, to, merges = []) {
  const S = cells.n.length; const mc = cells.m[metric.id];
  let sd2 = 0, sv = 0, m = 0;
  for (const off of [0, 6, 12, 18]) {
    let prev = null;
    for (let d0 = from + off; d0 + 24 <= to; d0 += 24) {
      let O = 0, E = 0, V = 0;
      for (let h = d0; h < d0 + 24; h++) { const k = cal.key[h]; for (let s = 0; s < S; s++) { const n = cells.n[s][h]; if (!n) continue; O += mc.y[s][h]; E += n * prof.rateAt(s, k); V += n * prof.perEventVar(s, k); } }
      const cur = (O > 0 && E > 0) ? { d0, r: Math.log(O / E), v: prof.phi * V / (O * O) } : null;
      if (cur && prev && !merges.some(t => t > prev.d0 && t < cur.d0 + 24)) { const d = cur.r - prev.r; sd2 += d * d; sv += cur.v + prev.v; m++; }
      prev = cur;
    }
  }
  if (m < 8) return 0;
  return Math.max(0, (sd2 - sv) / m);
}

// per-event variance in cell (s,k) when the rate is scaled by c
export function eventVarAt(metric, prof, s, k, c) {
  if (isBinary(metric)) { const p = Math.min(prof.rateAt(s, k) * c, 0.999); return p * (1 - p); }
  return prof.perEventVar(s, k) * c * c;
}

// shares of the expected sum by season key and by segment over [from,to), with per-hour weights
function expShares(cal, cells, prof, from, to, weight) {
  const S = cells.n.length;
  const wk = new Float64Array(SEASON_KEYS), ws = new Float64Array(S);
  let tot = 0;
  for (let h = from; h < to; h++) {
    const c = weight ? weight(h) : 1;
    const k = cal.key[h];
    for (let s = 0; s < S; s++) {
      const e = cells.n[s][h] * prof.rateAt(s, k) * c;
      wk[k] += e; ws[s] += e; tot += e;
    }
  }
  if (tot > 0) { for (let k = 0; k < SEASON_KEYS; k++) wk[k] /= tot; for (let s = 0; s < S; s++) ws[s] /= tot; }
  return { wk, ws, tot };
}

// ---------- helpers on PR timelines ----------
// end of PR i's commit-scoped window = next merge of the same agent (or data end)
export function windowEnd(prs, i, H) {
  const t0 = prs[i].t0;
  let end = H;
  for (const p of prs) if (p.t0 > t0 && p.t0 < end) end = p.t0;
  return end;
}

// ---------- 2-4. one PR x one metric ----------
// ctx: { cal, cells, metric, prs, H, alpha (per-metric), profileDays, levelHours, ratios }
// ratios: Map prNumber -> { lnR, varLnR } for earlier PRs (stacked-merge attribution)
export function analyzeMetric(ctx, prIndex, opts = {}) {
  const { cal, cells, metric, prs } = ctx;
  const H = ctx.H ?? cells.n[0].length;
  const pr = prs[prIndex];
  const t0 = pr.t0;
  const tEnd = Math.min(opts.until ?? H, windowEnd(prs, prIndex, H));
  const profileHours = (ctx.profileDays ?? 28) * 24;
  const levelHours = ctx.levelHours ?? 48;
  const alpha = ctx.alpha ?? 0.05 / 6;
  const S = cells.n.length;
  const mc = cells.m[metric.id];

  const prof = fitProfile(cal, cells, metric, Math.max(0, t0 - profileHours), t0);

  // level window with stacked-merge correction
  const lvFrom = Math.max(0, t0 - levelHours);
  const earlier = prs.filter(p => p.t0 > lvFrom && p.t0 < t0).sort((x, y) => x.t0 - y.t0);
  const ratios = ctx.ratios ?? new Map();
  let used = [];
  // hour h ran on regime after the last merge <= h; its expected rate under the
  // *current* regime is scaled by 1/prod(R_j) for every earlier merge j after h
  const scaleAt = (h) => {
    let lnc = 0;
    for (const p of earlier) if (p.t0 > h) { const r = ratios.get(p.number); if (r) lnc -= r.lnR; }
    return Math.exp(lnc);
  };
  let Ylv = 0, Elv = 0, Vlv = 0;
  for (let h = lvFrom; h < t0; h++) {
    const k = cal.key[h]; const c = scaleAt(h);
    for (let s = 0; s < S; s++) {
      const n = cells.n[s][h]; if (!n) continue;
      Ylv += mc.y[s][h];
      Elv += n * prof.rateAt(s, k) * c;
    }
  }
  const L = Elv > 0 && Ylv > 0 ? Ylv / Elv : 1;
  // variance of the level-window sum at the fitted rates (second pass)
  for (let h = lvFrom; h < t0; h++) {
    const k = cal.key[h]; const c = scaleAt(h) * L;
    for (let s = 0; s < S; s++) {
      const n = cells.n[s][h]; if (!n) continue;
      Vlv += n * eventVarAt(metric, prof, s, k, c);
    }
  }
  // delta method: Var(ln L) ~ Var(Y_lv) / Y_lv^2
  let varLnL = Ylv > 0 ? prof.phi * Vlv / (Ylv * Ylv) : 1;
  for (const p of earlier) {
    const r = ratios.get(p.number); if (!r) continue;
    // share of the level window's expected sum that lies before merge p
    let before = 0;
    for (let h = lvFrom; h < p.t0; h++) { const k = cal.key[h]; for (let s = 0; s < S; s++) before += cells.n[s][h] * prof.rateAt(s, k) * scaleAt(h); }
    const share = Elv > 0 ? before / Elv : 0;
    varLnL += share * share * r.varLnR;
    used.push({ number: p.number, share, lnR: r.lnR });
  }
  // day-to-day level drift: the level window can only predict the post window up
  // to the drift between days. Estimate the variance of consecutive daily
  // log(observed/profile) changes beyond what sampling explains.
  const varDrift = (opts.drift === false || ctx.drift === false) ? 0 : estimateDrift(cal, cells, metric, prof, Math.max(0, t0 - profileHours), lvFrom, prs.map(p => p.t0).filter(t => t < t0));
  varLnL += varDrift;
  const lvShares = expShares(cal, cells, prof, lvFrom, t0, scaleAt);

  // post-merge cumulative series (hourly looks)
  const series = [];
  let O = 0, E = 0, V = 0, N = 0;
  const wk = new Float64Array(SEASON_KEYS), ws = new Float64Array(S);
  // tune rho for intrinsic time at 24 h from the baseline's per-hour average
  const perHourV = (() => {
    let v = 0, hrs = 0;
    for (let h = Math.max(0, t0 - 168); h < t0; h++) { hrs++; const k = cal.key[h]; for (let s = 0; s < S; s++) v += cells.n[s][h] * prof.perEventVar(s, k); }
    return hrs ? prof.phi * v / hrs : 1;
  })();
  const rho = tuneRho(perHourV * 24, alpha / 2);
  const zB = normInv(1 - alpha / 4);
  for (let h = t0; h < tEnd; h++) {
    const k = cal.key[h];
    for (let s = 0; s < S; s++) {
      const n = cells.n[s][h]; if (!n) continue;
      const e = n * L * prof.rateAt(s, k);
      O += mc.y[s][h]; E += e; N += n;
      V += n * eventVarAt(metric, prof, s, k, L);
      wk[k] += e; ws[s] += e;
    }
    // baseline relative variance for the current post mix
    let vr = varLnL;
    if (E > 0) {
      for (let kk = 0; kk < SEASON_KEYS; kk++) { const d = wk[kk] / E - lvShares.wk[kk]; vr += d * d * prof.varLnB[kk]; }
      for (let s = 0; s < S; s++) { const d = ws[s] / E - lvShares.ws[s]; vr += d * d * prof.varLnA[s]; }
    }
    const Vt = prof.phi * V;
    const rCS = mixtureRadius(Vt, rho, alpha / 2);
    const rB = zB * E * Math.sqrt(vr);
    const rad = rCS + rB;
    const diff = O - E;
    series.push({
      t: h - t0 + 1, N, O, E, V: Vt, varRel: vr, rCS, rB,
      rel: E > 0 ? diff / E : 0,
      relLo: E > 0 ? Math.max(-1, (diff - rad) / E) : -1, // a rate can't fall below zero
      relHi: E > 0 ? (diff + rad) / E : Infinity,
      obsRate: N > 0 ? O / N : 0, expRate: N > 0 ? E / N : 0,
      absDiff: N > 0 ? diff / N : 0,
      absLo: N > 0 ? Math.max(-E / N, (diff - rad) / N) : -Infinity, absHi: N > 0 ? (diff + rad) / N : Infinity,
    });
  }
  const last = series[series.length - 1] ?? null;
  const lnR = last && last.O > 0 && last.E > 0 ? Math.log(last.O / last.E) : 0;
  const varLnR = last && last.O > 0 ? (last.V / (last.E * last.E)) + last.varRel : Infinity;
  return { pr: pr.number, metric: metric.id, t0, tEnd, L, varLnL, varDrift, phi: prof.phi, rho, alpha, profile: prof, chained: used, series, lnR, varLnR };
}

export function verdictOf(metric, pt, minEvents = 30) {
  if (!pt || pt.N < minEvents || pt.E < 3) return 'early';
  const worseUp = metric.sentiment !== 'positive';
  if (pt.relLo > 0) return worseUp ? 'worse' : 'better';
  if (pt.relHi < 0) return worseUp ? 'better' : 'worse';
  return 'none';
}

// first hourly look at which the verdict became decided (or null)
export function detectionHour(metric, series) {
  for (const p of series) { const v = verdictOf(metric, p); if (v === 'worse' || v === 'better') return p.t; }
  return null;
}

// Hours of additional traffic needed until the CS could exclude zero for a
// given true relative effect (projection at the current per-hour rates).
export function hoursToDetect(res, effect, maxHours = 24 * 14) {
  const s = res.series; if (!s.length) return null;
  const last = s[s.length - 1];
  const hrs = last.t;
  const eRate = last.E / hrs, vRate = last.V / hrs;
  const zB = normInv(1 - res.alpha / 4);
  const floor = zB * Math.sqrt(last.varRel);
  if (Math.abs(effect) <= floor) return { hours: null, floor };
  for (let t = 1; t <= maxHours; t++) {
    const E = eRate * t, V = vRate * t;
    const rad = mixtureRadius(V, res.rho, res.alpha / 2) + zB * E * Math.sqrt(last.varRel);
    if (Math.abs(effect) * E > rad) return { hours: t, floor };
  }
  return { hours: null, floor };
}

// ---------- the naive comparison Change Reports does today ----------
// equal-length window before the merge vs the commit-scoped window after,
// raw rates, two-sample z test (Welch for continuous metrics).
export function naiveCompare(ctx, prIndex, hours) {
  const { cells, metric, prs } = ctx;
  const H = ctx.H ?? cells.n[0].length;
  const pr = prs[prIndex];
  const t0 = pr.t0;
  const end = Math.min(t0 + hours, windowEnd(prs, prIndex, H));
  const span = end - t0;
  if (span <= 0) return null;
  const S = cells.n.length; const mc = cells.m[metric.id];
  const agg = (from, to) => {
    let n = 0, y = 0, y2 = 0;
    for (let h = Math.max(0, from); h < to; h++) for (let s = 0; s < S; s++) { n += cells.n[s][h]; y += mc.y[s][h]; y2 += mc.y2 ? mc.y2[s][h] : mc.y[s][h]; }
    return { n, y, y2, mean: n ? y / n : 0, v: n ? cellVar(metric, n, y, y2) : 0 };
  };
  const pre = agg(t0 - span, t0), post = agg(t0, end);
  let se;
  if (isBinary(metric)) { const p = (pre.y + post.y) / Math.max(pre.n + post.n, 1); se = Math.sqrt(p * (1 - p) * (1 / Math.max(pre.n, 1) + 1 / Math.max(post.n, 1))); }
  else se = Math.sqrt(pre.v / Math.max(pre.n, 1) + post.v / Math.max(post.n, 1));
  const diff = post.mean - pre.mean;
  const z = se > 0 ? diff / se : 0;
  const rel = pre.mean > 0 ? diff / pre.mean : 0;
  const sig = Math.abs(z) > 1.959964 && pre.n >= 30 && post.n >= 30;
  const worseUp = metric.sentiment !== 'positive';
  const verdict = !sig ? 'none' : ((diff > 0) === worseUp ? 'worse' : 'better');
  return { hours: span, pre, post, diff, rel, z, verdict };
}

// ---------- whole project ----------
// Analyse every PR (chronologically, so stacked-merge ratios are available)
// for every metric. familyAlpha is split across metrics (Bonferroni).
export function analyzeProject(data, opts = {}) {
  const familyAlpha = opts.familyAlpha ?? 0.05;
  const metrics = data.metrics;
  const alpha = familyAlpha / metrics.length;
  const H = opts.until ?? data.cal.key.length;
  const prs = data.prs.filter(p => p.t0 < H).slice().sort((a, b) => a.t0 - b.t0);
  const out = new Map();
  for (const metric of metrics) {
    const ratios = new Map();
    for (let i = 0; i < prs.length; i++) {
      const ctx = { cal: data.cal, cells: data.cells, metric, prs, H, alpha, profileDays: opts.profileDays ?? 28, levelHours: opts.levelHours ?? 48, ratios: opts.chain === false ? new Map() : ratios };
      const res = analyzeMetric(ctx, i);
      if (Number.isFinite(res.varLnR)) ratios.set(prs[i].number, { lnR: res.lnR, varLnR: res.varLnR });
      const naive = {
        early: naiveCompare(ctx, i, opts.earlyHours ?? 1),
        full: naiveCompare(ctx, i, opts.fullHours ?? 24),
      };
      if (!out.has(prs[i].number)) out.set(prs[i].number, {});
      out.get(prs[i].number)[metric.id] = { res, naive };
    }
  }
  return { alpha, familyAlpha, prs, byPr: out };
}

// state of a PR x metric at a given look (hours since merge, or Infinity = latest)
export function lookAt(res, hours) {
  const s = res.series; if (!s.length) return null;
  if (!Number.isFinite(hours)) return s[s.length - 1];
  const i = Math.min(s.length, Math.max(1, Math.floor(hours))) - 1;
  return s[i];
}

// CSV export of a project analysis at a look
export function toCSV(data, analysis, hours = Infinity) {
  const rows = [['pr', 'title', 'metric', 'hours_since_merge', 'events', 'observed', 'expected', 'rel_change', 'rel_lo', 'rel_hi', 'verdict', 'naive_full_rel', 'naive_full_verdict']];
  for (const pr of analysis.prs) {
    const byM = analysis.byPr.get(pr.number);
    for (const metric of data.metrics) {
      const { res, naive } = byM[metric.id];
      const pt = lookAt(res, hours);
      if (!pt) continue;
      const nv = naive.full;
      rows.push([pr.number, JSON.stringify(pr.title), metric.id, pt.t, pt.N, round(pt.O, 4), round(pt.E, 4), round(pt.rel, 5), round(pt.relLo, 5), round(pt.relHi, 5), verdictOf(metric, pt), nv ? round(nv.rel, 5) : '', nv ? nv.verdict : '']);
    }
  }
  return rows.map(r => r.join(',')).join('\n');
}

export function round(x, d = 3) { if (!Number.isFinite(x)) return x; const f = 10 ** d; return Math.round(x * f) / f; }
