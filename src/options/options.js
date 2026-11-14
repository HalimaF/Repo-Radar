import { loadSettings, saveSettings } from '../lib/settings.js';
import { CLIENT_ID, deviceLogin } from '../lib/oauth.js';

const $ = id => document.getElementById(id);
const s = await loadSettings();
$('token').value = s.githubToken;

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
  await saveSettings({ githubToken: $('token').value.trim() });
  $('status').textContent = 'Saved.';
});
