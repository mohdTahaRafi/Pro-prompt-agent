# Phase 1 — Foundation, Preconditions, Test Infrastructure & the Runtime Spike

**Document type:** Phase 1 execution document
**Architecture basis:** `architecture.md` §3.6 (directory), §3.7.8 (runtime grants), §3.7.14 (Zod), §3.8 (budgets), §3.9 (security model), §3.10 (roadmap), §3.11 Q8/Q11
**PRD basis:** PRE-1…PRE-6, PR-SEC-5…9, PR-PRV-2/3/5, PR-POL-5, SC-11
**Depends on:** Nothing. This is the first execution phase; it operates on the repository as it stands today.
**Status:** Ready to implement. No implementation has begun against this document.

---

## 1. Objective

At the end of this phase the repository is a foundation an acting product can be built on: every PRD precondition (PRE-1…PRE-6) is closed, install-time broad host access is gone and replaced by per-origin runtime grants, the Dexie schema is at v2 with the agent tables present and the `isActive` index defect migrated away, Zod 4 is the single validation dependency, and Vitest + Playwright + GitHub Actions run green on every push over a capture harness the later evaluation layers reuse. Alongside that, the phase runs **the combined runtime spike**: a measured answer to whether the offscreen document survives a multi-minute run across screen lock and sleep/wake (Q8), and whether Chrome's built-in `LanguageModel` is reachable from an offscreen document with `responseConstraint` and image input (Q11). Both answers are written down with their fallback declared before Phase 4 builds on them.

**By the end of this phase:** a user opens the popup on `example.com`, presses *Allow this site*, and Chrome's own permission prompt appears; on grant, a content script registers for that origin and a badge shows the site is granted. Pressing *Revoke* unregisters it. On a page with a `type="password"` field, no extension code reads, transmits, or renders that field's value — provably, by a test. `npm run ci` runs typecheck, unit tests, a build, and a small e2e suite, and exits 0.

**No agent, no planner, no gate, no perception, no verbs, no runs.** This phase creates no agent capability whatsoever. It removes defects, narrows permissions, installs the test and schema substrate, and produces one written spike report. Every existing text capability (refactor, score, generate, comprehension) keeps working exactly as it does today, with its latency baselined so Phase 8 can prove SC-11.

---

## 2. What exists today, verified in source

Read before changing. Every claim below was checked against the file named, not against the audit.

| File | State | What this phase does to it |
|---|---|---|
| `entrypoints/background.ts` (430 LOC) | **[built]** message router over a 40-member `MessageType` union; hosts a `setInterval` heartbeat, an `alarms` keep-alive, and offscreen lifecycle | Keep-alive deleted; dead alarm deleted; grant/revoke handlers added |
| `entrypoints/content.ts` (103 LOC) | **[built]** registered on `<all_urls>`; instantiates `SnippetManager` and `AutocompleteManager`; keep-alive pinger; Readability scan | **Deleted** at the end of this phase. Snippets move to a per-origin dynamic script; autocomplete is removed until Phase 4 |
| `entrypoints/toolbar.content.tsx` (433 LOC) | **[built]** six AI hosts, shadow root, five modals | Untouched this phase. Replaced in Phase 5 by the side panel + overlay |
| `entrypoints/offscreen/main.ts` (166 LOC) | **[built]** WebLLM host, `cold→loading→hot→error`, GPU keep-alive tick | Gains the spike harness only. Its WebLLM mechanism is not modified |
| `lib/db/dexie-db.ts` (115 LOC) | **[built-broken]** v1 schema indexes `isActive` as a boolean; seeds write `isActive: true` | Migrated to v2: `isActive` becomes `0 \| 1`, three agent tables added, `analytics` dropped |
| `lib/cache/cache-manager.ts` (179 LOC) | **[built-broken]** `where('isActive').equals(1)` against a boolean-valued index — matches nothing | Fixed by the v2 migration; `getActiveProfile` gains a defined cold-start contract |
| `lib/ui/autocomplete-manager.ts` (162 LOC) | **[built-broken]** on by default, `<all_urls>`, `isValidTarget()` accepts `type="password"`, ghost text built with `innerHTML` from model output | **Removed from the build.** Returns in Phase 4 under §3.7.22's four conditions |
| `lib/ui/snippet-manager.ts` (172 LOC) | **[built-broken]** popover appended to `document.body`, not a shadow root; `isValidTarget()` accepts `type="password"` | Popover moved into a closed shadow root; classifier replaced by `page/sensitive.ts` |
| `lib/adapters/groq-adapter.ts` (64 LOC) | **[built-broken]** key read from `chrome.storage.sync`; `DEFAULT_MODEL = 'llama-3.1-70b-versatile'` (decommissioned) | Key moved to `chrome.storage.local` with a one-time migration and a user-visible notice; model id corrected |
| `lib/adapters/llm-router.ts` (98 LOC) | **[built]** `FALLBACK_ORDER = ['webgpu','ollama','groq']`, a silent cascade across the locality boundary | **Untouched this phase.** Replaced wholesale in Phase 4 by `lib/model/router.ts`. Deleting it now would break every working text capability for three phases |
| `lib/types/llm.types.ts` (38 LOC) | **[built-broken]** `WebGPUModel` declares three model ids; `options/App.tsx:511-516` offers six entirely different ones | Union corrected to the six actually offered |
| `lib/agents/context-update-agent.ts` (124 LOC) | **[dead]** imported by nothing (`grep` returns no importer) | Left dead and untouched. Phase 8 decides its fate |
| `lib/utils/pii-scrubber.ts` (33 LOC) | **[built-broken]** `\b\d{10,12}\b` matches order numbers, timestamps and IDs | Phone rule narrowed |
| `wxt.config.ts` (39 LOC) | **[built]** declares `alarms` (used only for the dead keep-alive) and no `tabs`, while `background.ts` calls `chrome.tabs.query/sendMessage/create` | Permissions rewritten to §3.9's target set |
| tests | **none** | Vitest, Playwright, CI, capture harness created |

**Two facts worth stating precisely, because later phases depend on getting them right.**

First, `<all_urls>` is not in the `permissions` array — it arrives through `defineContentScript({ matches: ['<all_urls>'] })` in `content.ts`, which WXT compiles into a `content_scripts` manifest entry. That entry is what grants install-time access to every page and is what R-4 warns about. Removing the entrypoint removes the access.

Second, `chrome.tabs.query` and `chrome.tabs.create` do not throw without the `tabs` permission — they succeed, with `url`/`title` stripped from results. The current heartbeat therefore fails *silently* rather than loudly, which is why the defect survived. The fix is deletion, not declaration (§3.7.18).

---

## 3. Dexie Schema v2

### 3.1 The defect, stated exactly

IndexedDB key paths cannot index a JavaScript boolean — a record whose indexed property is `true` or `false` is simply absent from that index. `dexie-db.ts` declares `profiles: '++id, name, isActive, createdAt'` and `seedDefaultProfiles()` writes `isActive: true`. `cache-manager.ts:37` and `:48` then run `db.profiles.where('isActive').equals(1).first()`, which matches nothing — not because `1 !== true`, but because no profile is in the index at all. On a warm cache `getActiveProfile()` still works, because it first scans `profileCache.values()` for `p.isActive`. On a **cold** service worker the cache is empty, the query returns `undefined`, and `background.ts` `REFACTOR`/`SCORE`/`GENERATE` silently run with no profile context. That is PR-POL-5, and it is silent, which is what makes it serious.

### 3.2 The v2 schema

