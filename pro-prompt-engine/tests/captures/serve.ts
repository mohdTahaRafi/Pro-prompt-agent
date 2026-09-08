/**
 * Serves a single capture on a fixed port with a fixed origin, so grants and
 * origin checks are stable across runs (§8.3).
 *
 * Usage: npx tsx tests/captures/serve.ts <slug> [port=5600]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [slug, portArg] = process.argv.slice(2);
if (!slug) {
  console.error('Usage: npx tsx tests/captures/serve.ts <slug> [port=5600]');
  process.exit(1);
}
const port = Number(portArg ?? 5600);
const dir = path.join(__dirname, slug);

const server = createServer(async (req, res) => {
  const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const filePath = path.join(dir, reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, ''));
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    const contentType = filePath.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Serving tests/captures/${slug} at http://localhost:${port}`);
});
