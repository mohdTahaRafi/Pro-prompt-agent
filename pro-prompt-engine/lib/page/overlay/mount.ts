/**
 * Overlay host — content script only. Phase 2 §3.1, §13.
 *
 * The single closed-mode shadow-root host shared by the snippet popover
 * (moved here from being owned outright by SnippetManager) and, from
 * Phase 6 onward, the run badge. One host means settle.ts's isOurs() check
 * (§6.1) only has one attribute to look for, and it means the page can find
 * at most one extension-owned element by walking the DOM.
 *
 * mode: 'closed' makes host.shadowRoot null to page script — the page
 * cannot read, style, or remove what it cannot see. all: initial on the
 * host neutralises inherited page styles, exactly as the Phase 1 popover did.
 */

/** Marks the host element so settle.ts can exclude its own subtree's
 *  mutations from page-activity counting (§6.1). Not a valid page selector
 *  a page author would plausibly already be using. */
export const OVERLAY_ROOT_ATTR = 'data-pp-overlay-root';

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

/** Lazily creates the shared shadow host. Never appended twice. */
export function ensureOverlayRoot(): ShadowRoot {
  if (shadow) return shadow;
  host = document.createElement('div');
  host.setAttribute(OVERLAY_ROOT_ATTR, '');
  host.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647;';
  // documentElement, not body: some sites replace body on route change.
  document.documentElement.appendChild(host);
  shadow = host.attachShadow({ mode: 'closed' });
  return shadow;
}

/** Test/introspection only. */
export function getOverlayHost(): HTMLDivElement | null {
  return host;
}

export function teardownOverlayRoot(): void {
  host?.remove();
  host = null;
  shadow = null;
}
