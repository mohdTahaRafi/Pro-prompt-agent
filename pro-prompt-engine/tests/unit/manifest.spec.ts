/**
 * Mechanically checks that declared permissions match usage (PRE-4) and
 * stays that way. Reads the built manifest.json and greps the source tree
 * for chrome.<namespace>. calls, failing if a namespace is called that the
 * manifest does not authorise, or a permission is declared that no source
 * file uses.
 *
 * Note on a resolved spec contradiction: task 1.9's acceptance-table cell
 * says the manifest has "no content_scripts key" — read alone that would
 * mean deleting toolbar.content.tsx's own six-AI-host entry too, which no
 * other task asks for. Two other, more specific passages in the same doc
 * disagree with that cell and agree with each other: §8's test-infrastructure
 * table row for no-all-urls.spec.ts ("the built manifest.json contains no
 * content_scripts entry with <all_urls>") and §15's forward-dependency note,
 * which explicitly keeps toolbar.content.tsx's entry until Phase 5 and says
 * outright: "no-all-urls.spec.ts asserts the absence of <all_urls>
 * specifically, not the absence of content_scripts, for exactly this
 * reason." Two independent, detailed passages against one compressed
 * acceptance-cell phrasing — not a coin flip. This suite (and
 * no-all-urls.spec.ts) implements what §14/§15 actually specify: no
 * content_scripts entry matches <all_urls>, not the absence of the key.
 * See Docs/planning/phase_1_foundation_preconditions.md §5.5, §8, §15.
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

  it('has no content_scripts entry matching <all_urls>', () => {
    const manifest = readManifest();
    const entries = manifest.content_scripts ?? [];
    for (const entry of entries) {
      expect(entry.matches).not.toContain('<all_urls>');
    }
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
      // sidePanel is declared for Phase 5, which has not landed yet — its
      // permission is intentionally present ahead of use (wxt.config.ts §4.1).
      'sidePanel',
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
