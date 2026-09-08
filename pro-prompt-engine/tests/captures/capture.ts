/**
 * Capture harness (§8.3). Navigates to a live URL, waits for network idle,
 * inlines every same-origin CSS/font/image as a data URI, strips <script>,
 * and writes index.html + meta.json under tests/captures/<slug>/.
 *
 * <script> removal is what makes a capture deterministic and is also what
 * makes it less real than the live web — a capture cannot reproduce a React
 * re-render or a lazy-loaded section. That limit is recorded in meta.json's
 * `notes` per capture, and is why the live-site set in Phase 12 exists as a
 * third layer rather than being replaced by captures.
 *
 * Usage: npx tsx tests/captures/capture.ts <slug> <url> "<notes>"
 */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const [slug, url, notes = ''] = process.argv.slice(2);
  if (!slug || !url) {
    console.error('Usage: npx tsx tests/captures/capture.ts <slug> <url> "<notes>"');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

  // Inline every same-origin <link rel=stylesheet>, <img src>, and CSS
  // background-image url() as a data URI, then strip every <script> so the
  // capture is deterministic — no re-render, no lazy load, no network call
  // at replay time.
  // Passed as a plain string, not a closure: tsx/esbuild injects a __name()
  // helper call into transpiled functions that page.evaluate(fn) would ship
  // to the browser without the helper's own definition, throwing
  // ReferenceError there. A string body sidesteps esbuild's function
  // transform entirely.
  const html: string = await page.evaluate(`(async () => {
    const toDataUri = async (url) => {
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      } catch { return null; }
    };

    for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      const href = link.href;
      if (!href || !href.startsWith(location.origin)) continue;
      const dataUri = await toDataUri(href);
      if (dataUri) {
        const style = document.createElement('style');
        const cssRes = await fetch(href);
        style.textContent = await cssRes.text();
        link.replaceWith(style);
      }
    }

    for (const img of Array.from(document.querySelectorAll('img'))) {
      const src = img.src;
      if (!src || !src.startsWith(location.origin)) continue;
      const dataUri = await toDataUri(src);
      if (dataUri) img.src = dataUri;
    }

    for (const script of Array.from(document.querySelectorAll('script'))) script.remove();

    return '<!doctype html>\\n' + document.documentElement.outerHTML;
  })()`) as string;

  await browser.close();

  const dir = path.join(__dirname, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), html, 'utf-8');
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      sourceUrl: url,
      viewport: { width: 1280, height: 900 },
      notes,
      ppSchemaVersion: 1,
    }, null, 2),
    'utf-8',
  );
  console.log(`Captured ${url} -> tests/captures/${slug}/index.html`);
}

main().catch((err) => { console.error(err); process.exit(1); });
