import { parseRepo } from '../lib/repoUrl.js';
import { makeGitHub } from '../lib/github.js';
import { collect } from '../lib/collect.js';
import { scanDependencies } from '../lib/deps.js';
import { activity, activityScore, hygiene, dependencyScore, overall, grade, verdict } from '../lib/score.js';
import { makeRepoPilot } from '../lib/repoPilot.js';
import { loadSettings } from '../lib/settings.js';
import { fetchSources } from '../lib/tarball.js';
import { buildGraph, toMermaid, hubs, isSource } from '../lib/graph.js';

const CACHE_TTL = 30 * 60 * 1000;
const main = document.getElementById('main');
const input = document.getElementById('repo-input');

let current = null;   // { owner, repo }
let view = null;      // computed data for current repo
let tab = 'overview';
let runId = 0;        // guards against a slow earlier scan overwriting a newer one
const pilot = new Map(); // "owner/repo" -> { status, diagram, health, error }
const arch = new Map();  // "owner/repo" -> built-in diagram { status, graph, mermaid, level, hubs, error }
const MAX_REPO_KB = 150000;

// DOM helper: children are text or nodes; text is always set as text, never as HTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const fmt = n => (n == null ? 'n/a' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const ago = d => (d == null || !isFinite(d) ? 'never' : d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : d < 730 ? `${Math.round(d / 30)} months ago` : `${Math.round(d / 365)} years ago`);
const key = t => `${t.owner}/${t.repo}`.toLowerCase();

// ---------- data ----------

async function analyze(target, { force = false } = {}) {
  current = target;
  input.value = `${target.owner}/${target.repo}`;
  const id = ++runId;
  main.replaceChildren(h('p', { class: 'empty' }, h('span', { class: 'spin' }), ` Scanning ${target.owner}/${target.repo}…`));

  try {
    const cacheKey = `cache:${key(target)}`;
    let cached = force ? null : (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (!cached || Date.now() - cached.raw.fetchedAt > CACHE_TTL) {
      const { githubToken } = await loadSettings();
      const raw = await collect(makeGitHub(githubToken), target.owner, target.repo);
      const deps = await scanDependencies(target.owner, target.repo, raw.meta.default_branch, raw.paths)
        .catch(e => ({ manifests: [], packages: [], vulns: [], errors: [e.message] }));
      cached = { raw, deps };
      chrome.storage.local.set({ [cacheKey]: cached }).catch(() => {}); // a full cache only costs a re-scan
    }
    if (id !== runId) return;
    view = compute(cached.raw, cached.deps);
    render();
  } catch (e) {
    if (id !== runId) return;
    const msg = e.status === 404 ? 'Repository not found, or it is private.' : e.message;
    main.replaceChildren(h('p', { class: 'error' }, msg));
  }
}

function compute(raw, deps) {
  const act = activity(raw);
  const hyg = hygiene(raw);
  return {
    raw, deps, act, hyg,
    scores: { activity: activityScore(act), hygiene: hyg.score, deps: dependencyScore(deps) },
    verdict: verdict(act, hyg, deps),
  };
}

function totals() {
  const code = pilot.get(key(current))?.health?.score ?? null;
  const s = { ...view.scores, code };
  const total = overall(s);
  return { s, total, g: grade(total) };
}

// ---------- render ----------

function render() {
  const { raw, act } = view;
  const { total, g } = totals();
  const year = act.weekly.reduce((a, b) => a + b, 0);

  const hero = h('section', { class: 'hero' },
    h('div', { class: 'hero-top' },
      h('div', { class: 'grade', 'data-g': g, 'aria-label': `Grade ${g}` }, g),
      h('div', {},
        h('div', { class: 'hero-name' }, h('a', { href: raw.meta.html_url, target: '_blank', rel: 'noopener' }, raw.meta.full_name)),
        h('div', { class: 'score-line' }, `${total}/100 overall health`),
        raw.meta.description && h('div', { class: 'sub' }, raw.meta.description))),
    h('p', { class: 'verdict' }, view.verdict),
    strip(act.weekly),
    h('div', { class: 'strip-caption' }, h('span', {}, 'A year ago'), h('span', {}, `${fmt(year)} commits in 52 weeks`), h('span', {}, 'This week')));

  const tabs = [['overview', 'Overview'], ['activity', 'Activity'], ['health', 'Health'], ['deps', 'Dependencies'], ['arch', 'Architecture']];
  const nav = h('nav', { role: 'tablist' }, tabs.map(([id, label]) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; render(); } }, label)));

  const body = { overview, activity: activityTab, health: healthTab, deps: depsTab, arch: archTab }[tab]();
  main.replaceChildren(hero, nav, h('div', { role: 'tabpanel' }, body));
}

