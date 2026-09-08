/**
 * Snippet Manager
 * Detects "/prefix" triggers in text fields and shows a snippet insertion UI.
 *
 * [Phase 1 PRE-2 §5.2] The popover mounts in a closed-mode shadow root
 * instead of a bare document.body div. A bare div is reachable by any page
 * script — it can read, style or remove it, and the page's own CSS reset can
 * distort it. mode: 'closed' makes host.shadowRoot null to page script, so
 * the page cannot walk into the popover; all: initial on the host neutralises
 * inherited page styles. isValidTarget() defers to the shared sensitive-
 * field classifier (lib/page/sensitive.ts) instead of accepting every input.
 *
 * [Phase 2 §3.1, §13, task 2.13] The shadow host is no longer owned outright
 * by this class — it now shares agent.content.ts's single overlay host
 * (lib/page/overlay/mount.ts) with the rest of the extension's on-page UI,
 * so settle.ts's own-mutation filter and any future overlay have exactly
 * one host element to reason about.
 */

import type { Snippet } from '@lib/types/snippet.types';
import { classifySensitive } from '@lib/page/sensitive';
import { ensureOverlayRoot } from '@lib/page/overlay/mount';

const SNIPPET_POPOVER_CSS = `
  .pp-snippet-popup {
    position: absolute;
    z-index: 2147483647;
    background: #0F172A;
    border: 1px solid #334155;
    border-radius: 8px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
    color: #F8FAFC;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 13px;
    min-width: 200px;
    max-width: 300px;
    max-height: 200px;
    overflow-y: auto;
  }
  .pp-snippet-item {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid #1E293B;
    display: flex;
    flex-direction: column;
  }
  .pp-snippet-item:hover { background: #1E293B; }
  .pp-snippet-title { font-weight: 600; color: #3B82F6; margin-bottom: 2px; }
  .pp-snippet-desc {
    color: #94A3B8;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`;

export class SnippetManager {
  private activeElement: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null = null;
  private popup: HTMLDivElement | null = null;
  private currentQuery: string = '';
  private snippets: Snippet[] = [];

  constructor() {
    this.initListeners();
  }

  private initListeners() {
    document.addEventListener('input', this.handleInput.bind(this), true);
    document.addEventListener('keydown', this.handleKeydown.bind(this), true);
    document.addEventListener('click', (e) => {
      // e.target is in the page's light DOM; a closed shadow root's contents
      // never appear in e.composedPath() to page script, but this listener
      // runs inside our own content script so composedPath() still resolves.
      if (this.popup && !e.composedPath().includes(this.popup)) {
        this.closePopup();
      }
    });
  }

  private async handleInput(e: Event) {
    const target = e.target as HTMLElement;
    if (!this.isValidTarget(target)) { this.closePopup(); return; }
    this.activeElement = target;

    const text = this.getText(target);
    // Naive detection: if the last word starts with /
    const match = text.match(/(?:^|\s)(\/[a-zA-Z0-9_-]*)$/);
    if (match) {
      this.currentQuery = match[1];
      await this.showPopup(target, this.currentQuery);
    } else {
      this.closePopup();
    }
  }

  private handleKeydown(e: KeyboardEvent) {
    if (!this.popup) return;
    if (e.key === 'Escape') {
      this.closePopup();
      e.preventDefault();
    }
  }

  private isValidTarget(el: HTMLElement): boolean {
    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.hasAttribute('contenteditable');
    if (!isField) return false;
    // PRE-1/PRE-2: never offer snippet expansion into a password, payment,
    // OTP, file or hidden field. classifySensitive is the single classifier
    // shared with Phase 2's perception layer and Phase 4's autocomplete.
    return classifySensitive(el) === null;
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
    // Dispatch input event for React/Vue hooks
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private async fetchSnippets(query: string) {
    const cleanQuery = query.replace('/', '');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_SNIPPETS',
        payload: { query: cleanQuery },
      });
      if (response && response.status === 'success') {
        this.snippets = response.data;
      }
    } catch (err) {
      console.warn('[SnippetManager] Failed to fetch snippets', err);
    }
  }

  /** The shared overlay shadow root (lib/page/overlay/mount.ts). Injects its
   *  own <style> once — the shared root has no CSS of its own. */
  private ensureHost(): ShadowRoot {
    const shadow = ensureOverlayRoot();
    if (!shadow.querySelector('style[data-pp-snippet-style]')) {
      const style = document.createElement('style');
      style.setAttribute('data-pp-snippet-style', '');
      style.textContent = SNIPPET_POPOVER_CSS;
      shadow.appendChild(style);
    }
    return shadow;
  }

  private async showPopup(target: HTMLElement, query: string) {
    await this.fetchSnippets(query);
    if (this.snippets.length === 0) {
      this.closePopup();
      return;
    }

    const shadow = this.ensureHost();
    if (!this.popup) {
      this.popup = document.createElement('div');
      this.popup.className = 'pp-snippet-popup';
      shadow.appendChild(this.popup);
    }

    // Position near bottom right of target bounding rect
    const rect = target.getBoundingClientRect();
    this.popup.style.top = `${window.scrollY + rect.bottom + 5}px`;
    this.popup.style.left = `${window.scrollX + rect.left}px`;

    this.popup.innerHTML = '';
    this.snippets.forEach((snippet) => {
      const item = document.createElement('div');
      item.className = 'pp-snippet-item';

      const title = document.createElement('span');
      title.className = 'pp-snippet-title';
      title.textContent = snippet.prefix;

      const desc = document.createElement('span');
      desc.className = 'pp-snippet-desc';
      desc.textContent = snippet.description || snippet.body;

      item.appendChild(title);
      item.appendChild(desc);

      item.onmousedown = (e) => {
        e.preventDefault();
        this.injectSnippet(snippet);
      };

      this.popup!.appendChild(item);
    });
  }

  private injectSnippet(snippet: Snippet) {
    if (!this.activeElement) return;

    let text = this.getText(this.activeElement);
    // Replace the last occurrence of the query with the snippet body
    const lastIdx = text.lastIndexOf(this.currentQuery);
    if (lastIdx !== -1) {
      text = text.substring(0, lastIdx) + snippet.body + text.substring(lastIdx + this.currentQuery.length);
      this.setText(this.activeElement, text);
    }

    this.closePopup();
  }

  private closePopup() {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
  }
}
