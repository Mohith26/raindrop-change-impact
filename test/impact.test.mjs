import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normInv, normCdf, mixtureRadius, tuneRho, fitProfile, analyzeMetric, naiveCompare, verdictOf,
  hoursToDetect, windowEnd, analyzeProject, lookAt, toCSV, estimateDrift,
} from '../src/impact.js';
import { makeRng, makeCalendar, traffic, seasonal, METRICS, SEGMENTS } from '../scripts/model.mjs';
import { runTrial, nullBacktest } from '../scripts/backtest.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = '2026-09-28T07:00:00Z';
const metric = (id) => METRICS.map(({ base, sdLog, ...r }) => r).find(m => m.id === id);

// Deterministic "expected-value" data: n and y equal their means exactly (no noise).
function exactData(H, prs, metricIds = ['frustration', 'cost']) {
  const cal = makeCalendar(START, H);
  const S = SEGMENTS.length;
  const n = Array.from({ length: S }, () => new Array(H).fill(0));
  const m = {};
  for (const id of metricIds) m[id] = { y: Array.from({ length: S }, () => new Array(H).fill(0)), ...(id === 'cost' ? { y2: Array.from({ length: S }, () => new Array(H).fill(0)) } : {}) };
  for (let h = 0; h < H; h++) {
    const { total, mix } = traffic(cal, h);
    for (let s = 0; s < S; s++) {
      const ns = total * mix[s]; n[s][h] = ns;
      for (const id of metricIds) {
        const base = METRICS.find(x => x.id === id).base[s];
        let eff = 1; for (const p of prs) if (p.t0 <= h && p.effects[id]) eff *= p.effects[id];
        const mean = base * seasonal(id, cal, h) * eff;
        m[id].y[s][h] = ns * mean;
        if (id === 'cost') m[id].y2[s][h] = ns * mean * mean * Math.exp(0.85 * 0.85);
      }
    }
  }
  return { cal, cells: { n, m }, H };
}

test('normInv and normCdf are inverses (randomized)', () => {
  const rng = makeRng(1);
  for (let i = 0; i < 500; i++) {
    const p = 0.0005 + rng.u() * 0.999;
    assert.ok(Math.abs(normCdf(normInv(p)) - p) < 2e-6, `p=${p}`);
  }
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5);
});

test('mixture boundary grows with V, shrinks with alpha, and rho tuning is a minimum', () => {
  assert.ok(mixtureRadius(200, 10, 0.05) > mixtureRadius(100, 10, 0.05));
  assert.ok(mixtureRadius(100, 10, 0.01) > mixtureRadius(100, 10, 0.05));
  const V = 500, a = 0.01, r = tuneRho(V, a);
  const best = mixtureRadius(V, r, a);
  assert.ok(best <= mixtureRadius(V, r * 2, a) + 1e-9 && best <= mixtureRadius(V, r / 2, a) + 1e-9);
});

test('confidence sequence: Gaussian random walks cross the boundary at any time with prob <= alpha (randomized)', () => {
  const rng = makeRng(42); const alpha = 0.05; const T = 300; const paths = 2000;
  const rho = tuneRho(100, alpha);
  let crossed = 0;
  for (let i = 0; i < paths; i++) {
    let S = 0;
    for (let t = 1; t <= T; t++) { S += rng.normal(); if (Math.abs(S) >= mixtureRadius(t, rho, alpha)) { crossed++; break; } }
  }
  assert.ok(crossed / paths <= alpha, `crossing rate ${crossed / paths}`);
  // and a fixed 95% interval re-checked every step crosses far more often
  let naive = 0;
  for (let i = 0; i < 500; i++) { let S = 0; for (let t = 1; t <= T; t++) { S += rng.normal(); if (Math.abs(S) > 1.96 * Math.sqrt(t)) { naive++; break; } } }
  assert.ok(naive / 500 > 0.25);
});

test('fitProfile recovers segment x season rates on exact data', () => {
  const d = exactData(30 * 24, []);
  const mt = metric('frustration');
  const prof = fitProfile(d.cal, d.cells, mt, 0, 28 * 24);
  // compare fitted vs true rate for every segment and a handful of keys
  for (let s = 0; s < 3; s++) for (const h of [3, 10, 15, 22, 130, 150]) {
    const truth = METRICS[0].base[s] * seasonal('frustration', d.cal, h);
    const fit = prof.rateAt(s, d.cal.key[h]);
    assert.ok(Math.abs(fit / truth - 1) < 0.01, `s=${s} h=${h} fit=${fit} truth=${truth}`);
  }
  assert.ok(Math.abs(prof.phi - 1) < 1e-6, 'no residual -> phi clamps to 1');
});

