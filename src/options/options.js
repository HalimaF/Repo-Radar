import { loadSettings, saveSettings } from '../lib/settings.js';
import { DEFAULT_ENDPOINTS } from '../lib/repoPilot.js';

const $ = id => document.getElementById(id);
const s = await loadSettings();
$('token').value = s.githubToken;
$('rp').value = s.repoPilotUrl;
$('ep').value = JSON.stringify({ ...DEFAULT_ENDPOINTS, ...s.repoPilotEndpoints }, null, 2);

$('save').addEventListener('click', async () => {
  const status = $('status');
  let endpoints, url = $('rp').value.trim();
  try { endpoints = JSON.parse($('ep').value || '{}'); } catch { status.textContent = 'Endpoint paths are not valid JSON.'; return; }
  if (url) {
    let origin;
    try { origin = new URL(url).origin; } catch { status.textContent = 'Repo Pilot URL is not a valid URL.'; return; }
    // Host access is requested per backend, at save time, instead of asking for all sites up front.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) { status.textContent = 'Permission to reach that URL was declined.'; return; }
  }
  await saveSettings({ githubToken: $('token').value.trim(), repoPilotUrl: url, repoPilotEndpoints: endpoints });
  status.textContent = 'Saved.';
});
