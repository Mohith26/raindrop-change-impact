// Change Impact concept for Raindrop Briefs > Change reports.
// All numbers on the page are computed here from data/project.json by src/impact.js.
import { analyzeProject, lookAt, verdictOf, detectionHour, hoursToDetect, toCSV, round, analyzeMetric, naiveCompare } from './src/impact.js';
import { makeRng, makeCalendar, sampleCells, METRICS } from './scripts/model.mjs';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS_KEY = 'rd-change-impact-v1';
const TZ = 'America/Los_Angeles';
const LOOKS = [{ id: 'early', label: 'Early check', h: 1 }, { id: '6h', label: '6h', h: 6 }, { id: 'full', label: 'Full report', h: 24 }, { id: 'latest', label: 'Latest', h: Infinity }];

const NAV = [
  ['home', 'house'], ['events', 'message-circle'], ['signals', 'activity'], ['users', 'user'], ['issues', 'triangle-alert'],
  ['briefs', 'newspaper'], ['datasets', 'database'], ['costs', 'dollar-sign'], ['dashboards', 'layout-dashboard'],
  ['experiments', 'flask-conical'], ['simulations', 'route', 'beta'], ['agent', 'bot'],
];

const state = {
  data: null, results: null, an: null,
  settings: { conf: 0.95, showNaive: true, slackImpact: true },
  marks: {}, posts: {}, openDays: [],
  filter: { author: null, impact: null, status: null },
  route: { view: 'reports', pr: null, metric: null, look: 'latest' },
  live: null,
};

// ---------- persistence ----------
function load() {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); Object.assign(state.settings, s.settings || {}); state.marks = s.marks || {}; state.posts = s.posts || {}; state.openDays = s.openDays || []; Object.assign(state.filter, s.filter || {}); } catch { /* ignore */ }
}
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify({ settings: state.settings, marks: state.marks, posts: state.posts, openDays: state.openDays, filter: state.filter })); } catch { /* ignore */ } }

// ---------- time helpers (demo clock = end of data) ----------
const startMs = () => Date.parse(state.data.meta.start);
const nowMs = () => startMs() + state.data.meta.hours * 3600e3;
const hourMs = (h) => startMs() + h * 3600e3;
const fmtT = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(ms).replace(' AM', 'am').replace(' PM', 'pm');
const fmtD = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(ms);
const dayKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms);
function relDay(ms) { const d = dayKey(ms), n = dayKey(nowMs()), y = dayKey(nowMs() - 864e5); return d === n ? 'Today' : d === y ? 'Yesterday' : fmtD(ms); }
const fmtDT = (ms) => `${fmtD(ms)}, ${fmtT(ms)}`;
function sinceMerge(ms, pr) { const h = Math.round((ms - Date.parse(pr.mergedAt)) / 3600e3); return h < 1 ? 'right after merge' : h < 48 ? `${h}h after merge` : `${Math.round(h / 24)}d after merge`; }
const n0 = (x) => Math.round(x).toLocaleString('en-US');
function pct(x, d = 0) { if (!Number.isFinite(x)) return '–'; const v = x * 100; const s = Math.abs(v) < 0.05 ? '0' : v.toFixed(d); return (v > 0 ? '+' : v < 0 ? '−' : '') + s.replace('-', '') + '%'; }
function rateFmt(metric, r) { if (metric.kind === 'cost') return '$' + r.toFixed(2); const v = r * 100; return (v < 1 ? v.toFixed(2) : v.toFixed(1)) + '%'; }

// ---------- analysis ----------
function runAnalysis() {
  state.an = analyzeProject(state.data, { familyAlpha: 1 - state.settings.conf });
  state.prs = state.an.prs.slice().sort((a, b) => b.t0 - a.t0); // newest first
  state.metricsById = Object.fromEntries(state.data.metrics.map(m => [m.id, m]));
}
function lookHours(lookId) { return (LOOKS.find(l => l.id === lookId) || LOOKS[3]).h; }
function prWindowHours(pr) { const any = state.an.byPr.get(pr.number)[state.data.metrics[0].id].res; return any.tEnd - any.t0; }
function prAt(pr, lookId = state.route.look) {
  const byM = state.an.byPr.get(pr.number);
  const out = [];
  for (const m of state.data.metrics) {
    const { res, naive } = byM[m.id];
    const pt = lookAt(res, lookHours(lookId));
    const nv = pickNaive(naive, pt, m, pr);
    out.push({ metric: m, res, naive, nv, pt, v: verdictOf(m, pt) });
  }
  return out;
}
// the plain before/after a report posted at this look would show: equal-length
// window before vs. the first t hours on the commit (Change Reports stops at 24 h)
function pickNaive(naive, pt, metric, pr) {
  if (!pt) return null;
  if (pt.t <= 1) return naive.early;
  if (pt.t >= 24) return naive.full;
  return naiveAt(pr, metric, pt.t);
}
function naiveAt(pr, metric, t) {
  state._na = state._na || new Map();
  const key = `${pr.number}:${metric.id}:${t}`;
  if (!state._na.has(key)) {
    const prs = state.an.prs; const i = prs.findIndex(p => p.number === pr.number);
    state._na.set(key, naiveCompare({ cal: state.data.cal, cells: state.data.cells, metric, prs, H: state.data.meta.hours }, i, t));
  }
  return state._na.get(key);
}
function prStatus(pr) {
  const rows = prAt(pr, 'latest');
  if (rows.some(r => r.v === 'worse' || r.v === 'better')) return 'reported';
  const age = (nowMs() - Date.parse(pr.mergedAt)) / 3600e3;
  const win = prWindowHours(pr);
  if (age < 24 && win >= age - 1) return 'monitoring';
  return 'quiet';
}
const STATUS_LABEL = { monitoring: 'Monitoring', reported: 'Reported', quiet: 'No notable changes', unmeasured: 'Not measured' };
function statIco(status, cls = '') {
  const inner = {
    monitoring: '<circle cx="7" cy="7" r="5.25" stroke-dasharray="2.06 2.06"/>',
    reported: '<circle cx="7" cy="7" r="5.25"/><circle cx="7" cy="7" r="2.25" fill="currentColor" stroke="none"/>',
    quiet: '<circle cx="7" cy="7" r="5.25"/>',
    unmeasured: '<circle cx="7" cy="7" r="5.25"/><path d="M3.3 10.7 10.7 3.3"/>',
    merged: '<circle cx="7" cy="7" r="2.5" fill="currentColor" stroke="none"/>',
  }[status];
  return `<svg class="stat-ico ${status === 'reported' ? 'reported' : ''} ${cls}" width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" aria-hidden="true">${inner}</svg>`;
}

// ---------- routing ----------
function parseRoute() {
  const h = location.hash.replace(/^#/, '') || '/briefs/change-reports';
  const [p, q] = h.split('?');
  const qs = new URLSearchParams(q || '');
  const r = { view: 'reports', pr: qs.get('pr') ? +qs.get('pr') : null, metric: qs.get('metric'), look: qs.get('look') || 'latest' };
  if (p.startsWith('/briefs/digest')) r.view = 'digest';
  else if (qs.get('tab') === 'calibration') r.view = 'calibration';
  else if (qs.get('tab') === 'settings') r.view = 'settings';
  if (!LOOKS.some(l => l.id === r.look)) r.look = 'latest';
  return r;
}
function href(over = {}) {
  const r = { ...state.route, ...over };
  if (r.view === 'digest') return '#/briefs/digest';
  const qs = new URLSearchParams();
  if (r.view === 'calibration') qs.set('tab', 'calibration');
  if (r.view === 'settings') qs.set('tab', 'settings');
  if (r.view === 'reports') { if (r.pr) qs.set('pr', r.pr); if (r.metric) qs.set('metric', r.metric); if (r.look && r.look !== 'latest') qs.set('look', r.look); }
  const s = qs.toString();
  return '#/briefs/change-reports' + (s ? '?' + s : '');
}
function go(over, replace = false) { const h = href(over); if (replace) history.replaceState(null, '', h); else history.pushState(null, '', h); onRoute(); }

// ---------- shell ----------
function renderNav() {
  $('#navLinks').innerHTML = NAV.map(([name, icon, badge]) => `<a class="nav-item ${name === 'briefs' ? 'active' : ''}" href="${name === 'briefs' ? '#/briefs/change-reports' : '#/' + name}" ${name === 'briefs' ? 'aria-current="page"' : 'data-static="1"'}><i data-lucide="${icon}"></i><span>${name}</span>${badge ? `<b class="nav-badge">${badge}</b>` : ''}</a>`).join('');
}
function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } }); }

