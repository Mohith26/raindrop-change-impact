// Synthetic production-traffic model for an agent ("sprinkle-ai/assistant"),
// shared by the demo generator, the backtest and the tests.
// Seeded and deterministic. Rates are seeded from Raindrop's own published
// examples (Change Reports page: 238 users hitting compaction within ~48 min of
// a merge, ~$1,048 cost per window, "i said that already" forgetting quotes).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const u = mulberry32(seed);
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let x, y, r;
    do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r === 0 || r >= 1);
    const f = Math.sqrt(-2 * Math.log(r) / r);
    spare = y * f; return x * f;
  };
  const poisson = (lam) => {
    if (lam <= 0) return 0;
    if (lam < 40) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1; }
    return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal()));
  };
  const gamma = (shape) => { // Marsaglia-Tsang (boosted for shape < 1)
    if (shape < 1) return gamma(shape + 1) * Math.pow(u(), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) { let x, v; do { x = normal(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const uu = u(); if (uu < 1 - 0.0331 * x * x * x * x) return d * v; if (Math.log(uu) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
  };
  return { u, normal, poisson, gamma };
}

export const SEGMENTS = ['free', 'pro', 'team'];

export const METRICS = [
  { id: 'frustration', name: 'User Frustration', kind: 'signal', sentiment: 'negative', preset: true, base: [0.060, 0.042, 0.030] },
  { id: 'task_failure', name: 'Task Failure', kind: 'signal', sentiment: 'negative', preset: true, base: [0.028, 0.022, 0.016] },
  { id: 'forgetting', name: 'Forgot earlier context', kind: 'signal', sentiment: 'negative', preset: false, base: [0.010, 0.014, 0.019] },
  { id: 'empty_response', name: 'Ended without a response', kind: 'signal', sentiment: 'negative', preset: false, base: [0.007, 0.006, 0.005], selfDiag: true },
  { id: 'tool_error', name: 'web_search errors', kind: 'tool', sentiment: 'negative', preset: false, base: [0.032, 0.030, 0.026] },
  { id: 'cost', name: 'Cost per event', kind: 'cost', sentiment: 'negative', preset: false, base: [2.10, 3.40, 4.60], sdLog: 0.85 },
];

// local calendar (America/Los_Angeles, DST-aware) for H hours from startISO (UTC)
export function makeCalendar(startISO, H) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const start = Date.parse(startISO);
  const key = new Array(H), hod = new Array(H), wkend = new Array(H), dow = new Array(H);
  for (let h = 0; h < H; h++) {
    const parts = fmt.formatToParts(new Date(start + h * 3600e3));
    const hr = +parts.find(p => p.type === 'hour').value;
    const wd = parts.find(p => p.type === 'weekday').value;
    const we = wd === 'Sat' || wd === 'Sun';
    hod[h] = hr; wkend[h] = we ? 1 : 0; dow[h] = wd; key[h] = hr + (we ? 24 : 0);
  }
  return { startISO, H, key, hod, wkend, dow };
}

// expected traffic and segment mix for an hour
export function traffic(cal, h, scale = 1400) {
  const x = cal.hod[h];
  const shape = 0.28 + 1.32 * Math.exp(-(((x - 13) / 4.6) ** 2)) + 0.22 * Math.exp(-(((x - 21) / 2.2) ** 2));
  const we = cal.wkend[h];
  const day = h / 24;
  const total = scale * shape * (we ? 0.55 : 1) * (1 + 0.003 * day);
  let mix = we ? [0.66, 0.26, 0.08] : [0.45, 0.35, 0.20];
  if (x < 6) mix = [mix[0] + 0.12, mix[1] - 0.07, mix[2] - 0.05];
  return { total, mix };
}

// multiplicative hour-of-day / weekend modifiers per metric (the confounders)
export function seasonal(metricId, cal, h) {
  const x = cal.hod[h], we = cal.wkend[h];
  switch (metricId) {
    case 'frustration': return (x < 6 ? 1.25 : 1) * (we ? 1.10 : 1);
    case 'task_failure': return (x < 6 ? 1.15 : 1);
    case 'forgetting': return (we ? 0.88 : 1) * (x >= 9 && x <= 17 ? 1.08 : 1);
    case 'empty_response': return 1;
    case 'tool_error': return (x >= 9 && x <= 17 && !we ? 1.18 : 1);
    case 'cost': return (x >= 9 && x <= 17 && !we ? 1.06 : 0.97);
    default: return 1;
  }
}

// latent hourly/day noise processes (shared across segments) = realistic overdispersion
export function latent(rng, H, metrics, tauHour = 0.10, tauDay = 0.025) {
  const out = {};
  for (const m of metrics) {
    const hr = new Float64Array(H); let walk = 0; const days = Math.ceil(H / 24) + 1; const d = new Float64Array(days);
    for (let i = 0; i < days; i++) { walk = 0.85 * walk + tauDay * rng.normal(); d[i] = walk; }
    const tau = m.kind === 'cost' ? tauHour * 0.4 : tauHour;
    for (let h = 0; h < H; h++) hr[h] = Math.exp(tau * rng.normal() + d[Math.floor(h / 24)] - tau * tau / 2);
    out[m.id] = hr;
  }
  return out;
}

// true multiplicative effect on metric at hour h given PR list with effects
export function effectAt(prs, metricId, h) {
  let f = 1;
  for (const p of prs) if (p.t0 <= h && p.effects && p.effects[metricId]) f *= p.effects[metricId];
  return f;
}

// Fast cell-level sampler (used by the backtest): counts per (segment, hour)
export function sampleCells(rng, cal, metrics, prs, opts = {}) {
  const H = cal.H, S = SEGMENTS.length;
  const lat = latent(rng, H, metrics, opts.tauHour, opts.tauDay);
  const n = Array.from({ length: S }, () => new Array(H).fill(0));
  const m = {};
  for (const met of metrics) m[met.id] = { y: Array.from({ length: S }, () => new Array(H).fill(0)), ...(met.kind === 'cost' ? { y2: Array.from({ length: S }, () => new Array(H).fill(0)) } : {}) };
  for (let h = 0; h < H; h++) {
    const { total, mix } = traffic(cal, h, opts.scale);
    const vol = total * Math.exp(0.08 * rng.normal());
    for (let s = 0; s < S; s++) {
      const ns = rng.poisson(vol * mix[s]); n[s][h] = ns; if (!ns) continue;
      for (const met of metrics) {
        const mult = seasonal(met.id, cal, h) * lat[met.id][h] * effectAt(prs, met.id, h);
        if (met.kind === 'cost') {
          const mean = met.base[s] * mult, sdl = met.sdLog;
          const varx = mean * mean * (Math.exp(sdl * sdl) - 1);
          const sum = Math.max(0, ns * mean + Math.sqrt(ns * varx) * rng.normal());
          const s2 = ns > 1 ? varx * (2 * rng.gamma((ns - 1) / 2)) / (ns - 1) : 0;
          m[met.id].y[s][h] = sum; m[met.id].y2[s][h] = (ns - 1) * s2 + (sum * sum) / ns;
        } else {
          // user-level clustering: beta-binomial-ish via gamma frailty per cell
          const p = Math.min(met.base[s] * mult, 0.95);
          const frail = rng.gamma(20) / 20;
          m[met.id].y[s][h] = Math.min(ns, rng.poisson(ns * p * frail));
        }
      }
    }
  }
  return { n, m };
}
