import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo } from '../src/lib/repoUrl.js';
import { busFactor, activityScore, hygiene, dependencyScore, overall, grade, verdict } from '../src/lib/score.js';
import { pickManifests, parseManifest } from '../src/lib/deps.js';
import { normalizeDiagram, normalizeHealth } from '../src/lib/repoPilot.js';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const weekAgo = n => Math.floor((NOW - n * 7 * 86400000) / 1000);

test('parseRepo accepts repo URLs and shorthand, rejects non-repos', () => {
  assert.deepEqual(parseRepo('https://github.com/fastapi/fastapi/tree/master/docs'), { owner: 'fastapi', repo: 'fastapi' });
  assert.deepEqual(parseRepo('github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseRepo('octo/hello-world'), { owner: 'octo', repo: 'hello-world' });
  assert.equal(parseRepo('https://github.com/settings/tokens'), null);
  assert.equal(parseRepo('https://github.com/octo'), null);
  assert.equal(parseRepo('https://gitlab.com/a/b'), null);
  assert.equal(parseRepo('https://evil.com/github.com/a/b'), null);
});

test('busFactor counts fewest authors covering half of last-year commits', () => {
  const c = (login, commits, weeksAgo = 1) => ({ author: { login }, weeks: [{ w: weekAgo(weeksAgo), c: commits }] });
  assert.equal(busFactor([c('a', 60), c('b', 30), c('c', 10)], NOW).value, 1);
  assert.equal(busFactor([c('a', 40), c('b', 35), c('c', 25)], NOW).value, 2);
  // Commits older than a year are ignored.
  assert.equal(busFactor([c('old', 1000, 60), c('a', 5), c('b', 5)], NOW).value, 1);
  assert.equal(busFactor([], NOW), null);
});

test('activityScore: archived is 0, busy repo scores high, dormant low', () => {
  assert.equal(activityScore({ archived: true }), 0);
  const busy = { daysSincePush: 1, commits90: 80, bus: { value: 5 }, openIssues: 10, staleIssues: 0 };
  const dead = { daysSincePush: 900, commits90: 0, bus: { value: 0 }, openIssues: 10, staleIssues: 10 };
  assert.equal(activityScore(busy), 100);
  assert.equal(activityScore(dead), 0);
});

test('hygiene finds files in the tree and skips unknown CI from the score', () => {
  const raw = { paths: ['README.md', 'LICENSE', 'src/app.py', 'tests/test_app.py', '.github/workflows/ci.yml'], meta: { license: null, description: 'x' }, community: null, checkRuns: null };
  const h = hygiene(raw);
  const by = Object.fromEntries(h.checks.map(c => [c.key, c.ok]));
  assert.equal(by.readme, true);
  assert.equal(by.license, true);
  assert.equal(by.tests, true);
  assert.equal(by.ci, true);
  assert.equal(by.ciPassing, null);
  assert.equal(by.security, false);
  assert.ok(h.score > 60 && h.score < 100);
});

test('dependency score, overall weighting and grades', () => {
  assert.equal(dependencyScore({ packages: [], vulns: [] }), null);
  assert.equal(dependencyScore({ packages: [1], vulns: [{ severity: 'CRITICAL' }, { severity: 'LOW' }] }), 72);
  // Missing parts are skipped, not counted as zero.
  assert.equal(overall({ activity: 80, hygiene: 80, deps: null, code: null }), 80);
  assert.equal(grade(90), 'A');
  assert.equal(grade(39), 'F');
});

test('verdict is built only from computed facts', () => {
  const a = { archived: false, daysSincePush: 3, commits90: 40, bus: { value: 1 } };
  const h = { checks: [{ key: 'tests', label: 'Tests in the tree', ok: false }] };
  assert.equal(verdict(a, h, { vulns: [{}, {}] }), 'Actively developed, relies on one main contributor, missing tests in the tree, 2 known vulnerable dependencies.');
});

test('manifests: lockfile wins over its package.json, vendored dirs skipped', () => {
  const picked = pickManifests(['package.json', 'package-lock.json', 'node_modules/x/package.json', 'api/requirements.txt', 'examples/go.mod']);
  assert.deepEqual(picked, ['package-lock.json', 'api/requirements.txt']);
});

test('parseManifest reads exact versions per ecosystem', () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '^4.17.0' } }, 'node_modules/lodash': { version: '4.17.20' } } });
  assert.deepEqual(parseManifest('package-lock.json', lock).map(d => [d.name, d.version, d.approx]), [['lodash', '4.17.20', false]]);
  const pkg = JSON.stringify({ dependencies: { express: '^4.17.1', local: 'file:../x' } });
  assert.deepEqual(parseManifest('package.json', pkg).map(d => [d.name, d.version, d.approx]), [['express', '4.17.1', true]]);
  const req = 'django==3.2.0\nrequests>=2\n# c\nuvicorn[standard]==0.20.0 ; python_version>"3"';
  assert.deepEqual(parseManifest('requirements.txt', req).map(d => [d.name, d.version]), [['django', '3.2.0'], ['uvicorn', '0.20.0']]);
  const gomod = 'module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgolang.org/x/net v0.10.0 // indirect\n)\nrequire github.com/a/b v2.0.1\n';
  assert.deepEqual(parseManifest('go.mod', gomod).map(d => [d.name, d.version]), [['github.com/gin-gonic/gin', '1.9.0'], ['golang.org/x/net', '0.10.0'], ['github.com/a/b', '2.0.1']]);
});

test('Repo Pilot responses are read tolerantly', () => {
  assert.equal(normalizeDiagram({ mermaid: 'flowchart LR' }).mermaid, 'flowchart LR');
  assert.equal(normalizeDiagram({ diagram: 'graph TD' }).mermaid, 'graph TD');
  const h = normalizeHealth({ score: 81.6, grade: 'B', findings: [{ message: 'Cycle', level: 'HIGH', path: 'a.py' }] });
  assert.deepEqual(h.findings[0], { title: 'Cycle', severity: 'high', file: 'a.py' });
  assert.equal(h.score, 82);
});
