// "Sign in with GitHub" by device flow: the user types a short code on github.com.
// It needs no client secret, so it is safe to ship inside an extension.
// To turn it on: register a GitHub OAuth app, tick "Enable Device Flow", and paste its client ID here.
export const CLIENT_ID = '';

/** Resolves to an access token. No scope is requested, so the token can only read public data. */
export async function deviceLogin(clientId, onCode, fetchImpl = fetch, wait = ms => new Promise(r => setTimeout(r, ms))) {
  const post = async (url, body) => (await fetchImpl(url, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId, ...body }),
  })).json();
  const d = await post('https://github.com/login/device/code', {});
  if (!d.device_code) throw new Error(d.error_description ?? 'GitHub did not start the sign-in.');
  onCode(d.user_code);
  let interval = d.interval ?? 5;
  for (const end = Date.now() + (d.expires_in ?? 900) * 1000; Date.now() < end;) {
    await wait(interval * 1000);
    const t = await post('https://github.com/login/oauth/access_token', { device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (t.access_token) return t.access_token;
    if (t.error === 'slow_down') interval += 5;
    else if (t.error !== 'authorization_pending') throw new Error(t.error_description ?? t.error ?? 'Sign-in failed.');
  }
  throw new Error('Sign-in timed out. Try again.');
}