test('fitProfile detects overdispersion (phi > 1) on clustered counts', () => {
  const tr = runTrial(5);
  const rng = makeRng(9);
  // inflate dispersion: multiply each hour's count by a strong random factor
  const mt = metric('frustration');
  const y = tr.cells.m.frustration.y.map(row => row.map(v => Math.round(v * Math.exp(0.35 * rng.normal()))));
  const cells = { n: tr.cells.n, m: { frustration: { y } } };
  const p1 = fitProfile(tr.cal, tr.cells, mt, 0, 28 * 24);
  const p2 = fitProfile(tr.cal, cells, mt, 0, 28 * 24);
  assert.ok(p2.phi > p1.phi * 1.5, `phi ${p1.phi} -> ${p2.phi}`);
});

test('planted effect is recovered without bias on exact data', () => {
  const t0 = 31 * 24 + 10;
  const prs = [{ number: 1, t0, effects: { frustration: 1.3, cost: 0.9 } }];
  const d = exactData(t0 + 48, prs);
  for (const [id, eff] of [['frustration', 0.3], ['cost', -0.1]]) {
    const res = analyzeMetric({ cal: d.cal, cells: d.cells, metric: metric(id), prs, H: d.H, alpha: 0.05 / 6 }, 0);
    const last = res.series[res.series.length - 1];
    assert.ok(Math.abs(last.rel - eff) < 0.005, `${id} rel=${last.rel}`);
  }
});

test('weekend / traffic-mix shift: adjusted estimate stays at 0 while equal-window before/after moves', () => {
  // merge Friday 4 pm PT with NO effect: the window after is mostly evening + Saturday
  const t0 = Math.ceil((Date.parse('2026-10-30T23:00:00Z') - Date.parse(START)) / 3600e3);
  const prs = [{ number: 1, t0, effects: {} }];
  const d = exactData(t0 + 30, prs);
  const ctx = { cal: d.cal, cells: d.cells, metric: metric('frustration'), prs, H: d.H, alpha: 0.05 / 6 };
  const res = analyzeMetric(ctx, 0);
  const last = res.series[23];
  assert.ok(Math.abs(last.rel) < 0.005, `adjusted rel ${last.rel}`);
  const nv = naiveCompare(ctx, 0, 24);
  assert.ok(Math.abs(nv.rel) > 0.04, `naive rel ${nv.rel} should be confounded`);
});

test('stacked merges: an earlier PR\u2019s effect is not attributed to the next one', () => {
  const t1 = 31 * 24 + 14;
  const prs = [{ number: 1, t0: t1, effects: { frustration: 1.5 } }, { number: 2, t0: t1 + 6, effects: {} }];
  const d = exactData(t1 + 40, prs);
  const mt = metric('frustration');
  const ratios = new Map();
  const base = { cal: d.cal, cells: d.cells, metric: mt, prs, H: d.H, alpha: 0.05 / 6 };
  const r1 = analyzeMetric({ ...base, ratios }, 0);
  ratios.set(1, { lnR: r1.lnR, varLnR: r1.varLnR });
  const r2 = analyzeMetric({ ...base, ratios }, 1);
  const r2NoChain = analyzeMetric({ ...base, ratios: new Map() }, 1);
  assert.ok(Math.abs(r1.series.at(-1).rel - 0.5) < 0.01, 'PR1 carries the +50%');
  assert.ok(Math.abs(r2.series.at(-1).rel) < 0.01, `PR2 with attribution ${r2.series.at(-1).rel}`);
  assert.ok(r2NoChain.series.at(-1).rel > 0.2, `PR2 without attribution is blamed ${r2NoChain.series.at(-1).rel}`);
  assert.equal(r2.chained[0].number, 1);
});

test('windowEnd scopes a PR to its own commit (until the next merge)', () => {
  const prs = [{ number: 1, t0: 10 }, { number: 2, t0: 25 }, { number: 3, t0: 40 }];
  assert.equal(windowEnd(prs, 0, 100), 25);
  assert.equal(windowEnd(prs, 1, 100), 40);
  assert.equal(windowEnd(prs, 2, 100), 100);
});

