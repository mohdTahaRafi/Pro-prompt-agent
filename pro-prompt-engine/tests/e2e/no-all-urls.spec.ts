/**
 * On a page whose origin was never granted, chrome.scripting.
 * getRegisteredContentScripts() matches nothing, and the built manifest.json
 * contains no content_scripts entry with <all_urls>.
 */
import { test, expect } from './fixture';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('no <all_urls> content script, and an ungranted origin has no registered script', async ({ context, page }) => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../.output/e2e/chrome-mv3/manifest.json'), 'utf-8'),
  );
  for (const entry of manifest.content_scripts ?? []) {
    expect(entry.matches).not.toContain('<all_urls>');
  }

  await page.goto('http://localhost:5599/basic-form.html');

  const [sw] = context.serviceWorkers();
  const registered = await sw.evaluate(async () => chrome.scripting.getRegisteredContentScripts());
  expect((registered as any[]).some((s) => s.id.startsWith('pp-agent-'))).toBe(false);
});
