// GitHub paths under github.com/<x> that are not repositories.
const RESERVED = new Set([
  'settings', 'orgs', 'marketplace', 'explore', 'topics', 'trending', 'notifications',
  'issues', 'pulls', 'search', 'login', 'join', 'about', 'pricing', 'features',
  'sponsors', 'collections', 'new', 'organizations', 'codespaces', 'apps', 'enterprise',
]);
const NAME = /^[A-Za-z0-9_.-]+$/;

/** Returns { owner, repo } for a github.com repo URL or "owner/repo", else null. */
export function parseRepo(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(s) && !s.includes('.com')) s = `https://github.com/${s}`;
  else if (/^(www\.)?github\.com\//i.test(s)) s = `https://${s}`;
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const [owner, rawRepo] = url.pathname.split('/').filter(Boolean);
  if (!owner || !rawRepo || RESERVED.has(owner.toLowerCase())) return null;
  const repo = rawRepo.replace(/\.git$/, '');
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  return { owner, repo };
}
