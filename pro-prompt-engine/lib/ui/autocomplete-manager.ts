/**
 * Autocomplete Manager (Ghost Text) — [Phase 1] REMOVED FROM THE BUILD.
 *
 * Nothing imports this file. It violates three of the four §3.7.22
 * conditions simultaneously: it ran on every site, its isValidTarget()
 * returned true for type="password", and its debounced handler posted the
 * entire field value to the AUTOCOMPLETE message, which the router could
 * cascade to Groq when local engines were cold — a password typed into any
 * field on any site could leave the machine. Left on disk, unimported,
 * because the ghost-text positioning math (showGhostText) is the one part
 * of it that was correct and Phase 4 rebuilds on it once the sensitive-field
 * classifier (lib/page/sensitive.ts), the tier router and the grant model
 * all exist. See Docs/planning/phase_1_foundation_preconditions.md §5.1 and
 * architecture.md §3.7.22.
 */

import { debounce } from '@lib/utils/debounce';

export class AutocompleteManager {
  private activeElement: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null = null;
  private overlayDiv: HTMLDivElement | null = null;
  private currentSuggestion: string = '';
  private isEnabled: boolean = true;

  private requestAutocomplete = debounce(async (text: string) => {
    if (!text.trim() || text.length < 5) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AUTOCOMPLETE',
        payload: { text }
      });
      if (response && response.status === 'success' && response.data.suggestion) {
        this.showGhostText(response.data.suggestion);
      }
    } catch (err) {
      console.warn('[Autocomplete] Failed', err);
    }
  }, 800);

  constructor() {
    this.initListeners();
    chrome.storage.local.get('autocompleteEnabled', (res: { autocompleteEnabled?: boolean }) => {
      if (res.autocompleteEnabled !== undefined) {
        this.isEnabled = res.autocompleteEnabled;
      }
    });

    chrome.runtime.onMessage.addListener((msg: { type: string; payload?: { enabled: boolean } }) => {
      if (msg.type === 'TOGGLE_AUTOCOMPLETE') {
        this.isEnabled = msg.payload?.enabled ?? false;
        if (!this.isEnabled) this.closeSuggestion();
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
    if (!this.isEnabled) return;
    const target = e.target as HTMLElement;
    if (!this.isValidTarget(target)) return;
    
    this.activeElement = target;
    this.closeSuggestion();
    
    const text = this.getText(target);
    this.requestAutocomplete(text);
  }

  private handleKeydown(e: KeyboardEvent) {
    if (!this.overlayDiv || !this.activeElement) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      this.acceptSuggestion();
    } else if (e.key === 'Escape' || e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Backspace') {
      this.closeSuggestion();
    }
  }

  private isValidTarget(el: HTMLElement): boolean {
    return (
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'INPUT' ||
      el.hasAttribute('contenteditable')
    );
  }

  private getText(el: HTMLElement): string {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return (el as HTMLInputElement).value;
    }
    return el.textContent || '';
  }

  private setText(el: HTMLElement, text: string) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      (el as HTMLInputElement).value = text;
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private showGhostText(suggestion: string) {
    if (!this.activeElement) return;
    this.currentSuggestion = suggestion;

    if (!this.overlayDiv) {
      this.overlayDiv = document.createElement('div');
      this.overlayDiv.style.cssText = `
        position: absolute;
        pointer-events: none;
        z-index: 9999999;
        color: rgba(148, 163, 184, 0.7); /* Subtle ghost color */
        white-space: pre-wrap;
        overflow: hidden;
        word-wrap: break-word;
        font-family: inherit;
        font-size: inherit;
        line-height: inherit;
        padding: inherit;
        border: inherit;
        box-sizing: border-box;
      `;
      document.body.appendChild(this.overlayDiv);
    }

    const rect = this.activeElement.getBoundingClientRect();
    const style = window.getComputedStyle(this.activeElement);
    
    this.overlayDiv.style.top = `${window.scrollY + rect.top}px`;
    this.overlayDiv.style.left = `${window.scrollX + rect.left}px`;
    this.overlayDiv.style.width = `${rect.width}px`;
    this.overlayDiv.style.height = `${rect.height}px`;
    this.overlayDiv.style.fontFamily = style.fontFamily;
    this.overlayDiv.style.fontSize = style.fontSize;
    this.overlayDiv.style.lineHeight = style.lineHeight;
    this.overlayDiv.style.padding = style.padding;
    this.overlayDiv.style.border = style.border;
    
    // We render the existing text as transparent, and the suggestion as visible
    const existingText = this.getText(this.activeElement);
    // Replace spaces with non-breaking spaces for proper alignment calculation
    const invisiblePart = existingText.replace(/ /g, '\u00A0');
    
    this.overlayDiv.innerHTML = `<span style="opacity: 0;">${invisiblePart}</span><span style="opacity: 0.8; font-style: italic;">${suggestion}</span>`;
  }

  private acceptSuggestion() {
    if (!this.activeElement || !this.currentSuggestion) return;
    
    const text = this.getText(this.activeElement);
    const newText = text + this.currentSuggestion;
    
    this.setText(this.activeElement, newText);
    this.closeSuggestion();
  }

  private closeSuggestion() {
    if (this.overlayDiv) {
      this.overlayDiv.remove();
      this.overlayDiv = null;
    }
    this.currentSuggestion = '';
  }
}
