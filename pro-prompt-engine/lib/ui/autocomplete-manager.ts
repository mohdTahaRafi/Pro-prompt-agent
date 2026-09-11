/**
 * Autocomplete Manager (Ghost Text) — rebuilt. §9, OQ-8 closed.
 * Docs/planning/phase_4_model_tiers_routing.md §9.
 *
 * Removed in Phase 1 for violating three of §3.7.22's four conditions
 * simultaneously (see the file's old header, preserved in git history).
 * Returns here with all four met:
 *
 *  1. LOCAL ONLY, NO REMOTE PATH — lib/model/router.ts's CHAINS.inline
 *     contains promptApiEngine in BOTH postures and nothing else;
 *     tests/unit/router.spec.ts fails the build if that ever changes.
 *  2. GRANTED ORIGINS ONLY — this file is only ever imported and
 *     instantiated from entrypoints/agent.content.ts, which is registered
 *     per grant (lib/policy/scope.ts). There is no other injection point.
 *  3. THE SAME classifySensitive() the agent uses — suppresses the
 *     suggestion entirely; one classifier, one place to be right.
 *  4. TEXT NODES, NEVER THE RAW-MARKUP DOM PROPERTY — two pre-created
 *     <span> elements inside the shared shadow root
 *     (lib/page/overlay/mount.ts); the suggestion goes in via textContent
 *     only. That property (inner-H-T-M-L) appears nowhere in this file —
 *     tests/unit/inline.spec.ts greps for it.
 */

import { debounce } from '@lib/utils/debounce';
import { classifySensitive } from '@lib/page/sensitive';
import { ensureOverlayRoot } from '@lib/page/overlay/mount';

// [§9] was 800/5/no-cap. 300ms is roughly one typing pause and leaves
// ~100ms of the 400ms budget (§3's inline row) for the two-hop round trip.
// Below ~12 chars a continuation is a guess, not a completion.
const DEBOUNCE_MS = 300;
const MIN_CHARS = 12;
const MAX_TOKENS = 24;
const GHOST_STYLE = `
  .pp-ghost {
    position: absolute;
    pointer-events: none;
    z-index: 2147483647;
    color: rgba(148, 163, 184, 0.75);
    white-space: pre-wrap;
    overflow: hidden;
    word-wrap: break-word;
    box-sizing: border-box;
  }
  .pp-ghost-invisible { opacity: 0; }
  .pp-ghost-suggestion { opacity: 0.9; font-style: italic; }
`;

export class AutocompleteManager {
  private activeElement: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null = null;
  private ghostEl: HTMLDivElement | null = null;
  private invisibleSpan: HTMLSpanElement | null = null;
  private suggestionSpan: HTMLSpanElement | null = null;
  private currentSuggestion = '';
  private enabled = true;
  private abort: AbortController | null = null;

  private onInput = debounce(async (el: HTMLElement) => {
    if (classifySensitive(el) !== null) return;      // condition 3
    if (!this.enabled) return;
    const text = this.getText(el);
    if (text.length < MIN_CHARS) return;

    this.abort?.abort();                              // cancel the previous request
    this.abort = new AbortController();
    const signal = this.abort.signal;

    let res: { ok: boolean; data?: { suggestion?: string } } | undefined;
    try {
      // Two message hops: this content script -> service worker -> the
      // offscreen document's warm Prompt API base session (§9, §5.1). The
      // SW relays INLINE_COMPLETE to lib/model/router.ts's inline tier.
      res = await chrome.runtime.sendMessage({
        type: 'INLINE_COMPLETE',
        payload: { text: text.slice(-1_200), maxTokens: MAX_TOKENS },   // last ~300 tokens of context
      });
    } catch {
      return;   // suppressed silently — never blocks or delays typing
    }
    if (signal.aborted) return;
    if (!res || res.ok !== true || !res.data?.suggestion) return;   // silent suppression
    this.showGhostText(el, res.data.suggestion);
  }, DEBOUNCE_MS);

