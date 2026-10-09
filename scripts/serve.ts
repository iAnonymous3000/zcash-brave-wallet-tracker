// Minimal static server for local preview of dist/ under the configured base path.
// Usage: node scripts/serve.ts [port]   (env: TRACKER_OUT_DIR, TRACKER_BASE_PATH)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../config/tracker.ts';
import { ROOT } from '../src/lib/store.ts';

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };

/**
 * Request handler for `dir` served under `base`. A malformed request (bad percent-encoding, a
 * NUL byte, an unparsable URL) is answered 400; an unexpected error is answered 500. Nothing a
 * client sends can throw out of the handler and stop the server.
 */
export function previewHandler(dirIn: string, base: string): (req: IncomingMessage, res: ServerResponse) => void {
  const dir = resolve(dirIn);
  const send = (res: ServerResponse, status: number, body: string | Buffer = '', headers: Record<string, string> = {}) => {
    if (res.headersSent) return void res.end();
    res.writeHead(status, headers);
    res.end(body);
  };
  return (req, res) => {
    try {
      let url: URL;
      let rel: string;
      try {
        // The request target is a path ("origin-form"): parsed relative to a base URL, "//work" would be read as a
        // host named "work", so the path is appended to the origin instead.
        const target = req.url ?? '/';
        url = new URL(target.startsWith('/') ? `http://localhost${target}` : target, 'http://localhost');
        rel = url.pathname.startsWith(base) ? decodeURIComponent(url.pathname.slice(base.length)) : '';
      } catch {
        return send(res, 400, 'bad request', { 'Content-Type': 'text/plain' });
      }
      if (rel.includes('\0')) return send(res, 400, 'bad request', { 'Content-Type': 'text/plain' });
      if (url.pathname === '/' && base !== '/') return send(res, 302, '', { Location: base });
      if (!url.pathname.startsWith(base)) return send(res, 404, 'not under base path');
      let file = normalize(join(dir, rel));
      // Inside dir only: a sibling such as "<dir>-private" shares the prefix but is outside.
      if (file !== dir && !file.startsWith(dir + sep)) return send(res, 403);
      if (existsSync(file) && statSync(file).isDirectory()) {
        // Mimic GitHub Pages: a directory without a trailing slash redirects to it.
        if (!url.pathname.endsWith('/')) return send(res, 301, '', { Location: directoryLocation(url) });
        file = join(file, 'index.html');
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        const notFound = join(dir, '404.html');
        return send(res, 404, existsSync(notFound) ? readFileSync(notFound) : 'not found', { 'Content-Type': types['.html'] });
      }
      return send(res, 200, readFileSync(file), { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    } catch (err) {
      console.error(err);
      return send(res, 500, 'internal error', { 'Content-Type': 'text/plain' });
    }
  };
}

/**
 * The trailing-slash redirect target for a directory request: a path-absolute URL built from the parsed (still
 * percent-encoded) path with runs of slashes collapsed, so it can never start with "//" and be read as a
 * protocol-relative URL to another host ("/.//work" parses to "//work"; WHATWG also turns "\" into "/").
 */
export function directoryLocation(url: URL): string {
  return `/${url.pathname.replace(/\/{2,}/g, '/').replace(/^\//, '')}/${url.search}`;
}

export function createPreviewServer(dir: string, base: string): Server {
  return createServer(previewHandler(dir, base));
}

/** True when this file is the entry point (not imported by a test), even through a symlinked path. */
function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  const dir = resolve(process.env.TRACKER_OUT_DIR ?? join(ROOT, 'dist'));
  const base = SITE.basePath;
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
  createPreviewServer(dir, base).listen(port, () => console.log(`serving ${dir} at http://localhost:${port}${base}`));
}