```ts
// lib/db/dexie-db.ts
class ProPromptDB extends Dexie {
  profiles!: Table<Profile>;
  snippets!: Table<Snippet>;
  promptHistory!: Table<PromptHistoryEntry>;
  settings!: Table<Setting>;
  runs!: Table<RunRecord>;
  runEvents!: Table<RunEvent>;
  sitePolicy!: Table<SitePolicy>;
  tasks!: Table<SavedTask>;

  constructor() {
    super('ProPromptEngine');

    // v1 retained verbatim so an existing install can be opened and upgraded.
    this.version(1).stores({
      profiles: '++id, name, isActive, createdAt',
      snippets: '++id, prefix, profileId, createdAt',
      promptHistory: '++id, profileId, score, createdAt',
      settings: 'key',
      analytics: '++id, event, timestamp',
    });

    this.version(2)
      .stores({
        // analytics: null drops the table. One event kind was ever written
        // ('context_added'); AnalyticsView reads promptHistory, not analytics.
        analytics: null,
        profiles: '++id, name, isActive, createdAt',
        snippets: '++id, prefix, profileId, createdAt',
        promptHistory: '++id, profileId, score, createdAt',
        settings: 'key',
        runs: '++id, state, startedAt, origin',
        runEvents: '++id, runId, seq, kind, at, tabId',
        sitePolicy: 'origin, grantedAt',
        tasks: '++id, name, *tags, lastUsedAt, useCount',
      })
      .upgrade(async (tx) => {
        // Normalise isActive to 0 | 1 so the index actually contains every row.
        const profiles = await tx.table('profiles').toArray();
        let activeSeen = false;
        for (const p of profiles) {
          const isActive = (p.isActive === true || p.isActive === 1) && !activeSeen;
          if (isActive) activeSeen = true;
          await tx.table('profiles').update(p.id, { isActive: isActive ? 1 : 0 });
        }
        // Cold-start contract: exactly one active profile, always.
        // If the upgrade found none (the normal case for an install that has
        // been running with the defect), promote the lowest id rather than
        // leaving the product with no profile.
        if (!activeSeen && profiles.length > 0) {
          const first = profiles.reduce((a, b) => (a.id! < b.id! ? a : b));
          await tx.table('profiles').update(first.id, { isActive: 1 });
        }
      });
  }
}
```

`isActive` changes type in `profile.types.ts` from `boolean` to `0 | 1`, and every write site is updated: `seedDefaultProfiles()` (`isActive: 1` on All-Rounder, `0` on the other five) and `cacheManager.setActiveProfile()` (`modify({ isActive: 0 })` then `update(id, { isActive: 1 })`). The in-memory cache-sync loop in `setActiveProfile` becomes `p.isActive = k === id ? 1 : 0`.

**Why `0 | 1` and not a separate `activeProfileId` setting.** A settings row would also work and would arguably be cleaner, but it introduces a second source of truth about which profile is active and a window in which the row points at a deleted profile. Keeping the flag on the record and making the index correct is the smaller change and leaves `getActiveProfile()`'s call sites untouched.

### 3.3 New table shapes

Written now so Phases 3, 5 and 6 write into a schema that already exists rather than migrating again. Fields marked *(Phase N)* are present from v2 and written from that phase.

```ts
// lib/types/run.types.ts   [new]
export type RunState =
  | 'planning'                 // admitted; plan not yet produced
  | 'awaiting_plan_approval'   // plan shown; Suggest/Supervised hold here
  | 'running'
  | 'awaiting_approval'        // an Always-tier action is queued
  | 'awaiting_user'            // ask_user is outstanding
  | 'paused'                   // user pressed Pause
  | 'taken_over'               // user is driving; agent suspended
  | 'halted'                   // interrupted, revoked, or backend detached
  | 'stopped'                  // user pressed Stop
  | 'failed'
  | 'completed';               // includes completed_with_gaps

export interface RunRecord {
  id?: number;
  goal: string;                       // the user's original text, never rewritten
  state: RunState;
  mode: 'suggest' | 'step' | 'supervised' | 'watch';   // 'watch' is Phase 11
  posture: 'local-only' | 'hybrid';
  backend: 'dom' | 'cdp';             // 'cdp' is Phase 9
  origin: string;                     // the origin the run was started on
  scope: string[];                    // every origin granted to this run
  roster: number[];                   // tabIds; length 1 until Phase 7
  budgets: RunBudgets;                // SHARED across the roster (§3.7.16)
  plan?: Plan;                        // the approved plan, as executed
  outcome?: 'completed' | 'completed_with_gaps' | 'failed' | 'stuck' | 'stopped';
  startedAt: number; endedAt?: number;
  profileId?: number;                 // (Phase 8) fact attribution
}

export interface RunBudgets {
  maxActions: 40;
  maxRetriesPerStep: 3;
  maxPlannerCalls: 30;
  maxWallClockMs: 720_000;
}

export interface RunEvent {
  id?: number;
  runId: number;
  seq: number;                        // monotonic per run; assigned by journal.ts
  kind: RunEventKind;
  at: number;
  tabId: number | null;               // null for run-level events
  data: unknown;                      // validated by the per-kind Zod schema
}
```

`runEvents.tabId` is indexed from v2 even though nothing writes a non-null value until Phase 7. Adding the index later would mean a third migration on a table that by then holds every run the user has ever performed.

```ts
// lib/db/policy-store.ts   [new]
export interface SitePolicy {
  origin: string;                     // primary key, e.g. "https://example.com"
  capabilities: Verb[];               // narrower than the vocabulary, never wider (PR-SEC-6)
  defaultMode: 'suggest' | 'step' | 'supervised';
  grantedAt: number;
  revokedAt?: number;                 // set rather than deleted, so history is auditable
}
```

A revoked origin keeps its row with `revokedAt` set. Deleting it would make "was this site ever granted?" unanswerable, and the run history that references it would dangle.

---

## 4. Per-Origin Runtime Grants (PRE-4, PR-SEC-5…9)

### 4.1 The manifest

```ts
// wxt.config.ts
manifest: {
  name: 'Pro Prompt',
  version: '1.0.0',
  permissions: [
    'storage',      // Dexie is IndexedDB, but storage.local/session carry keys and run flags
    'scripting',    // registerContentScripts for granted origins
    'offscreen',    // the agent runtime and every inference engine
    'sidePanel',    // the cockpit (Phase 5)
    'activeTab',    // the popup's "grant this site" flow needs the current tab's URL
  ],
  optional_host_permissions: ['*://*/*'],
  host_permissions: [
    'http://localhost:11434/*',   // Ollama, local, required for a Local-only planner
  ],
  // Groq and other remote providers move to optional_host_permissions,
  // requested at the point the user enters a key (Phase 4).
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  },
  side_panel: { default_path: 'sidepanel.html' },   // the file arrives in Phase 5
  options_ui: { page: 'options.html', open_in_tab: true },
}
```

Removed and why:

| Removed | Reason |
|---|---|
| `alarms` | Its only use is `chrome.alarms.create('sw-keepalive', …)` plus a listener for `'webgpu-heartbeat'`, an alarm no code ever creates. Both go with the keep-alive. `alarms` returns in Phase 11 for scheduled runs and only then (§3.9) |
| `https://api.groq.com/*` from `host_permissions` | Becomes optional, requested when the user configures a remote provider. A user who never uses Hybrid never grants it |
| the `<all_urls>` content-script entry | Deleting `entrypoints/content.ts` removes it. This is the single largest liability closure in the phase |
| `web_accessible_resources` for `*.css` on `<all_urls>` | Only the toolbar's shadow-root UI needs it, and WXT's `cssInjectionMode: 'ui'` handles that for the origins the toolbar actually matches |

`tabs` is **not** added. `chrome.tabs.query` over granted origins already returns `url` and `title` for exactly those tabs (§3.7.18); nothing in this phase or any later one needs more.

### 4.2 `lib/policy/scope.ts`

