/**
 * lib/policy/scope.ts — grant, revoke, isGranted and reconciliation, against
 * the chrome double installed by tests/setup.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { grantOrigin, revokeOrigin, isGranted, reconcileGrants, toOrigin, AGENT_SCRIPT_ID_PREFIX } from '@lib/policy/scope';
import { db } from '@lib/db/dexie-db';

const ORIGIN = 'https://example.com';

describe('toOrigin', () => {
  it('normalises a URL to its bare origin', () => {
    expect(toOrigin('https://example.com/path?x=1')).toBe('https://example.com');
  });
  it('rejects non-http(s) protocols', () => {
    expect(toOrigin('chrome://extensions')).toBeNull();
    expect(toOrigin('file:///etc/passwd')).toBeNull();
  });
  it('returns null for an unparseable URL', () => {
    expect(toOrigin('not a url')).toBeNull();
  });
});

describe('grantOrigin / revokeOrigin / isGranted', () => {
  beforeEach(async () => {
    await db.sitePolicy.clear();
  });

  it('grant registers the agent script and writes a sitePolicy row', async () => {
    const ok = await grantOrigin(ORIGIN);
    expect(ok).toBe(true);
    expect(await isGranted(ORIGIN)).toBe(true);

    const registered = await chrome.scripting.getRegisteredContentScripts();
    expect(registered.some((s: any) => s.id === AGENT_SCRIPT_ID_PREFIX + ORIGIN)).toBe(true);

    const policy = await db.sitePolicy.get(ORIGIN);
    expect(policy).toBeDefined();
    // [Phase 3 §12 task 3.15] widened from the four perception verbs to the
    // eleven verbs that phase implements. [Phase 5 §10] widened again to
    // include the two control verbs, ask_user and finish — they act on the
    // run itself, never the page, so no site-level reason ever withholds them.
    expect(policy!.capabilities).toEqual([
      'read_page', 'read_structure', 'read_element', 'wait_for_settle',
      'scroll', 'click', 'type', 'select', 'navigate', 'history_back', 'history_forward',
      'ask_user', 'finish',
    ]);
    expect(policy!.defaultMode).toBe('supervised');
    expect(policy!.revokedAt).toBeUndefined();
  });

  it('returns false and never throws when the user declines the permission prompt', async () => {
    (chrome.permissions.request as any).mockResolvedValueOnce(false);
    const ok = await grantOrigin(ORIGIN);
    expect(ok).toBe(false);
    expect(await isGranted(ORIGIN)).toBe(false);
  });

  it('rolls back the permission grant if registerContentScripts fails', async () => {
    (chrome.scripting.registerContentScripts as any).mockRejectedValueOnce(new Error('quota exceeded'));
    const ok = await grantOrigin(ORIGIN);
    expect(ok).toBe(false);
    expect(await isGranted(ORIGIN)).toBe(false);
  });

  it('revoke unregisters the script, drops the permission, and sets revokedAt', async () => {
    await grantOrigin(ORIGIN);
    await revokeOrigin(ORIGIN);

    expect(await isGranted(ORIGIN)).toBe(false);
    const registered = await chrome.scripting.getRegisteredContentScripts();
    expect(registered.some((s: any) => s.id === AGENT_SCRIPT_ID_PREFIX + ORIGIN)).toBe(false);

    const policy = await db.sitePolicy.get(ORIGIN);
    expect(policy!.revokedAt).toBeDefined();
  });

  it('revoke is idempotent on an origin that was never granted', async () => {
    await expect(revokeOrigin('https://never-granted.example')).resolves.toBeUndefined();
  });

  // [Phase 2 §10.1] Found by tools/collect-real-fixtures.ts re-granting the
  // same origin for multiple corpus entries served from one combined
  // origin: registerContentScripts throws on a duplicate id, and the old
  // code treated that throw as a real failure, rolling back an otherwise-
  // fine permission. grantOrigin must be idempotent on an already-set-up
  // origin — this is also a real product bug, not just a test-harness
  // concern: a real user re-granting an already-granted site would have
  // hit the exact same silent rollback.
  it('grant is idempotent — re-granting an already-set-up origin succeeds without re-registering', async () => {
    const first = await grantOrigin(ORIGIN);
    expect(first).toBe(true);
    (chrome.scripting.registerContentScripts as any).mockClear();

    const second = await grantOrigin(ORIGIN);
    expect(second).toBe(true);
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(await isGranted(ORIGIN)).toBe(true);

    const registered = await chrome.scripting.getRegisteredContentScripts();
    expect(registered.filter((s: any) => s.id === AGENT_SCRIPT_ID_PREFIX + ORIGIN)).toHaveLength(1);
  });
});

describe('reconcileGrants — drift reconciliation (§4.3)', () => {
  beforeEach(async () => {
    await db.sitePolicy.clear();
  });

  it('marks a sitePolicy row revoked if Chrome no longer holds the permission', async () => {
    await grantOrigin(ORIGIN);
    // Simulate a revoke from chrome://extensions that happened while the SW
    // was asleep — the permission is gone from Chrome's store but our
    // sitePolicy row and registered script don't know that yet.
    (chrome.permissions as any).__granted.delete(`${ORIGIN}/*`);

    await reconcileGrants();

    const policy = await db.sitePolicy.get(ORIGIN);
    expect(policy!.revokedAt).toBeDefined();
    const registered = await chrome.scripting.getRegisteredContentScripts();
    expect(registered.some((s: any) => s.id === AGENT_SCRIPT_ID_PREFIX + ORIGIN)).toBe(false);
  });

  it('unregisters a script for an origin the extension no longer holds, even with no sitePolicy row', async () => {
    await chrome.scripting.registerContentScripts([{ id: AGENT_SCRIPT_ID_PREFIX + ORIGIN, matches: [`${ORIGIN}/*`] }]);
    await reconcileGrants();
    const registered = await chrome.scripting.getRegisteredContentScripts();
    expect(registered.some((s: any) => s.id === AGENT_SCRIPT_ID_PREFIX + ORIGIN)).toBe(false);
  });

  it('leaves a still-granted origin untouched', async () => {
    await grantOrigin(ORIGIN);
    await reconcileGrants();
    expect(await isGranted(ORIGIN)).toBe(true);
    const policy = await db.sitePolicy.get(ORIGIN);
    expect(policy!.revokedAt).toBeUndefined();
  });
});
