import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildGraph, toMermaid, hubs, isSource } from '../src/lib/graph.js';
import { untar, fetchSources } from '../src/lib/tarball.js';
import { makeTar } from './helpers.js';

test('untar strips the top folder, reads long pax names, filters', () => {
  const long = `src/${'deep/'.repeat(25)}x.ts`;
  const out = untar(new Uint8Array(makeTar({ 'a.py': 'print(1)', [long]: 'export {}', 'img.png': 'xx' })), isSource);
  assert.deepEqual(Object.keys(out).sort(), [long, 'a.py'].sort());
  assert.equal(out['a.py'], 'print(1)');
});

test('fetchSources gunzips and untars one download', async () => {
  const gz = gzipSync(makeTar({ 'm.js': 'x' }));
  const out = await fetchSources('acme', 'widget', 'main', () => true, async url => {
    assert.equal(url, 'https://codeload.github.com/acme/widget/tar.gz/main');
    return new Response(gz);
  });
  assert.deepEqual(out, { 'm.js': 'x' });
});

test('fetchSources refuses an archive that unpacks past the cap', async () => {
  const gz = gzipSync(makeTar({ 'big.js': 'x'.repeat(50000) }));
  await assert.rejects(fetchSources('a', 'b', 'main', () => true, async () => new Response(gz), 10000), /too big/);
});

test('folders and packages named like Object.prototype keys do not break the graph', () => {
  const g = buildGraph({
    '__proto__/a.js': `import './b.js'`, '__proto__/b.js': '',
    'lib/m.dart': `import 'package:constructor/x.dart';`,
  });
  assert.deepEqual(g.edges, [['__proto__/a.js', '__proto__/b.js']]);
  assert.match(toMermaid(g).mermaid, /__proto__/);
  assert.equal(hubs(g)[0].path, '__proto__/b.js');
});

test('JS/TS imports resolve to files, packages are ignored', () => {
  const g = buildGraph({
    'src/app.tsx': `import React from 'react';\nimport { api } from './lib/api';\nimport Btn from "@/components/Button";\nconst u = require('../util.js');\nexport * from './types.js';`,
    'src/lib/api.ts': `import axios from 'axios';\nimport cfg from '../config';`,
    'src/config/index.ts': 'export default {}',
    'src/components/Button.vue': `<script>import { api } from '../lib/api'</script>`,
    'util.js': '',
    'src/types.ts': '',
  });
  assert.deepEqual(g.edges.sort(), [
    ['src/app.tsx', 'src/components/Button.vue'],
    ['src/app.tsx', 'src/lib/api.ts'],
    ['src/app.tsx', 'src/types.ts'],
    ['src/app.tsx', 'util.js'],
    ['src/components/Button.vue', 'src/lib/api.ts'],
    ['src/lib/api.ts', 'src/config/index.ts'],
  ]);
  assert.deepEqual(hubs(g, 1), [{ path: 'src/lib/api.ts', count: 2 }]);
});

test('Python absolute, relative and submodule imports resolve', () => {
  const g = buildGraph({
    'app/main.py': 'import os\nfrom app.db import session\nfrom . import utils\nfrom .services import (\n    billing,\n    mail as m,\n)\nimport app.models',
    'app/db.py': 'from .models import User',
    'app/utils.py': '',
    'app/models/__init__.py': '',
    'app/services/billing.py': 'from ..db import x',
    'app/services/mail.py': '',
    'src/pkg/core.py': 'from pkg import helpers',
    'src/pkg/helpers.py': '',
  });
  const set = new Set(g.edges.map(e => e.join(' > ')));
  for (const e of ['app/main.py > app/db.py', 'app/main.py > app/utils.py', 'app/main.py > app/services/billing.py',
    'app/main.py > app/services/mail.py', 'app/main.py > app/models/__init__.py', 'app/db.py > app/models/__init__.py',
    'app/services/billing.py > app/db.py', 'src/pkg/core.py > src/pkg/helpers.py'])
    assert.ok(set.has(e), `missing ${e}`);
  assert.equal(set.size, 8);
});

test('Dart package: and relative imports resolve via pubspec name', () => {
  const g = buildGraph({
    'pubspec.yaml': 'name: shop_app\nversion: 1.0.0',
    'lib/main.dart': "import 'package:flutter/material.dart';\nimport 'package:shop_app/screens/home.dart';\nimport 'theme.dart';",
    'lib/screens/home.dart': "import '../theme.dart';",
    'lib/theme.dart': '',
  });
  assert.deepEqual(g.edges.map(e => e.join(' > ')).sort(), ['lib/main.dart > lib/screens/home.dart', 'lib/main.dart > lib/theme.dart', 'lib/screens/home.dart > lib/theme.dart']);
});