function renderPage() {
  const main = $('#main');
  const isDigest = state.route.view === 'digest';
  $('#phTitle').innerHTML = `Production<span class="sep">/</span><span class="crumb">Briefs</span><span class="sep">/</span>${isDigest ? 'Weekly Digest' : 'Change reports'}`;
  const weekAgo = nowMs() - 7 * 864e5;
  const thisWeek = state.prs.filter(p => Date.parse(p.mergedAt) >= weekAgo).length;
  $('#phMeta').innerHTML = isDigest ? '· Mondays at 8:00am PT' : `· ${state.prs.length} merged PRs · ${thisWeek} this week · assistant`;
  main.innerHTML = `${renderRail()}<section class="reader" aria-label="${isDigest ? 'Weekly Digest' : 'Change reports'}">${isDigest ? renderDigest() : renderReader()}</section>`;
  icons();
  afterRender();
}

function renderRail() {
  const sel = state.route.view === 'digest' ? 'digest' : 'cr';
  const item = (key, to, dot, title, meta, badge) => `<a class="rail-item ${sel === key ? 'sel' : ''}" href="${to}" ${sel === key ? 'aria-current="page"' : ''} ${key.startsWith('b') ? 'data-static="brief"' : ''}><span class="rail-dot ${dot}"></span><span class="rail-main"><span class="rail-title"><b>${title}</b>${badge || ''}</span><span class="rail-meta">${meta}</span></span></a>`;
  return `<nav class="rail" aria-label="Briefs">
    <div class="rail-project">Production</div>
    ${item('cr', '#/briefs/change-reports', 'bg-green', 'Change reports', 'Built-in · Merged PR reports', '<span class="new-badge">New</span>')}
    ${item('digest', '#/briefs/digest', 'bg-green', 'Weekly Digest', 'Built-in · Mondays at 8:00am, PT')}
    <div class="rail-sec">Your briefs</div>
    ${item('b1', '#/briefs/change-reports', 'bg-green', 'Enterprise churn watch', 'Every Monday at 9:00am · 2d ago')}
    <div class="rail-sec">Team briefs</div>
    ${item('b2', '#/briefs/change-reports', 'bg-green', 'Tool error rates', 'Every day at 8:30am · 1h ago')}
    ${item('b3', '#/briefs/change-reports', 'bg-gray', 'Checkout-v2 rollout', 'Paused · Nov 2')}
  </nav>`;
}

function renderReader() {
  const view = state.route.view;
  const repos = [...new Set(state.prs.map(() => state.data.meta.repo))];
  const weekAgo = nowMs() - 7 * 864e5;
  const thisWeek = state.prs.filter(p => Date.parse(p.mergedAt) >= weekAgo).length;
  const tab = (id, label, extra = '') => `<button class="tab" role="tab" aria-selected="${view === id}" data-tab="${id}">${label}${extra}</button>`;
  return `<header class="reader-head">
      <div class="rh-row"><div class="rh-titles"><div class="rh-h1"><h1>Change reports</h1><span class="new-badge">New</span></div><p class="rh-sub">Merged pull requests that Raindrop detected and monitored.</p></div><span class="pill-active"><i></i>Active</span></div>
      <dl class="facts">
        <div class="grow"><dt>Repository</dt><dd>${esc(repos.join(', '))}</dd></div>
        <div><dt>Agents</dt><dd>1 of 1 on</dd></div>
        <div style="flex:1.5;min-width:200px"><dt>Send to</dt><dd class="chan"><i data-lucide="hash" style="width:13px;height:13px"></i>agent-alerts</dd></div>
        <div><dt>Impact confidence</dt><dd>${Math.round(state.settings.conf * 100)}% · all metrics</dd></div>
        <div class="push"><dt>This week</dt><dd>${thisWeek} ${thisWeek === 1 ? 'PR' : 'PRs'}</dd></div>
      </dl>
      <div class="tabs"><div class="tablist" role="tablist" aria-label="Change reports tabs">
        ${tab('reports', 'Pull requests', ` <span class="count">${state.prs.length}</span>`)}
        ${tab('calibration', 'Impact calibration', ' <span class="new-badge">New</span>')}
        ${tab('settings', 'Settings')}
      </div></div>
    </header>
    <div class="reader-body">${view === 'calibration' ? renderCalibration() : view === 'settings' ? renderSettings() : renderReports()}</div>`;
}

// ---------- reports: filters + list + detail ----------
function filteredPrs() {
  return state.prs.filter(p => {
    if (state.filter.author && p.author !== state.filter.author) return false;
    if (state.filter.status && prStatus(p) !== state.filter.status) return false;
    if (state.filter.impact) {
      const rows = prAt(p, state.route.look);
      if (state.filter.impact === 'worse' && !rows.some(r => r.v === 'worse')) return false;
      if (state.filter.impact === 'better' && !rows.some(r => r.v === 'better')) return false;
      if (state.filter.impact === 'none' && rows.some(r => r.v === 'worse' || r.v === 'better')) return false;
      if (state.filter.impact === 'naive' && !rows.some(r => r.nv && r.nv.verdict !== 'none' && r.v !== r.nv.verdict)) return false;
    }
    return true;
  });
}
function renderReports() {
  const prs = filteredPrs();
  const authors = [...new Set(state.prs.map(p => p.author))];
  const authorName = state.filter.author ? state.prs.find(p => p.author === state.filter.author).authorName : 'Anyone';
  const impactLabel = { worse: 'Likely worse', better: 'Likely better', none: 'No detectable change', naive: 'Plain diff disagrees' }[state.filter.impact] || 'Any';
  const statusLabel = state.filter.status ? STATUS_LABEL[state.filter.status] : 'Any';
  let sel = prs.find(p => p.number === state.route.pr) || null;
  if (!sel && prs.length) { const st = prs.map(p => [p, prStatus(p)]); sel = (st.find(x => x[1] === 'reported') || st.find(x => x[1] === 'monitoring') || st[0])[0]; }
  state.sel = sel;
  return `<div class="filters" role="group" aria-label="Filter pull requests">
      <button class="fbtn" data-menu="repo"><span class="lbl">Repo</span>All repos<i data-lucide="chevron-down"></i></button>
      <button class="fbtn" data-menu="author" aria-haspopup="menu"><span class="lbl">Author</span>${esc(authorName)}<i data-lucide="chevron-down"></i></button>
      <button class="fbtn" data-menu="status" aria-haspopup="menu"><span class="lbl">Status</span>${statusLabel}<i data-lucide="chevron-down"></i></button>
      <button class="fbtn" data-menu="impact" aria-haspopup="menu"><span class="lbl">Impact</span>${impactLabel}<i data-lucide="chevron-down"></i></button>
      <span class="fsep"></span>
      <button class="iconbtn" data-menu="export" aria-haspopup="menu" title="Export (e)"><i data-lucide="download"></i>Export</button>
    </div>
    ${prs.length === 0 ? `<p class="empty">No pull requests match these filters. <button class="iconbtn" data-action="clear-filters" style="margin-left:8px">Clear filters</button></p>` : `
    <div class="split">
      <ul class="prlist" aria-label="Pull requests">${renderList(prs, sel)}</ul>
      <div class="detail" id="detail">${sel ? renderDetail(sel) : ''}</div>
    </div>`}`;
}

function renderList(prs, sel) {
  const groups = { reported: [], monitoring: [], quiet: [] };
  for (const p of prs) groups[prStatus(p)].push(p);
  const item = (p) => {
    const rows = prAt(p, state.route.look);
    const st = prStatus(p);
    const chips = rows.filter(r => r.v === 'worse' || r.v === 'better').map(r => `<span class="chip ${r.v}" title="${esc(r.metric.name)}: ${pct(r.pt.rel)} (${Math.round(state.settings.conf * 100)}% range ${pct(r.pt.relLo)} to ${pct(r.pt.relHi)})">${esc(shortName(r.metric))} <span class="n">${pct(r.pt.rel)}</span></span>`).join('');
    const naiveOnly = rows.filter(r => r.nv && r.nv.verdict !== 'none' && r.v !== r.nv.verdict).length;
    const merged = Date.parse(p.mergedAt);
    return `<li><button type="button" class="pri ${sel && sel.number === p.number ? 'sel' : ''}" data-pr="${p.number}" aria-current="${sel && sel.number === p.number ? 'true' : 'false'}">
      <span class="pri-top">${statIco(st)}<span class="pri-title" title="${esc(p.title)}"><span class="sr-only">${STATUS_LABEL[st]}: </span>${esc(p.title)}</span><span class="pri-when">${relDay(merged) === 'Today' ? fmtT(merged) : relDay(merged)}</span></span>
      <span class="pri-sub"><span>assistant #${p.number}</span><span>·</span><span>@${p.author}</span>${state.marks[p.number] ? `<span>·</span><span>${markLabel(state.marks[p.number])}</span>` : ''}</span>
      ${chips || (state.settings.showNaive && naiveOnly) ? `<span class="pri-chips">${chips}${state.settings.showNaive && naiveOnly ? `<span class="chip naive" title="A plain before/after comparison would flag ${naiveOnly} metric(s) that stay within normal variation here">${naiveOnly} plain-diff ${naiveOnly === 1 ? 'flag' : 'flags'} unsupported</span>` : ''}</span>` : ''}
    </button></li>`;
  };
  let html = '';
  if (groups.reported.length) html += `<li><h2 class="grp">Reported <span>${groups.reported.length}</span></h2></li>` + groups.reported.map(item).join('');
  if (groups.monitoring.length) html += `<li><h2 class="grp">Monitoring <span>${groups.monitoring.length}</span></h2></li>` + groups.monitoring.map(item).join('');
  if (groups.quiet.length) {
    html += `<li><h2 class="grp">No notable changes <span>${groups.quiet.length}</span></h2></li>`;
    const days = new Map();
    for (const p of groups.quiet) { const k = dayKey(Date.parse(p.mergedAt)); if (!days.has(k)) days.set(k, []); days.get(k).push(p); }
    for (const [k, ps] of days) {
      const open = state.openDays.includes(k) || ps.some(p => sel && p.number === sel.number);
      if (open) html += ps.map(item).join('');
      else html += `<li><button type="button" class="quietday" data-day="${k}">${statIco('quiet')}<span><b>${relDay(Date.parse(ps[0].mergedAt))}</b> · ${ps.length} pull ${ps.length === 1 ? 'request' : 'requests'}</span><i data-lucide="chevron-right" class="chev"></i></button></li>`;
    }
  }
  return html;
}
const shortName = (m) => ({ frustration: 'Frustration', task_failure: 'Task failure', forgetting: 'Forgetting', empty_response: 'No response', tool_error: 'web_search errors', cost: 'Cost' }[m.id] || m.name);
const markLabel = (k) => ({ investigating: 'Investigating', expected: 'Expected', revert: 'Revert planned' }[k]);

