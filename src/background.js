import { checkWatchlist } from './lib/watch.js';
import { loadSettings } from './lib/settings.js';

// Clicking the toolbar icon opens the side panel; the panel itself tracks the active tab.
// Firefox has no side panel API: there the same page is a sidebar.
if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
else chrome.action.onClicked.addListener(() => browser.sidebarAction.toggle());

// Watchlist: once a day, re-scan watched repos and notify when one gets worse.
// Only created when missing, because re-creating an alarm restarts its clock every time this worker wakes.
chrome.alarms.get('watch').then(a => a || chrome.alarms.create('watch', { periodInMinutes: 24 * 60 }));
chrome.alarms.onAlarm.addListener(async () => {
  const { watch = {} } = await chrome.storage.local.get('watch');
  const results = await checkWatchlist(watch, (await loadSettings()).githubToken);
  const fresh = (await chrome.storage.local.get('watch')).watch ?? {}; // the panel may have changed the list during the scans
  for (const [name, { now, news }] of Object.entries(results)) {
    if (!fresh[name]) continue;
    fresh[name] = now;
    if (news.length) chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title: `Repo Radar: ${name}`, message: news.join(', ') });
  }
  await chrome.storage.local.set({ watch: fresh });
});
