// Generates data/project.json: 44 days of event-level synthetic production
// traffic for one agent, with 12 merged PRs (some with planted true effects),
// aggregated to (segment x hour) cells, plus per-PR usage facts and sample
// conversations. Then runs the analysis once and writes the demo section of
// results/results.json. Deterministic: node scripts/generate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, makeCalendar, traffic, seasonal, latent, effectAt, METRICS, SEGMENTS } from './model.mjs';
import { analyzeProject, lookAt, verdictOf, detectionHour, round } from '../src/impact.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 20261111;
const rng = makeRng(SEED);

// Mon Sep 28 2026 00:00 PDT -> Wed Nov 11 2026 09:00 PST ("now")
const START = '2026-09-28T07:00:00Z';
const H = 1066;
const cal = makeCalendar(START, H);
const hourOf = (iso) => Math.round((Date.parse(iso) - Date.parse(START)) / 3600e3);
// merge at local wall time; analysis starts at the first full hour on the new commit
const merged = (iso) => { const ms = Date.parse(iso); return { mergedAt: iso, t0: Math.ceil((ms - Date.parse(START)) / 3600e3) }; };

const AUTHORS = { jackson: 'Jackson Lee', priya: 'Priya Raman', marco: 'Marco Bianchi', dana: 'Dana Okafor' };
const PRS = [
  { number: 276, title: 'Cache the system prompt prefix', author: 'priya', ...merged('2026-10-28T18:20:00Z'), kind: ['Cache settings changed'], effects: { cost: 0.93 } },
  { number: 278, title: 'Add send_email tool', author: 'marco', ...merged('2026-10-29T22:05:00Z'), kind: ['Tool added: send_email'], effects: {} },
  { number: 279, title: 'Refactor tool schemas (no behavior change)', author: 'dana', ...merged('2026-10-30T23:40:00Z'), kind: ['Tools changed'], effects: {} },
  { number: 281, title: 'Upgrade Claude Agent SDK to 0.9.2', author: 'jackson', ...merged('2026-11-02T18:15:00Z'), kind: ['Settings changed'], effects: {} },
  { number: 283, title: 'Tighten web_search timeout to 8s', author: 'marco', ...merged('2026-11-03T18:30:00Z'), kind: ['Tool settings changed: web_search'], effects: { tool_error: 1.35, frustration: 1.04 } },
  { number: 285, title: 'Reword tool descriptions for read_file and grep', author: 'dana', ...merged('2026-11-04T00:40:00Z'), kind: ['Tools changed: read_file, grep'], effects: {} },
  { number: 284, title: 'Lowered compaction threshold to 148k tokens', author: 'jackson', ...merged('2026-11-04T18:12:00Z'), kind: ['Settings changed: compaction'], effects: { forgetting: 1.45, cost: 0.985 } },
  { number: 286, title: 'Shorter planning instructions', author: 'priya', ...merged('2026-11-05T17:05:00Z'), kind: ['Instructions substantially changed'], effects: {} },
  { number: 288, title: 'Fix runs ending without a response', author: 'dana', ...merged('2026-11-06T19:40:00Z'), kind: ['Agent loop changed'], effects: { empty_response: 0.12 } },
  { number: 289, title: 'Bump max tool calls per turn to 40', author: 'marco', ...merged('2026-11-07T20:20:00Z'), kind: ['Settings changed'], effects: {} },
  { number: 290, title: 'Switch summarizer to a smaller model', author: 'priya', ...merged('2026-11-09T17:30:00Z'), kind: ['Model changed: summarizer'], effects: { cost: 0.90, task_failure: 1.12 } },
  { number: 291, title: 'Added MCP guidance to the system prompt', author: 'jackson', ...merged('2026-11-10T17:05:00Z'), kind: ['Instructions substantially changed'], effects: {} },
  { number: 292, title: 'Retry web_search once on timeout', author: 'marco', ...merged('2026-11-11T00:45:00Z'), kind: ['Tool settings changed: web_search'], effects: { tool_error: 0.80 } },
];
const hex = () => Math.floor(rng.u() * 0xfffffff).toString(16).padStart(7, '0');
for (const p of PRS) p.sha = hex();