```ts
// lib/policy/scope.ts   [new] — runs in the service worker
import { db } from '@lib/db/dexie-db';

const AGENT_SCRIPT_ID_PREFIX = 'pp-agent-';

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
 */
export async function grantOrigin(origin: string): Promise<boolean> {
  const origins = [toMatchPattern(origin)];
  const granted = await chrome.permissions.request({ origins });
  if (!granted) return false;

  await chrome.scripting.registerContentScripts([{
    id: AGENT_SCRIPT_ID_PREFIX + origin,
    matches: origins,
    js: ['content-scripts/agent.js'],       // WXT's output path for agent.content.ts
    runAt: 'document_idle',
    world: 'ISOLATED',                      // explicit: never MAIN (§3.9)
    persistAcrossSessions: true,
  }]);

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
 * user can revoke from chrome://extensions without telling us. The database row
 * is a record of intent; chrome.permissions.contains is the truth.
 */
export async function isGranted(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [toMatchPattern(origin)] });
}
```

**Why `isGranted` reads Chrome rather than `sitePolicy`.** A user who revokes host access from `chrome://extensions` never touches our database. If the gate trusted `sitePolicy`, it would permit actions on an origin Chrome has already taken away — and the action would then fail at the platform level, producing a confusing failure instead of a clean `OUT_OF_SCOPE` refusal. `sitePolicy` carries the *capability narrowing and mode default*; Chrome carries the *access*. Both must agree, and Chrome wins.

### 4.3 Drift reconciliation on startup

`chrome.permissions.onRemoved` fires when the user revokes from Chrome's own UI, but it does not fire for revocations that happened while the browser was closed. So both are handled:

```ts
// entrypoints/background.ts
chrome.permissions.onRemoved.addListener(async ({ origins }) => {
  for (const pattern of origins ?? []) {
    const origin = pattern.replace(/\/\*$/, '');
    await revokeOrigin(origin);        // idempotent; unregister of a missing id is caught
  }
});

chrome.runtime.onStartup.addListener(reconcileGrants);
chrome.runtime.onInstalled.addListener(reconcileGrants);

/** Any sitePolicy row whose permission Chrome no longer holds is marked revoked. */
async function reconcileGrants(): Promise<void> {
  const rows = await db.sitePolicy.filter(r => r.revokedAt === undefined).toArray();
  for (const row of rows) {
    if (!(await isGranted(row.origin))) await revokeOrigin(row.origin);
  }
  // And the inverse: a registered script for an origin we no longer hold.
  const registered = await chrome.scripting.getRegisteredContentScripts();
  for (const s of registered) {
    const origin = s.id.startsWith(AGENT_SCRIPT_ID_PREFIX)
      ? s.id.slice(AGENT_SCRIPT_ID_PREFIX.length) : null;
    if (origin && !(await isGranted(origin))) {
      await chrome.scripting.unregisterContentScripts({ ids: [s.id] }).catch(() => {});
    }
  }
}
```

**Failure mode:** if `registerContentScripts` fails after the permission was granted (duplicate id, quota, or a race with reconciliation), the grant is rolled back — `chrome.permissions.remove` is called and `grantOrigin` returns `false` with the reason surfaced. A held permission with no registered script is worse than no permission, because the popup would show the site as granted while nothing works.

### 4.4 What a grant actually grants in Phase 1

`DEFAULT_CAPABILITIES` in this phase is the empty set of *acting* verbs. A Phase 1 grant registers a content script that does exactly two things: serve snippet expansion (§5.2) and answer a `PING`. There is no perception, no actuation, no run. The grant flow is built now so that Phase 2's perception and Phase 3's actuation land inside a scope model that already exists and is already tested, rather than being retrofitted into one.

```ts
export const DEFAULT_CAPABILITIES: Verb[] = [];   // widened in Phase 2 and Phase 3
```

---

## 5. Closing the Precondition Defects

### 5.1 PRE-1 — Autocomplete removed from the build

`AutocompleteManager` violates three of the four §3.7.22 conditions simultaneously: it runs on every site, its `isValidTarget()` returns `true` for `type="password"`, and its debounced handler posts the **entire field value** to `AUTOCOMPLETE`, which `background.ts:180` hands to `routeInference` — whose cascade reaches Groq when local engines are cold. A password typed into any field on any site can therefore leave the machine.

The fix in this phase is removal, not repair:

1. Delete the `new AutocompleteManager()` construction along with `entrypoints/content.ts`.
2. Delete the `AUTOCOMPLETE` case from `background.ts` and its `MessageType` member.
3. Leave `lib/ui/autocomplete-manager.ts` on disk, unimported, with a header comment naming Phase 4 and §3.7.22. Deleting the file would discard the ghost-text positioning work, which is the one part of it that was correct.
4. Remove the *Autocomplete* toggle from `popup/App.tsx` and `toolbar.content.tsx`, and delete the `autocompleteEnabled` key from `chrome.storage.local` on upgrade so a re-enabled feature in Phase 4 starts from an explicit choice rather than a stale `true`.

**This is a capability regression and is stated as one.** Inline completion is a shipped behaviour users may be relying on, and it disappears for three phases. The alternative — repairing it in place — would require the sensitive-field classifier (Phase 2), the tier router (Phase 4) and the grant model (this phase) to all exist first. Shipping it broken for three phases is not an option, so it is switched off and its return is scheduled.

### 5.2 PRE-2 — No model output or page content reaches the host DOM as markup

Two sites:

**`autocomplete-manager.ts:141`** — `this.overlayDiv.innerHTML = '<span …>' + invisiblePart + '</span><span …>' + suggestion + '</span>'`, where `suggestion` is raw model output and `invisiblePart` is raw user/page text. Closed by §5.1's removal; the Phase 4 rebuild uses two `document.createTextNode` calls into two pre-created spans and never assigns `innerHTML`.

**`snippet-manager.ts:110-150`** — the popover is `document.createElement('div')` appended to `document.body`. Its per-item `title.textContent` / `desc.textContent` writes are already safe, so this is not an injection defect; it is a *host-page-isolation* defect. The popover inherits nothing from the page, but the page can read it, style it, and remove it, and the page's own CSS reset can distort it. PR-PRV-3 asks that content rendered from stored data cannot alter the host page; a bare `div` in `document.body` with a fixed `id` is reachable by any page script.

The fix: mount the popover in a **closed-mode shadow root** on a host element, with all styling inside that root.

```ts
// lib/ui/snippet-manager.ts — replacing the document.body append
private ensureHost(): ShadowRoot {
  if (this.shadow) return this.shadow;
  const host = document.createElement('div');
  // No id. An id is a handle for page script; a random attribute is not useful to it.
  host.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647;';
  document.documentElement.appendChild(host);   // documentElement, not body: some
                                                // sites replace body on route change
  this.shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = SNIPPET_POPOVER_CSS;      // a const string in this module
  this.shadow.appendChild(style);
  this.hostEl = host;
  return this.shadow;
}
```

`mode: 'closed'` means `host.shadowRoot` is `null` to page script, so the page cannot walk into the popover. `all: initial` on the host neutralises inherited page styles. `2147483647` is the maximum 32-bit signed z-index; the popover must sit above site chrome and there is no lower value that is reliably safe across sites.

`SnippetManager.isValidTarget()` is replaced by an import from `lib/page/sensitive.ts` — created in this phase as the single classifier, deepened in Phase 2 (§6).

### 5.3 PRE-3 — Active profile resolves on a cold start

Closed by the v2 migration (§3.2). Two behavioural additions make it stay closed:

```ts
// lib/cache/cache-manager.ts
async getActiveProfile(): Promise<Profile | undefined> {
  for (const p of this.profileCache.values()) if (p.isActive === 1) return p;
  let profile = await db.profiles.where('isActive').equals(1).first();
  if (!profile) {
    // Invariant repair, not a silent fallback: something wrote isActive wrongly.
    // Promote the lowest-id profile, persist it, and log loudly.
    profile = await db.profiles.orderBy('id').first();
    if (profile?.id !== undefined) {
      console.error('[CacheManager] No active profile found — repairing to id', profile.id);
      await this.setActiveProfile(profile.id);
      profile.isActive = 1;
    }
  }
  if (profile?.id !== undefined) this.profileCache.set(profile.id, profile);
  return profile;
}
```

