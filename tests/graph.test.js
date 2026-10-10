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
});
