// Runs the real panel.html + panel.js in jsdom with chrome.* and fetch faked,
// so the side panel is exercised end to end without a browser or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

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
  if (u.pathname === '/v1/querybatch') {
    const { queries } = JSON.parse(opts.body);
    return json({ results: queries.map(q => (q.package.name === 'django' ? { vulns: [{ id: 'GHSA-aaaa' }, { id: 'PYSEC-1' }] } : {})) });
  }
  if (u.pathname === '/v1/vulns/GHSA-aaaa') return json({ id: 'GHSA-aaaa', summary: 'SQL injection <script>', aliases: ['CVE-1'], database_specific: { severity: 'HIGH' } });
  if (u.pathname === '/v1/vulns/PYSEC-1') return json({ id: 'PYSEC-1', aliases: ['CVE-1'] }); // same flaw, should be de-duplicated
  // Repo Pilot backend
  if (u.pathname === '/api/ingest') return json({ ok: true });
  if (u.pathname === '/api/diagram') return json({ mermaid: 'flowchart LR\n a-->b' });
  if (u.pathname === '/api/code-health') return json({ score: 64, grade: 'C', summary: 'Some structural debt.', findings: [{ title: 'Circular import', severity: 'high', file: 'app/main.py' }] });
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
      storage: { local: {
        get: async keys => Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]])),
        set: async o => Object.assign(store, JSON.parse(JSON.stringify(o))),
      } },
      tabs: { query: async () => [{ url: 'https://github.com/acme/widget/pulls' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
      runtime: { openOptionsPage() {} },
    },
  });
  dom.window.mermaid = { initialize() {}, render: async () => ({ svg: '<svg id="drawn"></svg>' }) };
  await import(`../src/panel/panel.js?${Math.random()}`);
  return { doc: dom.window.document, store };
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

  tabBtn(doc, 'Health').click();
  assert.match(main.textContent, /1\/2 checks passing/);

  tabBtn(doc, 'Dependencies').click();
  assert.match(main.textContent, /1 known vulnerability/);
  assert.equal(doc.querySelectorAll('.sev.high').length, 1);
  assert.ok(!doc.querySelector('script'), 'vulnerability summary is not injected as HTML');
});

test('Repo Pilot fills Architecture and adds code structure to the score', async () => {
  const { doc, store } = await boot();
  store.repoPilotUrl = 'http://localhost:8000';
  await until(() => doc.querySelector('.grade'));
  const before = doc.querySelector('.score-line').textContent;

  tabBtn(doc, 'Architecture').click();
  (await until(() => [...doc.querySelectorAll('button')].find(b => b.textContent === 'Run Repo Pilot'))).click();
  await until(() => doc.getElementById('drawn'));

  tabBtn(doc, 'Health').click();
  assert.match(doc.getElementById('main').textContent, /64\/100 \(grade C\)/);
  assert.match(doc.getElementById('main').textContent, /Circular import/);
  assert.notEqual(doc.querySelector('.score-line').textContent, before, 'overall score now includes code structure');
});