And `deleteProfile` refuses to leave the database with no active profile: deleting the active profile promotes the lowest remaining id within the same Dexie transaction, and deleting the last remaining profile is refused outright.

`tests/unit/profile-store.spec.ts` covers: a v1 database with `isActive: true` opens at v2 with exactly one profile at `isActive: 1`; a v1 database with *no* active profile promotes exactly one; `getActiveProfile()` on an empty cache returns a profile; deleting the active profile leaves exactly one active.

### 5.4 PRE-5 — The Groq key stops replicating

`chrome.storage.sync` replicates to every browser signed into the same Google account, so a key entered on a work machine appears on a personal one. `getGroqConfig()` moves to `chrome.storage.local`, with a one-time migration that also *removes* the synced copy — leaving it behind would mean the key is still replicated and the fix is cosmetic.

```ts
// lib/adapters/groq-adapter.ts
async function getGroqConfig(): Promise<{ apiKey: string; model: string }> {
  const local = await chrome.storage.local.get(['groqApiKey', 'groqModel']);
  if (local.groqApiKey) return { apiKey: local.groqApiKey, model: local.groqModel || DEFAULT_MODEL };

  // One-time migration out of storage.sync, then delete the synced copy.
  const synced = await chrome.storage.sync.get(['groqApiKey', 'groqModel']);
  if (synced.groqApiKey) {
    await chrome.storage.local.set({ groqApiKey: synced.groqApiKey, groqModel: synced.groqModel || DEFAULT_MODEL });
    await chrome.storage.sync.remove(['groqApiKey', 'groqModel']);
    await chrome.storage.local.set({ keyMigrationNotice: Date.now() });
    return { apiKey: synced.groqApiKey, model: synced.groqModel || DEFAULT_MODEL };
  }
  return { apiKey: '', model: DEFAULT_MODEL };
}
```

`keyMigrationNotice` makes the dashboard show, once: *"Your API key was moved to this device only. It was previously synced to every browser signed into your Google account. If you used Pro Prompt on another machine, you will need to re-enter it there."* Telling the user is part of the fix — a key that silently stops working on their second machine is a worse outcome than the defect.

`DEFAULT_MODEL` changes from `'llama-3.1-70b-versatile'` (decommissioned by Groq) to `'llama-3.3-70b-versatile'`. The model id is also surfaced as an editable field in the dashboard, because a hard-coded provider model id will go stale again and a user should not need an extension update to change it.

### 5.5 PRE-4 — Declared permissions match usage

The `wxt.config.ts` rewrite in §4.1 removes `alarms`; the keep-alive deletion in §5.6 removes every `chrome.tabs.*` call the extension makes without a matching permission. What remains after this phase:

| API used | Permission that authorises it |
|---|---|
| `chrome.storage.local` / `.session` | `storage` |
| `chrome.scripting.registerContentScripts` / `executeScript` | `scripting` + the granted host permission |
| `chrome.offscreen.createDocument` | `offscreen` |
| `chrome.permissions.request/remove/contains` | none required |
| `chrome.tabs.create({url: options.html})` | none required — opening a tab needs no permission |
| `chrome.tabs.query` for the popup's current tab | `activeTab` |
| `chrome.sidePanel.*` | `sidePanel` (surface arrives Phase 5) |
| `fetch` to `localhost:11434` | `host_permissions` |
| `fetch` to a remote provider | granted at key-entry time, Phase 4 |

`tests/unit/manifest.spec.ts` asserts this table mechanically: it reads the built `manifest.json` and greps the source tree for `chrome.<namespace>.` call sites, failing if a namespace is called that the manifest does not authorise, or a permission is declared that no source file uses. This is what keeps PRE-4 closed rather than merely closed once.

### 5.6 The three-layer keep-alive is deleted

Three mechanisms exist today and all three go:

1. `background.ts:33-47` — `setInterval` every 20 s doing `chrome.tabs.query({status:'complete'})` then `sendMessage` to every tab. This is one of the two `tabs` violations, and it messages every page in the browser.
2. `background.ts:51` — `chrome.alarms.create('sw-keepalive', {periodInMinutes: 0.4})`, whose handler only logs. Plus a listener for `'webgpu-heartbeat'`, an alarm nothing creates.
3. `content.ts:31-40` — the content-script side, pinging the SW every 20 s from every page.

They existed to keep the service worker alive across a 30-second WebLLM inference. With the run loop moving to the offscreen document in Phase 5 and every action waking the SW by message anyway, none is needed. Removing them also removes a continuous 20-second wake cycle across every open tab, which is a real battery cost for no benefit.

**Retained:** the offscreen document's own GPU no-op tick (`offscreen/main.ts:48-60`). It solves a different problem — VRAM eviction of loaded weights — and is unaffected by any of this.

### 5.7 The scrubber's phone rule

```ts
// Before: matches "1234567890123" in an order id, a unix ms timestamp, an invoice number.
{ pattern: /\b\d{10,12}\b/g, replacement: '[PHONE_REDACTED]', label: 'phone' },

// After: requires a phone-shaped separator or an international prefix.
{ pattern: /(?:\+\d{1,3}[-.\s]?)?\b\d{3}[-.\s]\d{3,4}[-.\s]\d{4}\b/g,
  replacement: '[PHONE_REDACTED]', label: 'phone' },
{ pattern: /\+\d{1,3}[-.\s]?\d{6,12}\b/g,
  replacement: '[PHONE_REDACTED]', label: 'phone_intl' },
```

The narrowed rule trades recall for precision deliberately: a bare eleven-digit run with no separators is more often an identifier than a phone number, and redacting identifiers corrupts the prompt the user actually wrote. **This is stated in the doc and in the code comment because it is a real reduction in coverage.** The scrubber is the fourth line of defence (§3.7.23), behind exclusion, minimisation and condensation, and it is never presented to a user as a guarantee. `tests/unit/scrubber.spec.ts` carries both directions: a corpus of true phone numbers that must still redact, and a corpus of order ids, timestamps, ISBNs and invoice numbers that must now survive.

### 5.8 The model union

```ts
// lib/types/llm.types.ts
export type WebGPUModel =
  | 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC'
  | 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'
  | 'gemma-2-2b-it-q4f32_1-MLC'
  | 'Phi-3-mini-4k-instruct-q4f16_1-MLC'
  | 'TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC'
  | 'stablelm-2-zephyr-1_6b-q4f16_1-MLC';

export const WEBGPU_MODELS: readonly WebGPUModel[] = [ /* the six above */ ] as const;
```

`options/App.tsx:511-516` stops carrying its own array literal and maps `WEBGPU_MODELS`. Today the two lists share **no** entries — the type declares three ids the UI never offers, and the UI offers six the type rejects. `strict` typechecking did not catch it because the array literal is untyped `string[]`. One exported const is what stops it recurring.

---

## 6. `lib/page/sensitive.ts` — the single classifier

Created in this phase because three consumers need it immediately: the snippet manager (§5.2), the Phase 2 perception layer, and the Phase 4 autocomplete rebuild. One classifier means one place to be right and one place the tests cover (§3.7.22).