function renderDetail(pr) {
  const st = prStatus(pr);
  const merged = Date.parse(pr.mergedAt);
  const win = prWindowHours(pr);
  const nextMerge = state.prs.filter(p => p.t0 > pr.t0).sort((a, b) => a.t0 - b.t0)[0];
  const mark = state.marks[pr.number];
  return `<section class="detail-in" aria-label="Pull request">
    <div style="display:flex;align-items:center;gap:10px"><span class="status ${st}">${statIco(st)}${STATUS_LABEL[st]}</span>${mark ? `<span class="mark-chip ${mark}">${markLabel(mark)}</span>` : ''}<span style="flex:1"></span><button class="mark-btn" data-menu="mark" aria-haspopup="menu" title="Mark as (m)">Mark as<i data-lucide="chevron-down"></i></button></div>
    <h2 class="d-title">${esc(pr.title)}${worstPill(pr)}</h2>
    <div class="d-meta"><span>${esc(state.data.meta.repo)} #${pr.number}</span><span>Merged ${fmtDT(merged)} by ${esc(pr.authorName)}</span><span class="sha">${pr.sha}</span><a href="#" data-action="github">View on GitHub</a></div>
    <h3 class="h3">1 agent changed</h3>
    <ul class="agents"><li>${statIco(st)}<b>assistant</b><span>${esc(pr.kind.join(' · '))} · ${n0(pr.facts.usersAll)} users on this commit${nextMerge ? ` until #${nextMerge.number} merged ${win}h later` : ''}</span></li></ul>
    ${renderImpact(pr)}
    <h3 class="h3">Timeline</h3>
    <ol class="timeline">${renderTimeline(pr)}</ol>
  </section>`;
}

function worstPill(pr) {
  const rows = prAt(pr);
  if (rows.some(r => r.v === 'worse')) return ' <span class="sev worse"><i data-lucide="circle-x"></i>Likely worse</span>';
  if (rows.some(r => r.v === 'better')) return ' <span class="sev better"><i data-lucide="circle-check"></i>Likely better</span>';
  return '';
}
function verdictSentence(pr, rows, look) {
  const dec = rows.filter(r => r.v === 'worse' || r.v === 'better');
  const t = rows[0].pt ? rows[0].pt.t : 0;
  if (!rows[0].pt || rows.every(r => r.v === 'early')) return { cls: 'early', text: `Too early to tell: ${rows[0].pt ? n0(rows[0].pt.N) : 0} events on the new commit so far.` };
  if (dec.length) {
    const w = dec.filter(r => r.v === 'worse').map(r => r.metric.name), b = dec.filter(r => r.v === 'better').map(r => r.metric.name);
    const parts = [];
    if (w.length) parts.push(`${list(w)} ${w.length > 1 ? 'are' : 'is'} likely worse`);
    if (b.length) parts.push(`${list(b)} ${b.length > 1 ? 'are' : 'is'} likely better`);
    return { cls: w.length ? 'worse' : 'better', text: `${cap(parts.join(', and '))} after this change.` };
  }
  const widest = rows.filter(r => r.pt && r.v === 'none').map(r => Math.max(Math.abs(r.pt.relLo), Math.abs(r.pt.relHi)));
  const cost = rows.find(r => r.metric.kind === 'cost');
  const costB = cost && cost.pt ? Math.max(Math.abs(cost.pt.relLo), Math.abs(cost.pt.relHi)) : null;
  return { cls: 'none', text: `No metric moved beyond normal variation ${t}h after merge.${costB !== null ? ` Cost per event changed by less than ${Math.round(costB * 100)}%.` : ''}` };
}
const list = (a) => a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function renderImpact(pr) {
  const rows = prAt(pr);
  const look = state.route.look;
  const vs = verdictSentence(pr, rows, look);
  const t = rows[0].pt ? rows[0].pt.t : 0;
  const scale = Math.max(0.25, ...rows.filter(r => r.pt).map(r => Math.min(2, Math.max(Math.abs(r.pt.relLo), Math.abs(r.pt.relHi), r.nv ? Math.abs(r.nv.rel) : 0))));
  const confPct = Math.round(state.settings.conf * 100);
  const maxRate = (r) => r.metric.kind === 'cost' ? Math.max(r.pt.expRate, r.pt.obsRate) : Math.max(r.pt.expRate, r.pt.obsRate);
  const rowHtml = rows.map(r => {
    const m = r.metric; const open = state.route.metric === m.id;
    if (!r.pt) return '';
    const mx = maxRate(r) || 1;
    const color = r.v === 'worse' ? 'red' : r.v === 'better' ? 'green' : '';
    const wB = Math.max(2, 72 * r.pt.expRate / mx), wO = Math.max(2, 72 * r.pt.obsRate / mx);
    const badge = r.v === 'early' ? '<span class="badge early">EARLY</span>' : r.v === 'worse' ? `<span class="badge worse">${pct(r.pt.rel)}</span>` : r.v === 'better' ? `<span class="badge better">${pct(r.pt.rel)} ${m.kind === 'cost' ? 'SAVED' : 'REDUCTION'}</span>` : '<span class="badge none">SAME</span>';
    const pos = (x) => `${50 + 50 * Math.max(-1, Math.min(1, x / scale))}%`;
    const lo = Math.max(-scale, r.pt.relLo), hi = Math.min(scale, r.pt.relHi);
    const nv = r.nv;
    const nvTxt = !state.settings.showNaive || !nv ? '' : nv.verdict === 'none' ? `<span class="ok">Plain before/after ${pct(nv.rel)}, not flagged</span>` : (nv.verdict === r.v ? `<span class="ok">Plain before/after ${pct(nv.rel)}, also flagged</span>` : `<span class="x">Plain before/after ${pct(nv.rel)} would flag ${nv.verdict}</span>`);
    return `<div class="mrow ${open ? 'open' : ''}" role="button" tabindex="0" data-metric="${m.id}" aria-expanded="${open}" aria-label="${esc(m.name)}: ${pct(r.pt.rel)}, ${confPct}% range ${pct(r.pt.relLo)} to ${pct(r.pt.relHi)}">
      <span class="mname"><span class="nm">${esc(m.name)}</span>${m.preset ? '' : `<span class="kind">${m.kind === 'tool' ? 'tool' : m.kind === 'cost' ? 'cost' : m.selfDiag ? 'self-diag' : 'custom'}</span>`}<span class="lead"></span></span>
      <span class="bars"><span class="l">${rateFmt(m, r.pt.expRate)}<span class="bar base ${color}" style="width:${wB}px"></span></span><span class="mid"></span><span class="r"><span class="bar obs ${color}" style="width:${wO}px"></span>${rateFmt(m, r.pt.obsRate)}</span></span>
      ${badge}
      <span class="rowx"><span class="ci" aria-hidden="true"><span class="axis"></span><span class="zero" style="left:50%"></span><span class="band ${r.v === 'worse' ? 'worse' : r.v === 'better' ? 'better' : ''}" style="left:${pos(lo)};width:calc(${pos(hi)} - ${pos(lo)})"></span><span class="pt" style="left:${pos(r.pt.rel)}"></span>${state.settings.showNaive && nv ? `<span class="nv" style="left:${pos(nv.rel)}"></span>` : ''}</span><span class="cival">${pct(r.pt.rel)} [${pct(r.pt.relLo)}, ${pct(r.pt.relHi)}]</span><span class="naivecol">${nvTxt}</span></span>
    </div>${open ? renderDrill(pr, r) : ''}`;
  }).join('');
  return `<div class="imp-head"><h3>Impact <span class="new-badge">New</span></h3><span class="sp"></span>
      <span class="seg-label">As of</span><div class="seg" role="group" aria-label="As of">${LOOKS.map(l => `<button type="button" data-look="${l.id}" aria-pressed="${look === l.id}">${l.label}</button>`).join('')}</div>
      <button class="iconbtn" data-action="slack" title="Preview the Slack report (s)"><i data-lucide="slack"></i>Post to Slack</button>
    </div>
    <p class="imp-sub">Each metric against its counterfactual for the same hours, weekday and traffic mix. Ranges hold at every look and for all ${rows.length} metrics together (${confPct}%). <span class="mono">${t}h on commit ${pr.sha}</span></p>
    <div class="verdict-bar ${vs.cls}" role="status">${esc(vs.text)}</div>
    <div class="card cmp">
      <div class="cmp-head"><span class="t">Signals and cost</span><span class="k">Counterfactual → observed · ${t}h after merge</span></div>
      ${rowHtml}
      <div class="cmp-foot"><span class="leg"><i class="b1"></i>${confPct}% range, valid at every look</span>${state.settings.showNaive ? `<span class="leg"><i class="b2"></i>Plain before/after (equal-length window before the merge)</span>` : ''}<span style="margin-left:auto">Click a metric for the evidence</span></div>
    </div>`;
}

function renderDrill(pr, r) {
  const m = r.metric, res = r.res;
  const series = res.series;
  const look = r.pt.t;
  const det = detectionHour(m, series);
  const plan = hoursToDetect(res, 0.10);
  const chained = res.chained.length ? res.chained.map(c => `#${c.number} ${pct(Math.exp(c.lnR) - 1)}`).join(', ') + ' <span class="muted">(merged inside the level window; their own estimates applied)</span>' : 'none in the 48h before';
  const samples = (pr.samples[m.id] || []).slice(0, 4);
  const users = pr.facts.signalUsers[m.id];
  return `<div class="drill" id="drill">
    <div class="drill-grid">
      <div class="chart" id="chart" data-pr="${pr.number}" data-metric="${m.id}">
        <div class="chart-title"><span>${esc(m.name)}: change since merge</span><span class="mono">hours on commit ${pr.sha}</span></div>
        ${chartSvg(series, look, m, r)}
      </div>
      <div class="drill-side">
        <dl class="kv">
          <dt>Observed</dt><dd>${m.kind === 'cost' ? '$' + n0(r.pt.O) : n0(r.pt.O) + ' events'} <span class="muted">· ${rateFmt(m, r.pt.obsRate)} of ${n0(r.pt.N)}</span></dd>
          <dt>Expected</dt><dd>${m.kind === 'cost' ? '$' + n0(r.pt.E) : n0(r.pt.E) + ' events'} <span class="muted">· ${rateFmt(m, r.pt.expRate)} for this mix</span></dd>
          <dt>Change</dt><dd><b>${pct(r.pt.rel, 1)}</b> <span class="muted">· ${Math.round(state.settings.conf * 100)}% range ${pct(r.pt.relLo, 1)} to ${pct(r.pt.relHi, 1)}</span></dd>
          <dt>Decided</dt><dd>${det ? `${det}h after merge` : 'not yet'}</dd>
          <dt>Baseline</dt><dd>28-day hour × weekday × plan profile, level from the 48h before merge <span class="muted">(±${(Math.sqrt(res.varLnL) * 100).toFixed(1)}%)</span></dd>
          <dt>Stacked PRs</dt><dd>${chained}</dd>
          <dt>Noise</dt><dd>overdispersion ${res.phi.toFixed(2)}× · day-to-day drift ±${(Math.sqrt(res.varDrift) * 100).toFixed(1)}%</dd>
          ${m.kind !== 'cost' && users !== undefined ? `<dt>Users</dt><dd>${n0(users)} users matched on this commit</dd>` : ''}
        </dl>
        <div class="planner" id="planner">
          <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin-bottom:4px">Hours to detect a change of</div><div class="row"><input type="range" min="5" max="60" step="1" value="${state.plannerEffect || 10}" id="planEffect" aria-label="Change size to detect"><b id="planEff">${state.plannerEffect || 10}%</b></div>
          <div id="planOut">${planText(res, (state.plannerEffect || 10) / 100)}</div>
        </div>
      </div>
    </div>
    ${samples.length ? `<div class="convos"><table><thead><tr><th>Event ID</th><th>Time</th><th>User</th><th>Plan</th><th>${m.kind === 'cost' ? 'Event' : 'Evidence'}</th></tr></thead><tbody>${samples.map(s => `<tr><td class="id">${esc(s.id.replace('ev_', '').slice(0, 8))}</td><td class="muted">${fmtD(hourMs(s.h))}, ${fmtT(hourMs(s.h) + (parseInt(s.id.slice(3, 9), 16) % 3600) * 1e3)}</td><td class="muted">${esc(s.user.slice(0, 13))}…</td><td class="muted">${s.seg}</td><td class="q">${m.id === 'forgetting' || m.id === 'frustration' ? '“' + esc(s.text) + '”' : esc(s.text)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
}
function planText(res, eff) {
  const p = hoursToDetect(res, eff);
  if (!p) return '';
  const floor = Math.round(p.floor * 100);
  if (p.hours === null) return `A ${Math.round(eff * 100)}% change can't be separated from day-to-day variation with this baseline (floor ±${floor}%).`;
  const have = res.series.length;
  return p.hours <= have ? `A ${Math.round(eff * 100)}% change would already be decided by now (${p.hours}h of traffic needed, ${have}h observed).` : `A ${Math.round(eff * 100)}% change needs about <b>${p.hours}h</b> of traffic at the current rate (${have}h so far). Floor: ±${floor}%.`;
}

function chartSvg(series, look, m, r) {
  const W = 520, H = 190, L = 40, R = 8, T = 8, B = 22;
  const n = series.length;
  if (!n) return '';
  const xs = (t) => L + (W - L - R) * (t - 1) / Math.max(1, n - 1);
  const pts = series.map(p => ({ t: p.t, lo: p.relLo, hi: p.relHi, e: p.rel }));
  const naive = state.settings.showNaive ? naiveSeries(r) : [];
  // scale to the settled part of the range (the first hours are clipped, not hidden)
  const settled = pts.filter(p => p.t >= Math.max(3, Math.ceil(n / 6)));
  const sp = settled.length ? settled : pts;
  let ymin = Math.min(0, ...sp.map(p => p.lo), ...naive.filter(p => p.t >= 2).map(p => p.rel)), ymax = Math.max(0, ...sp.map(p => p.hi), ...naive.filter(p => p.t >= 2).map(p => p.rel));
  ymin = Math.max(ymin, -1.5); ymax = Math.min(ymax, 2);
  const pad = (ymax - ymin) * 0.08; ymin -= pad; ymax += pad;
  const ys = (v) => T + (H - T - B) * (1 - (Math.max(ymin - 2, Math.min(ymax + 2, v)) - ymin) / (ymax - ymin));
  const step = niceStep((ymax - ymin) / 4);
  let grid = '';
  for (let v = Math.ceil(ymin / step) * step; v <= ymax + 1e-9; v += step) grid += `<line class="gl" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text class="ax" x="${L - 6}" y="${ys(v) + 3}" text-anchor="end">${pct(v)}</text>`;
  const xt = [];
  const xstep = n > 48 ? 12 : n > 24 ? 6 : n > 8 ? 3 : 1;
  for (let t = 1; t <= n; t += xstep) xt.push(`<text class="ax" x="${xs(t)}" y="${H - 6}" text-anchor="middle">${t}h</text>`);
  const band = `M${pts.map(p => `${xs(p.t)},${ys(p.hi)}`).join('L')}L${pts.slice().reverse().map(p => `${xs(p.t)},${ys(p.lo)}`).join('L')}Z`;
  const est = `M${pts.map(p => `${xs(p.t)},${ys(p.e)}`).join('L')}`;
  const nvPath = naive.length ? `<path class="naive" d="M${naive.map(p => `${xs(p.t)},${ys(p.rel)}`).join('L')}"/>` : '';
  const cls = r.v === 'worse' ? 'worse' : r.v === 'better' ? 'better' : '';
  const lx = xs(Math.min(look, n));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.name)} change since merge with ${Math.round(state.settings.conf * 100)}% range">
    <defs><clipPath id="plotClip"><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></clipPath></defs>
    ${grid}<line class="zero" x1="${L}" x2="${W - R}" y1="${ys(0)}" y2="${ys(0)}"/>
    <g clip-path="url(#plotClip)"><path class="band ${cls}" d="${band}"/><path class="est" d="${est}"/>${nvPath}</g>
    <line class="look" x1="${lx}" x2="${lx}" y1="${T}" y2="${H - B}"/>
    <line class="hov" id="hovLine" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/>
    ${xt.join('')}
    <rect id="hovRect" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
  </svg>`;
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))); const f = x / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
// plain before/after at each hour (what a report posted at that hour would compare)
function naiveSeries(r) {
  const key = `${r.res.pr}:${r.metric.id}`;
  state._ns = state._ns || new Map();
  if (state._ns.has(key)) return state._ns.get(key);
  const prs = state.an.prs; const i = prs.findIndex(p => p.number === r.res.pr);
  const ctx = { cal: state.data.cal, cells: state.data.cells, metric: r.metric, prs, H: state.data.meta.hours };
  const out = [];
  for (let t = 1; t <= r.res.series.length; t++) { const nv = naiveCompare(ctx, i, t); if (nv) out.push({ t, rel: nv.rel, verdict: nv.verdict }); }
  state._ns.set(key, out);
  return out;
}

function renderTimeline(pr) {
  const merged = Date.parse(pr.mergedAt);
  const f = pr.facts;
  const steps = [];
  steps.push(['merged', 'Merged', fmtDT(merged), `<p>by ${esc(pr.authorName)} (@${pr.author})</p>`]);
  const early = merged + 60 * 60e3;
  if (early <= nowMs()) steps.push(['quiet', 'Checked', `${fmtDT(early)} · 1h after merge`, `<p>${esc(earlySummary(pr))}</p>`]);
  const rows = prAt(pr, 'latest');
  const dec = rows.filter(r => r.v === 'worse' || r.v === 'better').map(r => ({ r, at: detectionHour(r.metric, r.res.series) })).sort((a, b) => a.at - b.at);
  if (dec.length) {
    const at = merged + dec[0].at * 3600e3;
    steps.push(['reported', 'Report posted to <span class="chan">#agent-alerts</span>', `${fmtDT(at)} · assistant`, `<div class="headline">${esc(reportHeadline(pr, dec))}</div><ul>${dec.map(({ r, at }) => `<li><b>${esc(r.metric.name)}</b> ${pct(r.pt.rel)} (${Math.round(state.settings.conf * 100)}% range ${pct(r.pt.relLo)} to ${pct(r.pt.relHi)}), decided ${at}h after merge${r.metric.kind !== 'cost' && f.signalUsers[r.metric.id] ? `, ${n0(f.signalUsers[r.metric.id])} users` : ''}.${quoteFor(pr, r.metric)}</li>`).join('')}</ul>`]);
  }
  for (const p of (state.posts[pr.number] || [])) steps.push(['reported', 'Report posted to <span class="chan">#agent-alerts</span>', `${fmtDT(nowMs())} · manual · ${p.lookLabel}`, `<p>${esc(p.headline)}</p>`]);
  const win = prWindowHours(pr);
  const age = (nowMs() - merged) / 3600e3;
  if (age < 24 && win >= age - 1) steps.push(['monitoring', 'Next check', `${fmtDT(merged + 24 * 3600e3)} · 24h after merge`, '']);
  else {
    const next = state.prs.filter(p => p.t0 > pr.t0).sort((a, b) => a.t0 - b.t0)[0];
    steps.push(['quiet', 'Monitoring ended', next && win < 24 ? `when #${next.number} merged, ${win}h after this one` : 'after the 1-day check', '']);
  }
  return steps.map(([ico, title, meta, body]) => `<li class="tl"><span class="ico">${statIco(ico)}</span><span class="rail"></span><div class="tl-head"><h4>${title}</h4><span>${meta}</span></div>${body}</li>`).join('');
}
function quoteFor(pr, m) { const s = (pr.samples[m.id] || [])[0]; return s && (m.id === 'forgetting' || m.id === 'frustration') ? ` <span class="q">“${esc(s.text)}”</span>` : ''; }
function reportHeadline(pr, dec) {
  const w = dec.filter(d => d.r.v === 'worse'), b = dec.filter(d => d.r.v === 'better');
  if (w.length) return `${w.map(d => d.r.metric.name).join(' and ')} went up after this change.`;
  return `${b.map(d => d.r.metric.name).join(' and ')} improved after this change.`;
}
function earlySummary(pr) {
  const f = pr.facts;
  const base = `${n0(f.events1h)} events from ${n0(f.users1h)} users ran on the new code in the first hour.`;
  switch (pr.number) {
    case 284: return `The updated compaction settings are live. In the first hour, ${n0(f.compactionUsers1h)} users had conversations that triggered compaction.`;
    case 278: return f.sendEmailCalls ? `send_email was called ${n0(f.sendEmailCalls)} times by ${n0(f.sendEmailUsers)} users on this commit.` : 'send_email has not been called yet.';
    case 291: return `The agent explained how to connect MCP to ${n0(f.mcpExplainedUsers)} users; ${n0(f.mcpConnectedUsers)} connected MCP afterwards.`;
    case 276: return `Cost in the first hour was $${n0(f.cost1h)} vs. $${n0(f.costPre1h)} the hour before. ${base}`;
    case 283: case 292: return `web_search was called ${n0(f.webSearchCalls)} times on this commit. ${base}`;
    default: return base;
  }
}

