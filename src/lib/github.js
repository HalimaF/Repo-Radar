const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Minimal GitHub REST client. `token` is optional (60 req/h without, 5000 with). */
export function makeGitHub(token, fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function get(path, { allow404 = false } = {}) {
    const res = await fetchImpl(API + path, { headers });
    if (res.status === 404 && allow404) return { data: null, res };
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        throw new GitHubError('GitHub rate limit reached. Add a token in Repo Radar settings.', res.status);
      }
    }
    if (!res.ok && res.status !== 202) throw new GitHubError(`GitHub ${res.status} on ${path}`, res.status);
    return { data: res.status === 202 || res.status === 204 ? null : await res.json(), res };
  }

  // /stats/* answers 202 while GitHub computes; retry a few times, then give up quietly.
  async function stats(path) {
    for (let i = 0; i < 4; i++) {
      const { data, res } = await get(path);
      if (res.status !== 202) return data;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
    return null;
  }

  // Count items in a list endpoint with one request, using the Link header's last page.
  async function count(path) {
    const sep = path.includes('?') ? '&' : '?';
    const { data, res } = await get(`${path}${sep}per_page=1`);
    const last = /[?&]page=(\d+)>; rel="last"/.exec(res.headers.get('link') || '');
    return last ? Number(last[1]) : (data?.length ?? 0);
  }

  return { get: async (p, o) => (await get(p, o)).data, stats, count };
}
