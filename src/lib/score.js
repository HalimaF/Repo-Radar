// Pure scoring: no network, no LLM. Every number shown in the panel comes from here.
const DAY = 86400000;
const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
const daysSince = (iso, now) => (iso ? (now - Date.parse(iso)) / DAY : Infinity);

/** Fewest authors who together made at least half the commits in the last 52 weeks. */
export function busFactor(contributors, now = Date.now()) {
  if (!Array.isArray(contributors) || !contributors.length) return null;
  const cutoff = (now - 365 * DAY) / 1000;
  const recent = contributors
    .map(c => ({ login: c.author?.login ?? 'unknown', commits: (c.weeks ?? []).filter(w => w.w >= cutoff).reduce((s, w) => s + w.c, 0) }))
    .filter(c => c.commits > 0)
    .sort((a, b) => b.commits - a.commits);
  const total = recent.reduce((s, c) => s + c.commits, 0);
  if (!total) return { value: 0, top: [], total: 0 };
  let acc = 0, value = 0;
  for (const c of recent) { acc += c.commits; value++; if (acc * 2 >= total) break; }
  return { value, top: recent.slice(0, 5), total, activeAuthors: recent.length };
}

export function activity(raw, now = Date.now()) {
  const weeks = raw.commitActivity ?? [];
  const commits90 = weeks.slice(-13).reduce((s, w) => s + w.total, 0);
  const merged90 = (raw.closedPRs ?? []).filter(p => p.merged_at && daysSince(p.merged_at, now) <= 90).length;
  const lastRelease = raw.releases?.[0] ?? null;
  const openIssues = raw.openPRs == null ? null : Math.max(0, raw.meta.open_issues_count - raw.openPRs);
  return {
    weekly: weeks.map(w => w.total),
    commits90,
    merged90,
    openPRs: raw.openPRs,
    openIssues,
    staleIssues: raw.staleIssues,
    daysSincePush: Math.floor(daysSince(raw.meta.pushed_at, now)),
    lastRelease: lastRelease && { tag: lastRelease.tag_name, days: Math.floor(daysSince(lastRelease.published_at, now)) },
    bus: busFactor(raw.contributors, now),
    archived: !!raw.meta.archived,
  };
}

export function activityScore(a) {
  if (a.archived) return 0;
  const d = a.daysSincePush;
  const recency = d <= 7 ? 100 : d <= 30 ? 80 : d <= 90 ? 55 : d <= 180 ? 30 : d <= 365 ? 10 : 0;
  const commits = Math.min(100, 25 * Math.log2(1 + a.commits90)); // 15 commits/quarter = 100
  const parts = [recency, commits];
  if (a.bus) parts.push({ 0: 0, 1: 30, 2: 60, 3: 80, 4: 80 }[a.bus.value] ?? 100);
  if (a.openIssues && a.staleIssues != null) parts.push(100 * (1 - Math.min(1, a.staleIssues / a.openIssues)));
  return clamp(parts.reduce((s, x) => s + x, 0) / parts.length);
}

const has = (paths, re) => paths.some(p => re.test(p));

export function hygiene(raw) {
  const p = raw.paths, files = raw.community?.files ?? {};
  const runs = raw.checkRuns;
  const failing = runs?.filter(r => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion)).length ?? 0;
  const ciPresent = has(p, /^\.github\/workflows\/.+\.ya?ml$/) || has(p, /^(\.gitlab-ci\.yml|\.circleci\/|azure-pipelines\.yml|Jenkinsfile)/);
  const checks = [
    { key: 'readme', label: 'README', ok: !!files.readme || has(p, /^readme(\.\w+)?$/i), weight: 15 },
    { key: 'license', label: 'License', ok: !!raw.meta.license || has(p, /^(licen[cs]e|copying)(\.\w+)?$/i), weight: 15 },
    { key: 'description', label: 'Repo description', ok: !!raw.meta.description, weight: 5 },
    { key: 'tests', label: 'Tests in the tree', ok: has(p, /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.\w+$|_test\.go$/i), weight: 20 },
    { key: 'ci', label: 'CI configured', ok: ciPresent, weight: 15 },
    { key: 'ciPassing', label: 'CI passing on default branch', ok: runs ? runs.length > 0 && failing === 0 : null, weight: 10,
      note: runs?.length ? `${runs.length - failing}/${runs.length} checks passing` : 'no check runs on latest commit' },
    { key: 'contributing', label: 'Contributing guide', ok: !!files.contributing || has(p, /(^|\/)contributing(\.\w+)?$/i), weight: 7 },
    { key: 'security', label: 'Security policy', ok: has(p, /(^|\/)security(\.\w+)?$/i), weight: 7 },
    { key: 'templates', label: 'Issue / PR templates', ok: !!files.issue_template || !!files.pull_request_template || has(p, /^\.github\/(ISSUE_TEMPLATE|pull_request_template)/i), weight: 6 },
  ];
  const scored = checks.filter(c => c.ok !== null);
  const total = scored.reduce((s, c) => s + c.weight, 0);
  const score = clamp(100 * scored.filter(c => c.ok).reduce((s, c) => s + c.weight, 0) / total);
  return { checks, score };
}

const SEVERITY_COST = { CRITICAL: 25, HIGH: 15, MODERATE: 8, MEDIUM: 8, LOW: 3 };
export function dependencyScore(deps) {
  if (!deps || !deps.packages.length) return null;
  const cost = deps.vulns.reduce((s, v) => s + (SEVERITY_COST[v.severity] ?? 5), 0);
  return clamp(100 - cost);
}

/** Weighted average of whichever parts are available; null parts are skipped, not zeroed. */
export function overall({ activity: a, hygiene: h, deps, code }) {
  const parts = [[a, 0.35], [h, 0.25], [deps, 0.2], [code, 0.2]].filter(([v]) => v != null);
  const w = parts.reduce((s, [, x]) => s + x, 0);
  return clamp(parts.reduce((s, [v, x]) => s + v * x, 0) / w);
}

export function grade(score) {
  return score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
}

/** One plain sentence built only from computed facts. */
export function verdict(a, h, deps) {
  if (a.archived) return 'Archived: read-only, no longer maintained.';
  const pace = a.daysSincePush <= 30 && a.commits90 >= 10 ? 'Actively developed'
    : a.daysSincePush <= 90 ? 'Moderately active'
    : a.daysSincePush <= 365 ? 'Slowing down' : 'Dormant';
  const bits = [pace];
  if (a.bus?.value === 1) bits.push('relies on one main contributor');
  const missing = h.checks.filter(c => c.ok === false && ['tests', 'ci', 'license'].includes(c.key)).map(c => c.label.toLowerCase());
  if (missing.length) bits.push(`missing ${missing.join(', ')}`);
  if (deps?.vulns.length) bits.push(`${deps.vulns.length} known vulnerable dependenc${deps.vulns.length === 1 ? 'y' : 'ies'}`);
  return bits.join(', ') + '.';
}
