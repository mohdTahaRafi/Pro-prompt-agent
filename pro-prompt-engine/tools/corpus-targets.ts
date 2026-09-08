/**
 * The 15 frozen-capture + 10 live-panel real-page targets for the §10.1
 * corpus (the 15 hand-built / 15 frozen-capture / 10 live-panel split —
 * phase_2_perception.md §10.1 and §17). Read by:
 * - wxt.config.ts (PP_CORPUS=1 build) — every origin here becomes a fixed
 *   host_permissions entry, so chrome.permissions.request() resolves
 *   instantly for it instead of hanging on a native bubble Playwright
 *   cannot drive (see collect-real-fixtures.ts's header for why).
 * - tools/collect-real-fixtures.ts — drives Playwright + the real
 *   extension through each target, saving a real PerceptionSnapshot.
 * - tests/captures/capture.ts (frozen targets only) — freezes the page
 *   once before collect-real-fixtures.ts reads it.
 *
 * Every URL is public and requires no credentials to read structurally.
 * the-internet.herokuapp.com is a public QA-automation demo site built
 * specifically for this kind of DOM exercise (login forms, shadow DOM,
 * iframes, dynamic content) — used here for structures that are otherwise
 * hard to find on a stable, real, freely-navigable page. The Wikipedia
 * account-creation/login pages are read for their form structure only;
 * nothing is ever submitted.
 */

export interface FrozenTarget {
  /** tests/captures/<id>/ — also the corpus entry id. */
  id: string;
  url: string;
  /** capture.ts's third argument — recorded in meta.json. */
  notes: string;
  /** Already captured in a prior session — skip re-running capture.ts. */
  alreadyCaptured?: boolean;
}

export interface LiveTarget {
  /** the corpus entry id. */
  id: string;
  url: string;
  notes: string;
}