// ---------- calibration ----------
function renderCalibration() {
  const bt = state.results.backtest, demo = state.results.demo;
  const nm = bt.nullMerges;
  const pw = bt.power;
  const big = pw.filter(p => ['forgetting', 'tool_error'].includes(p.metric));
  const live = state.live;
  const mName = (id) => state.metricsById[id].name;
  return `<div class="calib"><div class="calib-in">
    <h2>How often would a report be wrong?</h2>
    <p class="lede">${bt.trials} simulated merges that change nothing, at random times across weekdays, nights and weekends, on the same traffic model as this project. A plain before/after comparison (equal-length window before the merge, checked at the early check and the full report) treats normal hour-of-day, weekend and plan-mix swings as effects. Change Impact compares each hour with its own counterfactual and keeps one ${Math.round((1 - bt.familyAlpha) * 100)}% guarantee across all ${bt.metrics} metrics and every hourly look.</p>
    <div class="kpis">
      <div class="kpi"><div class="l">No-op merges flagged, plain diff</div><div class="v red">${(nm.naive * 100).toFixed(1)}%<small>${nm.naiveCount} of ${bt.trials}</small></div><div class="s">early check + full report</div></div>
      <div class="kpi"><div class="l">No-op merges flagged, Change Impact</div><div class="v green">${(nm.adjusted * 100).toFixed(1)}%<small>${nm.adjustedCount} of ${bt.trials}</small></div><div class="s">every hour for ${bt.postHours}h, all metrics</div></div>
      <div class="kpi"><div class="l">Large regressions caught, 24h</div><div class="v">${Math.round(100 * Math.min(...big.map(p => p.adjPower)))}–${Math.round(100 * Math.max(...big.map(p => p.adjPower)))}%</div><div class="s">${big.map(p => `${shortName(state.metricsById[p.metric])} ${pct(p.effect - 1)}`).join(', ')}; ${Math.round(100 * Math.min(...big.map(p => p.adjPower72h)))}–${Math.round(100 * Math.max(...big.map(p => p.adjPower72h)))}% by 72h</div></div>
      <div class="kpi"><div class="l">Wrong PR blamed, stacked merges</div><div class="v">${Math.round(bt.stacked.secondBlamed.adjusted * 100)}%<small>vs ${Math.round(bt.stacked.secondBlamed.naive * 100)}% plain</small></div><div class="s">2nd PR ${bt.stacked.gapHours}h after a real regression</div></div>
    </div>
    <div class="card"><table class="ctable"><thead><tr><th>Metric</th><th class="num">No-op merges flagged · plain</th><th></th><th class="num">· Change Impact</th><th></th></tr></thead><tbody>
      ${Object.entries(nm.perMetric).map(([id, v]) => `<tr><td>${esc(mName(id))}</td><td class="num">${(v.naive * 100).toFixed(1)}%</td><td style="width:22%"><span class="pbar" style="width:${Math.max(1, v.naive * 100)}%;background:#fb2c36"></span></td><td class="num">${(v.adjusted * 100).toFixed(1)}%</td><td style="width:22%"><span class="pbar" style="width:${Math.max(1, v.adjusted * 100)}%;background:#00a63e"></span></td></tr>`).join('')}
    </tbody></table></div>
    <div class="card"><table class="ctable"><thead><tr><th>Planted change</th><th class="num">Caught in 24h · Change Impact</th><th class="num">by 72h</th><th class="num">Median hours to decide</th><th class="num">Other metrics falsely flagged · CI / plain</th></tr></thead><tbody>
      ${pw.map(p => `<tr><td>${esc(mName(p.metric))} ${pct(p.effect - 1)}</td><td class="num">${Math.round(p.adjPower * 100)}%</td><td class="num">${Math.round(p.adjPower72h * 100)}%</td><td class="num">${p.adjMedianHours ?? '–'}</td><td class="num">${Math.round(p.adjOtherFalse * 100)}% / ${Math.round(p.naiveOtherFalse * 100)}%</td></tr>`).join('')}
    </tbody></table></div>
    <div class="card method">
      <b style="color:var(--content)">This project (synthetic, ground truth known)</b>: across ${demo.prs} merged PRs × ${demo.metrics} metrics, the plain before/after raised <b style="color:var(--content)">${demo.naive.flags}</b> flags and ${demo.naive.false} were wrong; Change Impact raised <b style="color:var(--content)">${demo.adjusted.flags}</b> and ${demo.adjusted.false} were wrong, catching ${demo.adjusted.realCaught} of the ${demo.realEffects} planted changes of 10% or more (the misses are left as “no detectable change”, with the range shown).
      <div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><button class="iconbtn" data-action="live-run" ${live && live.running ? 'disabled' : ''}><i data-lucide="play"></i>${live && live.running ? 'Running…' : 'Run 60 more no-op merges in this tab'}</button><span id="liveOut" class="tnum">${liveText()}</span></div>
    </div>
    <div class="card method"><b style="color:var(--content)">Method</b>
      <ol>
        <li><b>Counterfactual.</b> Fit rate = <code>a[plan] × b[hour-of-day, weekend]</code> by raking (Poisson log-linear) on the 28 days before the merge; set the level from the 48 hours before it. Hours that ran on an earlier PR are rescaled by that PR's own estimate, so a stacked merge isn't blamed for its predecessor.</li>
        <li><b>Commit-scoped window.</b> Only traffic on the PR's commit counts (until the next merge), using the <code>raindrop.app.commit_sha</code> property Change Reports already reads.</li>
        <li><b>Anytime-valid range.</b> Observed minus expected is a running sum; a Gaussian-mixture confidence sequence (Robbins; Howard et al. 2021) on it, with variance inflated by the fitted overdispersion, holds at every hourly look. Baseline error (level, profile, day-to-day drift net of sampling) is added with its own bound; the error budget is split across metrics (Bonferroni).</li>
        <li><b>Planner.</b> Projects the range forward at the current traffic to say how many hours a given change needs, and the floor below which the baseline can't resolve it.</li>
      </ol>
    </div>
  </div></div>`;
}
function liveText() { const l = state.live; if (!l || !l.done) return 'Same simulator and code as the backtest, seeded differently.'; return `${l.done} merges: plain before/after flagged ${l.naive} (${Math.round(100 * l.naive / l.done)}%), Change Impact flagged ${l.adj} (${(100 * l.adj / l.done).toFixed(1)}%).`; }
function liveRun() {
  if (state.live && state.live.running) return;
  const metrics = METRICS.map(({ base, sdLog, ...r }) => ({ ...r }));
  const L = state.live = { running: true, done: 0, adj: 0, naive: 0, seed: (Date.now() & 0xffff) };
  const total = 60;
  const stepFn = () => {
    const t0 = performance.now();
    while (L.done < total && performance.now() - t0 < 40) {
      const rng = makeRng(L.seed * 7919 + L.done);
      const off = Math.floor(rng.u() * 168), Hh = 30 * 24 + off + 25;
      const cal = makeCalendar(state.data.meta.start, Hh);
      const prs = [{ number: 1, t0: 30 * 24 + off, effects: {} }];
      const cells = sampleCells(rng, cal, METRICS, prs);
      let a = false, nvf = false;
      for (const metric of metrics) {
        const ctx = { cal, cells, metric, prs, H: Hh, alpha: 0.05 / metrics.length };
        const res = analyzeMetric(ctx, 0);
        if (res.series.some(p => { const v = verdictOf(metric, p); return v === 'worse' || v === 'better'; })) a = true;
        const e = naiveCompare(ctx, 0, 1), f = naiveCompare(ctx, 0, 24);
        if ((e && e.verdict !== 'none') || (f && f.verdict !== 'none')) nvf = true;
      }
      L.done++; if (a) L.adj++; if (nvf) L.naive++;
    }
    const out = $('#liveOut'); if (out) out.textContent = liveText();
    if (L.done < total) setTimeout(stepFn, 0); else { L.running = false; if (state.route.view === 'calibration') renderPage(); toast(`Ran ${total} more no-op merges in your browser`); }
  };
  renderPage();
  setTimeout(stepFn, 0);
}