function strip(weeks) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'strip');
  svg.setAttribute('viewBox', '0 0 520 48');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', weeks.length ? 'Weekly commits over the past year' : 'Commit history not available yet');
  const max = Math.max(1, ...weeks);
  weeks.forEach((n, i) => {
    const r = document.createElementNS(NS, 'rect');
    const ht = n ? Math.max(3, (n / max) * 46) : 2;
    r.setAttribute('x', i * 10); r.setAttribute('width', 8);
    r.setAttribute('y', 48 - ht); r.setAttribute('height', ht);
    if (!n) r.setAttribute('class', 'zero');
    const t = document.createElementNS(NS, 'title'); t.textContent = `${n} commits`; r.append(t);
    svg.append(r);
  });
  return svg;
}

function overview() {
  const { raw, act } = view;
  const { s } = totals();
  const bar = (label, v, naText) => h('div', { class: `bar-row${v == null ? ' na' : ''}` },
    h('span', {}, label),
    h('div', { class: 'bar' }, h('i', { style: `width:${v ?? 0}%` })),
    h('span', { class: 'n' }, v == null ? naText : v));
  return [
    h('div', { class: 'bars' },
      bar('Activity', s.activity),
      bar('Project hygiene', s.hygiene),
      bar('Dependencies', s.deps, 'none'),
      bar('Code structure', s.code, 'off')),
    h('dl', { class: 'facts' },
      fact('Stars', fmt(raw.meta.stargazers_count)),
      fact('Forks', fmt(raw.meta.forks_count)),
      fact('Main language', raw.meta.language ?? 'n/a'),
      fact('Last push', ago(act.daysSincePush)),
      fact('Latest release', act.lastRelease ? `${act.lastRelease.tag}, ${ago(act.lastRelease.days)}` : 'none'),
      fact('License', raw.meta.license?.spdx_id && raw.meta.license.spdx_id !== 'NOASSERTION' ? raw.meta.license.spdx_id : raw.meta.license ? 'custom' : 'none')),
    s.code == null && h('p', { class: 'note' }, 'Code structure joins the score once you run Repo Pilot from the Architecture tab.'),
    h('div', { class: 'actions' }, h('button', { onclick: () => analyze(current, { force: true }) }, 'Refresh'),
      h('span', { class: 'sub' }, scannedAgo(raw.fetchedAt))),
  ];
}
const scannedAgo = t => { const m = Math.floor((Date.now() - t) / 60000); return m < 1 ? 'Scanned just now' : `Scanned ${m} min ago`; };
const fact = (dt, dd) => h('div', {}, h('dt', {}, dt), h('dd', {}, dd));

