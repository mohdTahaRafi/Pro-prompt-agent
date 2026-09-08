/**
 * Accessible name computation — content script; pure, synchronous, no I/O.
 *
 * Phase 2 §5.1. A pragmatic subset of the ACCNAME specification, in
 * precedence order: aria-labelledby, aria-label, native host-language label,
 * subtree text (name-from-content roles only), title, placeholder. The
 * single highest-leverage thing perception does — `name: "Submit
 * application"` is what makes a plan readable, an approval request
 * specific, and a report honest.
 */
import { NAME_FROM_CONTENT_ROLES, computeRole } from '@lib/page/roles';

export type NameSource =
  | 'labelledby' | 'label' | 'native' | 'content' | 'title' | 'placeholder' | 'none';

export interface AccessibleName {
  name: string;
  source: NameSource;
}

const MAX_NAME_LENGTH = 120;

const NAME_FROM_VALUE_INPUTS = new Set(['button', 'submit', 'reset']);

/** Public entry point. Always returns a normalised, length-capped result. */
export function accessibleName(el: Element): string {
  return computeAccessibleName(el).name;
}

export function computeAccessibleName(el: Element): AccessibleName {
  const labelledBy = fromLabelledBy(el, 0);
  if (labelledBy) return finalize(labelledBy, 'labelledby');

  // aria-label shares the 'label' source tag with the native host-language
  // label below — the snapshot schema's nameSource enum (§7.6) does not
  // distinguish them further, since both are author-authored labels rather
  // than derived text.
  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return finalize(ariaLabel, 'label');

  const native = fromNativeLabel(el);
  if (native) return finalize(native, 'native');

  const role = computeRole(el);
  if (NAME_FROM_CONTENT_ROLES.has(role)) {
    const content = fromSubtreeText(el);
    if (content) return finalize(content, 'content');
  }

  const title = el.getAttribute('title')?.trim();
  if (title) return finalize(title, 'title');

  const placeholder = (el as HTMLInputElement).placeholder;
  if (placeholder && placeholder.trim()) return finalize(placeholder.trim(), 'placeholder');

  return { name: '', source: 'none' };
}

/**
 * aria-labelledby: resolve every id, concatenate rendered text with single
 * spaces, skip ids that don't exist. Recursion depth capped at 1 — an
 * aria-labelledby chain deeper than that is malformed and the cap prevents a
 * cycle from hanging the page.
 */
function fromLabelledBy(el: Element, depth: number): string | null {
  const idsAttr = el.getAttribute('aria-labelledby');
  if (!idsAttr) return null;
  const doc = el.ownerDocument;
  const ids = idsAttr.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  for (const id of ids) {
    const target = doc.getElementById(id);
    if (!target) continue;
    const text = depth === 0
      ? (fromLabelledBy(target, depth + 1) ?? renderedText(target))
      : renderedText(target);
    if (text) parts.push(text);
  }
  const joined = parts.join(' ').trim();
  return joined || null;
}

/**
 * Native host-language label: <label for>, then an ancestor <label>; for
 * input[type=button|submit|reset] the value; for <img> the alt; for
 * <fieldset> the <legend>; for <table> the <caption>.
 */
function fromNativeLabel(el: Element): string | null {
  const tag = el.tagName;

  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (NAME_FROM_VALUE_INPUTS.has(type)) {
      const value = (el as HTMLInputElement).value?.trim();
      if (value) return value;
      if (type === 'submit') return 'Submit';
      if (type === 'reset') return 'Reset';
    }
  }

  if (tag === 'IMG') {
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
  }

  if (tag === 'FIELDSET') {
    const legend = el.querySelector(':scope > legend');
    if (legend) {
      const text = renderedText(legend);
      if (text) return text;
    }
  }

  if (tag === 'TABLE') {
    const caption = el.querySelector(':scope > caption');
    if (caption) {
      const text = renderedText(caption);
      if (text) return text;
    }
  }

  if ('labels' in el) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const text = renderedText(labels[0]);
      if (text) return text;
    }
  }

  const ancestorLabel = el.closest('label');
  if (ancestorLabel) {
    const text = renderedText(ancestorLabel);
    if (text) return text;
  }

  return null;
}

/**
 * Subtree text for name-from-content roles. Traverses open shadow roots and
 * ::before/::after content, skips aria-hidden="true" subtrees and
 * display:none.
 */
function fromSubtreeText(el: Element): string | null {
  const text = renderedText(el);
  return text || null;
}

/** Rendered text of an element: visible text content plus generated content. */
function renderedText(el: Element): string {
  const parts: string[] = [];
  collectText(el, parts, true);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function collectText(node: Element, parts: string[], isRoot: boolean): void {
  const view = node.ownerDocument.defaultView;
  if (!isRoot) {
    if (node.getAttribute('aria-hidden') === 'true') return;
    if (view) {
      try {
        const style = view.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;
      } catch { /* detached — include it rather than silently dropping text */ }
    }
  }

  if (view) {
    try {
      const before = view.getComputedStyle(node, '::before').content;
      if (before && before !== 'none' && before !== 'normal') {
        parts.push(stripQuotes(before));
      }
    } catch { /* no-op */ }
  }

  const shadow = (node as Element).shadowRoot;
  const children: (Element | ChildNode)[] = shadow
    ? Array.from(shadow.childNodes)
    : Array.from(node.childNodes);

  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent;
      if (t && t.trim()) parts.push(t.trim());
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      collectText(child as Element, parts, false);
    }
  }

  if (view) {
    try {
      const after = view.getComputedStyle(node, '::after').content;
      if (after && after !== 'none' && after !== 'normal') {
        parts.push(stripQuotes(after));
      }
    } catch { /* no-op */ }
  }
}

function stripQuotes(content: string): string {
  return content.replace(/^["']|["']$/g, '');
}

function finalize(raw: string, source: NameSource): AccessibleName {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const truncated = collapsed.length > MAX_NAME_LENGTH
    ? collapsed.slice(0, MAX_NAME_LENGTH - 1) + '…'
    : collapsed;
  return { name: truncated, source };
}