// ---------- settings ----------
function renderSettings() {
  const sw = (key, on) => `<button class="switch" role="switch" aria-checked="${on}" data-switch="${key}" aria-label="${key}"></button>`;
  return `<div class="settings"><div class="card">
    <div class="srow"><div class="tx"><b>Impact confidence</b><span>One guarantee for all metrics at every look. Higher confidence means fewer false alarms and later decisions.</span></div><div class="seg" role="group" aria-label="Confidence">${[0.9, 0.95, 0.99].map(c => `<button data-conf="${c}" aria-pressed="${state.settings.conf === c}">${Math.round(c * 100)}%</button>`).join('')}</div></div>
    <div class="srow"><div class="tx"><b>Show the plain before/after</b><span>Show the equal-length-window comparison next to each metric, so the difference is visible.</span></div>${sw('showNaive', state.settings.showNaive)}</div>
    <div class="srow"><div class="tx"><b>Add impact lines to Slack reports</b><span>Each report lists the decided metrics with their ranges and what was ruled out.</span></div>${sw('slackImpact', state.settings.slackImpact)}</div>
    <div class="srow"><div class="tx"><b>assistant</b><span>sprinkle-ai/assistant · reports to #agent-alerts · max 4 per day</span></div>${sw('agent', true)}</div>
  </div></div>`;
}

