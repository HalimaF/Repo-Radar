// Runs the real panel.html + panel.js in jsdom with chrome.* and fetch faked,
// so the side panel is exercised end to end without a browser or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { gzipSync } from 'node:zlib';
import { makeTar } from './helpers.js';

const now = Date.now();
const iso = daysAgo => new Date(now - daysAgo * 86400000).toISOString();
const week = n => Math.floor((now - n * 7 * 86400000) / 1000);

const routes = {
  '/repos/acme/widget': { full_name: 'acme/widget', html_url: 'https://github.com/acme/widget', description: 'Widgets <b>for</b> all', default_branch: 'main', pushed_at: iso(2), open_issues_count: 12, stargazers_count: 15400, forks_count: 320, language: 'Python', license: { spdx_id: 'MIT' }, archived: false },
  '/repos/acme/widget/stats/commit_activity': Array.from({ length: 52 }, (_, i) => ({ total: i % 3, week: week(52 - i) })),
  '/repos/acme/widget/stats/contributors': [
    { author: { login: 'alice' }, weeks: [{ w: week(2), c: 70 }] },
    { author: { login: 'bob' }, weeks: [{ w: week(3), c: 30 }] },
  ],
  '/repos/acme/widget/pulls?state=open&per_page=1': { body: [{}], link: '<https://api.github.com/x?state=open&per_page=1&page=4>; rel="last"' },
  '/repos/acme/widget/pulls?state=closed&sort=updated&direction=desc&per_page=100': [{ merged_at: iso(5) }, { merged_at: null }, { merged_at: iso(200) }],
  '/repos/acme/widget/issues?state=closed&sort=updated&direction=desc&per_page=100': [{ created_at: iso(9), closed_at: iso(7) }, { created_at: iso(9), closed_at: iso(1), pull_request: {} }],
  '/repos/acme/widget/releases?per_page=5': [{ tag_name: 'v2.1.0', published_at: iso(20) }],
  '/repos/acme/widget/community/profile': { files: { readme: {}, contributing: null } },
  '/repos/acme/widget/git/trees/main?recursive=1': { tree: ['README.md', 'requirements.txt', 'app/main.py', 'tests/test_main.py', '.github/workflows/ci.yml'].map(path => ({ path, type: 'blob' })) },
  '/repos/acme/widget/commits/main/check-runs?per_page=100': { check_runs: [{ name: 'test', conclusion: 'success' }, { name: 'lint', conclusion: 'failure' }] },
};

function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  const json = (body, status = 200, headers = {}) => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
  if (u.hostname === 'api.github.com') {
    const path = u.pathname + u.search;
    if (path.startsWith('/search/issues')) return json({ total_count: 3 });
    const r = routes[decodeURIComponent(path)];
    if (!r) return json({ message: 'Not Found' }, 404);
    return r.link ? json(r.body, 200, { link: r.link }) : json(r);
  }
  if (u.hostname === 'raw.githubusercontent.com') return json('django==3.2.0\nrequests==2.31.0\n');
  if (u.hostname === 'codeload.github.com') return Promise.resolve(new Response(gzipSync(makeTar({
    'app/main.py': 'from app import db\nfrom app.api import routes', 'app/db.py': '', 'app/api/routes.py': 'from ..db import engine',
  }))));
  if (u.pathname === '/v1/querybatch') {
    const { queries } = JSON.parse(opts.body);
    return json({ results: queries.map(q => (q.package.name === 'django' ? { vulns: [{ id: 'GHSA-aaaa' }, { id: 'PYSEC-1' }] } : {})) });
  }
  if (u.pathname === '/v1/vulns/GHSA-aaaa') return json({ id: 'GHSA-aaaa', summary: 'SQL injection <script>', aliases: ['CVE-1'], database_specific: { severity: 'HIGH' } });
  if (u.pathname === '/v1/vulns/PYSEC-1') return json({ id: 'PYSEC-1', aliases: ['CVE-1'] }); // same flaw, should be de-duplicated
  if (u.hostname === 'api.deps.dev') {
    if (u.pathname === '/v3/systems/pypi/packages/django') return json({ versions: [{ versionKey: { version: '3.2.0' } }, { versionKey: { version: '5.1.0' }, isDefault: true }] });
    if (u.pathname === '/v3/systems/pypi/packages/requests/versions/2.31.0') return json({ licenses: ['GPL-3.0'] });
    return json({}, 404);
  }
  return json({}, 404);
}

async function boot() {
  const html = readFileSync(new URL('../src/panel/panel.html', import.meta.url), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/src/panel/panel.html' });
  const store = {};
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    matchMedia: () => ({ matches: false }),
    fetch: fakeFetch,
    chrome: {
      storage: (area => ({ local: area, session: area }))({
        get: async keys => Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]])),
        set: async o => Object.assign(store, JSON.parse(JSON.stringify(o))),
      }),
      tabs: { query: async () => [{ url: 'https://github.com/acme/widget/pulls' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
      runtime: { openOptionsPage() {} },
    },
  });
  const copied = [], opened = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async t => { copied.push(t); } } } });
  dom.window.open = url => { opened.push(url); };
  // Shaped like Mermaid's output: one <g class="node"> per box, with our node id inside its element id.
  dom.window.mermaid = { initialize() {}, render: async (_, code) => ({ svg: `<svg id="drawn">${[...code.matchAll(/^\s+(n\d+)\[/gm)].map(m => `<g class="node" id="rr-1-flowchart-${m[1]}-0"></g>`).join('')}</svg>` }) };
  await import(`../src/panel/panel.js?${Math.random()}`);
  return { doc: dom.window.document, store, copied, opened, window: dom.window };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timed out waiting');
};
const tabBtn = (doc, name) => [...doc.querySelectorAll('nav button')].find(b => b.textContent === name);