```ts
// lib/page/sensitive.ts   [new] — content script; pure, synchronous, no I/O
export type SensitiveKind =
  | 'password' | 'payment' | 'otp' | 'file' | 'hidden' | null;

const SENSITIVE_INPUT_TYPES = new Set(['password']);
const SENSITIVE_AUTOCOMPLETE = new Set([
  // WHATWG autofill tokens that identify payment and credential fields.
  'current-password', 'new-password', 'one-time-code',
  'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type',
  'cc-name', 'cc-given-name', 'cc-family-name',
]);
// Matched against name / id / aria-label / placeholder / the field's <label> text.
const SENSITIVE_NAME_RE =
  /\b(pass(word|wd|phrase)|pwd|cvv|cvc|csc|card[\s_-]?(number|num|no)|cc[\s_-]?num|
     security[\s_-]?code|otp|one[\s_-]?time|2fa|mfa|auth(entication)?[\s_-]?code|
     verification[\s_-]?code|pin|iban|sort[\s_-]?code|routing[\s_-]?number|
     account[\s_-]?number|ssn|social[\s_-]?security|tax[\s_-]?id)\b/ix;

export function classifySensitive(el: Element): SensitiveKind {
  if (!(el instanceof HTMLElement)) return null;
  const tag = el.tagName;

  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') || 'text').toLowerCase();
    if (SENSITIVE_INPUT_TYPES.has(type)) return 'password';
    if (type === 'file') return 'file';              // PR-ACT-8: reported, never filled
    if (type === 'hidden') return 'hidden';

    const ac = (input.getAttribute('autocomplete') || '').toLowerCase();
    // autocomplete may carry section/billing prefixes: "section-a billing cc-number"
    for (const token of ac.split(/\s+/)) {
      if (SENSITIVE_AUTOCOMPLETE.has(token)) {
        return token === 'one-time-code' ? 'otp'
             : token.startsWith('cc-') ? 'payment' : 'password';
      }
    }
    if (input.inputMode === 'numeric' && (input.maxLength === 4 || input.maxLength === 6)
        && SENSITIVE_NAME_RE.test(descriptiveText(el))) return 'otp';
  }

  if (SENSITIVE_NAME_RE.test(descriptiveText(el))) {
    const t = descriptiveText(el);
    if (/otp|one[\s_-]?time|2fa|mfa|verification|auth/i.test(t)) return 'otp';
    if (/cvv|cvc|csc|card|iban|routing|account[\s_-]?number/i.test(t)) return 'payment';
    return 'password';
  }
  return null;
}

/** Everything a human would read as naming this field, concatenated once. */
function descriptiveText(el: HTMLElement): string {
  const parts = [
    el.getAttribute('name'), el.id, el.getAttribute('aria-label'),
    el.getAttribute('placeholder'), el.getAttribute('data-testid'),
    labelTextFor(el),
  ];
  return parts.filter(Boolean).join(' ');
}
```

**Two deliberate biases, stated because they have costs.**

*False positives are acceptable; false negatives are not.* A field named `account_number` that is really a customer reference gets excluded, and the agent reports it as something only the user can fill. That is a lost capability. A payment field that is *not* excluded is a hard-gate violation (§3.8). The asymmetry is total, so the classifier errs wide and the report explains the exclusion rather than hiding it.

*It is a heuristic over authored markup and can be defeated by a page that wants to.* A site that labels its password field `favourite_colour` will not be caught. That is why exclusion is layer one of five (§3.7.23) and not the whole defence, and it is why PR-SEC-16 forbids ever describing this as immunity.

`tests/unit/never-rules.spec.ts` runs the classifier over a fixture corpus in `tests/e2e/fixtures/sensitive-corpus.html`: Stripe Elements markup, a PayPal card form, three OTP shapes (6-digit split inputs, single `inputmode=numeric`, an `autocomplete="one-time-code"` field), four password shapes, plus twenty non-sensitive fields — search, quantity, postcode, phone, date of birth — that must classify `null`.

---

## 7. Zod 4, Schemas and `Result`

### 7.1 The dependency

`zod@^4` is the one new runtime dependency of this phase. It earns its place by serving two enforcement points from one definition (§3.7.14): `z.toJSONSchema()` produces the JSON Schema handed to a constrained-decoding engine, and the same object validates at the gate. Two hand-maintained descriptions of the action shape would drift, and the drift would be silent.

Phase 1 creates the schema files with the shapes it actually needs, and no more. `action.schema.ts` and `plan.schema.ts` are created as stubs carrying only their file header and a `// Phase 3` / `// Phase 4` marker — writing them now would mean writing the verb vocabulary before the gate that enforces it exists.

```ts
// lib/schemas/message.schema.ts   [new]
import { z } from 'zod';

export const OriginSchema = z.string().refine(
  (s) => { try { const u = new URL(s); return u.origin === s && /^https?:$/.test(u.protocol); }
           catch { return false; } },
  'must be a bare http(s) origin with no path',
);

export const GrantOriginRequest = z.object({
  type: z.literal('GRANT_ORIGIN'),
  payload: z.object({ origin: OriginSchema }),
});

export const RevokeOriginRequest = z.object({
  type: z.literal('REVOKE_ORIGIN'),
  payload: z.object({ origin: OriginSchema }),
});

export const ExtensionRequest = z.discriminatedUnion('type', [
  GrantOriginRequest, RevokeOriginRequest, /* … existing message types … */
]);
```

Every message the service worker receives is parsed through `ExtensionRequest` before its handler runs. A message that fails validation is answered with `{status:'error', message:'INVALID_MESSAGE'}` and journaled to the console with the failing path — never coerced, never partially handled. The existing 40-member `MessageType` string union stays as the discriminant; Zod adds the payload validation it never had.

### 7.2 `lib/utils/result.ts`

```ts
// lib/utils/result.ts   [new]
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; detail?: unknown };

export const Ok  = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E, detail?: unknown): Result<never, E> => ({ ok: false, error, detail });
```

**The rule this exists to enforce: no `throw` crosses a context boundary.** An exception thrown in the service worker and sent through `chrome.runtime.sendMessage` arrives as `undefined` at the caller — the structured clone algorithm does not carry `Error` subclasses or stack traces, and the caller sees a silent success with no data. That failure shape is present in the current code (`webgpu-adapter.ts` throws inside a `sendMessage` handler chain) and it is why some model errors surface as an empty string rather than a message. Every handler returns `Result`; the message router serialises it.

---

## 8. Test Infrastructure (PRE-6)

### 8.1 Vitest

```ts
// vitest.config.ts   [new]
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@lib': path.resolve(__dirname, './lib') } },
  test: {
    environment: 'happy-dom',        // ~4x faster than jsdom to boot, and the DOM
                                     // surface we exercise (shadow roots, elementFromPoint,
                                     // MutationObserver) is fully supported
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      // Only the files whose correctness is a safety property. A global
      // percentage across a UI-heavy repo measures nothing useful.
      include: ['lib/policy/**', 'lib/page/sensitive.ts', 'lib/agent/**', 'lib/schemas/**'],
      thresholds: { lines: 90, functions: 90, branches: 85 },
    },
  },
});
```

`tests/setup.ts` installs a `chrome` API double — an in-memory `storage.local/session/sync`, a `permissions` store with `request/remove/contains`, a `scripting` registry, and a `runtime.sendMessage` that routes to registered handlers. It is ~180 lines and is the reason the gate and the scope module can be unit-tested at all; mocking `chrome` per test file would produce six divergent doubles.

The Phase 1 suites: `manifest.spec.ts`, `profile-store.spec.ts`, `scrubber.spec.ts`, `never-rules.spec.ts`, `scope.spec.ts`, `message-schema.spec.ts`. The remaining suites named in §3.6 are created as failing placeholders (`it.todo`) so the file tree matches the architecture from the first commit.

### 8.2 Playwright

```ts
// playwright.config.ts   [new]
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,     // a persistent context with an extension is a single
                            // browser profile; parallel workers collide on it
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', video: 'retain-on-failure' },
  webServer: {
    command: 'npx http-server tests/e2e/fixtures -p 5599 --silent',
    port: 5599, reuseExistingServer: true,
  },
});
```