// ---------- weekly digest (built-in brief) ----------
function renderDigest() {
  const H = state.data.meta.hours, c = state.data.cells;
  const rate = (m, from, to) => { let n = 0, y = 0; for (let s = 0; s < c.n.length; s++) for (let h = from; h < to; h++) { n += c.n[s][h]; y += c.m[m.id].y[s][h]; } return { n, y, r: n ? y / n : 0 }; };
  const rows = state.data.metrics.map(m => { const a = rate(m, H - 336, H - 168), b = rate(m, H - 168, H); return { m, a, b, rel: a.r ? b.r / a.r - 1 : 0 }; });
  const ev = rows[0].b.n;
  return `<header class="reader-head"><div class="rh-row"><div class="rh-titles"><div class="rh-h1"><h1>Weekly Digest</h1></div><p class="rh-sub">A Monday read on how the week went, compared with the week before.</p></div><span class="pill-active"><i></i>Active</span></div></header>
  <div class="digest"><div class="card cmp"><div class="cmp-head"><span class="t">Last 7 days vs. the 7 before</span><span class="k">${n0(ev)} events</span></div>
  ${rows.map(r => { const mx = Math.max(r.a.r, r.b.r) || 1; return `<div class="mrow" style="cursor:default"><span class="mname"><span class="nm">${esc(r.m.name)}</span><span class="lead"></span></span><span class="bars"><span class="l">${rateFmt(r.m, r.a.r)}<span class="bar base" style="width:${120 * r.a.r / mx}px"></span></span><span class="mid"></span><span class="r"><span class="bar obs" style="width:${120 * r.b.r / mx}px"></span>${rateFmt(r.m, r.b.r)}</span></span><span class="badge none">${pct(r.rel)}</span></div>`; }).join('')}
  <div class="cmp-foot">Week-over-week moves include every merge in between; open Change reports to see which PR did what.</div></div></div>`;
}