test('verdicts respect metric sentiment and minimum evidence', () => {
  const neg = { sentiment: 'negative' }, pos = { sentiment: 'positive' };
  const up = { N: 1000, E: 50, relLo: 0.1, relHi: 0.5 }, down = { N: 1000, E: 50, relLo: -0.5, relHi: -0.1 }, flat = { N: 1000, E: 50, relLo: -0.1, relHi: 0.1 };
  assert.equal(verdictOf(neg, up), 'worse'); assert.equal(verdictOf(neg, down), 'better');
  assert.equal(verdictOf(pos, up), 'better'); assert.equal(verdictOf(pos, down), 'worse');
  assert.equal(verdictOf(neg, flat), 'none');
  assert.equal(verdictOf(neg, { ...up, N: 10 }), 'early');
});

test('naive comparison matches a hand-computed two-proportion z test', () => {
  const cal = makeCalendar(START, 4);
  const cells = { n: [[100, 100, 100, 100], [0, 0, 0, 0], [0, 0, 0, 0]], m: { frustration: { y: [[5, 5, 12, 12], [0, 0, 0, 0], [0, 0, 0, 0]] } } };
  const r = naiveCompare({ cal, cells, metric: metric('frustration'), prs: [{ number: 1, t0: 2 }], H: 4 }, 0, 2);
  const p = 34 / 400; const se = Math.sqrt(p * (1 - p) * (2 / 200));
  assert.ok(Math.abs(r.z - 0.07 / se) < 1e-9);
  assert.equal(r.verdict, 'worse');
  assert.ok(Math.abs(r.rel - 1.4) < 1e-12);
});

test('hours-to-detect planner: bigger effects need fewer hours; tiny effects hit the baseline floor', () => {
  const tr = runTrial(11, { post: 24 });
  const res = analyzeMetric({ cal: tr.cal, cells: tr.cells, metric: metric('frustration'), prs: tr.prs, H: tr.H, alpha: 0.05 / 6 }, 0);
  const a = hoursToDetect(res, 0.5), b = hoursToDetect(res, 0.3);
  assert.ok(a.hours !== null && b.hours !== null && a.hours < b.hours, `${a.hours} vs ${b.hours}`);
  const tiny = hoursToDetect(res, a.floor * 0.5);
  assert.equal(tiny.hours, null);
});

test('drift estimate ignores level shifts caused by merges', () => {
  const t0 = 20 * 24;
  const prs = [{ number: 1, t0, effects: { frustration: 1.6 } }];
  const d = exactData(30 * 24, prs);
  const mt = metric('frustration');
  const prof = fitProfile(d.cal, d.cells, mt, 0, 28 * 24);
  const withShift = estimateDrift(d.cal, d.cells, mt, prof, 0, 28 * 24, []);
  const skipped = estimateDrift(d.cal, d.cells, mt, prof, 0, 28 * 24, [t0]);
  assert.ok(withShift > 0.005, `shift counted as drift ${withShift}`);
  assert.ok(skipped < withShift / 5, `skipping the merge removes it ${skipped}`);
});

test('family-wise false alarms on no-op merges stay under 5% across all metrics and every hourly look (randomized)', () => {
  const r = nullBacktest(80, 3);
  assert.ok(r.adjusted <= 0.05, `adjusted ${r.adjusted}`);
  assert.ok(r.naive >= 0.5, `naive ${r.naive}`);
});

test('headline numbers: results.json backtest reproduces from scratch', () => {
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'results/results.json'), 'utf8'));
  const n = results.backtest.trials;
  const r = nullBacktest(n, 7);
  assert.equal(r.adjustedCount, results.backtest.nullMerges.adjustedCount);
  assert.equal(r.naiveCount, results.backtest.nullMerges.naiveCount);
  assert.equal(Math.round(100 * r.naive), Math.round(100 * results.backtest.nullMerges.naive));
});

test('demo: committed data reproduces the committed demo scorecard; CSV has one row per PR x metric', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/project.json'), 'utf8'));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'results/results.json'), 'utf8'));
  const an = analyzeProject(data);
  let flags = 0;
  for (const p of an.prs) for (const m of data.metrics) { const v = verdictOf(m, lookAt(an.byPr.get(p.number)[m.id].res, Infinity)); if (v === 'worse' || v === 'better') flags++; }
  assert.equal(flags, results.demo.adjusted.flags);
  const csv = toCSV(data, an).trim().split('\n');
  assert.equal(csv.length, 1 + an.prs.length * data.metrics.length);
});
