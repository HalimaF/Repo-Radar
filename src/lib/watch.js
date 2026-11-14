// Watchlist: remember a grade per repo, re-scan daily, report what got worse.
import { scanRepo } from './collect.js';
import { summarize, overall, grade } from './score.js';

/** What is remembered about a watched repo. Repo Pilot's score is left out so the daily check compares like with like. */
export const snapshot = view => ({ grade: grade(overall(view.scores)), vulns: view.deps.vulns.length });

/** Re-scans watched repos. Returns { "owner/repo": { now, news } }, where news lists what got worse since `watch`. */
export async function checkWatchlist(watch, token, scan = scanRepo) {
  const out = {};
  // shortcut: without a token only 4 scans fit in GitHub's hourly limit, so the rest are skipped; add a token to watch more.
  for (const [name, last] of Object.entries(watch).slice(0, token ? 50 : 4)) {
    try {
      const [owner, repo] = name.split('/');
      const { raw, deps } = await scan(owner, repo, token);
      const now = snapshot(summarize(raw, deps)), news = [], more = now.vulns - last.vulns;
      if (now.grade > last.grade) news.push(`grade dropped from ${last.grade} to ${now.grade}`); // letters sort A to F
      if (more > 0) news.push(`${more} new known vulnerabilit${more === 1 ? 'y' : 'ies'}`);
      out[name] = { now, news };
    } catch (e) { console.warn(e); } // one unreachable repo must not stop the others
  }
  return out;
}
