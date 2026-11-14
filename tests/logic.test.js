import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo } from '../src/lib/repoUrl.js';
import { busFactor, activity, activityScore, hygiene, dependencyScore, overall, grade, verdict, summarize, explain } from '../src/lib/score.js';
import { pickManifests, parseManifest, outdated, copyleft } from '../src/lib/deps.js';
import { checkWatchlist } from '../src/lib/watch.js';
import { deviceLogin } from '../src/lib/oauth.js';

test('commit stats that GitHub has not computed yet are skipped, not scored as zero', () => {
  const raw = { meta: { pushed_at: new Date().toISOString(), open_issues_count: 0 }, openPRs: 0, staleIssues: 0 };
  assert.equal(activityScore(activity({ ...raw, commitActivity: null })), 100);
  assert.equal(activityScore(activity({ ...raw, commitActivity: [{ total: 0 }] })), 50);
});

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
  assert.equal(parseRepo('../user'), null);
  assert.deepEqual(parseRepo('octo/.github'), { owner: 'octo', repo: '.github' });
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
  const busy = { weekly: [80], daysSincePush: 1, commits90: 80, bus: { value: 5 }, openIssues: 10, staleIssues: 0 };
  const dead = { weekly: [0], daysSincePush: 900, commits90: 0, bus: { value: 0 }, openIssues: 10, staleIssues: 10 };
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
  assert.equal(overall({ activity: 80, hygiene: 80, deps: null }), 80);
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

test('parseManifest reads Cargo, Poetry, pyproject, Maven, Gradle, RubyGems and Composer', () => {
  const read = (path, text) => parseManifest(path, text).map(d => `${d.ecosystem} ${d.name}@${d.version}${d.approx ? '~' : ''}`);
  assert.deepEqual(read('Cargo.toml', '[package]\nname = "x"\nversion = "9.9.9"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1.28", features = ["full"] }\nlocal = { path = "../l" }\n'),
    ['crates.io serde@1.0.0~', 'crates.io tokio@1.28.0~']);
  assert.deepEqual(read('Cargo.lock', '[[package]]\nname = "mine"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.190"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'),
    ['crates.io serde@1.0.190']);
  assert.deepEqual(read('poetry.lock', '[[package]]\nname = "flask"\nversion = "2.0.1"\ndescription = ""\n'), ['PyPI flask@2.0.1']);
  assert.deepEqual(read('pyproject.toml', '[project]\ndependencies = [\n  "requests>=2.28",\n  "uvicorn[standard]==0.20.0",\n]\n\n[tool.poetry.dependencies]\npython = "^3.9"\nflask = "^2.0.1"\n'),
    ['PyPI requests@2.28~', 'PyPI uvicorn@0.20.0~', 'PyPI flask@2.0.1~']);
  assert.deepEqual(read('pom.xml', '<project><properties><guava.version>31.0</guava.version></properties><dependencies>\n<dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>${guava.version}</version></dependency>\n<dependency><groupId>a</groupId><artifactId>b</artifactId></dependency></dependencies></project>'),
    ['Maven com.google.guava:guava@31.0']);
  assert.deepEqual(read('app/build.gradle.kts', 'dependencies {\n  implementation("com.squareup.okhttp3:okhttp:4.9.0")\n  testImplementation \'junit:junit:4.13\'\n}'),
    ['Maven com.squareup.okhttp3:okhttp@4.9.0', 'Maven junit:junit@4.13']);
  assert.deepEqual(read('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.3)\n    rails (6.1.0)\n      rack (>= 2.0)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rails (~> 6.1)\n\nBUNDLED WITH\n   2.2\n'),
    ['RubyGems rails@6.1.0']);
  assert.deepEqual(read('composer.lock', JSON.stringify({ packages: [{ name: 'monolog/monolog', version: 'v2.3.0' }], 'packages-dev': [] })), ['Packagist monolog/monolog@2.3.0']);
  assert.deepEqual(read('composer.json', JSON.stringify({ require: { php: '>=8.0', 'guzzlehttp/guzzle': '^7.2' } })), ['Packagist guzzlehttp/guzzle@7.2~']);
  assert.deepEqual(pickManifests(['Cargo.toml', 'Cargo.lock', 'web/composer.json', 'pyproject.toml']), ['Cargo.lock', 'pyproject.toml', 'web/composer.json']);
});