// ---- user pools (Zipf activity) ----
const POOL = [9000, 3200, 1100];
const pools = POOL.map((size, s) => {
  const w = []; let tot = 0;
  for (let i = 0; i < size; i++) { const v = 1 / Math.pow(i + 1, 0.9); w.push(v); tot += v; }
  const cdf = new Float64Array(size); let c = 0;
  for (let i = 0; i < size; i++) { c += w[i] / tot; cdf[i] = c; }
  const frail = Array.from({ length: size }, () => rng.gamma(4) / 4);
  const ids = Array.from({ length: size }, () => `${hex()}${hex()}`.slice(0, 8) + '-' + hex().slice(0, 4) + '-4' + hex().slice(0, 3) + '-' + hex().slice(0, 4));
  return { cdf, frail, ids, seg: SEGMENTS[s] };
});
const pickUser = (s) => { const cdf = pools[s].cdf; const x = rng.u(); let lo = 0, hi = cdf.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid; } return lo; };

const lat = latent(rng, H, METRICS);
const S = SEGMENTS.length;
const n = Array.from({ length: S }, () => new Array(H).fill(0));
const m = {};
for (const met of METRICS) m[met.id] = { y: Array.from({ length: S }, () => new Array(H).fill(0)), ...(met.kind === 'cost' ? { y2: Array.from({ length: S }, () => new Array(H).fill(0)) } : {}) };

// per-PR facts collected from the event stream
const stats = new Map(PRS.map(p => [p.number, { users1: new Set(), users24: new Set(), usersAll: new Set(), events1: 0, events24: 0, sigUsers: Object.fromEntries(METRICS.map(x => [x.id, new Set()])), cost1: 0, costPre1: 0, compactUsers1: new Set(), sendEmail: 0, sendEmailUsers: new Set(), mcpExplained: new Set(), mcpConnected: new Set(), webSearchCalls: 0, samples: Object.fromEntries(METRICS.map(x => [x.id, []])) }]));
const prsSorted = PRS.slice().sort((a, b) => a.t0 - b.t0);
const prAt = (h) => { let cur = null; for (const p of prsSorted) if (p.t0 <= h) cur = p; return cur; };

const QUOTES = {
  frustration: ['this is the third time, just run the tests', 'no. read the error first', 'why did you delete my config', 'stop rewriting files i didn\u2019t ask about'],
  task_failure: ['Gave up after 3 failed attempts to apply the patch to src/routes.ts.', 'Reported tests passing without running them.', 'Could not locate the migration the user referenced and stopped.'],
  forgetting: ['i said that already', 'i put the plan above', 'we went over this before the summary', 'you already read that file, check the earlier output'],
  empty_response: ['(run ended after a tool call with no assistant text)', '(final turn contained only a tool_result)'],
  tool_error: ['web_search: timed out after 8000 ms', 'web_search: upstream 429 rate limited', 'web_search: timed out after 8000 ms (query: "prisma migrate deploy error P3009")'],
  cost: ['$41.20 event: 212k input tokens across 9 model calls', '$18.75 event: 3 compactions in one session'],
};

