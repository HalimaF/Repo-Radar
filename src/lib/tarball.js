// Downloads a repo snapshot as one .tar.gz and returns { path: text } for the wanted files.
// One request regardless of repo size, and codeload is not counted against the API rate limit.
const MAX_FILE_BYTES = 512 * 1024;

export async function fetchSources(owner, repo, ref, wanted, fetchImpl = fetch) {
  const res = await fetchImpl(`https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`);
  if (!res.ok) throw new Error(`Could not download the repo (HTTP ${res.status}).`);
  const tar = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return untar(tar, wanted);
}

/** Minimal ustar/pax reader: regular files only, top-level "owner-repo-sha/" folder stripped. */
export function untar(buf, wanted = () => true) {
  const dec = new TextDecoder();
  const str = (o, n) => dec.decode(buf.subarray(o, o + n)).replace(/\0.*$/s, '');
  const files = {};
  let pos = 0, longName = null;
  while (pos + 512 <= buf.length) {
    const name0 = str(pos, 100);
    if (!name0) break; // two zero blocks end the archive
    const size = parseInt(str(pos + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buf[pos + 156]);
    const prefix = str(pos + 345, 155);
    const body = pos + 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(buf.subarray(body, body + size)));
      longName = m ? m[1] : null;
    } else if (type === '0' || type === '\0') {
      const full = longName ?? (prefix ? `${prefix}/${name0}` : name0);
      const path = full.split('/').slice(1).join('/');
      if (path && size <= MAX_FILE_BYTES && wanted(path)) files[path] = dec.decode(buf.subarray(body, body + size));
      longName = null;
    } else if (type !== 'g') longName = null;
    pos = body + Math.ceil(size / 512) * 512;
  }
  return files;
}