test('outdated and copyleft read the deps.dev details', () => {
  const pkgs = [{ name: 'a', version: '1.2.0', latest: '4.0.0', license: 'MIT' }, { name: 'b', version: '3.0.0', latest: '4.1.0', license: 'AGPL-3.0' }, { name: 'c', version: '1.0.0', latest: null, license: 'LGPL-2.1' }];
  assert.deepEqual(outdated(pkgs).map(p => p.name), ['a']);
  assert.deepEqual(copyleft(pkgs).map(p => p.name), ['b']);
});

test('explain lists the points each part lost, and they add up to the score', () => {
  const raw = { paths: ['README.md'], meta: { license: { spdx_id: 'MIT' }, description: 'x', pushed_at: new Date(NOW - 45 * 86400000).toISOString(), open_issues_count: 0 }, community: null, checkRuns: null,
    closedPRs: [1, 3, 10].map(d => ({ created_at: new Date(NOW - 20 * 86400000).toISOString(), merged_at: new Date(NOW - (20 - d) * 86400000).toISOString() })) };
  const v = summarize(raw, { packages: [1], vulns: [{ severity: 'HIGH' }, { severity: 'HIGH' }, { severity: 'LOW' }] });
  const why = explain(v);
  assert.deepEqual(why.deps, [{ lost: 30, why: '2 high vulnerabilities' }, { lost: 3, why: '1 low vulnerability' }]);
  assert.equal(100 - why.deps.reduce((s, x) => s + x.lost, 0), v.scores.deps);
  assert.ok(why.hygiene.some(x => /Tests in the tree/.test(x.why)));
  assert.ok(Math.abs(100 - why.hygiene.reduce((s, x) => s + x.lost, 0) - v.scores.hygiene) <= 2, 'hygiene reasons match the score, give or take rounding');
  assert.ok(why.activity.some(x => /Last push/.test(x.why)));
  assert.equal(Math.round(activity(raw, NOW).mergeDays), 3, 'median of 1, 3 and 10 days');
});

test('watchlist check reports a dropped grade and new vulnerabilities, and survives a failing repo', async () => {
  const raw = { paths: [], meta: { pushed_at: null, open_issues_count: 0 }, community: null, checkRuns: null };
  const scan = async owner => { if (owner === 'gone') throw new Error('404'); return { raw, deps: { packages: [1], vulns: [{ severity: 'LOW' }] } }; };
  const out = await checkWatchlist({ 'a/b': { grade: 'A', vulns: 0 }, 'gone/x': { grade: 'A', vulns: 0 }, 'c/d': { grade: 'F', vulns: 1 } }, 'token', scan);
  assert.deepEqual(Object.keys(out), ['a/b', 'c/d']);
  assert.equal(out['a/b'].news.length, 2);
  assert.match(out['a/b'].news.join(), /grade dropped from A to .*1 new known vulnerability/);
  assert.deepEqual(out['c/d'].news, []);
});

test('device sign-in polls until GitHub hands over a token', async () => {
  const replies = [{ device_code: 'd', user_code: 'ABCD-1234', interval: 1, expires_in: 60 }, { error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'gho_x' }];
  const calls = [], waits = [];
  const fakeFetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { json: async () => replies.shift() }; };
  let shown;
  assert.equal(await deviceLogin('cid', c => { shown = c; }, fakeFetch, async ms => { waits.push(ms); }), 'gho_x');
  assert.equal(shown, 'ABCD-1234');
  assert.deepEqual(calls[0], ['https://github.com/login/device/code', { client_id: 'cid' }], 'no scope: public data only');
  assert.deepEqual(waits, [1000, 1000, 6000], 'slow_down adds five seconds');
  await assert.rejects(deviceLogin('cid', () => {}, async () => ({ json: async () => ({ error_description: 'bad app' }) })), /bad app/);
});

