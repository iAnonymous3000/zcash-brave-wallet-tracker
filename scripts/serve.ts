// Minimal static server for local preview of dist/ under the configured base path.
// Usage: node scripts/serve.ts [port]   (env: TRACKER_OUT_DIR, TRACKER_BASE_PATH)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { SITE } from '../config/tracker.ts';
import { ROOT } from '../src/lib/store.ts';

const dir = resolve(process.env.TRACKER_OUT_DIR ?? join(ROOT, 'dist'));
const base = SITE.basePath;
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/' && base !== '/') {
    res.writeHead(302, { Location: base });
    return res.end();
  }
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404);
    return res.end('not under base path');
  }
  let rel = decodeURIComponent(url.pathname.slice(base.length));
  let file = normalize(join(dir, rel));
  if (!file.startsWith(dir)) {
    res.writeHead(403);
    return res.end();
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    // Mimic GitHub Pages: directory without trailing slash redirects; otherwise 404.html.
    if (existsSync(join(file, 'index.html'))) {
      res.writeHead(301, { Location: `${url.pathname}/` });
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': types['.html'] });
    return res.end(existsSync(join(dir, '404.html')) ? readFileSync(join(dir, '404.html')) : 'not found');
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`serving ${dir} at http://localhost:${port}${base}`));
