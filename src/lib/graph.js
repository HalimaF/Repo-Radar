// Import graph parsed from source text. No LLM: every edge is an import statement in the code.
// shortcut: JS/TS (+Vue/Svelte), Python and Dart only; add Go/Java/Rust parsers when users ask.
const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
export const SOURCE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|py|dart)$/;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.next|out|coverage|site-packages|\.venv|venv|__pycache__|\.dart_tool)\//;
const SKIP_FILE = /\.(min|bundle)\.js$|\.d\.ts$|\.g\.dart$|\.freezed\.dart$/;

export const isSource = p => (SOURCE.test(p) && !SKIP.test(p) && !SKIP_FILE.test(p)) || /(^|\/)pubspec\.yaml$/.test(p);

const dirname = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function join(dir, rel) {
  const out = dir ? dir.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function jsSpecs(text) {
  const specs = [];
  for (const re of [/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g, /import\s*['"]([^'"]+)['"]/g, /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g])
    for (const m of text.matchAll(re)) specs.push(m[1]);
  return specs;
}

function resolveJs(from, spec, has) {
  let base;
  if (spec.startsWith('.')) base = join(dirname(from), spec);
  else if (/^[@~]\//.test(spec)) base = join('src', spec.slice(2)); // common "@/..." alias for src/
  else if (spec.startsWith('/')) base = spec.slice(1);
  else return null; // a package from npm, not a file in this repo
  const stem = base.replace(/\.(js|jsx|mjs)$/, ''); // TS projects import "./x.js" meaning x.ts
  const tries = [base, ...JS_EXT.map(e => stem + e), ...JS_EXT.map(e => `${base}/index${e}`)];
  return tries.find(has) ?? null;
}

const PY_ROOTS = ['', 'src/', 'lib/'];
function resolvePy(from, text, has) {
  const out = [];
  const mod = (dotted, dir = null) => {
    const rel = dotted.replace(/\./g, '/');
    for (const root of dir != null ? [dir ? `${dir}/` : ''] : PY_ROOTS) {
      for (const c of [`${root}${rel}.py`, `${root}${rel}/__init__.py`]) if (rel && has(c)) return c;
    }
    return null;
  };
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm))
    for (const name of m[1].split(',')) { const r = mod(name.trim()); if (r) out.push(r); }
  // Names may span lines only inside parentheses.
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n#]+))/gm)) {
    const [, dots, pkg] = m, names = m[3] ?? m[4];
    let dir = null;
    if (dots) { dir = dirname(from); for (let i = 1; i < dots.length; i++) dir = dirname(dir); }
    const subs = names.split(',').map(s => s.trim().split(/\s+/)[0]).filter(n => n && n !== '*');
    // "from pkg import name" may name a submodule (pkg/name.py) or a symbol inside pkg.
    let hit = false;
    for (const s of subs) { const r = mod(pkg ? `${pkg}.${s}` : s, dir); if (r) { out.push(r); hit = true; } }
    if (!hit && pkg) { const r = mod(pkg, dir); if (r) out.push(r); }
  }
  return out;
}

function resolveDart(from, text, has, packages) {
  const out = [];
  for (const m of text.matchAll(/^[ \t]*(?:import|export|part)[ \t]+['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    let p = null;
    const pkg = /^package:([\w]+)\/(.+)$/.exec(spec);
    if (pkg) p = packages[pkg[1]] != null ? join(packages[pkg[1]], `lib/${pkg[2]}`) : null;
    else if (!spec.startsWith('dart:')) p = join(dirname(from), spec);
    if (p && has(p)) out.push(p);
  }
  return out;
}

/** files: { path: text } -> { nodes: [path], edges: [[from, to]] } (deduplicated, no self-loops). */
export function buildGraph(files) {
  const paths = Object.keys(files).filter(p => SOURCE.test(p));
  const set = new Set(paths);
  const has = p => set.has(p);
  const packages = {}; // Dart: pubspec "name:" -> folder holding its lib/
  for (const [p, text] of Object.entries(files)) {
    const m = /(^|\/)pubspec\.yaml$/.test(p) && /^name:\s*([\w]+)/m.exec(text);
    if (m) packages[m[1]] = dirname(p);
  }
  const edges = new Set();
  for (const from of paths) {
    const text = files[from];
    let targets;
    if (from.endsWith('.py')) targets = resolvePy(from, text, has);
    else if (from.endsWith('.dart')) targets = resolveDart(from, text, has, packages);
    else targets = jsSpecs(text).map(s => resolveJs(from, s, has));
    for (const to of targets) if (to && to !== from) edges.add(`${from}\n${to}`);
  }
  return { nodes: paths, edges: [...edges].map(e => e.split('\n')) };
}

/** Files ranked by how many other files import them. */
export function hubs(graph, n = 5) {
  const inDeg = {};
  for (const [, to] of graph.edges) inDeg[to] = (inDeg[to] ?? 0) + 1;
  return Object.entries(inDeg).sort((a, b) => b[1] - a[1]).slice(0, n).map(([path, count]) => ({ path, count }));
}

const esc = s => s.replace(/"/g, '#quot;').replace(/[<>]/g, '');

/**
 * Mermaid flowchart. Small graphs are drawn per file, grouped in folder boxes; large ones
 * collapse to folders (as shallow as needed to fit), with edge labels counting the imports merged.
 */
export function toMermaid(graph, maxNodes = 60) {
  const linked = new Set(graph.edges.flat());
  if (!linked.size) return { mermaid: null, level: 'none', shown: 0 };

  if (linked.size <= maxNodes) {
    const id = new Map([...linked].map((p, i) => [p, `n${i}`]));
    const byDir = {};
    for (const p of linked) (byDir[dirname(p)] ??= []).push(p);
    const lines = ['flowchart LR'];
    Object.entries(byDir).forEach(([dir, ps], i) => {
      if (dir) lines.push(`  subgraph d${i}["${esc(dir)}"]`);
      for (const p of ps) lines.push(`    ${id.get(p)}["${esc(p.split('/').pop())}"]`);
      if (dir) lines.push('  end');
    });
    for (const [a, b] of graph.edges) lines.push(`  ${id.get(a)} --> ${id.get(b)}`);
    return { mermaid: lines.join('\n'), level: 'file', shown: linked.size };
  }

  for (const depth of [3, 2, 1]) {
    const folder = p => dirname(p).split('/').filter(Boolean).slice(0, depth).join('/') || '(root)';
    const folders = new Set([...linked].map(folder));
    if (folders.size > maxNodes && depth > 1) continue;
    const id = new Map([...folders].map((f, i) => [f, `f${i}`]));
    const weight = {};
    for (const [a, b] of graph.edges) {
      const fa = folder(a), fb = folder(b);
      if (fa !== fb) weight[`${fa}\n${fb}`] = (weight[`${fa}\n${fb}`] ?? 0) + 1;
    }
    const lines = ['flowchart LR', ...[...folders].map(f => `  ${id.get(f)}["${esc(f)}/"]`)];
    for (const [k, w] of Object.entries(weight)) {
      const [a, b] = k.split('\n');
      lines.push(`  ${id.get(a)} -->|${w}| ${id.get(b)}`);
    }
    return { mermaid: lines.join('\n'), level: 'folder', shown: folders.size };
  }
}
