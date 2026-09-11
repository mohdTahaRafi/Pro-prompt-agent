/**
 * Agent content script — the only content script the agent uses.
 * Phase 2 §3.1. Registered dynamically per granted origin via
 * chrome.scripting.registerContentScripts (lib/policy/scope.ts) — never in
 * the manifest. `registration: 'runtime'` and `matches: []` mean WXT bundles
 * this to content-scripts/agent.js and copies it into the build without
 * writing any content_scripts or host_permissions manifest entry; the
 * origin match comes entirely from the `matches` array scope.ts passes to
 * registerContentScripts at grant time.
 *
 * Answers the four Phase 2 perception verbs (PERCEIVE_STRUCTURE,
 * PERCEIVE_ELEMENT, PERCEIVE_PAGE, WAIT_FOR_SETTLE) plus the Phase 1
 * pp-ping/pp-pong bridge and snippet expansion, which now share this
 * script's overlay host (lib/page/overlay/mount.ts).
 * [Phase 3] adds the ACTUATE handler — lib/actuation/dom-backend.ts proxies
 * a permitted, already-gated action here; lib/page/actuator.ts is the only
 * code in this file that touches the DOM on the agent's behalf.
 *
 * ctx.onInvalidated matters: when the extension is updated or reloaded, the
 * old content script's chrome.runtime handle is dead but its listeners are
 * still attached. Without this teardown a stale script keeps a
 * MutationObserver running on the page forever.
 */
import { SnippetManager } from '@lib/ui/snippet-manager';
import { AutocompleteManager } from '@lib/ui/autocomplete-manager';
import { ElementRegistry } from '@lib/page/registry';
import { SettleDetector } from '@lib/page/settle';
import { buildSnapshot, visibilityOf, isDisabled } from '@lib/page/perception';
import { readPage, READ_PAGE_DEFAULT_TOKEN_CAP } from '@lib/page/readable';
import { PerceptionRequest, ElementDescriptorSchema } from '@lib/schemas/snapshot.schema';
import type { ElementDescriptor } from '@lib/schemas/snapshot.schema';
import { computeRole } from '@lib/page/roles';
import { computeAccessibleName } from '@lib/page/accname';
import { classifySensitive } from '@lib/page/sensitive';
import { actuate } from '@lib/page/actuator';
import { ActuateMessageSchema } from '@lib/schemas/action.schema';

