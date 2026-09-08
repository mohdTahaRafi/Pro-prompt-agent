/**
 * Computed role mapping — content script; pure, synchronous, no I/O.
 *
 * Phase 2 §5.2. Three questions this module answers, and only these three:
 * what role does the platform expose for this element, is it something a
 * user can act on, and is it something that orients a planner without being
 * actionable.
 *
 * The explicit `role` attribute wins, but only if it names a real ARIA role.
 * An invalid role is *ignored*, not passed through: a page that writes
 * role="submit-button" would otherwise inject an unbounded vocabulary into
 * the snapshot, and a planner that has been told the vocabulary is ARIA
 * would be reading a string the gate cannot reason about.
 */

/**
 * The ARIA 1.2 role set, used only to validate an explicit role attribute.
 * Abstract roles (`widget`, `input`, `structure`, …) are deliberately absent:
 * they are not legal author values, so an element carrying one is as invalid
 * as one carrying a typo.
 */
export const ARIA_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
  'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
  'complementary', 'contentinfo', 'definition', 'deletion', 'dialog',
  'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic',
  'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu',
  'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter',
  'navigation', 'none', 'note', 'option', 'paragraph', 'presentation',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
  'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch',
  'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer',
  'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

/**
 * Roles whose accessible name may come from their own subtree text
 * (the ARIA "name from author and content" set). Consumed by accname.ts §5.1
 * step 4 — a textbox is NOT in this set, which is why a text field wrapped in
 * a <label> gets its name from the label and never from whatever the user has
 * typed into it.
 */
export const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row',
  'rowheader', 'switch', 'tab', 'tooltip', 'treeitem',
]);

/** Roles the agent could conceivably act on. Drives `isInteractive`. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
]);

/**
 * Roles that orient a planner without being actionable. Deliberately narrow:
 * every entry here costs tokens in the snapshot, and `list`/`listitem` were
 * left out because an ordinary page has hundreds of them and they say nothing
 * a heading or a repeat region does not say better (§7.3 priority 3).
 */
export const STRUCTURAL_ROLES: ReadonlySet<string> = new Set([
  'banner', 'columnheader', 'complementary', 'contentinfo', 'form', 'heading',
  'main', 'navigation', 'region', 'rowheader', 'search', 'table',
]);

/** The landmark subset of STRUCTURAL_ROLES — §7.3 priority 2. */
export const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation',
  'region', 'search',
]);

/** input[type] → implicit role. Anything unlisted falls through to textbox. */
const INPUT_TYPE_ROLES: Record<string, string> = {
  button: 'button', submit: 'button', reset: 'button', image: 'button',
  // HTML-AAM maps input[type=file] to no role at all. `button` is used here
  // because that is what assistive tech announces, and because leaving it
  // role-less would drop it out of the interactive set — the one thing §7.1
  // is explicit that must not happen to a file input.
  file: 'button',
  checkbox: 'checkbox', radio: 'radio',
  range: 'slider', number: 'spinbutton', search: 'searchbox',
  hidden: 'none',
  text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox',
  password: 'textbox', date: 'textbox', 'datetime-local': 'textbox',
  month: 'textbox', week: 'textbox', time: 'textbox', color: 'textbox',
};

/** Tags whose implicit role never depends on an attribute. */
const SIMPLE_TAG_ROLES: Record<string, string> = {
  BUTTON: 'button', TEXTAREA: 'textbox', SUMMARY: 'button',
  NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', FORM: 'form',
  SEARCH: 'search', DIALOG: 'dialog', OPTION: 'option', OPTGROUP: 'group',
  FIELDSET: 'group', DETAILS: 'group', TABLE: 'table', TR: 'row',
  TD: 'cell', THEAD: 'rowgroup', TBODY: 'rowgroup', TFOOT: 'rowgroup',
  UL: 'list', OL: 'list', LI: 'listitem', DL: 'list', MENU: 'list',
  PROGRESS: 'progressbar', METER: 'meter', OUTPUT: 'status', HR: 'separator',
  BLOCKQUOTE: 'blockquote', FIGURE: 'figure', ARTICLE: 'article',
  P: 'paragraph', CODE: 'code', TIME: 'time', CAPTION: 'caption',
  H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading',
  H5: 'heading', H6: 'heading',
};

