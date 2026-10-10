// Direct dependencies -> OSV.dev vulnerability lookup.
// shortcut: only npm, PyPI (requirements.txt) and Go are parsed; add Cargo/Gem/Maven when users ask.
const MANIFESTS = /(^|\/)(package-lock\.json|package\.json|requirements\.txt|go\.mod)$/;
const MAX_MANIFESTS = 6;

/** Manifest paths to read, shallowest first, skipping vendored and example folders. */
export function pickManifests(paths) {
  const found = paths.filter(p => MANIFESTS.test(p) && !/(^|\/)(node_modules|vendor|examples?|fixtures?|test|tests)\//.test(p));
  // A package.json whose sibling lockfile exists is covered by the lockfile.
  const set = new Set(found);
  return found
    .filter(p => !(p.endsWith('package.json') && set.has(p.replace(/package\.json$/, 'package-lock.json'))))
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, MAX_MANIFESTS);
}

const clean = v => (v || '').replace(/^[\^~>=<v\s]+/, '').split(/\s|\|\|/)[0];

/** Returns [{ name, version, ecosystem, approx, source }] for one manifest's direct deps. */
export function parseManifest(path, text) {
  const out = [];
  const add = (name, version, ecosystem, approx = false) => {
    if (name && version && /^\d/.test(version)) out.push({ name, version, ecosystem, approx, source: path });
  };
  if (path.endsWith('package-lock.json')) {
    const lock = JSON.parse(text);
    const root = lock.packages?.[''] ?? {};
    const names = Object.keys({ ...root.dependencies, ...root.devDependencies });
    for (const n of names) add(n, lock.packages?.[`node_modules/${n}`]?.version ?? lock.dependencies?.[n]?.version, 'npm');
  } else if (path.endsWith('package.json')) {
    const pkg = JSON.parse(text);
    for (const [n, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) add(n, clean(v), 'npm', true);
  } else if (path.endsWith('requirements.txt')) {
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.\-\[\]]+)\s*==\s*([^\s;#]+)/.exec(line);
      if (m) add(m[1].replace(/\[.*\]/, ''), m[2], 'PyPI');
    }
  } else if (path.endsWith('go.mod')) {
    for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/[^\s]+)\s+(v[^\s]+)/gim)) add(m[1], m[2].replace(/^v/, ''), 'Go');
  }
  return out;
}

function severityOf(v) {
  const s = v.database_specific?.severity || v.affected?.[0]?.ecosystem_specific?.severity;
  return s ? String(s).toUpperCase() : 'UNKNOWN';
}

export async function scanDependencies(owner, repo, branch, paths, fetchImpl = fetch) {
  const manifests = pickManifests(paths);
  const packages = [];
  const errors = [];
  await Promise.all(manifests.map(async p => {
    try {
      const res = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${p.split('/').map(encodeURIComponent).join('/')}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      packages.push(...parseManifest(p, await res.text()));
    } catch (e) { errors.push(`${p}: ${e.message}`); }
  }));

  // De-duplicate across manifests (monorepos repeat the same packages).
  const uniq = [...new Map(packages.map(d => [`${d.ecosystem}:${d.name}@${d.version}`, d])).values()];
  if (!uniq.length) return { manifests, packages: [], vulns: [], errors };

  const vulns = [];
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    const res = await fetchImpl('https://api.osv.dev/v1/querybatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: chunk.map(d => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
    });
    if (!res.ok) { errors.push(`OSV ${res.status}`); break; }
    const { results } = await res.json();
    results.forEach((r, j) => (r.vulns ?? []).forEach(v => vulns.push({ id: v.id, pkg: chunk[j] })));
  }

  // Batch results carry only ids; fetch details for severity and a summary (capped).
  const details = new Map();
  await Promise.all([...new Set(vulns.map(v => v.id))].slice(0, 40).map(async id => {
    try { const r = await fetchImpl(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`); if (r.ok) details.set(id, await r.json()); } catch {}
  }));
  const enriched = vulns.map(v => {
    const d = details.get(v.id);
    return { ...v, severity: d ? severityOf(d) : 'UNKNOWN', summary: d?.summary ?? '', aliases: d?.aliases ?? [] };
  });
  // OSV lists the same flaw under several ids (GHSA-…, PYSEC-…, CVE-…); count it once per package.
  const seen = new Set();
  const deduped = enriched.filter(v => {
    const keys = [v.id, ...v.aliases].map(k => `${v.pkg.name}:${k}`);
    if (keys.some(k => seen.has(k))) return false;
    keys.forEach(k => seen.add(k));
    return true;
  });
  return { manifests, packages: uniq, vulns: deduped, errors };
}
