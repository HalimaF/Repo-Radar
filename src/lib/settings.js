const DEFAULTS = { githubToken: '', repoPilotUrl: '', repoPilotEndpoints: {} };

// Token stays in local storage (not sync) so it never leaves this machine.
export const loadSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });
export const saveSettings = s => chrome.storage.local.set(s);