// ---------- menus, modals, toast ----------
let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
function openMenu(anchor, items) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'menu'; el.setAttribute('role', 'menu');
  el.innerHTML = items.map(it => it.sep ? '<hr>' : it.hint ? `<div class="mhint">${it.hint}</div>` : `<button role="menuitemradio" aria-checked="${!!it.on}" data-i="${it.key}"><span class="chk">${it.on ? '✓' : ''}</span>${esc(it.label)}${it.count !== undefined ? `<span class="mcount">${it.count}</span>` : ''}</button>`).join('');
  document.body.appendChild(el);
  const w = el.offsetWidth;
  el.style.left = Math.min(window.innerWidth - w - 8, r.left) + 'px';
  el.style.top = (r.bottom + 4) + 'px';
  el.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; const it = items.find(x => String(x.key) === b.dataset.i); closeMenu(); it && it.run(); });
  openMenuEl = el;
  const first = el.querySelector('button'); if (first) first.focus();
}
function menuFor(kind, anchor) {
  if (kind === 'author') {
    const authors = [...new Set(state.prs.map(p => p.author))];
    openMenu(anchor, [{ key: 'any', label: 'Anyone', count: state.prs.length, on: !state.filter.author, run: () => setFilter({ author: null }) }, { sep: 1 }, ...authors.map(a => ({ key: a, label: `${state.prs.find(p => p.author === a).authorName} (@${a})`, count: state.prs.filter(p => p.author === a).length, on: state.filter.author === a, run: () => setFilter({ author: a }) }))]);
  } else if (kind === 'status') {
    openMenu(anchor, [{ key: 'any', label: 'Any', on: !state.filter.status, run: () => setFilter({ status: null }) }, ...['reported', 'monitoring', 'quiet'].map(s => ({ key: s, label: STATUS_LABEL[s], on: state.filter.status === s, count: state.prs.filter(p => prStatus(p) === s).length, run: () => setFilter({ status: s }) }))]);
  } else if (kind === 'impact') {
    const cnt = (k) => state.prs.filter(p => { const rows = prAt(p); return k === 'worse' ? rows.some(r => r.v === 'worse') : k === 'better' ? rows.some(r => r.v === 'better') : k === 'none' ? !rows.some(r => r.v === 'worse' || r.v === 'better') : rows.some(r => r.nv && r.nv.verdict !== 'none' && r.v !== r.nv.verdict); }).length;
    openMenu(anchor, [{ key: 'any', label: 'Any', on: !state.filter.impact, run: () => setFilter({ impact: null }) }, { key: 'worse', label: 'Likely worse', count: cnt('worse'), on: state.filter.impact === 'worse', run: () => setFilter({ impact: 'worse' }) }, { key: 'better', label: 'Likely better', count: cnt('better'), on: state.filter.impact === 'better', run: () => setFilter({ impact: 'better' }) }, { key: 'none', label: 'No detectable change', count: cnt('none'), on: state.filter.impact === 'none', run: () => setFilter({ impact: 'none' }) }, { sep: 1 }, { key: 'naive', label: 'Plain diff disagrees', count: cnt('naive'), on: state.filter.impact === 'naive', run: () => setFilter({ impact: 'naive' }) }]);
  } else if (kind === 'repo') {
    openMenu(anchor, [{ key: 'all', label: 'All repos', on: true, run: () => {} }, { key: 'r', label: state.data.meta.repo, run: () => {} }]);
  } else if (kind === 'export') {
    openMenu(anchor, [{ key: 'csv', label: 'All PRs × metrics (CSV)', run: exportCSV }, { key: 'json', label: 'This PR (JSON)', run: exportJSON }, { key: 'link', label: 'Copy link to this view', run: copyLink }]);
  } else if (kind === 'mark') {
    const pr = state.sel; if (!pr) return;
    const cur = state.marks[pr.number];
    openMenu(anchor, [{ hint: 'Shown on the PR and in the list; saved in this browser.' }, ...['investigating', 'expected', 'revert'].map(k => ({ key: k, label: markLabel(k), on: cur === k, run: () => setMark(pr, k) })), { sep: 1 }, { key: 'clear', label: 'Clear', run: () => setMark(pr, null) }]);
  }
}
function setFilter(f) { Object.assign(state.filter, f); save(); renderPage(); }
function setMark(pr, k) { if (k) state.marks[pr.number] = k; else delete state.marks[pr.number]; save(); renderPage(); toast(k ? `#${pr.number} marked ${markLabel(k).toLowerCase()}` : `Cleared mark on #${pr.number}`); }

function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function exportCSV() { download(`change-impact-${state.route.look}.csv`, toCSV(state.data, state.an, lookHours(state.route.look)), 'text/csv'); toast('Exported CSV'); }
function exportJSON() {
  const pr = state.sel; if (!pr) return;
  const rows = prAt(pr).map(r => ({ metric: r.metric.id, name: r.metric.name, hoursSinceMerge: r.pt?.t ?? 0, events: r.pt?.N ?? 0, observed: round(r.pt?.O ?? 0, 4), expected: round(r.pt?.E ?? 0, 4), change: round(r.pt?.rel ?? 0, 5), range: [round(r.pt?.relLo ?? 0, 5), round(r.pt?.relHi ?? 0, 5)], verdict: r.v, decidedAtHour: detectionHour(r.metric, r.res.series), plainBeforeAfter: r.nv ? { change: round(r.nv.rel, 5), verdict: r.nv.verdict, hours: r.nv.hours } : null, chainedPRs: r.res.chained.map(c => c.number) }));
  download(`change-impact-pr-${pr.number}.json`, JSON.stringify({ pr: pr.number, title: pr.title, commit: pr.sha, confidence: state.settings.conf, look: state.route.look, metrics: rows }, null, 2), 'application/json');
  toast(`Exported #${pr.number} as JSON`);
}
function copyLink() { const u = location.href; (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(() => toast('Link copied'), () => toast(u)); }

function modal(title, body, foot) {
  const ov = $('#overlay');
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-h"><h2>${esc(title)}</h2><button class="iconbtn" data-action="close" aria-label="Close"><i data-lucide="x"></i></button></div><div class="modal-b">${body}</div>${foot ? `<div class="modal-f">${foot}</div>` : ''}</div>`;
  ov.hidden = false; icons();
  const f = ov.querySelector('.modal-f .primary') || ov.querySelector('button'); f && f.focus();
}
function closeModal() { const ov = $('#overlay'); ov.hidden = true; ov.innerHTML = ''; }
function slackText(pr) {
  const rows = prAt(pr);
  const dec = rows.filter(r => r.v === 'worse' || r.v === 'better');
  const none = rows.filter(r => r.v === 'none');
  const t = rows[0].pt ? rows[0].pt.t : 0;
  const conf = Math.round(state.settings.conf * 100);
  const lines = [];
  lines.push(earlySummary(pr));
  if (state.settings.slackImpact) {
    for (const r of dec) lines.push(`<b>${esc(r.metric.name)}: ${pct(r.pt.rel)}</b> (${conf}% range ${pct(r.pt.relLo)} to ${pct(r.pt.relHi)}), vs. the same hours and traffic mix before the change.${quoteFor(pr, r.metric)}`);
    if (none.length) lines.push(`No detectable change in ${list(none.map(r => r.metric.name.toLowerCase()))}${none.some(r => r.metric.kind === 'cost') ? `; cost per event moved less than ${Math.round(100 * Math.max(...none.filter(r => r.metric.kind === 'cost').map(r => Math.max(Math.abs(r.pt.relLo), Math.abs(r.pt.relHi)))))}%` : ''}.`);
    const nvOnly = rows.filter(r => r.nv && r.nv.verdict !== 'none' && r.v !== r.nv.verdict);
    if (nvOnly.length) lines.push(`Not flagged: ${list(nvOnly.map(r => `${r.metric.name.toLowerCase()} ${pct(r.nv.rel)}`))} in a plain before/after, explained by time of day, weekend or plan mix.`);
  }
  return { headline: dec.length ? reportHeadline(pr, dec.map(r => ({ r }))) : `No notable changes ${t}h after merge.`, lines, t };
}
function slackPreview() {
  const pr = state.sel; if (!pr) return;
  const s = slackText(pr);
  const lookLabel = LOOKS.find(l => l.id === state.route.look).label;
  modal('Post to Slack', `<div class="slack"><span class="av"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2.5c3.4 4.3 6.5 8 6.5 11.6A6.5 6.5 0 0 1 5.5 14.1C5.5 10.5 8.6 6.8 12 2.5Z" fill="#fff"/></svg></span><div><div><span class="nm">Raindrop</span><span class="app">APP</span><span class="tm">${fmtT(nowMs())}</span></div>
    <div><b>Change Report: ${esc(pr.title)}</b></div><div><a href="#">${esc(state.data.meta.repo)}</a> · <a href="#">#${pr.number}</a> · Merged by @${pr.author} · ${s.t}h on the new commit</div>
    <div style="margin-top:6px">${esc(s.headline)}</div><ul>${s.lines.map(l => `<li>${l}</li>`).join('')}</ul></div></div>`,
    `<span style="margin-right:auto;font-size:12px;color:var(--content-secondary);align-self:center">Posts to #agent-alerts · as of ${lookLabel}</span><button class="btn" data-action="copy-slack">Copy text</button><button class="btn primary" data-action="send-slack">Post</button>`);
  state._slack = { pr, s, lookLabel };
}
function helpModal() {
  modal('Keyboard shortcuts', `<div class="keys"><kbd>j</kbd><span>Next pull request</span><kbd>k</kbd><span>Previous pull request</span><kbd>1</kbd><span>As of the early check (1h)</span><kbd>2</kbd><span>As of 6h</span><kbd>3</kbd><span>As of the full report (24h)</span><kbd>4</kbd><span>Latest</span><kbd>↓ ↑</kbd><span>Open the next / previous metric</span><kbd>m</kbd><span>Mark as…</span><kbd>s</kbd><span>Preview the Slack report</span><kbd>e</kbd><span>Export CSV</span><kbd>c</kbd><span>Impact calibration</span><kbd>r</kbd><span>Pull requests</span><kbd>Esc</kbd><span>Close</span></div>`);
}
let toastT = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2200); }