```ts
// tests/e2e/fixture.ts — the extension harness every e2e spec imports
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';

const EXT = path.resolve(__dirname, '../../.output/chrome-mv3');

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({ }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    // MV3: the service worker may not have started yet on a cold profile.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    await use(sw.url().split('/')[2]);
  },
});
export const expect = test.expect;
```

Headless is not used. An extension with a side panel and `chrome.permissions.request` needs a real browser UI, and `--headless=new` does not reliably drive permission prompts. CI runs it under `xvfb-run`.

Phase 1 e2e specs — three, deliberately small, each proving one thing this phase claims:

| Spec | Asserts |
|---|---|
| `grant-revoke.spec.ts` | Granting `http://localhost:5599` registers a script (`chrome.scripting.getRegisteredContentScripts()` contains `pp-agent-http://localhost:5599`) and the fixture page's `window.__proPromptPing()` answers. Revoking unregisters it and the ping times out |
| `no-all-urls.spec.ts` | On a page whose origin was never granted, `chrome.scripting.getRegisteredContentScripts()` matches nothing, and the built `manifest.json` contains no `content_scripts` entry with `<all_urls>` |
| `sensitive-untouched.spec.ts` | On `fixtures/sensitive-corpus.html`, typing into every field and waiting 3 s produces zero `chrome.runtime.sendMessage` calls carrying any field's value — asserted by a service-worker-side recorder installed by the fixture |

### 8.3 The capture harness

Phase 12's evaluation layer needs frozen real-page captures (Q5), and building the capture tooling then would mean Phase 12 also debugging the tooling. It is built now, small, and used immediately for the sensitive-field corpus.

```
tests/captures/
├── capture.ts            # Playwright script: navigate, wait for network idle,
│                         #   inline every same-origin CSS/font/image as data URI,
│                         #   strip <script>, write index.html + meta.json
├── serve.ts              # Serves a capture on a fixed port with a fixed origin,
│                         #   so grants and origin checks are stable across runs
└── <site-slug>/
    ├── index.html        # the frozen page
    └── meta.json         # { capturedAt, sourceUrl, viewport, notes, ppSchemaVersion: 1 }
```

`<script>` removal is what makes a capture deterministic and is also what makes it *less* real than the live web — a capture cannot reproduce a React re-render or a lazy-loaded section. That limit is recorded in `meta.json` notes per capture and is why the live set in Phase 12 exists as a third layer rather than being replaced by captures.

Phase 1 produces exactly one capture — a public government form page with a long field list — used as a realistic input to the sensitive-field corpus and as proof the harness round-trips.

### 8.4 CI

```yaml
# .github/workflows/ci.yml   [new]
name: ci
on: { push: { branches: ['**'] }, pull_request: }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - run: npm run compile              # tsc --noEmit, strict
      - run: npm run test:unit -- --coverage
      - run: npm run build                # wxt build → .output/chrome-mv3
      - run: npx playwright install --with-deps chromium
      - run: xvfb-run -a npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/, retention-days: 7 }
```

```jsonc
// package.json scripts added
"compile":    "tsc --noEmit",
"test:unit":  "vitest run",
"test:watch": "vitest",
"test:e2e":   "playwright test",
"ci":         "npm run compile && npm run test:unit && npm run build && npm run test:e2e"
```

`tsconfig.json` gains `"strict": true`. WXT's generated `.wxt/tsconfig.json` does not set it, and the contracts in §3.3.2 are only worth writing under strict null checks. Expect this to surface roughly 30–60 existing errors across `options/App.tsx`, `background.ts` and the adapters — chiefly implicit `any` on `message.payload` casts and unchecked `profile.id`. Fixing them is task 1.4 and is the reason `strict` is turned on in Phase 1 rather than later, when there would be four times as much code to fix.

---

## 9. The Runtime Spike (Q8 + Q11)

Everything from Phase 4 onward assumes both answers. The spike is a **throwaway entrypoint** — `entrypoints/spike/` — deleted at the end of the phase, leaving only `Docs/planning/spike_report_phase1.md`.

### 9.1 Q8 — Offscreen document survival

**Question:** does an offscreen document created with `reasons: ['WORKERS']` survive 30 minutes of a run's lifetime, including a screen lock and a sleep/wake cycle?

**Protocol.** The spike offscreen document writes a heartbeat to `chrome.storage.local` every 5 s: `{seq, at, sinceCreateMs}`. A spike page in a tab renders the series. Three scenarios, each run three times on the reference machine (mid-range 2023 laptop, Chrome stable):

| # | Scenario | Duration |
|---|---|---|
| S1 | Idle, browser foregrounded, no interaction | 30 min |
| S2 | Screen locked at t=2 min, unlocked at t=25 min | 30 min |
| S3 | System sleep at t=2 min, wake at t=20 min | 30 min |

**Measured:** whether the document is still alive at t=30 min (`chrome.runtime.getContexts` returns it), the largest heartbeat gap, and whether the document's JS state (`globalThis.__spikeCounter`) survived or the document was recreated. A recreated document with a reset counter counts as **not survived**, because a run's in-memory state would have been lost.

**Budget:** ≥90 % survival across the nine runs (§3.8).

**What each outcome means, decided now so the result cannot be rationalised later:**

| Result | Consequence |
|---|---|
| ≥90 % | The 12-minute wall-clock budget stands. Nothing changes |
| 60–90 % | The wall-clock budget drops to the largest duration that survived ≥90 % of the time, rounded down to the nearest minute, and §3.8 is amended. **No durability machinery is added** (§3.7.11) |
| <60 %, or S3 always kills it | Runs are declared non-survivable across sleep. The Supervisor journals `run.interrupted` on wake and halts (already the design). The wall clock drops to 5 minutes and the roadmap records that long runs are not a supported shape |

### 9.2 Q11 — `LanguageModel` reachability from an offscreen document

**The single riskiest unverified assumption in the architecture.** An offscreen document is a DOM document rather than a worker, so `LanguageModel` *should* be exposed — but "should" is not "is", and Phases 3, 4, 10 and the entire ≥98 % schema-valid budget rest on it.

Five probes, each answered yes/no with the observed value recorded:

| # | Probe | Method |
|---|---|---|
| P1 | Is `LanguageModel` defined in the offscreen global scope? | `typeof LanguageModel !== 'undefined'` |
| P2 | What does availability report? | `await LanguageModel.availability()` → `unavailable \| downloadable \| downloading \| available` |
| P3 | Does a session create and answer? | `create()`, then `prompt('Reply with the single word: ok')`, timed |
| P4 | Does `responseConstraint` constrain decoding? | `prompt(…, { responseConstraint: z.toJSONSchema(TestVerbSchema) })` × 20 on a deliberately confusing prompt; count how many parse against the schema first-try |
| P5 | Does image input work? | `prompt([{role:'user', content:[{type:'text', value:'What colour is this square?'}, {type:'image', value: blob}]}])` with a solid-red 64×64 PNG |

Also recorded, because they set Phase 4's budgets: cold `create()` latency, `clone()` latency from a warm session, and a 20-token continuation's p50/p95 round trip measured **from the content script**, since the two message hops are part of the ≤400 ms inline budget (§3.8, Q6).

**The declared fallback, written before the measurement so it cannot be adjusted to fit:**

| Probe fails | Consequence |
|---|---|
| P1 or P2 unavailable on the reference machine | Judge tier falls to WebLLM. **A second probe is required** from a `sidepanel` document; if `LanguageModel` is reachable there but not from offscreen, Phase 4 routes judge calls through the side panel with the offscreen document as fallback, and §3.7.14's constrained decoding survives at the cost of one message hop and a dependency on the panel being open |
| P4 shows constraint is ignored | The ≥98 % schema-valid budget collapses to the 85 % validate-and-repair path. `action.schema.ts` still drives validation; the repair ladder becomes the primary path and Phase 4's error budget is amended |
| P5 fails | Local vision does not exist. §3.7.13's "a remote vision model is the better choice" becomes "the only option", and Phase 10 has no Local-only visual escalation — `look_at` on a Local-only run returns `ask_user` |

