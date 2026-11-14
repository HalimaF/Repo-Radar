// Gathers everything Repo Radar needs from GitHub in ~12 requests, so an unauthenticated
// user (60 req/h) can still analyse about five repos an hour.
import { makeGitHub } from './github.js';
import { scanDependencies } from './deps.js';

const DAY = 86400000;

export async function collect(gh, owner, repo, now = Date.now()) {
  const base = `/repos/${owner}/${repo}`;
  const meta = await gh.get(base);
  const branch = encodeURIComponent(meta.default_branch);
  const since90 = new Date(now - 90 * DAY).toISOString().slice(0, 10);

  const settle = p => p.then(v => v, e => { console.warn(e); return null; });
  const [commitActivity, contributors, openPRs, closedPRs, closedIssues, staleSearch, releases, community, tree, checks] =
    await Promise.all([
      settle(gh.stats(`${base}/stats/commit_activity`)),
      settle(gh.stats(`${base}/stats/contributors`)),
      settle(gh.count(`${base}/pulls?state=open`)),
      settle(gh.get(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=100`)),
      settle(gh.get(`${base}/issues?state=closed&sort=updated&direction=desc&per_page=100`)),
      settle(gh.get(`/search/issues?q=${encodeURIComponent(`repo:${owner}/${repo} is:issue is:open updated:<${since90}`)}&per_page=1`)),
      settle(gh.get(`${base}/releases?per_page=5`)),
      settle(gh.get(`${base}/community/profile`, { allow404: true })),
      settle(gh.get(`${base}/git/trees/${branch}?recursive=1`)),
      settle(gh.get(`${base}/commits/${branch}/check-runs?per_page=100`)),
    ]);

  return {
    owner, repo, meta, commitActivity, contributors, openPRs,
    // trimmed: only these fields are used, and the result is cached
    closedPRs: closedPRs?.map(p => ({ created_at: p.created_at, merged_at: p.merged_at })) ?? null,
    closedIssues: closedIssues?.filter(i => !i.pull_request).map(i => ({ created_at: i.created_at, closed_at: i.closed_at })) ?? null, // the issues list includes PRs
    staleIssues: staleSearch?.total_count ?? null,
    releases, community,
    paths: tree?.tree?.filter(t => t.type === 'blob').map(t => t.path) ?? [],
    treeTruncated: !!tree?.truncated,
    checkRuns: checks?.check_runs?.map(r => ({ name: r.name, conclusion: r.conclusion })) ?? null,
    fetchedAt: now,
  };
}

/** One full scan: GitHub facts plus the dependency check. Used by the panel and the daily watchlist check. */
export async function scanRepo(owner, repo, token) {
  const raw = await collect(makeGitHub(token), owner, repo);
  const deps = await scanDependencies(owner, repo, raw.meta.default_branch, raw.paths)
    .catch(e => ({ manifests: [], packages: [], vulns: [], errors: [e.message] }));
  return { raw, deps };
}