test('side panel scans the active tab repo and renders every tab', async () => {
  const { doc, store } = await boot();
  const main = doc.getElementById('main');
  await until(() => doc.querySelector('.grade'));

  assert.equal(doc.querySelector('.hero-name').textContent, 'acme/widget');
  assert.ok(doc.querySelector('.sub').textContent.includes('<b>for</b>'), 'repo text is rendered as text, not HTML');
  assert.equal(doc.querySelectorAll('.strip rect').length, 52);
  assert.match(doc.querySelector('.verdict').textContent, /Actively developed|Moderately active/);
  assert.match(doc.querySelector('.verdict').textContent, /1 known vulnerable dependency/);
  assert.ok(store['cache:acme/widget'], 'scan is cached');

  tabBtn(doc, 'Activity').click();
  assert.match(main.textContent, /Open pull requests4/);
  assert.match(main.textContent, /Open issues8/);         // 12 minus 4 PRs
  assert.match(main.textContent, /Issues idle 90\+ days3/);
  assert.match(main.textContent, /1 person makes half/);
  assert.match(main.textContent, /Typical time to close an issue2 days/, 'pull requests in the issues list are left out');

  tabBtn(doc, 'Health').click();
  assert.match(main.textContent, /1\/2 checks passing/);

  tabBtn(doc, 'Dependencies').click();
  assert.match(main.textContent, /1 known vulnerability/);
  assert.equal(doc.querySelectorAll('.sev.high').length, 1);
  assert.ok(!doc.querySelector('script'), 'vulnerability summary is not injected as HTML');
});

const button = (doc, name) => [...doc.querySelectorAll('button')].find(b => b.textContent === name);

test('overview explains the score, copies a report and a badge, and keeps a watchlist', async () => {
  const { doc, store, copied } = await boot();
  const main = doc.getElementById('main');
  await until(() => doc.querySelector('.grade'));
  assert.match(main.textContent, /Where points were lost/);
  assert.match(main.textContent, /1 high vulnerabilityDependencies−15/);
  assert.match(main.textContent, /CI passing on default branch: missing or failing/);

  button(doc, 'Copy report').click();
  await until(() => copied.length === 1);
  assert.match(copied[0], /^## Repo Radar: \[acme\/widget\]\(https:\/\/github\.com\/acme\/widget\)/);
  assert.match(copied[0], /\| Known vulnerabilities \| 1 \|/);
  button(doc, 'Copy badge').click();
  await until(() => copied.length === 2);
  assert.match(copied[1], /^!\[Repo Radar grade [A-F]\]\(https:\/\/img\.shields\.io\/badge\/Repo%20Radar-[A-F]-\w+\)$/);

  button(doc, 'Watch').click();
  await until(() => button(doc, 'Stop watching'));
  assert.equal(store.watch['acme/widget'].vulns, 1);
  assert.match(main.textContent, /Watchingacme\/widgetgrade [A-F]/);
  button(doc, 'Stop watching').click();
  await until(() => button(doc, 'Watch'));
  assert.deepEqual(store.watch, {});
});

test('dependencies tab flags outdated and GPL packages; compare shows two repos side by side', async () => {
  const { doc } = await boot();
  const main = doc.getElementById('main');
  await until(() => doc.querySelector('.grade'));

  tabBtn(doc, 'Dependencies').click();
  assert.match(main.textContent, /1 far behind the latest version/);
  assert.match(main.textContent, /django 3\.2\.0latest 5\.1\.0/);
  assert.match(main.textContent, /1 under a GPL-family licence/);
  assert.match(main.textContent, /requestsGPL-3\.0/);

  tabBtn(doc, 'Compare').click();
  const form = doc.querySelector('form.row');
  form.elements.other.value = 'nobody/nothing';
  form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await until(() => /Repository not found/.test(main.textContent));

  const again = doc.querySelector('form.row');
  again.elements.other.value = 'Acme/Widget';
  again.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await until(() => doc.querySelector('table.cmp'));
  const rows = [...doc.querySelectorAll('table.cmp tbody tr')].map(r => r.textContent);
  assert.ok(rows.includes('Stars15k15k') && rows.includes('Known vulnerabilities11'));
  assert.equal(doc.querySelectorAll('td.win').length, 0, 'equal values have no winner');
});

test('diagram boxes open their file and the search fades unrelated boxes', async () => {
  const { doc, opened, window } = await boot();
  await until(() => doc.querySelector('.grade'));
  tabBtn(doc, 'Architecture').click();
  await until(() => doc.querySelectorAll('g.node').length === 3);
  await until(() => doc.querySelector('g.node').style.cursor === 'pointer');

  doc.querySelector('g.node').dispatchEvent(new window.Event('click'));
  assert.match(opened[0], /^https:\/\/github\.com\/acme\/widget\/blob\/main\/app\/\w+/);

  const find = doc.querySelector('input.find');
  find.value = 'routes';
  find.dispatchEvent(new window.Event('input'));
  assert.equal(doc.querySelectorAll('g.node.hit').length, 1);
  assert.equal(doc.querySelectorAll('g.node.dim').length, 0, 'routes.py touches both other files');
  find.value = 'zzz';
  find.dispatchEvent(new window.Event('input'));
  assert.equal(doc.querySelectorAll('g.node.dim').length, 3);
});

test('Architecture tab draws the import graph without any backend', async () => {
  const { doc } = await boot();
  await until(() => doc.querySelector('.grade'));
  tabBtn(doc, 'Architecture').click();
  await until(() => doc.getElementById('drawn'));
  const text = doc.getElementById('main').textContent;
  assert.match(text, /3 imports between 3 files, parsed from 3 source files/);
  assert.match(text, /Most imported filesapp\/db\.py2 importers/);
});