The report states, for each probe, the Chrome version, the machine, the raw output, and the consequence taken. A probe that could not be run — because the device is below Chrome's hardware floor for the built-in model — is recorded as **not measured**, never as a pass.

### 9.3 The baseline for SC-11

Before any of this phase's changes land, `tests/bench/text-ops.bench.ts` records the current end-to-end latency of `REFACTOR`, `SCORE`, `GENERATE` and `SAVE_CONTEXT` against a fixed 400-word prompt on each of the three current providers, p50 and p95 over 20 runs each. The numbers go into `Docs/planning/baseline_phase1.md` and are the datum Phase 8 must stay within +150 ms of. Baselining *after* the changes would measure the wrong thing, so this is task 1.1, run before task 1.2.

---

## 10. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 1.1 | Record the pre-change text-operation baseline | `Docs/planning/baseline_phase1.md` exists with p50/p95 for REFACTOR, SCORE, GENERATE, SAVE_CONTEXT × 3 providers, 20 runs each, and names the machine and Chrome version |
| 1.2 | Add Zod 4; create `message.schema.ts` and `result.ts`; stub `action`/`plan`/`snapshot` schemas | `npm ls zod` shows a 4.x version; every `chrome.runtime.onMessage` handler in `background.ts` parses through `ExtensionRequest`; sending `{type:'GRANT_ORIGIN', payload:{origin:'not-a-url'}}` returns `{status:'error', message:'INVALID_MESSAGE'}` |
| 1.3 | Vitest + happy-dom + `tests/setup.ts` chrome double | `npm run test:unit` exits 0 with at least one passing assertion in each of the six Phase 1 suites |
| 1.4 | Turn on `strict: true` and fix every resulting error | `npm run compile` exits 0 with zero errors and no `@ts-expect-error` added to a `lib/` file |
| 1.5 | Dexie v2 migration and the `isActive: 0\|1` normalisation | `profile-store.spec.ts` passes all four cases in §5.3; opening an existing v1 profile database yields exactly one row with `isActive === 1`; `db.tables.map(t=>t.name)` contains `runs`, `runEvents`, `sitePolicy`, `tasks` and does not contain `analytics` |
| 1.6 | `getActiveProfile` cold-start repair and `deleteProfile` invariant | With an empty LRU cache and a database where every profile has `isActive: 0`, `getActiveProfile()` returns a profile and persists the repair; deleting the only profile is refused with `Err('LAST_PROFILE')` |
| 1.7 | Move the Groq key to `storage.local`, delete the synced copy, correct the model id | After one call to `getGroqConfig()`, `chrome.storage.sync.get('groqApiKey')` returns `{}` and `chrome.storage.local.get('groqApiKey')` returns the key; the dashboard shows the migration notice exactly once; `DEFAULT_MODEL` is `'llama-3.3-70b-versatile'` |
| 1.8 | Delete the three-layer keep-alive and the dead alarm | `grep -rn 'chrome.alarms\|SW_HEARTBEAT\|KEEP_ALIVE' entrypoints lib` returns no hits; the offscreen GPU tick at `offscreen/main.ts` still runs |
| 1.9 | Rewrite `wxt.config.ts` permissions; delete `entrypoints/content.ts` | The built `manifest.json` `permissions` array is exactly `["storage","scripting","offscreen","sidePanel","activeTab"]`; no `content_scripts` entry matches `<all_urls>` (§15: `toolbar.content.tsx`'s own six-AI-host entry is untouched until Phase 5, so the key itself is still present — see §15); `optional_host_permissions` is `["*://*/*"]`; `manifest.spec.ts` passes |
| 1.10 | Implement `lib/policy/scope.ts` and the grant/revoke UI in the popup | `grant-revoke.spec.ts` passes: grant registers the script and the fixture answers a ping; revoke unregisters it and the ping times out within 2 s |
| 1.11 | Implement grant reconciliation on `onStartup`/`onInstalled` and `permissions.onRemoved` | Manually removing the host permission from `chrome://extensions` while the extension is loaded unregisters the script within one event loop turn and sets `revokedAt`; removing it while the browser is closed does so on next startup |
| 1.12 | Remove `AutocompleteManager` from the build; strip the `AUTOCOMPLETE` message and its UI toggles | `grep -rn 'AutocompleteManager\|AUTOCOMPLETE' entrypoints` returns no hits; `lib/ui/autocomplete-manager.ts` still exists with a Phase 4 header comment; `sensitive-untouched.spec.ts` passes |
| 1.13 | Implement `lib/page/sensitive.ts`; move the snippet popover into a closed shadow root using it | `never-rules.spec.ts` passes over the full corpus with zero false negatives; on a fixture page, `document.querySelector('div').shadowRoot` is `null` for the popover host, and typing `/dev` still expands the snippet |
| 1.14 | Narrow the scrubber's phone rule | `scrubber.spec.ts` passes both corpora: every true phone number redacts, and none of the 12 identifier fixtures does |
| 1.15 | Correct the `WebGPUModel` union and drive the options list from `WEBGPU_MODELS` | `npm run compile` passes with the options list typed as `readonly WebGPUModel[]`; the dashboard offers exactly six models, all of which load |
| 1.16 | Playwright harness, the three e2e specs, and the capture tool | `npm run test:e2e` exits 0; `tests/captures/<slug>/index.html` opens in a browser and renders without network access |
| 1.17 | CI workflow | A push runs `compile → test:unit → build → test:e2e` and the badge is green; a deliberately broken assertion turns it red and uploads the Playwright report |
| 1.18 | Run the Q8 survival spike, nine runs | `spike_report_phase1.md` §Q8 records nine rows with survival, largest gap and counter continuity, and states which of the three §9.1 consequences was taken |
| 1.19 | Run the Q11 `LanguageModel` probes | `spike_report_phase1.md` §Q11 records P1–P5 with raw outputs, the cold/clone/round-trip latencies, and the consequence taken for every failed probe. A probe not runnable on the hardware is recorded as *not measured* |
| 1.20 | Delete `entrypoints/spike/` | `grep -rn 'spike' entrypoints` returns no hits; the report remains under `Docs/planning/` |

---

## 11. Milestone Definition

Phase 1 is **complete** when:

> A developer clones the repository, runs `npm ci && npm run ci`, and watches typecheck, 6 unit suites, a production build and 3 Playwright specs all pass, ending with exit code 0. They load `.output/chrome-mv3` unpacked into Chrome and open `chrome://extensions`, where the extension's permission list reads *Storage, Scripting, Offscreen, Side panel, Active tab* — and nothing about reading data on all websites. They visit `http://localhost:5599/sensitive-corpus.html`, type a password into the password field, wait ten seconds, and open the service worker's console: no message carrying that value was ever sent, because the extension has no content script on that page at all. They open the Pro Prompt popup and press **Allow this site**; Chrome's own prompt asks for access to `localhost:5599`; they accept, and the popup badge turns green. Typing `/dev` into the page's comment box now opens the snippet popover — and `document.querySelectorAll('div')` from the page console finds its host element with `shadowRoot === null`, because the popover is closed to the page. They press **Revoke**; the badge greys, and typing `/dev` does nothing. They open the dashboard, which shows a one-time notice explaining that their API key has been moved off Google account sync onto this device only. They open `Docs/planning/spike_report_phase1.md` and read nine survival rows for the offscreen document with a stated verdict on the 12-minute wall clock, and five `LanguageModel` probe results — each with its raw output and, for any failure, the fallback that Phase 4 will now be built on. Nothing in the extension can click, type into, or read a page. That is the point: the foundation is provably inert.

---

## 12. Files to Create

```
pro-prompt-engine/
├── entrypoints/
│   ├── background.ts               # [modify] keep-alive removed, grant handlers, Zod validation
│   ├── content.ts                  # [DELETE]
│   ├── spike/                      # [create then DELETE at 1.20]
│   │   ├── index.html
│   │   ├── main.ts                 #   Q8 heartbeat + Q11 probes
│   │   └── panel.html              #   renders the heartbeat series
│   ├── offscreen/main.ts           # [modify] spike hooks only, removed at 1.20
│   └── popup/App.tsx               # [modify] grant/revoke UI; autocomplete toggle removed
├── lib/
│   ├── policy/scope.ts             # [new] grants, registration, revocation, reconciliation
│   ├── page/sensitive.ts           # [new] the single sensitive-field classifier
│   ├── db/
│   │   ├── dexie-db.ts             # [modify] v2 schema + upgrade
│   │   └── policy-store.ts         # [new] sitePolicy accessors
│   ├── schemas/
│   │   ├── message.schema.ts       # [new] every cross-context payload
│   │   ├── action.schema.ts        # [new, stub] — Phase 3
│   │   ├── plan.schema.ts          # [new, stub] — Phase 4
│   │   └── snapshot.schema.ts      # [new, stub] — Phase 2
│   ├── types/
│   │   ├── run.types.ts            # [new] RunRecord, RunState, RunEvent, RunBudgets
│   │   ├── agent.types.ts          # [new, stub] — Phase 3
│   │   ├── llm.types.ts            # [modify] six-model union + WEBGPU_MODELS
│   │   └── profile.types.ts        # [modify] isActive: 0 | 1
│   ├── utils/
│   │   ├── result.ts               # [new]
│   │   └── pii-scrubber.ts         # [modify] phone rule
│   ├── ui/
│   │   ├── snippet-manager.ts      # [modify] closed shadow root, shared classifier
│   │   └── autocomplete-manager.ts # [unimported] Phase 4 header comment added
│   ├── cache/cache-manager.ts      # [modify] isActive 0|1, cold-start repair
│   └── adapters/groq-adapter.ts    # [modify] storage.local + migration + model id
├── tests/
│   ├── setup.ts                    # [new] chrome API double
│   ├── unit/{manifest,profile-store,scrubber,never-rules,scope,message-schema}.spec.ts
│   ├── unit/{tiers,gate,settle,recovery,run-state,journal,supervisor,ownership,
│   │         pruning,replan-trigger,vision-trigger}.spec.ts   # [new] it.todo placeholders
│   ├── e2e/
│   │   ├── fixture.ts              # [new] persistent-context extension harness
│   │   ├── grant-revoke.spec.ts    # [new]
│   │   ├── no-all-urls.spec.ts     # [new]
│   │   ├── sensitive-untouched.spec.ts # [new]
│   │   └── fixtures/{sensitive-corpus.html, basic-form.html, index.html}
│   ├── captures/{capture.ts, serve.ts, <slug>/}
│   └── bench/text-ops.bench.ts     # [new] the SC-11 baseline
├── Docs/planning/
│   ├── spike_report_phase1.md      # [new] Q8 + Q11, with declared consequences
│   └── baseline_phase1.md          # [new]
├── .github/workflows/ci.yml        # [new]
├── vitest.config.ts                # [new]
├── playwright.config.ts            # [new]
├── wxt.config.ts                   # [modify] permissions rewritten
├── tsconfig.json                   # [modify] strict: true
└── package.json                    # [modify] zod, vitest, playwright, happy-dom, scripts
```

---

## 13. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| Offscreen document survival | §9.1 protocol, nine runs | ≥ 90 % over 30 min (§3.8) |
| Cold `LanguageModel.create()` | `performance.now()` around `create()` in the offscreen spike | Recorded, not gated. Feeds Phase 4's warm-session design |
| `clone()` from a warm session | 20 clones, p50/p95 | Recorded. If p95 > 50 ms the ≤400 ms inline budget is at risk and Phase 4 is told now |
| Schema-valid first attempt, constrained | Probe P4, 20 samples | ≥ 98 % (§3.8). Below 90 % triggers the §9.2 fallback |
| Text-operation latency, pre-change | `tests/bench/text-ops.bench.ts`, 20 runs | Recorded as the SC-11 datum |
| Text-operation latency, post-change | Same bench re-run at 1.20 | Within **+50 ms** of the 1.1 baseline. This phase touches no inference path, so any larger regression is a bug in the Zod message validation and must be found before Phase 2 |
| CI wall clock | GitHub Actions job duration | ≤ 6 min. Above that developers stop waiting for it, and a test practice nobody waits for is not a shipping gate |

---

## 14. Estimated Complexity

| Component | New LOC | Modified LOC | Files |
|---|---|---|---|
| `lib/policy/scope.ts` + reconciliation | ~180 | — | 1 |
| `lib/page/sensitive.ts` | ~140 | — | 1 |
| Dexie v2 + types + policy-store | ~150 | ~60 | 4 |
| Zod schemas + `result.ts` + router validation | ~160 | ~90 | 6 |
| Precondition fixes (5.1–5.8) | ~90 | ~260 | 9 |
| `tests/setup.ts` chrome double | ~180 | — | 1 |
| Unit suites (6 real + 11 placeholders) | ~520 | — | 17 |
| Playwright harness + 3 specs + fixtures | ~380 | — | 8 |
| Capture harness | ~200 | — | 2 |
| Spike (deleted at 1.20) | ~340 | — | 3 |
| CI + configs | ~110 | ~40 | 5 |
| **Total** | **~2,450** | **~450** | **57** |

New dependencies: **4** — `zod@^4`, `vitest@^2`, `happy-dom`, `@playwright/test@^1.4x`. Deleted: `entrypoints/content.ts` (103 LOC) and ~90 LOC of keep-alive. Net repository growth is roughly 2,700 lines, of which ~1,280 are tests and ~340 are thrown away at 1.20.

---

## 15. Forward Dependencies Declared Here

Marked inline so no later phase has to rediscover them.

- `lib/schemas/{action,plan,snapshot}.schema.ts` are stubs. **[Phase 2 fills `snapshot`, Phase 3 fills `action`, Phase 4 fills `plan`.]**
- `DEFAULT_CAPABILITIES` is `[]`. **[Phase 2 adds the perception verbs; Phase 3 adds the interaction verbs.]**
- `runEvents.tabId` is indexed and always `null`. **[Phase 7 writes real tab ids.]**
- `RunRecord.mode` includes `'watch'` and `RunRecord.backend` includes `'cdp'`. Both are rejected by validation until their phase. **[Phase 9 enables `cdp`; Phase 11 enables `watch`.]**
- `revokeOrigin` has a `// [Phase 5: halt any run whose scope contains this origin]` marker. There are no runs yet, so there is nothing to halt.
- `lib/adapters/llm-router.ts` retains its `FALLBACK_ORDER` cascade across the local/remote boundary — a PR-LOC-4 violation that this phase deliberately does not fix. **[Phase 4 replaces the file wholesale with `lib/model/router.ts`.]** It is left in place because every working text capability depends on it and there is no tier router yet to replace it with.
- `entrypoints/toolbar.content.tsx` still matches six AI hosts through its own `content_scripts` entry, which means the built manifest is not yet free of install-time host permissions — it holds those six. **[Phase 5 replaces the toolbar with the side panel and the per-origin overlay, at which point the manifest's `content_scripts` key disappears entirely.]** `no-all-urls.spec.ts` asserts the absence of `<all_urls>` specifically, not the absence of `content_scripts`, for exactly this reason.
