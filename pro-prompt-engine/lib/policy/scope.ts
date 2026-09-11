/**
 * Per-origin runtime grants — the scope module. Runs in the service worker.
 *
 * [Phase 2 §11 task 2.15] DEFAULT_CAPABILITIES is widened from the Phase 1
 * empty set to the four perception verbs: a fresh grant now registers
 * agent.content.ts (Phase 2 §3.1), which answers read_structure,
 * read_element, wait_for_settle and read_page.
 * [Phase 3 §12 task 3.15] widened again to the eleven verbs this phase
 * implements (§3, lib/policy/gate.ts's IMPLEMENTED_VERBS) — a fresh grant
 * now permits the gate to actually classify and dispatch interaction and
 * navigation verbs, not just read them. A site's capabilities are never
 * wider than the implemented vocabulary (PR-SEC-6) and can be narrowed
 * per-origin later; this is only ever the ceiling a fresh grant starts at.
 * See Docs/planning/phase_1_foundation_preconditions.md §4,
 * Docs/planning/phase_2_perception.md §3.1, §11,
 * Docs/planning/phase_3_gate_actuation_verification.md §12.
 */
import { db } from '@lib/db/dexie-db';
import type { Verb } from '@lib/schemas/action.schema';

export const AGENT_SCRIPT_ID_PREFIX = 'pp-agent-';

export const DEFAULT_CAPABILITIES: Verb[] = [
  'read_page', 'read_structure', 'read_element', 'wait_for_settle',
  'scroll', 'click', 'type', 'select', 'navigate', 'history_back', 'history_forward',
];

/** Normalise any URL to the origin form used as the sitePolicy primary key. */
export function toOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;                       // "https://example.com", no trailing slash
  } catch { return null; }
}

/** The match pattern Chrome wants for an origin: origin + "/*". */
function toMatchPattern(origin: string): string { return `${origin}/*`; }

/**
 * Grant. MUST be called from a user-gesture handler — chrome.permissions.request
 * throws otherwise. Returns false if the user declined; never throws on decline.
 *
 * Idempotent: granting an origin that is already fully set up (permission
 * held AND its content script already registered) is a no-op success, not
 * a failure. This matters for a real user re-granting a site they already
 * granted (a stale popup re-offering "grant" for an already-active origin)
 * and not just for automation — found by tools/collect-real-fixtures.ts
 * (§10.1) re-granting the same localhost origin for multiple frozen
 * captures served from one combined origin, which surfaced the bug:
 * chrome.scripting.registerContentScripts throws on a duplicate id, and
 * the old code treated ANY throw there as a real failure, rolling back a
 * permission that was actually fine. Only a genuinely missing registration
 * (permission held, no script) re-registers; only a real registration
 * error (quota, a different fault) rolls back.
 *
 * Failure mode: if registration fails for a reason other than "already
 * registered" (quota, a race with reconciliation), the grant is rolled
 * back — chrome.permissions.remove is called and grantOrigin returns
 * false. A held permission with no registered script is worse than no
 * permission, because the popup would show the site as granted while
 * nothing works.
 */
export async function grantOrigin(origin: string): Promise<boolean> {
  const origins = [toMatchPattern(origin)];
  const scriptId = AGENT_SCRIPT_ID_PREFIX + origin;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) return false;

  // Filtered by id where the real API supports it; membership is also
  // checked explicitly below rather than trusting an empty result, since
  // not every environment honours the filter (e.g. the test double).
  const already = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
  if (!already.some((s) => s.id === scriptId)) {
    try {
      await chrome.scripting.registerContentScripts([{
        id: scriptId,
        matches: origins,
        // entrypoints/agent.content.ts uses defineContentScript with
        // registration: 'runtime' (Phase 2 §3.1) — WXT bundles it to
        // content-scripts/agent.js without adding any static content_scripts
        // or host_permissions manifest entry, because runtime registration
        // supplies its own `matches` (this origin only) at call time instead.
        js: ['content-scripts/agent.js'],
        runAt: 'document_idle',
        world: 'ISOLATED',                      // explicit: never MAIN (§3.9)
        persistAcrossSessions: true,
      }]);
    } catch (err) {
      console.error('[scope] registerContentScripts failed — rolling back grant', err);
      await chrome.permissions.remove({ origins }).catch(() => {});
      return false;
    }
  }

  await db.sitePolicy.put({
    origin,
    capabilities: DEFAULT_CAPABILITIES,     // see §4.4
    defaultMode: 'supervised',              // PR-AUT-4
    grantedAt: Date.now(),
    revokedAt: undefined,
  });
  return true;
}

/**
 * Revoke. Order matters: unregister the script FIRST so that no new content
 * script can be injected in the window between the permission drop and the
 * unregistration. Then drop the permission, then mark the policy row.
 */
export async function revokeOrigin(origin: string): Promise<void> {
  const id = AGENT_SCRIPT_ID_PREFIX + origin;
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
  await chrome.permissions.remove({ origins: [toMatchPattern(origin)] });
  await db.sitePolicy.update(origin, { revokedAt: Date.now() });
  // [Phase 5: halt any run whose scope contains this origin]
}

/**
 * The authoritative scope check. Reads Chrome, not our database, because the
 * user can revoke from chrome://extensions without telling us. The database
 * row is a record of intent; chrome.permissions.contains is the truth.
 */
export async function isGranted(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [toMatchPattern(origin)] });
}

/**
 * chrome.permissions.onRemoved fires when the user revokes from Chrome's own
 * UI, but it does not fire for revocations that happened while the browser
 * was closed. Any sitePolicy row whose permission Chrome no longer holds is
 * marked revoked; the inverse (a registered script for an origin we no
 * longer hold) is also reconciled.
 */
export async function reconcileGrants(): Promise<void> {
  const rows = await db.sitePolicy.filter((r) => r.revokedAt === undefined).toArray();
  for (const row of rows) {
    if (!(await isGranted(row.origin))) await revokeOrigin(row.origin);
  }
  const registered = await chrome.scripting.getRegisteredContentScripts();
  for (const s of registered) {
    const origin = s.id.startsWith(AGENT_SCRIPT_ID_PREFIX)
      ? s.id.slice(AGENT_SCRIPT_ID_PREFIX.length) : null;
    if (origin && !(await isGranted(origin))) {
      await chrome.scripting.unregisterContentScripts({ ids: [s.id] }).catch(() => {});
    }
  }
}
