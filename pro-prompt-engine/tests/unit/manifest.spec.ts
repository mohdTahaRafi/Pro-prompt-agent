/**
 * Mechanically checks that declared permissions match usage (PRE-4) and
 * stays that way. Reads the built manifest.json and greps the source tree
 * for chrome.<namespace>. calls, failing if a namespace is called that the
 * manifest does not authorise, or a permission is declared that no source
 * file uses.
 *
 * Note on a resolved spec contradiction, now closed: Phase 1 §15 deferred
 * "no content_scripts key at all" to Phase 5, deliberately keeping
 * toolbar.content.tsx's static six-AI-host entry alive until then (see
 * Docs/planning/phase_1_foundation_preconditions.md §5.5, §8, §15 for the
 * original reasoning). Phase 5 §2/§11 task 5.16 deletes
 * entrypoints/toolbar.content.tsx outright — the side panel plus the
 * in-page overlay replace it — which was the LAST static content_scripts
 * manifest entry (entrypoints/agent.content.ts registers at runtime,
 * per-grant, via chrome.scripting.registerContentScripts, and so never
 * appears in the manifest at all). The assertion below is strengthened
 * accordingly, per Docs/planning/phase_5_agent_loop.md §11 task 5.16.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST_PATH = path.join(ROOT, '.output/chrome-mv3/manifest.json');

const EXPECTED_PERMISSIONS = ['activeTab', 'offscreen', 'scripting', 'sidePanel', 'storage'];

function readManifest(): any {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

// This suite is the one place in the unit run that needs a production build
// to already exist. The CI order (§8.4) is compile → test:unit → build →
// test:e2e, which runs this suite before the pipeline's own `build` step —
// so if nothing has built yet, this suite builds once itself rather than
// failing on a missing artifact. A local `npm run build` beforehand (or a
// prior CI run) is reused as-is.
beforeAll(() => {
  if (!existsSync(MANIFEST_PATH)) {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
  }
}, 120_000);

describe('manifest permissions match usage (PRE-4)', () => {
  it('declares exactly the Phase 1 baseline permission set', () => {
    const manifest = readManifest();
    expect([...manifest.permissions].sort()).toEqual([...EXPECTED_PERMISSIONS].sort());
  });

  it('declares no alarms permission (the three-layer keep-alive is deleted)', () => {
    const manifest = readManifest();
    expect(manifest.permissions).not.toContain('alarms');
  });

  it('declares localhost:11434 as a fixed host permission and not api.groq.com', () => {
    const manifest = readManifest();
    expect(manifest.host_permissions ?? []).toContain('http://localhost:11434/*');
    expect(manifest.host_permissions ?? []).not.toContain('https://api.groq.com/*');
  });

  it('declares *://*/* only as an optional host permission', () => {
    const manifest = readManifest();
    expect(manifest.optional_host_permissions ?? []).toContain('*://*/*');
    expect(manifest.host_permissions ?? []).not.toContain('*://*/*');
  });

  // [Phase 5 §11 task 5.16] strengthened from "no <all_urls> entry" to "no
  // content_scripts key at all" — see the file header.
  it('has no content_scripts key at all', () => {
    const manifest = readManifest();
    expect(manifest.content_scripts ?? []).toHaveLength(0);
  });

  it('every chrome.<namespace> call site is authorised by a declared permission', () => {
    const manifest = readManifest();
    const declared = new Set<string>(manifest.permissions ?? []);
    // Namespaces that need no permission entry at all, or are authorised by
    // host_permissions/activeTab rather than a `permissions` array member.
    const alwaysOk = new Set(['runtime', 'permissions', 'tabs', 'storage']);
    // Grep only lib/ and entrypoints/ — not node_modules, not .output, not tests.
    const grep = execSync(
      String.raw`grep -rhoE "chrome\.[a-zA-Z]+\." lib entrypoints | sort -u`,
      { cwd: ROOT, encoding: 'utf-8' },
    );
    const namespaces = new Set(
      grep.split('\n').filter(Boolean).map((l) => l.replace(/^chrome\./, '').replace(/\.$/, '')),
    );
    for (const ns of namespaces) {
      if (alwaysOk.has(ns)) continue;
      expect(declared.has(ns), `chrome.${ns} is called but "${ns}" is not a declared permission`).toBe(true);
    }
  });

  it('every declared permission is used by at least one source file', () => {
    const manifest = readManifest();
    const noOwnNamespace = new Set([
      // activeTab has no chrome.activeTab namespace of its own — granting it
      // is what lets chrome.tabs.query / chrome.scripting.executeScript see
      // the current tab's URL and content from the popup (§5.5's table).
      'activeTab',
    ]);
    const grep = execSync(
      String.raw`grep -rhoE "chrome\.[a-zA-Z]+\." lib entrypoints | sort -u`,
      { cwd: ROOT, encoding: 'utf-8' },
    );
    const namespaces = new Set(
      grep.split('\n').filter(Boolean).map((l) => l.replace(/^chrome\./, '').replace(/\.$/, '')),
    );
    for (const perm of manifest.permissions ?? []) {
      if (noOwnNamespace.has(perm)) continue;
      expect(namespaces.has(perm), `"${perm}" is declared but chrome.${perm} is never called`).toBe(true);
    }
  });
});
