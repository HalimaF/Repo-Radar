// Chrome extensions cannot load remote scripts, so Mermaid is copied into vendor/.
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('vendor', { recursive: true });
copyFileSync('node_modules/mermaid/dist/mermaid.min.js', 'vendor/mermaid.min.js');
copyFileSync('node_modules/mermaid/LICENSE', 'vendor/mermaid.LICENSE');
console.log('vendor/mermaid.min.js updated');
