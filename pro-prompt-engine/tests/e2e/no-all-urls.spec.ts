/**
 * On a page whose origin was never granted, chrome.scripting.
 * getRegisteredContentScripts() matches nothing, and the built manifest.json
 * has no content_scripts key at all.
 *
 * [Phase 5 §11 task 5.16] Strengthened from "no <all_urls> entry" — true
 * since Phase 1 — to "no content_scripts key at all": Phase 5 deletes
 * entrypoints/toolbar.content.tsx, the last static content_scripts manifest
 * entry (tests/unit/manifest.spec.ts's header has the full history).
 */
import { test, expect } from './fixture';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('no content_scripts key at all, and an ungranted origin has no registered script', async ({ context, page }) => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../.output/e2e/chrome-mv3/manifest.json'), 'utf-8'),
  );
  expect(manifest.content_scripts ?? []).toHaveLength(0);

  await page.goto('http://localhost:5599/basic-form.html');

  const [sw] = context.serviceWorkers();
  const registered = await sw.evaluate(async () => chrome.scripting.getRegisteredContentScripts());
  expect((registered as any[]).some((s) => s.id.startsWith('pp-agent-'))).toBe(false);
});
