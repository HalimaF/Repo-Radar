// Dependencies -> OSV.dev vulnerability lookup, plus licence and latest version from deps.dev.
// Covers npm, PyPI, Go, Cargo, Maven/Gradle, RubyGems and Composer.
const MANIFESTS = /(^|\/)(package-lock\.json|package\.json|requirements\.txt|go\.mod|Cargo\.lock|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile\.lock|composer\.lock|composer\.json|poetry\.lock|pyproject\.toml)$/;
const LOCK_OF = new Map([['package.json', 'package-lock.json'], ['composer.json', 'composer.lock'], ['pyproject.toml', 'poetry.lock'], ['Cargo.toml', 'Cargo.lock']]);
const MAX_MANIFESTS = 6;

/** Manifest paths to read, shallowest first, skipping vendored and example folders. */
export function pickManifests(paths) {
  const found = paths.filter(p => MANIFESTS.test(p) && !/(^|\/)(node_modules|vendor|examples?|fixtures?|test|tests)\//.test(p));
  // A manifest whose sibling lockfile exists is covered by the lockfile, which has exact versions.
  const set = new Set(found);
  return found
    .filter(p => { const dir = p.slice(0, p.lastIndexOf('/') + 1), lock = LOCK_OF.get(p.slice(dir.length)); return !(lock && set.has(dir + lock)); })
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, MAX_MANIFESTS);
}

const clean = v => (v || '').replace(/^[\^~>=<v\s]+/, '').split(/\s|\|\||,/)[0];
const pad = v => v + '.0'.repeat(Math.max(0, 3 - v.split('.').length)); // Cargo writes "1" or "1.2" for 1.0.0 / 1.2.0

// [dependencies]-style TOML tables (Cargo, Poetry): name = "1.2" or name = { version = "1.2" }.
function tomlDeps(text) {
  const out = [];
  for (const section of text.split(/^\[/m).slice(1)) {
    if (!/^[^\]\n]*dependencies\]/.test(section)) continue;
    for (const m of section.matchAll(/^([\w.-]+)\s*=\s*(?:"([^"]+)"|\{[^}\n]*?\bversion\s*=\s*"([^"]+)")/gm)) out.push([m[1], m[2] ?? m[3]]);
  }
  return out;
}

/** Returns [{ name, version, ecosystem, approx, source }] for one manifest's dependencies. */
export function parseManifest(path, text) {
  const out = [];
  const file = path.split('/').pop();
  const add = (name, version, ecosystem, approx = false) => {
    if (name && version && /^\d[\w.+-]*$/.test(version)) out.push({ name, version, ecosystem, approx, source: path });
  };
  if (file === 'Cargo.lock') { // packages without a registry source are the repo's own crates
    for (const m of text.matchAll(/\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"\r?\nsource = "registry/g)) add(m[1], m[2], 'crates.io');
  } else if (file === 'Cargo.toml') {
    for (const [n, v] of tomlDeps(text)) add(n, pad(clean(v)), 'crates.io', true);
  } else if (file === 'poetry.lock') {
    for (const m of text.matchAll(/\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g)) add(m[1], m[2], 'PyPI');
  } else if (file === 'pyproject.toml') {
    for (const m of text.matchAll(/["']([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:==|>=|~=)\s*(\d[^"',;\s]*)/g)) add(m[1], m[2], 'PyPI', true); // PEP 621 lists
    for (const [n, v] of tomlDeps(text)) if (n !== 'python') add(n, clean(v), 'PyPI', true); // Poetry tables
  } else if (file === 'pom.xml') {
    const tag = (xml, t) => new RegExp(`<${t}>\\s*([^<\\s]+)\\s*</${t}>`).exec(xml)?.[1];
    for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const version = (tag(m[1], 'version') ?? '').replace(/^\$\{([\w.-]+)\}$/, (_, k) => tag(text, k.replace(/\./g, '\\.')) ?? ''); // ${x.version} from <properties>
      add(tag(m[1], 'groupId') && `${tag(m[1], 'groupId')}:${tag(m[1], 'artifactId')}`, version, 'Maven');
    }
  } else if (/^build\.gradle/.test(file)) {
    for (const m of text.matchAll(/\b(?:implementation|api|compile|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*['"]([\w.-]+:[\w.-]+):([\w.+-]+)['"]/g)) add(m[1], m[2], 'Maven');
  } else if (file === 'Gemfile.lock') { // versions sit under "specs:", the direct ones are named under DEPENDENCIES
    const specs = new Map([...text.matchAll(/^ {4}(\S+) \(([^)]+)\)\r?$/gm)].map(m => [m[1], m[2]]));
    const direct = text.split(/^DEPENDENCIES\r?$/m)[1]?.split(/^\S/m)[0] ?? '';
    for (const m of direct.matchAll(/^ {2}([\w.-]+)/gm)) add(m[1], specs.get(m[1]), 'RubyGems');
  } else if (file === 'composer.lock') {
    const lock = JSON.parse(text);
    for (const p of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) add(p.name, clean(p.version), 'Packagist');
  } else if (file === 'composer.json') {
    const pkg = JSON.parse(text);
    for (const [n, v] of Object.entries({ ...pkg.require, ...pkg['require-dev'] })) if (n.includes('/')) add(n, clean(v), 'Packagist', true); // no "/" means php or an extension
  } else if (path.endsWith('package-lock.json')) {
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

const DEPS_DEV = new Map([['npm', 'npm'], ['PyPI', 'pypi'], ['Go', 'go'], ['Maven', 'maven'], ['crates.io', 'cargo'], ['RubyGems', 'rubygems']]);
const MAX_ENRICH = 30; // two requests per package

/** Adds { latest, license } from deps.dev to the first packages. Best effort: a failed lookup leaves them null. */
async function enrich(packages, fetchImpl) {
  const get = async url => { try { const r = await fetchImpl(url); return r.ok ? await r.json() : null; } catch { return null; } };
  await Promise.all(packages.filter(d => DEPS_DEV.has(d.ecosystem)).slice(0, MAX_ENRICH).map(async d => {
    const base = `https://api.deps.dev/v3/systems/${DEPS_DEV.get(d.ecosystem)}/packages/${encodeURIComponent(d.name)}`;
    const [pkg, ver] = await Promise.all([get(base), get(`${base}/versions/${encodeURIComponent((d.ecosystem === 'Go' ? 'v' : '') + d.version)}`)]);
    const latest = Array.isArray(pkg?.versions) ? pkg.versions.find(v => v.isDefault)?.versionKey?.version : null;
    d.latest = typeof latest === 'string' ? latest.replace(/^v/, '') : null;
    d.license = Array.isArray(ver?.licenses) ? ver.licenses.join(', ') : null;
  }));
}

/** Packages two or more major versions behind the latest release. */
export const outdated = packages => packages.filter(d => d.latest && parseInt(d.latest, 10) - parseInt(d.version, 10) >= 2);
/** Packages under a GPL-family licence (GPL, AGPL, SSPL; not the weaker LGPL). */
export const copyleft = packages => packages.filter(d => /(^|[^L])GPL|SSPL/.test(d.license ?? ''));

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

  const enriching = enrich(uniq, fetchImpl); // runs alongside the OSV lookups
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
  await enriching;
  return { manifests, packages: uniq, vulns: deduped, errors };
}
