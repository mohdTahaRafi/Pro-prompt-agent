/**
 * Serves every capture under tests/captures/ from ONE fixed origin
 * (http://localhost:5600), each at its own path prefix
 * (http://localhost:5600/<slug>/index.html) — so the PP_CORPUS build
 * (wxt.config.ts) only needs a single localhost origin in host_permissions
 * to cover all 14 new frozen captures, rather than one port per capture.
 *
 * Usage: npx tsx tests/captures/serve-all.ts [port=5600]
 */
import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 5600);

const server = createServer(async (req, res) => {
  const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const parts = reqPath.split('/').filter(Boolean);
  if (parts.length === 0) {
    const slugs = (await readdir(__dirname, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Available captures:\n${slugs.map((s) => `  /${s}/`).join('\n')}`);
    return;
  }
  const [slug, ...rest] = parts;
  const relPath = rest.length ? rest.join('/') : 'index.html';
  const filePath = path.join(__dirname, slug, relPath);
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    const contentType = filePath.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end(`Not found: /${slug}/${relPath}`);
  }
});

server.listen(port, () => {
  console.log(`Serving all tests/captures/* at http://localhost:${port}/<slug>/`);
});