// ---------- events ----------
function afterRender() {
  const sel = $('.pri.sel'), lst = $('.prlist');
  if (sel && lst) { const top = sel.offsetTop - lst.offsetTop, bot = top + sel.offsetHeight; if (top < lst.scrollTop) lst.scrollTop = top - 8; else if (bot > lst.scrollTop + lst.clientHeight) lst.scrollTop = bot - lst.clientHeight + 8; }
  const chart = $('#chart');
  if (chart) {
    const rect = chart.querySelector('#hovRect'), line = chart.querySelector('#hovLine');
    const pr = state.prs.find(p => p.number === +chart.dataset.pr); const m = state.metricsById[chart.dataset.metric];
    const res = state.an.byPr.get(pr.number)[m.id].res;
    const nv = state.settings.showNaive ? naiveSeries({ res, metric: m }) : [];
    let tip = null;
    rect.addEventListener('mousemove', (e) => {
      const svg = rect.ownerSVGElement; const b = svg.getBoundingClientRect();
      const W = 520, L = 40, R = 8; const x = (e.clientX - b.left) * W / b.width;
      const n = res.series.length; const t = Math.max(1, Math.min(n, Math.round(1 + (x - L) / (W - L - R) * (n - 1))));
      const p = res.series[t - 1]; const xx = L + (W - L - R) * (t - 1) / Math.max(1, n - 1);
      line.setAttribute('x1', xx); line.setAttribute('x2', xx); line.style.display = '';
      if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip); }
      const q = nv[t - 1];
      tip.innerHTML = `<div class="mono">${t}h after merge · ${n0(p.N)} events</div><div><b>${pct(p.rel, 1)}</b> [${pct(p.relLo, 1)}, ${pct(p.relHi, 1)}]</div>${q ? `<div style="color:#9a6b00">plain before/after ${pct(q.rel, 1)}${q.verdict !== 'none' ? ' (flag)' : ''}</div>` : ''}`;
      tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY - 10) + 'px';
    });
    rect.addEventListener('mouseleave', () => { line.style.display = 'none'; if (tip) { tip.remove(); tip = null; } });
  }
  const pe = $('#planEffect');
  if (pe) pe.addEventListener('input', () => { state.plannerEffect = +pe.value; $('#planEff').textContent = pe.value + '%'; const ch = $('#chart'); const res = state.an.byPr.get(+ch.dataset.pr)[ch.dataset.metric].res; $('#planOut').innerHTML = planText(res, pe.value / 100); });
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (openMenuEl && !t.closest('.menu') && !t.closest('[data-menu]')) closeMenu();
  const stat = t.closest('[data-static]');
  if (stat) { e.preventDefault(); toast(stat.dataset.static === 'brief' ? 'Custom briefs are not part of this concept demo' : 'Only Briefs is part of this concept demo'); return; }
  const tabB = t.closest('[data-tab]'); if (tabB) { go({ view: tabB.dataset.tab }); return; }
  const prB = t.closest('[data-pr]'); if (prB && prB.classList.contains('pri')) { go({ pr: +prB.dataset.pr, metric: null }); return; }
  const day = t.closest('[data-day]'); if (day) { state.openDays.push(day.dataset.day); save(); renderPage(); return; }
  const lk = t.closest('[data-look]'); if (lk) { go({ look: lk.dataset.look }, true); return; }
  const mr = t.closest('.mrow[data-metric]'); if (mr) { const id = mr.dataset.metric; go({ metric: state.route.metric === id ? null : id }, true); return; }
  const menuB = t.closest('[data-menu]'); if (menuB) { if (openMenuEl) { closeMenu(); return; } menuFor(menuB.dataset.menu, menuB); return; }
  const sw = t.closest('[data-switch]'); if (sw) { const k = sw.dataset.switch; if (k in state.settings) { state.settings[k] = !state.settings[k]; save(); renderPage(); toast('Saved'); } else toast('Agent stays on in this demo'); return; }
  const cf = t.closest('[data-conf]'); if (cf) { state.settings.conf = +cf.dataset.conf; save(); state._ns = null; state._na = null; runAnalysis(); renderPage(); toast(`Impact confidence set to ${Math.round(state.settings.conf * 100)}%`); return; }
  const act = t.closest('[data-action]');
  if (act) {
    const a = act.dataset.action;
    if (a === 'close') closeModal();
    else if (a === 'slack') slackPreview();
    else if (a === 'clear-filters') setFilter({ author: null, impact: null, status: null });
    else if (a === 'github') { e.preventDefault(); toast('Links to the synthetic repo are disabled in this demo'); }
    else if (a === 'live-run') liveRun();
    else if (a === 'copy-slack') { const s = state._slack; const txt = [`Change Report: ${s.pr.title}`, s.s.headline, ...s.s.lines.map(l => '• ' + l.replace(/<[^>]+>/g, ''))].join('\n'); (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast('Copied'), () => toast('Copy failed')); }
    else if (a === 'send-slack') { const s = state._slack; (state.posts[s.pr.number] = state.posts[s.pr.number] || []).push({ headline: s.s.headline, lookLabel: s.lookLabel }); save(); closeModal(); renderPage(); toast('Report posted to #agent-alerts'); }
  }
});
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeModal(); });
$('#helpBtn').addEventListener('click', helpModal);
$('#askBtn').addEventListener('click', () => toast('Ask Raindrop is not part of this concept demo'));

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && e.target.type !== 'range') return;
  if (e.key === 'Escape') { if (!$('#overlay').hidden) closeModal(); else if (openMenuEl) closeMenu(); else if (state.route.metric) go({ metric: null }, true); return; }
  if (!$('#overlay').hidden) return;
  const view = state.route.view;
  if (e.key === '?') { helpModal(); return; }
  if (e.key === 'c') { go({ view: 'calibration' }); return; }
  if (e.key === 'r') { go({ view: 'reports' }); return; }
  if (view !== 'reports') return;
  const prs = [...document.querySelectorAll('.pri')].map(b => +b.dataset.pr);
  const cur = state.sel ? state.sel.number : null;
  if (e.key === 'j' || e.key === 'k') { e.preventDefault(); const i = prs.indexOf(cur); const j = e.key === 'j' ? Math.min(prs.length - 1, i + 1) : Math.max(0, i - 1); if (prs[j]) go({ pr: prs[j], metric: null }, true); return; }
  if (['1', '2', '3', '4'].includes(e.key)) { go({ look: LOOKS[+e.key - 1].id }, true); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (tag === 'input') return;
    e.preventDefault(); const ids = state.data.metrics.map(m => m.id); const i = ids.indexOf(state.route.metric);
    const j = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(ids.length - 1, i + 1)) : Math.max(0, i - 1);
    go({ metric: ids[j] }, true); const row = document.querySelector(`.mrow[data-metric="${ids[j]}"]`); row && row.focus({ preventScroll: false }); return;
  }
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('mrow')) { e.target.click(); return; }
  if (e.key === 'e') { exportCSV(); return; }
  if (e.key === 's') { slackPreview(); return; }
  if (e.key === 'm') { const b = document.querySelector('[data-menu="mark"]'); b && menuFor('mark', b); return; }
});
window.addEventListener('popstate', onRoute);
window.addEventListener('hashchange', onRoute);

function onRoute() {
  const prevView = state.route.view, prevPr = state.route.pr;
  state.route = parseRoute();
  closeMenu();
  const detail = $('#detail'); const keep = detail && prevView === state.route.view && prevPr === state.route.pr ? detail.scrollTop : 0;
  renderPage();
  const d2 = $('#detail'); if (d2 && keep) d2.scrollTop = keep;
  if (state.route.metric) { const dr = $('#drill'); if (dr && d2) { const top = dr.offsetTop - d2.offsetTop, bot = top + dr.offsetHeight; if (bot > d2.scrollTop + d2.clientHeight) d2.scrollTop = Math.min(top - 120, bot - d2.clientHeight + 16); } }
}

// ---------- boot ----------
async function boot() {
  load();
  renderNav(); icons();
  try {
    const [d, r] = await Promise.all([fetch('data/project.json').then(x => { if (!x.ok) throw new Error(`data/project.json: HTTP ${x.status}`); return x.json(); }), fetch('results/results.json').then(x => { if (!x.ok) throw new Error(`results/results.json: HTTP ${x.status}`); return x.json(); })]);
    state.data = d; state.results = r;
    const t0 = performance.now();
    runAnalysis();
    state.analysisMs = Math.round(performance.now() - t0);
    document.documentElement.dataset.analysisMs = state.analysisMs;
    state.route = parseRoute();
    renderPage();
  } catch (err) {
    $('#main').innerHTML = `<div class="err-state" role="alert"><h2>Couldn't load this project</h2><p>${esc(err.message)}. If you opened the file directly, serve the folder over HTTP (for example <code>python3 -m http.server</code>).</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
  }
}
boot();