test('Go, Java, Rust and C# imports resolve', () => {
  const edges = files => buildGraph(files).edges.map(e => e.join(' > ')).sort();
  assert.deepEqual(edges({
    'go.mod': 'module github.com/acme/app\n\ngo 1.22\n',
    'main.go': 'package main\n\nimport (\n\t"fmt"\n\tdb "github.com/acme/app/internal/db"\n)\n',
    'internal/db/conn.go': 'package db\n\nimport "github.com/acme/app/internal/log"\nimport "github.com/other/lib"\n',
    'internal/db/query.go': 'package db\n',
    'internal/log/log.go': 'package log\n',
  }), ['internal/db/conn.go > internal/log/*', 'main.go > internal/db/*']);

  assert.deepEqual(edges({
    'src/main/java/com/acme/App.java': 'package com.acme;\n\nimport java.util.List;\nimport com.acme.db.Repo;\nimport static com.acme.util.Text.trim;\n',
    'src/main/java/com/acme/db/Repo.java': 'package com.acme.db;\n',
    'src/main/java/com/acme/util/Text.java': 'package com.acme.util;\n',
  }), ['src/main/java/com/acme/App.java > src/main/java/com/acme/db/Repo.java', 'src/main/java/com/acme/App.java > src/main/java/com/acme/util/Text.java']);

  assert.deepEqual(edges({
    'src/main.rs': 'mod config;\npub mod net;\nuse std::fs;\nuse crate::net::http::Client;\n',
    'src/config.rs': '',
    'src/net/mod.rs': 'mod http;\n',
    'src/net/http.rs': 'use crate::config::Settings;\n',
  }), ['src/main.rs > src/config.rs', 'src/main.rs > src/net/http.rs', 'src/main.rs > src/net/mod.rs', 'src/net/http.rs > src/config.rs', 'src/net/mod.rs > src/net/http.rs']);

  assert.deepEqual(edges({
    'App/Program.cs': 'using System;\nusing Acme.Core;\nusing static Acme.Core.Maths;\n\nnamespace Acme.App;\nclass P { void M() { using var s = Open(); } }\n',
    'Core/Maths.cs': 'namespace Acme.Core\n{\n}\n',
  }), ['App/Program.cs > Core/*']);
});

test('Mermaid output says which file or folder each box stands for', () => {
  const m = toMermaid({ nodes: [], edges: [['a/x.py', 'b/y.py'], ['main.go', 'internal/db/*']] });
  assert.deepEqual(Object.values(m.ids).sort(), ['a/x.py', 'b/y.py', 'internal/db/*', 'main.go']);
  assert.equal(m.links.length, 2);
  assert.equal(m.ids[m.links[0][0]], 'a/x.py');
  assert.match(m.mermaid, /\["\*"\]/);
});

test('Mermaid: file level groups by folder; big graphs collapse to folders', () => {
  const small = toMermaid({ nodes: [], edges: [['a/x.py', 'b/y.py'], ['b/y.py', 'z.py']] });
  assert.equal(small.level, 'file');
  assert.match(small.mermaid, /subgraph d\d\["a"\]/);
  assert.match(small.mermaid, /\["z\.py"\]/);

  const edges = [];
  for (let i = 0; i < 40; i++) edges.push([`ui/p${i}.js`, `api/c${i}.js`], [`api/c${i}.js`, 'core/db.js']);
  const big = toMermaid({ nodes: [], edges }, 60);
  assert.equal(big.level, 'folder');
  assert.match(big.mermaid, /-->\|40\|/);
  assert.equal(big.shown, 3);
  assert.equal(toMermaid({ nodes: ['a.py'], edges: [] }).mermaid, null);
});

test('labels cannot break out of Mermaid syntax', () => {
  const m = toMermaid({ nodes: [], edges: [['we"ird<b>.js', 'ok.js']] }).mermaid;
  assert.ok(!m.includes('<b>') && !/"we"/.test(m));
  assert.ok(!toMermaid({ nodes: [], edges: [['$$x^2$$.js', 'ok.js']] }).mermaid.includes('$$'));
});