  constructor() {
    this.initListeners();
    chrome.storage.local.get('autocompleteEnabled', (r: { autocompleteEnabled?: boolean }) => {
      if (r.autocompleteEnabled !== undefined) this.enabled = r.autocompleteEnabled;
    });
    chrome.runtime.onMessage.addListener((msg: { type: string; payload?: { enabled: boolean } }) => {
      if (msg.type === 'TOGGLE_AUTOCOMPLETE') {
        this.enabled = msg.payload?.enabled ?? false;
        if (!this.enabled) this.closeSuggestion();
      }
    });
  }

  private initListeners() {
    document.addEventListener('input', this.handleInput.bind(this), true);
    document.addEventListener('keydown', this.handleKeydown.bind(this), true);
    document.addEventListener('focusout', this.closeSuggestion.bind(this), true);
    window.addEventListener('resize', this.closeSuggestion.bind(this));
  }

  private handleInput(e: Event) {
    if (!this.enabled) return;
    const target = e.target as HTMLElement;
    if (!this.isValidTarget(target)) return;

    this.activeElement = target;
    this.closeSuggestion();
    this.onInput(target);
  }

  private handleKeydown(e: KeyboardEvent) {
    if (!this.ghostEl || !this.activeElement) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      this.acceptSuggestion();                          // condition 4 (Tab accepts)
    } else if (e.key === 'Escape' || e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Backspace') {
      this.closeSuggestion();
    }
  }

  private isValidTarget(el: HTMLElement): boolean {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.hasAttribute('contenteditable');
  }

  private getText(el: HTMLElement): string {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return (el as HTMLInputElement).value;
    return el.textContent || '';
  }

  private setText(el: HTMLElement, text: string) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') (el as HTMLInputElement).value = text;
    else el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** The shared overlay shadow root — see lib/page/snippet-manager.ts's
   *  identical pattern. Two child spans, created once and reused: the
   *  first renders the field's existing text invisibly (for layout
   *  alignment), the second renders the suggestion. Both set via
   *  textContent only. */
  private ensureGhostHost(): HTMLDivElement {
    const shadow = ensureOverlayRoot();
    if (!shadow.querySelector('style[data-pp-ghost-style]')) {
      const style = document.createElement('style');
      style.setAttribute('data-pp-ghost-style', '');
      style.textContent = GHOST_STYLE;
      shadow.appendChild(style);
    }
    if (!this.ghostEl) {
      this.ghostEl = document.createElement('div');
      this.ghostEl.className = 'pp-ghost';
      this.invisibleSpan = document.createElement('span');
      this.invisibleSpan.className = 'pp-ghost-invisible';
      this.suggestionSpan = document.createElement('span');
      this.suggestionSpan.className = 'pp-ghost-suggestion';
      this.ghostEl.appendChild(this.invisibleSpan);
      this.ghostEl.appendChild(this.suggestionSpan);
      shadow.appendChild(this.ghostEl);
    }
    return this.ghostEl;
  }

  private showGhostText(el: HTMLElement, suggestion: string) {
    if (this.activeElement !== el) return;   // focus moved while the request was in flight
    this.currentSuggestion = suggestion;

    const ghost = this.ensureGhostHost();
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    ghost.style.top = `${window.scrollY + rect.top}px`;
    ghost.style.left = `${window.scrollX + rect.left}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.fontFamily = style.fontFamily;
    ghost.style.fontSize = style.fontSize;
    ghost.style.lineHeight = style.lineHeight;
    ghost.style.padding = style.padding;
    ghost.style.border = style.border;

    const existingText = this.getText(el).replace(/ /g, ' ');
    this.invisibleSpan!.textContent = existingText;      // condition 4: textContent only
    this.suggestionSpan!.textContent = suggestion;
    ghost.style.display = '';
  }

  private acceptSuggestion() {
    if (!this.activeElement || !this.currentSuggestion) return;
    const text = this.getText(this.activeElement);
    this.setText(this.activeElement, text + this.currentSuggestion);
    this.closeSuggestion();
  }

  private closeSuggestion() {
    if (this.ghostEl) this.ghostEl.style.display = 'none';
    this.currentSuggestion = '';
  }
}
