// Gathers everything Repo Radar needs from GitHub in ~11 requests, so an unauthenticated
// user (60 req/h) can still analyse about five repos an hour.
const DAY = 86400000;

export async function collect(gh, owner, repo, now = Date.now()) {
  const base = `/repos/${owner}/${repo}`;
  const meta = await gh.get(base);
  const branch = encodeURIComponent(meta.default_branch);
  const since90 = new Date(now - 90 * DAY).toISOString().slice(0, 10);

  const settle = p => p.then(v => v, e => { console.warn(e); return null; });
  const [commitActivity, contributors, openPRs, closedPRs, staleSearch, releases, community, tree, checks] =
    await Promise.all([
      settle(gh.stats(`${base}/stats/commit_activity`)),
      settle(gh.stats(`${base}/stats/contributors`)),
      settle(gh.count(`${base}/pulls?state=open`)),
      settle(gh.get(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=100`)),
      settle(gh.get(`/search/issues?q=${encodeURIComponent(`repo:${owner}/${repo} is:issue is:open updated:<${since90}`)}&per_page=1`)),
      settle(gh.get(`${base}/releases?per_page=5`)),
      settle(gh.get(`${base}/community/profile`, { allow404: true })),
      settle(gh.get(`${base}/git/trees/${branch}?recursive=1`)),
      settle(gh.get(`${base}/commits/${branch}/check-runs?per_page=100`)),
    ]);

  return {
    owner, repo, meta, commitActivity, contributors, openPRs,
    closedPRs: closedPRs?.map(p => ({ merged_at: p.merged_at })) ?? null, // trimmed: only this is used, and it's cached
    staleIssues: staleSearch?.total_count ?? null,
    releases, community,
    paths: tree?.tree?.filter(t => t.type === 'blob').map(t => t.path) ?? [],
    treeTruncated: !!tree?.truncated,
    checkRuns: checks?.check_runs?.map(r => ({ name: r.name, conclusion: r.conclusion })) ?? null,
    fetchedAt: now,
  };
}