/**
 * The computed role: explicit-and-valid, then implicit, then `generic`.
 */
export function computeRole(el: Element): string {
  const explicit = el.getAttribute?.('role')?.trim().toLowerCase();
  if (explicit) {
    // role may carry a fallback list ("role='doc-abstract section'"); the
    // first token that names a real role wins, per the ARIA spec.
    for (const token of explicit.split(/\s+/)) {
      if (ARIA_ROLES.has(token)) return token;
    }
    // Every token invalid: fall through to the implicit mapping. The
    // attribute is treated as if it were absent, never surfaced verbatim.
  }
  return implicitRole(el);
}

function implicitRole(el: Element): string {
  const tag = el.tagName?.toUpperCase() ?? '';

  const simple = SIMPLE_TAG_ROLES[tag];
  if (simple) return simple;

  switch (tag) {
    case 'A':
    case 'AREA':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'INPUT': {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return INPUT_TYPE_ROLES[type] ?? 'textbox';
    }
    case 'SELECT':
      return (el as HTMLSelectElement).multiple || numAttr(el, 'size') > 1
        ? 'listbox' : 'combobox';
    case 'IMG':
      // alt="" is the author's explicit statement that the image is
      // decorative. alt absent entirely is not — that is an unlabelled image.
      return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    case 'TH':
      return (el as HTMLTableCellElement).scope === 'row' ? 'rowheader' : 'columnheader';
    case 'HEADER':
      return isScoped(el) ? 'generic' : 'banner';
    case 'FOOTER':
      return isScoped(el) ? 'generic' : 'contentinfo';
    case 'SECTION':
      // A <section> is only a landmark when it is named — an unnamed one is
      // an ordinary box, and treating every <section> as a region would put
      // a dozen meaningless landmarks in the completeness report.
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
        ? 'region' : 'generic';
    default:
      return 'generic';
  }
}

/** A <header>/<footer> inside sectioning content is not a landmark. */
function isScoped(el: Element): boolean {
  return el.parentElement?.closest('article, aside, main, nav, section') != null
    || el.closest('article, aside, main, nav, section') !== null;
}

function numAttr(el: Element, name: string): number {
  const v = Number(el.getAttribute(name));
  return Number.isFinite(v) ? v : 0;
}

/**
 * Can the agent act on this? Role first, behaviour second.
 *
 * The behavioural arm exists for the `<div onclick>` pattern, which carries
 * no ARIA at all and is far too common to ignore. It is deliberately fenced:
 * a `cursor: pointer` element with more than three element children is
 * almost always a card wrapper whose *child* is the real control, and
 * matching the wrapper produces a click that lands in the wrong place.
 */
export function isInteractive(el: Element): boolean {
  if (INTERACTIVE_ROLES.has(computeRole(el))) return !isAriaHidden(el);
  if (isAriaHidden(el)) return false;
  return isBehaviourallyInteractive(el);
}

export function isBehaviourallyInteractive(el: Element): boolean {
  if (!(el instanceof Element)) return false;
  if (el.hasAttribute('onclick')) return true;

  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;

  const ce = el.getAttribute('contenteditable');
  if (ce !== null && ce !== 'false') return true;

  // cursor:pointer is the last and weakest signal, so it carries the
  // leaf-ish constraint (§5.2). getComputedStyle is the expensive call in
  // the whole walk, which is why it runs last and only after the three
  // attribute checks above have failed.
  if (el.childElementCount <= 3) {
    try {
      if (el.ownerDocument.defaultView?.getComputedStyle(el).cursor === 'pointer') return true;
    } catch { /* detached node or a document without a view — not interactive */ }
  }
  return false;
}

/** Orients the planner; never actionable. */
export function isStructural(el: Element): boolean {
  return STRUCTURAL_ROLES.has(computeRole(el)) && !isAriaHidden(el);
}

export function isLandmark(el: Element): boolean {
  return LANDMARK_ROLES.has(computeRole(el));
}

/** aria-hidden on the element or any ancestor removes it from the a11y tree. */
export function isAriaHidden(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.getAttribute?.('aria-hidden') === 'true') return true;
    node = node.parentElement;
  }
  return false;
}