let evId = 0;
for (let h = 0; h < H; h++) {
  const { total, mix } = traffic(cal, h);
  const vol = total * Math.exp(0.08 * rng.normal());
  const pr = prAt(h);
  for (let s = 0; s < S; s++) {
    const ns = rng.poisson(vol * mix[s]); n[s][h] = ns;
    for (let e = 0; e < ns; e++) {
      evId++;
      const ui = pickUser(s); const uid = pools[s].ids[ui]; const fr = pools[s].frail[ui];
      const out = {};
      for (const met of METRICS) {
        const mult = seasonal(met.id, cal, h) * lat[met.id][h] * effectAt(PRS, met.id, h);
        if (met.kind === 'cost') {
          const mean = met.base[s] * mult; const sd = met.sdLog;
          const x = mean * Math.exp(sd * rng.normal() - sd * sd / 2);
          m.cost.y[s][h] += x; m.cost.y2[s][h] += x * x; out.cost = x;
        } else {
          const p = Math.min(met.base[s] * mult * fr, 0.95);
          const hit = rng.u() < p ? 1 : 0; m[met.id].y[s][h] += hit; out[met.id] = hit;
        }
      }
      // behaviours used by the narrative report
      const compP = [0.03, 0.06, 0.09][s] * (h >= PRS.find(p => p.number === 284).t0 ? 1.6 : 1);
      const compact = rng.u() < compP;
      const webSearch = rng.u() < 0.4;
      const sendEmail = h >= PRS.find(p => p.number === 278).t0 && rng.u() < 0.0004;
      const mcp = h >= PRS.find(p => p.number === 291).t0 && rng.u() < 0.004;
      // attribute to every PR whose analysis windows include this hour
      for (const p of PRS) {
        const dt = h - p.t0; if (dt < 0) continue;
        const st = stats.get(p.number);
        const onCommit = pr && pr.number === p.number;
        if (dt < 1 && onCommit) { st.users1.add(uid); st.events1++; st.cost1 += out.cost; if (compact) st.compactUsers1.add(uid); }
        if (dt < 24 && onCommit) { st.users24.add(uid); st.events24++; }
        if (onCommit) {
          st.usersAll.add(uid);
          for (const met of METRICS) if (met.kind !== 'cost' && out[met.id]) { st.sigUsers[met.id].add(uid); if (st.samples[met.id].length < 4 && rng.u() < 0.08) st.samples[met.id].push({ id: `ev_${(evId * 2654435761 >>> 0).toString(16)}`, user: uid, h, seg: SEGMENTS[s], text: QUOTES[met.id][Math.floor(rng.u() * QUOTES[met.id].length)] }); }
          if (out.cost > 16 && st.samples.cost.length < 3 && rng.u() < 0.05) st.samples.cost.push({ id: `ev_${(evId * 2654435761 >>> 0).toString(16)}`, user: uid, h, seg: SEGMENTS[s], text: `$${out.cost.toFixed(2)} for one event`, value: round(out.cost, 2) });
          if (sendEmail) { st.sendEmail++; st.sendEmailUsers.add(uid); }
          if (mcp) { st.mcpExplained.add(uid); if (rng.u() < 0.3) st.mcpConnected.add(uid); }
          if (webSearch) st.webSearchCalls++;
        }
      }
      // equal-length pre window cost for the early check narrative
      for (const p of PRS) if (h === p.t0 - 1) stats.get(p.number).costPre1 += out.cost;
    }
  }
}
// round cost sums to cents (keeps JSON small)
for (let s = 0; s < S; s++) for (let h = 0; h < H; h++) { m.cost.y[s][h] = round(m.cost.y[s][h], 2); m.cost.y2[s][h] = round(m.cost.y2[s][h], 1); }

const prsOut = PRS.map(p => {
  const st = stats.get(p.number);
  return {
    number: p.number, title: p.title, author: p.author, authorName: AUTHORS[p.author], mergedAt: p.mergedAt, t0: p.t0, sha: p.sha, kind: p.kind,
    facts: {
      users1h: st.users1.size, events1h: st.events1, users24h: st.users24.size, events24h: st.events24, usersAll: st.usersAll.size,
      cost1h: round(st.cost1, 2), costPre1h: round(st.costPre1, 2), compactionUsers1h: st.compactUsers1.size,
      sendEmailCalls: st.sendEmail, sendEmailUsers: st.sendEmailUsers.size, mcpExplainedUsers: st.mcpExplained.size, mcpConnectedUsers: st.mcpConnected.size, webSearchCalls: st.webSearchCalls,
      signalUsers: Object.fromEntries(Object.entries(st.sigUsers).map(([k, v]) => [k, v.size])),
    },
    samples: st.samples,
  };
});

const data = {
  meta: { org: 'sprinkle-ai', project: 'Production', agent: 'assistant', repo: 'sprinkle-ai/assistant', tz: 'America/Los_Angeles', start: START, hours: H, generated: 'scripts/generate.mjs', seed: SEED, synthetic: true },
  segments: SEGMENTS,
  metrics: METRICS.map(({ base, sdLog, ...rest }) => rest),
  cal: { key: cal.key, hod: cal.hod, wkend: cal.wkend },
  cells: { n, m },
  prs: prsOut,
};
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/project.json'), JSON.stringify(data));

