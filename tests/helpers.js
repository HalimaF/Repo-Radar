/** Builds a ustar archive like GitHub's: pax global header, then files under "owner-repo-sha/". */
export function makeTar(files, top = 'acme-widget-abc123') {
  const blocks = [];
  const header = (name, size, type) => {
    const b = Buffer.alloc(512);
    b.write(name.slice(0, 100), 0);
    b.write(size.toString(8).padStart(11, '0') + '\0', 124);
    b.write(type, 156);
    b.write('ustar\0', 257);
    return b;
  };
  const pad = buf => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
  const g = Buffer.from('52 comment=abc123abc123abc123abc123abc123abc123ab\n');
  blocks.push(header('pax_global_header', g.length, 'g'), pad(g));
  for (const [path, text] of Object.entries(files)) {
    const full = `${top}/${path}`, body = Buffer.from(text);
    if (full.length > 100) { // long names travel in a pax "x" record, as GitHub does
      const rec = ` path=${full}\n`;
      const len = String(rec.length + String(rec.length + 2).length);
      const pax = Buffer.from(`${len}${rec}`);
      blocks.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    blocks.push(header(full, body.length, '0'), pad(body));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