function activityTab() {
  const a = view.act;
  const busText = !a.bus ? 'GitHub is still computing contributor stats. Refresh in a minute.'
    : a.bus.value === 0 ? 'No commits in the last year.'
    : `${a.bus.value} ${a.bus.value === 1 ? 'person makes' : 'people make'} half of the last year's commits, out of ${a.bus.activeAuthors} active.`;
  return [
    h('dl', { class: 'facts' },
      fact('Commits, last 90 days', fmt(a.commits90)),
      fact('PRs merged, last 90 days', a.merged90 >= 100 ? '100+' : fmt(a.merged90)),
      fact('Open pull requests', fmt(a.openPRs)),
      fact('Open issues', fmt(a.openIssues)),
      fact('Issues idle 90+ days', fmt(a.staleIssues)),
      fact('Bus factor', a.bus ? String(a.bus.value) : 'n/a')),
    h('h2', {}, 'Who keeps it moving'),
    h('p', { class: 'sub' }, busText),
    a.bus?.top.length ? h('ul', { class: 'plain' }, a.bus.top.map(c => h('li', {},
      h('div', { class: 'grow' },
        h('a', { href: `https://github.com/${encodeURIComponent(c.login)}`, target: '_blank', rel: 'noopener' }, c.login),
        h('div', { class: 'share' }, h('i', { style: `width:${(100 * c.commits / a.bus.total).toFixed(1)}%` }))),
      h('span', { class: 'sub' }, `${c.commits} commits`)))) : null,
  ];
}

function healthTab() {
  const { hyg } = view;
  const p = pilot.get(key(current));
  const mark = ok => h('span', { class: `mark ${ok === null ? 'na' : ok ? 'ok' : 'no'}`, 'aria-label': ok === null ? 'unknown' : ok ? 'present' : 'missing' }, ok === null ? '?' : ok ? '✓' : '✗');
  return [
    h('h2', {}, `Project hygiene: ${hyg.score}/100`),
    h('ul', { class: 'plain' }, hyg.checks.map(c => h('li', {}, mark(c.ok),
      h('div', { class: 'grow' }, c.label, c.note && h('div', { class: 'sub' }, c.note))))),
    view.raw.treeTruncated && h('p', { class: 'note' }, 'This repo is very large, so GitHub returned a partial file list. Some checks may read as missing.'),
    h('h2', {}, 'Code structure'),
    p?.health ? codeHealth(p.health) : pilotPrompt('Grade circular imports, hub modules, untested modules and dead code with Repo Pilot.'),
  ];
}

