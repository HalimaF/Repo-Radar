import { loadSettings, saveSettings } from '../lib/settings.js';
import { DEFAULT_ENDPOINTS } from '../lib/repoPilot.js';
import { CLIENT_ID, deviceLogin } from '../lib/oauth.js';

const $ = id => document.getElementById(id);
const s = await loadSettings();
$('token').value = s.githubToken;
$('rp').value = s.repoPilotUrl;
$('ep').value = JSON.stringify({ ...DEFAULT_ENDPOINTS, ...s.repoPilotEndpoints }, null, 2);

// Shown only once an OAuth app's client ID has been set in oauth.js.
if (CLIENT_ID) {
  $('signin').hidden = false;
  $('signin').addEventListener('click', async () => {
    const out = $('device');
    try {
      const token = await deviceLogin(CLIENT_ID, code => {
        const link = Object.assign(document.createElement('a'), { href: 'https://github.com/login/device', target: '_blank', rel: 'noopener', textContent: 'github.com/login/device' });
        out.replaceChildren('Open ', link, ` and enter the code ${code}. Waiting…`);
      });
      $('token').value = token;
      await saveSettings({ githubToken: token });
      out.textContent = 'Signed in.';
    } catch (e) { out.textContent = e.message; }
  });
}

$('save').addEventListener('click', async () => {
  const status = $('status');
  let endpoints, url = $('rp').value.trim();
  try { endpoints = JSON.parse($('ep').value || '{}'); } catch { status.textContent = 'Endpoint paths are not valid JSON.'; return; }
  // Paths only: "@host/x" or "//host/x" would send requests to a different server.
  if (!Object.values(endpoints ?? [0]).every(p => typeof p === 'string' && /^\/(?!\/)/.test(p))) { status.textContent = 'Each endpoint path must start with a single "/".'; return; }
  if (url) {
    let origin;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw 0;
      origin = u.origin;
    } catch { status.textContent = 'Repo Pilot URL must be https:// (or http://localhost).'; return; }
    // Host access is requested per backend, at save time, instead of asking for all sites up front.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) { status.textContent = 'Permission to reach that URL was declined.'; return; }
  }
  await saveSettings({ githubToken: $('token').value.trim(), repoPilotUrl: url, repoPilotEndpoints: endpoints });
  status.textContent = 'Saved.';
});
