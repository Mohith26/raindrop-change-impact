// Backtest: how often does each method raise a false alarm on merges that
// change nothing, how fast does it catch real changes, and does it blame the
// right PR when two merges are stacked? Fresh synthetic stream per trial
// (cell-level sampler, same traffic model as the demo), random merge times
// covering weekdays, nights and weekends.
//   node scripts/backtest.mjs [trials]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, makeCalendar, sampleCells, METRICS } from './model.mjs';
import { analyzeMetric, naiveCompare, verdictOf, detectionHour, normInv, round } from '../src/impact.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const metrics = METRICS.map(({ base, sdLog, ...r }) => ({ ...r }));
const START = '2026-09-28T07:00:00Z';
const PRE = 30 * 24; // history before the merge window
const POST = 24;
const FAMILY = 0.05;

export function runTrial(seed, { effects = {}, stacked = null, post = POST } = {}) {
  const rng = makeRng(seed);
  const offset = Math.floor(rng.u() * 168); // random hour-of-week for the merge
  const H = PRE + offset + post + (stacked ? stacked.gap : 0) + 1;
  const cal = makeCalendar(START, H);
  const t0 = PRE + offset;
  const prs = [{ number: 1, t0, effects }];
  if (stacked) prs.push({ number: 2, t0: t0 + stacked.gap, effects: stacked.effects ?? {} });
  const cells = sampleCells(rng, cal, METRICS, prs.map(p => ({ t0: p.t0, effects: p.effects })));
  return { cal, cells, prs, H, t0 };
}

function evalTrial(tr, { pr = 0, until, chain = true, peekFixed = false } = {}) {
  const alpha = FAMILY / metrics.length;
  const out = { adj: [], naive: [], peek: [] };
  for (const metric of metrics) {
    const ratios = new Map();
    // analyse earlier PRs first so stacked-merge ratios exist
    for (let i = 0; i <= pr; i++) {
      const ctx = { cal: tr.cal, cells: tr.cells, metric, prs: tr.prs, H: tr.H, alpha, ratios: chain ? ratios : new Map() };
      const res = analyzeMetric(ctx, i, { until });
      if (Number.isFinite(res.varLnR)) ratios.set(tr.prs[i].number, { lnR: res.lnR, varLnR: res.varLnR });
      if (i !== pr) continue;
      const v = res.series.map(p => verdictOf(metric, p));
      const flagged = v.find(x => x === 'worse' || x === 'better') ?? 'none';
      out.adj.push({ metric: metric.id, verdict: flagged, at: detectionHour(metric, res.series), final: res.series[res.series.length - 1] });
      const e = naiveCompare(ctx, i, 1), f = naiveCompare(ctx, i, 24);
      const nv = [e, f].filter(Boolean).find(x => x.verdict !== 'none');
      out.naive.push({ metric: metric.id, verdict: nv ? nv.verdict : 'none', at: e && e.verdict !== 'none' ? 1 : (f && f.verdict !== 'none' ? f.hours : null) });
      if (peekFixed) {
        // ablation: same adjusted estimate, but a plain 95% z interval re-checked every hour
        const z = 1.959964;
        let at = null, dir = 'none';
        for (const p of res.series) {
          const se = Math.sqrt(p.V + p.E * p.E * p.varRel);
          if (p.N >= 30 && Math.abs(p.O - p.E) > z * se) { at = p.t; dir = ((p.O > p.E) === (metric.sentiment !== 'positive')) ? 'worse' : 'better'; break; }
        }
        out.peek.push({ metric: metric.id, verdict: dir, at });
      }
    }
  }
  return out;
}

export function nullBacktest(trials = 400, seed0 = 7) {
  let adjFA = 0, naiveFA = 0, peekFA = 0;
  const perMetric = Object.fromEntries(metrics.map(m => [m.id, { adj: 0, naive: 0 }]));
  for (let i = 0; i < trials; i++) {
    const tr = runTrial(seed0 * 100003 + i);
    const r = evalTrial(tr, { peekFixed: true });
    if (r.adj.some(x => x.verdict !== 'none')) adjFA++;
    if (r.naive.some(x => x.verdict !== 'none')) naiveFA++;
    if (r.peek.some(x => x.verdict !== 'none')) peekFA++;
    for (const x of r.adj) if (x.verdict !== 'none') perMetric[x.metric].adj++;
    for (const x of r.naive) if (x.verdict !== 'none') perMetric[x.metric].naive++;
  }
  return { adjusted: round(adjFA / trials, 4), naive: round(naiveFA / trials, 4), adjustedFixedPeeking: round(peekFA / trials, 4), adjustedCount: adjFA, naiveCount: naiveFA, perMetric: Object.fromEntries(Object.entries(perMetric).map(([k, v]) => [k, { adjusted: round(v.adj / trials, 4), naive: round(v.naive / trials, 4) }])) };
}