function codeHealth(r) {
  const order = ['critical', 'high', 'medium', 'moderate', 'low', 'info'];
  const findings = [...r.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return [
    h('p', {}, r.score != null ? `${r.score}/100${r.grade ? ` (grade ${r.grade})` : ''}. ` : '', r.summary),
    r.nextStep && h('p', { class: 'sub' }, r.nextStep),
    findings.length ? h('ul', { class: 'plain' }, findings.slice(0, 40).map(f => h('li', {},
      h('span', { class: `sev ${f.severity}` }, f.severity),
      h('div', { class: 'grow' }, f.title, f.file && h('div', { class: 'sub' }, fileLink(f.file)))))) : h('p', { class: 'sub' }, 'No findings.'),
  ];
}

function fileLink(path) {
  const { meta } = view.raw;
  return h('a', { href: `${meta.html_url}/blob/${encodeURIComponent(meta.default_branch)}/${path.split('/').map(encodeURIComponent).join('/')}`, target: '_blank', rel: 'noopener' }, path);
}

function depsTab() {
  const d = view.deps;
  if (!d.manifests.length) return h('p', { class: 'empty' }, 'No package.json, package-lock.json, requirements.txt or go.mod found.');
  const order = ['CRITICAL', 'HIGH', 'MODERATE', 'MEDIUM', 'LOW', 'UNKNOWN'];
  const vulns = [...d.vulns].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const approx = d.packages.some(p => p.approx);
  return [
    h('h2', {}, vulns.length ? `${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y' : 'ies'}` : 'No known vulnerabilities'),
    h('p', { class: 'sub' }, `Checked ${d.packages.length} direct dependencies against OSV.dev, from ${d.manifests.join(', ')}.`),
    vulns.length ? h('ul', { class: 'plain' }, vulns.map(v => h('li', {},
      h('span', { class: `sev ${v.severity.toLowerCase()}` }, v.severity.toLowerCase()),
      h('div', { class: 'grow' },
        h('div', {}, `${v.pkg.name} ${v.pkg.version}`),
        h('div', { class: 'sub' }, v.summary || 'No summary', ' ', h('a', { href: `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`, target: '_blank', rel: 'noopener' }, v.id)))))) : null,
    approx && h('p', { class: 'note' }, 'Some versions come from package.json ranges rather than a lockfile, so they are the lowest allowed version and may over-report.'),
    d.errors.length ? h('p', { class: 'note' }, `Could not read: ${d.errors.join('; ')}`) : null,
  ];
}

// ---------- Repo Pilot ----------

// The built-in diagram: download the source once, parse imports locally, no backend needed.
async function buildArch() {
  const target = current, k = key(target), { meta } = view.raw;
  arch.set(k, { status: 'running' });
  try {
    if (meta.size > MAX_REPO_KB) throw new Error(`This repo is over ${MAX_REPO_KB / 1000} MB, too big to parse in the browser. Repo Pilot can still draw it.`);
    const files = await fetchSources(target.owner, target.repo, meta.default_branch, isSource);
    const graph = buildGraph(files);
    arch.set(k, { status: 'done', graph, ...toMermaid(graph), hubs: hubs(graph) });
  } catch (e) {
    arch.set(k, { status: 'error', error: e.message });
  }
  if (current && key(current) === k && tab === 'arch') render();
}

function archTab() {
  const k = key(current);
  const p = pilot.get(k);
  if (p?.diagram?.mermaid) return [diagramView(p.diagram.mermaid), h('p', { class: 'note' }, p.diagram.aggregated ? 'Drawn by Repo Pilot at folder level.' : 'Drawn by Repo Pilot.')];

  const a = arch.get(k);
  if (!a) buildArch();
  if (!a || a.status === 'running') return h('p', { class: 'empty' }, h('span', { class: 'spin' }), ' Downloading the source and parsing imports…');
  if (a.status === 'error') return [h('p', { class: 'error' }, a.error), h('div', { class: 'actions' }, h('button', { onclick: () => { arch.delete(k); render(); } }, 'Try again')), pilotOptional()];

  const files = a.graph.nodes.length;
  if (!a.mermaid) {
    return [h('p', { class: 'empty' }, files
      ? `Parsed ${files} source files but found no imports between them.`
      : 'No JavaScript, TypeScript, Python or Dart source found.'), pilotOptional()];
  }
  return [
    h('p', { class: 'sub' }, `${a.graph.edges.length} imports between ${a.shown} ${a.level === 'folder' ? 'folders' : 'files'}, parsed from ${files} source files.`
      + (a.level === 'folder' ? ' Large repo, so files are grouped by folder; edge labels count the imports.' : '')),
    diagramView(a.mermaid),
    a.hubs.length && h('h2', {}, 'Most imported files'),
    a.hubs.length && h('ul', { class: 'plain' }, a.hubs.map(x => h('li', {}, h('div', { class: 'grow' }, fileLink(x.path)), h('span', { class: 'sub' }, `${x.count} importers`)))),
    h('p', { class: 'note' }, 'Every arrow is an import statement found in the code. Imports resolved through custom path aliases or build config may be missing.'),
    pilotOptional(),
  ];
}

function diagramView(code) {
  let scale = 1;
  const box = h('div', { class: 'diagram' }, h('span', { class: 'spin' }));
  const zoom = f => { scale = Math.min(3, Math.max(0.2, scale * f)); box.style.transform = `scale(${scale})`; };
  renderMermaid(box, code);
  return [
    h('div', { class: 'actions' },
      h('button', { onclick: () => zoom(1.25), 'aria-label': 'Zoom in' }, '+'),
      h('button', { onclick: () => zoom(0.8), 'aria-label': 'Zoom out' }, '−'),
      h('button', { onclick: () => { scale = 1; zoom(1); } }, 'Reset')),
    h('div', { class: 'diagram-wrap' }, box),
  ];
}

// Shown only when a Repo Pilot backend is configured; otherwise nothing.
function pilotOptional() {
  const wrap = h('div', {});
  loadSettings().then(({ repoPilotUrl }) => { if (repoPilotUrl) wrap.replaceChildren(pilotPrompt('Repo Pilot can also draw this, with nested folders and support for more languages.')); });
  return wrap;
}

let mermaidReady = false;
async function renderMermaid(box, code) {
  try {
    if (!mermaidReady) {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', maxTextSize: 500000, maxEdges: 5000 });
      mermaidReady = true;
    }
    const { svg } = await window.mermaid.render(`rr-${Date.now()}`, code);
    box.innerHTML = svg; // Mermaid output, sanitized by its strict security level
  } catch (e) {
    box.replaceChildren(h('p', { class: 'error' }, `Could not draw the diagram: ${e.message ?? e}`));
  }
}

function pilotPrompt(why) {
  const p = pilot.get(key(current));
  const wrap = h('div', {});
  loadSettings().then(({ repoPilotUrl }) => {
    if (!repoPilotUrl) {
      wrap.replaceChildren(h('p', { class: 'sub' }, why),
        h('p', {}, 'Add your Repo Pilot backend URL in ', h('a', { href: '#', onclick: e => { e.preventDefault(); chrome.runtime.openOptionsPage(); } }, 'Settings'), ' to turn this on.'));
      return;
    }
    wrap.replaceChildren(
      h('p', { class: 'sub' }, why),
      p?.status === 'running'
        ? h('p', {}, h('span', { class: 'spin' }), ' Repo Pilot is indexing this repo. Big repos take a minute or two.')
        : h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: runPilot }, 'Run Repo Pilot')),
      p?.error && h('p', { class: 'error' }, p.error));
  });
  return wrap;
}