export const FROZEN_CAPTURE_TARGETS: FrozenTarget[] = [
  { id: 'dol-whd-complaint', url: 'https://www.dol.gov/agencies/whd/contact/complaints', notes: 'govt multi-field complaint contact page (captured Phase 1)', alreadyCaptured: true },
  { id: 'govuk-home', url: 'https://www.gov.uk', notes: 'nav-heavy homepage with a site-search form' },
  { id: 'wikipedia-browser-article', url: 'https://en.wikipedia.org/wiki/Web_browser', notes: 'long-form article, TOC nav, dense link list' },
  { id: 'mdn-array-docs', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array', notes: 'docs page, sidebar nav landmark, code blocks' },
  { id: 'hn-front', url: 'https://news.ycombinator.com', notes: 'dense repeat-row list, minimal styling' },
  { id: 'herokuapp-login', url: 'https://the-internet.herokuapp.com/login', notes: 'real login form — sensitive-field exclusion on a real page' },
  { id: 'herokuapp-checkboxes', url: 'https://the-internet.herokuapp.com/checkboxes', notes: 'toggle controls, minimal DOM' },
  { id: 'herokuapp-dropdown', url: 'https://the-internet.herokuapp.com/dropdown', notes: 'native select control' },
  { id: 'herokuapp-upload', url: 'https://the-internet.herokuapp.com/upload', notes: 'file input — unsupported-action willNotDo case, real page' },
  { id: 'herokuapp-tables', url: 'https://the-internet.herokuapp.com/tables', notes: 'tabular data, sortable columns' },
  { id: 'github-repo', url: 'https://github.com/microsoft/playwright', notes: 'dashboard-style repo page, nav, action buttons, stats' },
  { id: 'python-docs-tutorial', url: 'https://docs.python.org/3/tutorial/index.html', notes: 'docs nav tree, long TOC' },
  { id: 'wikipedia-population-table', url: 'https://en.wikipedia.org/wiki/List_of_countries_by_population_(United_Nations)', notes: 'a genuinely large real repeat/table region — pruning stress on production HTML' },
  { id: 'httpbin-form', url: 'https://httpbin.org/forms/post', notes: 'a small, purpose-built multi-field real HTML form' },
  { id: 'wikipedia-login', url: 'https://en.wikipedia.org/wiki/Special:UserLogin', notes: 'a second, differently-structured real login form' },
];

// §10.1's split is 15 hand-built / 15 frozen-capture / 10 live-panel (see
// phase_2_perception.md §10.1) — NOT 10/15/15, which is what this file and
// tools/build-corpus.ts originally implemented (a real transcription error
// caught and fixed after all 15 of these were already collected and
// gold-authored; see phase_2_perception.md §17 for the dated account). Kept
// at 10 rather than re-deriving from scratch: 5 of the 15 originally
// collected targets were dropped for being the most redundant with
// FROZEN_CAPTURE_TARGETS' own site coverage (wikipedia-machine-learning
// vs. wikipedia-browser-article, python-docs-glossary vs.
// python-docs-tutorial, hn-newest vs. hn-front, govuk-browse-benefits vs.
// govuk-home, python-org-home's nav/search pattern vs. already-covered nav
// tasks). Their real, schema-valid snapshots are still on disk at
// tests/fixtures/snapshots/{wikipedia-machine-learning,python-docs-glossary,
// hn-newest,govuk-browse-benefits,python-org-home}.json (and in
// collection-log.json) — genuinely collected, just not part of the scored
// corpus, the same "collected more than kept" pattern build-corpus.ts uses
// for its archived 30.
export const LIVE_PANEL_TARGETS: LiveTarget[] = [
  { id: 'mdn-css-flexbox', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout/Basic_concepts_of_flexbox', notes: 'docs page with interactive examples' },
  { id: 'herokuapp-add-remove', url: 'https://the-internet.herokuapp.com/add_remove_elements/', notes: 'dynamically added/removed elements — epoch-increment relevant' },
  { id: 'herokuapp-inputs', url: 'https://the-internet.herokuapp.com/inputs', notes: 'a numeric input, minimal page' },
  { id: 'herokuapp-dynamic-content', url: 'https://the-internet.herokuapp.com/dynamic_content', notes: 'content that changes per load — settle-detector relevant' },
  { id: 'herokuapp-shadowdom', url: 'https://the-internet.herokuapp.com/shadowdom', notes: 'a real open shadow root on a real page' },
  // Was herokuapp-nested-frames — confirmed via curl that the top-level
  // frameset document has no <title> and the leaf frames (frame_left/
  // middle/right) are bare text with zero interactive elements, and
  // frame_bottom itself now 200s to Heroku's own "Application Error"
  // page upstream. elements:[] was therefore a correct read of a
  // genuinely empty page, not a perception bug — but it's useless as a
  // gold-answer target (nothing to reason about), so swapped for a
  // same-origin iframe page that actually has interactive content: a
  // real TinyMCE rich-text editor (toolbar buttons + an editable iframe
  // body) plus the page's own nav/link chrome around it.
  { id: 'herokuapp-iframe-editor', url: 'https://the-internet.herokuapp.com/iframe', notes: 'real same-origin iframe containing a live TinyMCE rich-text editor' },
  { id: 'herokuapp-jqueryui-menu', url: 'https://the-internet.herokuapp.com/jqueryui/menu', notes: 'a real interactive ARIA menu widget' },
  { id: 'github-issues-list', url: 'https://github.com/microsoft/playwright/issues', notes: 'repeat-region issue list plus a filter form' },
  // Was https://en.wikipedia.org/wiki/Special:CreateAccount — Wikimedia's
  // SUL3 auth flow 302s that page to a DIFFERENT origin
  // (auth.wikimedia.org), so the granted en.wikipedia.org origin never
  // matches the tab that actually loads and collect-real-fixtures.ts's
  // chrome.tabs.query finds nothing. Confirmed with a direct curl -L
  // before swapping rather than guessing. Same-origin form instead.
  { id: 'herokuapp-forgot-password', url: 'https://the-internet.herokuapp.com/forgot_password', notes: 'a real password-reset form (email field, submit)' },
  { id: 'httpbin-home', url: 'https://httpbin.org/', notes: 'API-reference-style dense link list' },
];
