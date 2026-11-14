// Builds build/firefox/: the same extension with a Firefox manifest.
// Firefox has a sidebar instead of Chrome's side panel, a background page instead of a
// service worker, and its own key for the options page.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const out = 'build/firefox';
rmSync(out, { recursive: true, force: true });
for (const dir of ['src', 'vendor', 'icons']) cpSync(dir, `${out}/${dir}`, { recursive: true });

const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
m.sidebar_action = { default_panel: m.side_panel.default_path, default_title: m.name, default_icon: m.icons };
m.background = { scripts: [m.background.service_worker], type: 'module' };
m.options_ui = { page: m.options_page, open_in_tab: true };
m.permissions = m.permissions.filter(p => p !== 'sidePanel');
m.browser_specific_settings = { gecko: { id: 'repo-radar@halimaf.github.io', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } };
delete m.side_panel; delete m.options_page; delete m.minimum_chrome_version;
writeFileSync(`${out}/manifest.json`, `${JSON.stringify(m, null, 2)}\n`);
console.log(`${out}/ ready: load its manifest.json from about:debugging`);