async function runPilot() {
  const target = current, k = key(target);
  const repoUrl = `https://github.com/${target.owner}/${target.repo}`;
  pilot.set(k, { status: 'running' });
  render();
  const { repoPilotUrl, repoPilotEndpoints } = await loadSettings();
  const rp = makeRepoPilot(repoPilotUrl, repoPilotEndpoints);
  const entry = { status: 'done' };
  try {
    await rp.ingest(repoUrl);
    const [diagram, health] = await Promise.allSettled([rp.diagram(repoUrl), rp.codeHealth(repoUrl)]);
    if (diagram.status === 'fulfilled') entry.diagram = diagram.value;
    if (health.status === 'fulfilled') entry.health = health.value;
    const errs = [diagram, health].filter(r => r.status === 'rejected').map(r => r.reason.message);
    if (errs.length) entry.error = errs.join(' ');
  } catch (e) {
    entry.error = e.message.includes('Failed to fetch') ? `Could not reach Repo Pilot at ${repoPilotUrl}. Is it running?` : e.message;
  }
  pilot.set(k, entry);
  if (current && key(current) === k) render();
}

// ---------- wiring ----------

document.getElementById('picker').addEventListener('submit', e => {
  e.preventDefault();
  const t = parseRepo(input.value);
  if (t) analyze(t);
  else main.replaceChildren(h('p', { class: 'error' }, 'That is not a GitHub repository link. Try github.com/owner/repo.'));
});
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// Follow the active tab: switching to another repo re-targets the panel.
async function followActiveTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  const target = parseRepo(t?.url);
  if (target && (!current || key(target) !== key(current))) analyze(target);
}
chrome.tabs.onActivated.addListener(followActiveTab);
chrome.tabs.onUpdated.addListener((_, info, t) => { if (info.url && t.active) followActiveTab(); });
followActiveTab();