export default defineContentScript({
  registration: 'runtime',   // registered by chrome.scripting, never by the manifest
  matches: [],                // required by the type; ignored for runtime registration
  runAt: 'document_idle',
  allFrames: false,           // §3.2 — top frame only; same-origin iframes are
                               // traversed from there, cross-origin ones are
                               // reported as unreachable, never silently empty
  main(ctx) {
    new SnippetManager();
    // [Phase 4 §9] Local-only, granted-origins-only ghost text — see
    // lib/ui/autocomplete-manager.ts's header for all four §3.7.22
    // conditions. Instantiated here and nowhere else: this file is only
    // ever registered per grant (lib/policy/scope.ts), so an ungranted
    // origin never loads this class at all.
    new AutocompleteManager();

    const registry = new ElementRegistry();
    const settle = new SettleDetector();
    let cachedTabId: number | null = null;

    async function getTabId(): Promise<number> {
      if (cachedTabId !== null) return cachedTabId;
      let resolved = -1;
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_TAB_ID' });
        resolved = typeof resp?.data?.tabId === 'number' ? resp.data.tabId : -1;
      } catch { /* resolved stays -1 */ }
      cachedTabId = resolved;
      return resolved;
    }

    // Phase 1 ping bridge — kept for the grant/revoke e2e flow, which
    // observes this from outside the extension via a main-world CustomEvent
    // (world: 'ISOLATED' content scripts don't share a `window` with the
    // page). See tests/e2e/grant-revoke.spec.ts.
    document.addEventListener('pp-ping', () => {
      document.dispatchEvent(new CustomEvent('pp-pong', { detail: { at: Date.now() } }));
    });

    chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      const parsed = PerceptionRequest.safeParse(raw);
      if (!parsed.success) return false;   // not ours; let another listener answer

      handle(parsed.data).then(sendResponse);
      return true;   // keep the channel open for the async response
    });

    // [Phase 3] ACTUATE — the only path by which this content script
    // touches the DOM on the agent's behalf. The action has already been
    // permitted by lib/policy/gate.ts in the service worker; this listener
    // performs it and reports what it observed, nothing more (§6.1).
    chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      const parsed = ActuateMessageSchema.safeParse(raw);
      if (!parsed.success) return false;   // not ours; let another listener answer

      actuate(parsed.data.action, parsed.data.epoch, registry, parsed.data.runId).then((result) => {
        sendResponse(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error });
      });
      return true;
    });

    async function handle(req: import('@lib/schemas/snapshot.schema').PerceptionRequestType) {
      switch (req.type) {
        case 'PERCEIVE_STRUCTURE': {
          const tabId = await getTabId();
          const result = await buildSnapshot(registry, settle, {
            runId: req.runId, tabId, region: req.region, tokenBudget: req.tokenBudget,
          });
          if (!result.ok) {
            return { status: 'error', message: result.reason };
          }
          return { status: 'success', data: result.snapshot };
        }

        case 'PERCEIVE_ELEMENT': {
          const resolution = registry.resolve(req.handle, registry.currentEpoch);
          if (resolution.kind === 'missing') {
            return { status: 'error', message: 'TARGET_MISSING' };
          }
          if (resolution.kind === 'ambiguous') {
            // Same exclusion re-check as below: a candidate the page has
            // turned sensitive since the original walk is dropped from the
            // set, not described with a wrong sensitiveKind.
            const safeCandidates = resolution.candidates.filter((n) => isSafeToDescribe(n));
            if (safeCandidates.length === 0) return { status: 'error', message: 'TARGET_MISSING' };
            return {
              status: 'success',
              data: { kind: 'ambiguous', candidates: safeCandidates.map((n) => describeElement(n)) },
            };
          }
          // Re-check the exclusion here, not just at walk time (§7.1's
          // "earliest possible point" applies every time a value could be
          // read, and re-resolution can land on a DIFFERENT live node than
          // the one originally classified — e.g. the page swapped a benign
          // field for a password field at the same position since the
          // snapshot). A handle that now resolves to a sensitive node is
          // reported exactly like one that resolves to nothing at all.
          if (!isSafeToDescribe(resolution.node)) {
            return { status: 'error', message: 'TARGET_MISSING' };
          }
          const descriptor = describeElement(resolution.node);
          return resolution.kind === 'exact'
            ? { status: 'success', data: { kind: 'exact', element: descriptor } }
            : { status: 'success', data: { kind: 'reresolved', element: descriptor, confidence: resolution.confidence } };
        }

        case 'PERCEIVE_PAGE': {
          return { status: 'success', data: readPage(READ_PAGE_DEFAULT_TOKEN_CAP) };
        }

        case 'WAIT_FOR_SETTLE': {
          const result = await settle.wait(req.maxMs);
          return { status: 'success', data: result };
        }

        default:
          return { status: 'error', message: 'INVALID_REQUEST' };
      }
    }

    /** True unless classifySensitive() flags this node as anything other
     *  than the one kind that survives description (§7.1) — checked BEFORE
     *  describeElement() reads anything else about the node, mirroring the
     *  walk's own ordering. */
    function isSafeToDescribe(el: Element): boolean {
      const sensitive = classifySensitive(el);
      return sensitive === null || sensitive === 'file';
    }

    /** Minimal descriptor builder for PERCEIVE_ELEMENT, sharing the same
     *  classification and naming logic buildSnapshot's walk uses, but for a
     *  single already-resolved node rather than a full walk. Callers MUST
     *  have already checked isSafeToDescribe(el). */
    function describeElement(el: Element): ElementDescriptor {
      const role = computeRole(el);
      const { name, source } = computeAccessibleName(el);
      const sensitive = classifySensitive(el);
      const { visible, inViewport } = visibilityOf(el);
      const tag = el.tagName.toLowerCase();
      const descriptor = {
        handle: 'e0',   // PERCEIVE_ELEMENT returns a fresh descriptor for a
                         // node already identified by its own handle; the
                         // caller already has that handle and this field is
                         // schema-required rather than meaningful here.
        role, name, nameSource: source, tag,
        inputType: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
        enabled: !isDisabled(el),
        visible, inViewport,
        actionable: visible && !isDisabled(el),
        href: tag === 'a' ? (el as HTMLAnchorElement).href || undefined : undefined,
        sensitiveKind: sensitive === 'file' ? 'file' as const : null,
        autocomplete: el.getAttribute('autocomplete') ?? undefined,
        regionId: 'region:root',
        ordinal: 0,
      };
      return ElementDescriptorSchema.parse(descriptor);
    }

    // Invalidate everything when the document itself changes underneath us.
    ctx.addEventListener(window, 'pagehide', () => registry.invalidateAll('PAGEHIDE'));
    ctx.onInvalidated(() => {
      settle.stop();
      registry.invalidateAll('CTX_INVALIDATED');
    });
  },
});