export function backtest(trials = 400, seed0 = 7) {
  // 1) null merges
  const nullMerges = nullBacktest(trials, seed0);
  // 2) planted regressions/improvements (one metric, true effect)
  const plants = [
    { metric: 'forgetting', effect: 1.45 }, { metric: 'tool_error', effect: 1.35 }, { metric: 'frustration', effect: 1.25 },
    { metric: 'task_failure', effect: 1.3 }, { metric: 'empty_response', effect: 0.2 }, { metric: 'cost', effect: 0.92 },
  ];
  const power = [];
  const nPow = Math.max(20, Math.floor(trials / 4));
  for (const pl of plants) {
    let adjHit = 0, naiveHit = 0, adjOther = 0, naiveOther = 0, adjHit72 = 0; const adjAt = [];
    for (let i = 0; i < nPow; i++) {
      const tr = runTrial(seed0 * 200003 + i * 7 + pl.metric.length, { effects: { [pl.metric]: pl.effect } });
      const r = evalTrial(tr);
      const want = (pl.effect > 1) ? 'worse' : 'better';
      const a = r.adj.find(x => x.metric === pl.metric), n = r.naive.find(x => x.metric === pl.metric);
      if (a.verdict === want) { adjHit++; adjAt.push(a.at); }
      if (n.verdict === want) naiveHit++;
      if (r.adj.some(x => x.metric !== pl.metric && x.verdict !== 'none')) adjOther++;
      if (r.naive.some(x => x.metric !== pl.metric && x.verdict !== 'none')) naiveOther++;
      // same seed, monitored for 72 h (Change Impact keeps watching the commit window)
      const tr72 = runTrial(seed0 * 200003 + i * 7 + pl.metric.length, { effects: { [pl.metric]: pl.effect }, post: 72 });
      const metric = metrics.find(m => m.id === pl.metric);
      const ctx = { cal: tr72.cal, cells: tr72.cells, metric, prs: tr72.prs, H: tr72.H, alpha: FAMILY / metrics.length };
      const res72 = analyzeMetric(ctx, 0);
      if (res72.series.some(p => verdictOf(metric, p) === want)) adjHit72++;
    }
    adjAt.sort((x, y) => x - y);
    power.push({ metric: pl.metric, effect: pl.effect, trials: nPow, adjPower: round(adjHit / nPow, 3), adjPower72h: round(adjHit72 / nPow, 3), naivePower: round(naiveHit / nPow, 3), adjMedianHours: adjAt.length ? adjAt[Math.floor(adjAt.length / 2)] : null, adjOtherFalse: round(adjOther / nPow, 3), naiveOtherFalse: round(naiveOther / nPow, 3) });
  }
  // 3) stacked merges: PR1 raises forgetting x1.5, PR2 (6 h later) changes nothing.
  //    Is PR2 blamed? (with and without stacked-merge attribution)
  const nSt = Math.max(20, Math.floor(trials / 4));
  let blamedAdj = 0, blamedNoChain = 0, blamedNaive = 0;
  for (let i = 0; i < nSt; i++) {
    const tr = runTrial(seed0 * 300007 + i, { effects: { forgetting: 1.5 }, stacked: { gap: 6, effects: {} } });
    const r = evalTrial(tr, { pr: 1 });
    const r0 = evalTrial(tr, { pr: 1, chain: false });
    if (r.adj.find(x => x.metric === 'forgetting').verdict !== 'none') blamedAdj++;
    if (r0.adj.find(x => x.metric === 'forgetting').verdict !== 'none') blamedNoChain++;
    if (r.naive.find(x => x.metric === 'forgetting').verdict !== 'none') blamedNaive++;
  }
  return {
    trials, familyAlpha: FAMILY, metrics: metrics.length, postHours: POST,
    nullMerges,
    power,
    stacked: { trials: nSt, gapHours: 6, effect: 'forgetting x1.5 on the first PR only', secondBlamed: { adjusted: round(blamedAdj / nSt, 3), withoutAttribution: round(blamedNoChain / nSt, 3), naive: round(blamedNaive / nSt, 3) } },
  };
}

if (process.argv[1] && process.argv[1].endsWith('backtest.mjs')) {
  const trials = +(process.argv[2] ?? 400);
  const t = Date.now();
  const bt = backtest(trials);
  bt.runtimeMs = Date.now() - t;
  const p = path.join(ROOT, 'results/results.json');
  const prev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  prev.backtest = { generatedBy: `node scripts/backtest.mjs ${trials}`, ...bt };
  fs.writeFileSync(p, JSON.stringify(prev, null, 1));
  console.log(JSON.stringify(bt, null, 1));
}