// ground truth is kept OUT of the app data; used only for scoring
const truth = Object.fromEntries(PRS.map(p => [p.number, p.effects]));
fs.writeFileSync(path.join(ROOT, 'data/truth.json'), JSON.stringify(truth, null, 1));

// ---- demo analysis + scoring vs ground truth ----
const an = analyzeProject(data);
const rows = [];
let adjFlags = 0, adjTrue = 0, adjFalse = 0, naiveFlags = 0, naiveFalse = 0, naiveTrue = 0, realEffects = 0, adjCaught = 0, naiveCaught = 0;
for (const p of an.prs) {
  for (const met of data.metrics) {
    const { res, naive } = an.byPr.get(p.number)[met.id];
    const pt = lookAt(res, Infinity);
    const v = verdictOf(met, pt);
    const eff = truth[p.number][met.id];
    const real = eff !== undefined && Math.abs(Math.log(eff)) >= Math.log(1.1); // >=10% true change counts as real
    const tiny = eff !== undefined && !real;
    if (real) realEffects++;
    const nv = [naive.early, naive.full].filter(Boolean);
    const nFlag = nv.some(x => x.verdict !== 'none');
    if (v === 'worse' || v === 'better') { adjFlags++; if (eff !== undefined && (Math.log(eff) > 0) === (v === 'worse')) { adjTrue++; if (real) adjCaught++; } else adjFalse++; }
    if (nFlag) { naiveFlags++; const dir = nv.find(x => x.verdict !== 'none').verdict; if (eff !== undefined && (Math.log(eff) > 0) === (dir === 'worse')) { naiveTrue++; if (real) naiveCaught++; } else naiveFalse++; }
    rows.push({ pr: p.number, metric: met.id, hours: pt ? pt.t : 0, rel: pt ? round(pt.rel, 4) : null, lo: pt ? round(pt.relLo, 4) : null, hi: pt ? round(pt.relHi, 4) : null, verdict: v, detectedAtHour: detectionHour(met, res.series), naiveEarly: naive.early ? { rel: round(naive.early.rel, 4), verdict: naive.early.verdict } : null, naiveFull: naive.full ? { rel: round(naive.full.rel, 4), verdict: naive.full.verdict, hours: naive.full.hours } : null, truth: eff ?? 1, tiny });
  }
}
const resultsPath = path.join(ROOT, 'results/results.json');
const prev = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : {};
prev.demo = {
  generatedBy: 'scripts/generate.mjs', seed: SEED, prs: an.prs.length, metrics: data.metrics.length, familyAlpha: an.familyAlpha,
  realEffects, // planted effects of 10%+ size
  adjusted: { flags: adjFlags, correct: adjTrue, false: adjFalse, realCaught: adjCaught },
  naive: { flags: naiveFlags, correct: naiveTrue, false: naiveFalse, realCaught: naiveCaught, looks: 'early check (1 h) + full report (24 h), equal-length window before, z test at 95%' },
  rows,
};
fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(resultsPath, JSON.stringify(prev, null, 1));
console.log(JSON.stringify({ realEffects, adjusted: prev.demo.adjusted, naive: prev.demo.naive }, null, 1));
for (const r of rows) if (r.verdict === 'worse' || r.verdict === 'better' || r.truth !== 1 || (r.naiveFull && r.naiveFull.verdict !== 'none') || (r.naiveEarly && r.naiveEarly.verdict !== 'none')) console.log(r.pr, r.metric, 'truth', r.truth, '| adj', r.verdict, r.rel, `[${r.lo}, ${r.hi}]`, '@', r.detectedAtHour, '| naive', r.naiveEarly?.verdict, r.naiveFull?.verdict, r.naiveFull?.rel);
const sz = fs.statSync(path.join(ROOT, 'data/project.json')).size;
console.log('project.json bytes', sz);
