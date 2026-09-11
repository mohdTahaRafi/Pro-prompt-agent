/**
 * The perception walk, region derivation, ordering and structure-aware
 * pruning. Content script only. Phase 2 §7.
 *
 * buildSnapshot() is the single entry point agent.content.ts calls for
 * PERCEIVE_STRUCTURE. Everything else in this file is a step of that
 * pipeline: walk the reachable DOM (§7.1), classify visibility (§7.2),
 * derive regions from the page's own structure (§7.3), order candidates so
 * pruning drops the least useful things first (§7.4), then prune to the
 * token budget without ever silently hiding the working region or
 * half-listing a repeating block (§7.5).
 */
import { classifySensitive, type SensitiveKind } from '@lib/page/sensitive';
import { computeRole, isInteractive, isStructural, isLandmark } from '@lib/page/roles';
import { computeAccessibleName } from '@lib/page/accname';
import { countTokens } from '@lib/page/token-budget';
import {
  ElementRegistry, formSignature, ownText, domPath,
  type ResolutionDescriptor,
} from '@lib/page/registry';
import type { SettleDetector, SettleResult } from '@lib/page/settle';
import type { ElementDescriptor, PerceptionSnapshot, RegionCompleteness } from '@lib/schemas/snapshot.schema';

// §7.5 — every descriptor's JSON footprint, plus the snapshot envelope
// itself (runId, url, title, settle fields — measured once, not per call,
// because it never changes shape).
const SNAPSHOT_ENVELOPE_TOKENS = 180;
const MAX_SNAPSHOT_TOKENS = 12_000;   // PERCEPTION_TOO_LARGE above this

/** A single candidate discovered by the walk, before region tagging. */
interface Candidate {
  node: Element;
  frame: string;
  role: string;
  name: string;
  nameSource: ElementDescriptor['nameSource'];
  tag: string;
  inputType?: string;
  enabled: boolean;
  visible: boolean;
  inViewport: boolean;
  actionable: boolean;
  href?: string;
  sensitiveKind: SensitiveKind & ('file' | null);
  autocomplete?: string;
  formEl: HTMLFormElement | null;
  valueShape?: string;
  interactive: boolean;
  regionId: string;   // filled in by tagRegions()
}

interface WalkResult {
  candidates: Candidate[];
  excludedCount: number;
  unreachableRegions: string[];
  searchableRoots: (Document | ShadowRoot)[];
}

export interface BuildSnapshotOptions {
  runId: string;
  tabId: number;
  region?: string;
  tokenBudget: number;
}

export interface BuildSnapshotOutcome {
  ok: true;
  snapshot: PerceptionSnapshot;
}
export interface BuildSnapshotTooLarge {
  ok: false;
  reason: 'PERCEPTION_TOO_LARGE';
  tokensOver: number;
}
export type BuildSnapshotResult = BuildSnapshotOutcome | BuildSnapshotTooLarge;

export async function buildSnapshot(
  registry: ElementRegistry,
  settle: SettleDetector,
  opts: BuildSnapshotOptions,
): Promise<BuildSnapshotResult> {
  const t0 = performance.now();
  const settleResult = await settle.wait();
  const epoch = registry.beginEpoch();
  if (settleResult.suspect) registry.markSuspect(epoch);

  const { candidates, excludedCount, unreachableRegions, searchableRoots } = walk();
  const { regions: regionDefs, regionOf } = deriveRegions(candidates, searchableRoots);
  for (const c of candidates) c.regionId = regionOf(c.node);

  const { ordered, targetRegionId } = orderCandidates(candidates, opts.region);
  const { kept, regions, overBudgetBy } = prune(ordered, opts.tokenBudget, regionDefs, targetRegionId);

  // A Rule-1 overshoot is allowed to exceed the requested budget, but never
  // past the hard MAX_SNAPSHOT_TOKENS ceiling — checked here on the actual
  // kept set before any handle is allocated for it.
  const keptCost = SNAPSHOT_ENVELOPE_TOKENS
    + kept.reduce((s, c) => s + countTokens(serialiseCandidate(c)), 0);
  if (keptCost > MAX_SNAPSHOT_TOKENS) {
    return { ok: false, reason: 'PERCEPTION_TOO_LARGE', tokensOver: keptCost - MAX_SNAPSHOT_TOKENS };
  }

  const elements: ElementDescriptor[] = kept.map((c, i) => {
    const desc = toResolutionDescriptor(c, ordered);
    const handle = registry.allocate(c.node, desc, c.frame);
    return {
      handle,
      role: c.role,
      name: c.name,
      nameSource: c.nameSource,
      tag: c.tag,
      inputType: c.inputType,
      valueShape: c.valueShape as ElementDescriptor['valueShape'],
      enabled: c.enabled,
      visible: c.visible,
      inViewport: c.inViewport,
      actionable: c.actionable,
      href: c.href,
      sensitiveKind: c.sensitiveKind,
      autocomplete: c.autocomplete,
      formId: c.formEl ? (formSignature(c.formEl) ?? undefined) : undefined,
      regionId: c.regionId,
      ordinal: i,
    };
  });

  const buildMs = Math.round(performance.now() - t0);
  const snapshot: PerceptionSnapshot = {
    runId: opts.runId,
    tabId: opts.tabId,
    epoch,
    url: location.href,
    origin: location.origin,
    title: document.title.slice(0, 200),
    settled: settleResult.settled,
    settleWaitedMs: settleResult.waitedMs,
    settleCalibration: settleResult.calibration,
    epochSuspect: settleResult.suspect,
    elements,
    excludedCount,
    regions,
    unreachableRegions,
    buildMs,
    ...(overBudgetBy ? { overBudget: { by: overBudgetBy } } : {}),
  };
  return { ok: true, snapshot };
}

// ═══════════════════════════ 7.1 — The walk ═══════════════════════════

function walk(): WalkResult {
  const candidates: Candidate[] = [];
  const unreachable: string[] = [];
  const searchableRoots: (Document | ShadowRoot)[] = [document];
  let excludedCount = 0;

  const visit = (root: Document | ShadowRoot, frame: string) => {
    const it = document.createTreeWalker(
      root === document ? document.documentElement : (root as ShadowRoot).host ?? (root as unknown as Element),
      NodeFilter.SHOW_ELEMENT,
    );
    // For a ShadowRoot, TreeWalker needs an Element root — start walking
    // from the shadow root's children directly instead.
    let node: Element | null = root === document
      ? (it.currentNode as Element)
      : firstShadowChild(root as ShadowRoot);

    let iframeIndex = 0;

    while (node) {
      // 1. Open shadow roots are traversed inline. Closed ones are
      //    unreachable, by design (architecture.md §3.7.2 — no bypass).
      if (node.shadowRoot) {
        searchableRoots.push(node.shadowRoot);
        visit(node.shadowRoot, frame);
      } else if (isCustomElementWithClosedShadow(node)) {
        unreachable.push(`shadow:${node.localName}`);
      }

      // 2. Same-origin iframes share the namespace; cross-origin ones are
      //    reported, never treated as empty (PRD §9.2).
      if (node instanceof HTMLIFrameElement) {
        const doc = sameOriginContentDocument(node);
        if (doc) {
          const childFrame = frame ? `${frame}>f${iframeIndex}` : `f${iframeIndex}`;
          iframeIndex += 1;
          searchableRoots.push(doc);
          visit(doc, childFrame);
        } else {
          const org = originOf(node.getAttribute('src') ?? '');
          unreachable.push(`iframe:${org ?? 'opaque'}`);
        }
      }

      // 3. THE EXCLUSION, at the earliest possible point — before any value
      //    read, before name computation (§7.1, PR-PRV-1, SC-2).
      const sensitive = classifySensitive(node);
      if (sensitive && sensitive !== 'file') {
        excludedCount += 1;
        node = nextNode(root, it, node);
        continue;
      }

      const interactive = isInteractive(node);
      const structural = !interactive && isStructural(node);
      if (interactive || structural) {
        candidates.push(makeCandidate(node, frame, sensitive as 'file' | null, interactive));
      }
      node = nextNode(root, it, node);
    }
  };

  visit(document, '');
  return { candidates, excludedCount, unreachableRegions: dedupe(unreachable), searchableRoots };
}

function firstShadowChild(shadow: ShadowRoot): Element | null {
  for (const child of Array.from(shadow.children)) return child;
  return null;
}

/** Depth-first-next helper that works both for a real TreeWalker (document
 *  case) and the shadow-root case, where we hand-roll the same traversal
 *  order over shadow.children so open shadow roots nest exactly like
 *  ordinary elements from the walk's point of view. */
function nextNode(root: Document | ShadowRoot, it: TreeWalker, current: Element): Element | null {
  if (root === document) return it.nextNode() as Element | null;
  // Manual pre-order traversal within a shadow root's light tree.
  if (current.firstElementChild) return current.firstElementChild;
  let node: Element | null = current;
  while (node) {
    if (node.nextElementSibling) return node.nextElementSibling;
    node = node.parentElement;
    if (node === (root as ShadowRoot).host) return null;
  }
  return null;
}

function isCustomElementWithClosedShadow(el: Element): boolean {
  // A closed shadow root is invisible to script by construction — there is
  // no direct way to detect one exists. The heuristic: a custom element
  // (hyphenated tag name) that declares itself shadow-hosting via a common
  // convention attribute, OR simply any custom element with no light-DOM
  // children and no shadowRoot visible to us, which is the shape a closed
  // shadow host takes from outside.
  if (!el.tagName.includes('-')) return false;
  if (el.shadowRoot) return false;   // open — already handled above
  return el.children.length === 0 && el.childNodes.length === 0;
}

function sameOriginContentDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument;
  } catch {
    return null;
  }
}

function originOf(src: string): string | null {
  if (!src) return null;
  try {
    return new URL(src, location.href).origin;
  } catch {
    return null;
  }
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list));
}

function makeCandidate(
  el: Element, frame: string, sensitiveKind: 'file' | null, interactive: boolean,
): Candidate {
  const role = computeRole(el);
  const { name, source } = computeAccessibleName(el);
  const { visible, inViewport } = visibilityOf(el);
  const tag = el.tagName.toLowerCase();
  const enabled = !isDisabled(el);
  const isFile = sensitiveKind === 'file';
  const actionable = interactive && enabled && !isFile;

  const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined;
  const href = tag === 'a' ? (el as HTMLAnchorElement).href || undefined : undefined;
  const autocomplete = el.getAttribute('autocomplete') ?? undefined;
  const formEl = 'closest' in el ? (el as HTMLElement).closest('form') : null;

  return {
    node: el, frame, role, name, nameSource: source, tag, inputType,
    enabled, visible, inViewport, actionable, href, sensitiveKind: isFile ? 'file' : null,
    autocomplete, formEl, valueShape: computeValueShape(el, tag, isFile),
    interactive, regionId: 'region:root',
  };
}

export function isDisabled(el: Element): boolean {
  if ('disabled' in el && (el as { disabled?: boolean }).disabled) return true;
  return el.getAttribute('aria-disabled') === 'true';
}

/**
 * §7.6 — the literal-value rule. A field's current value, truncated to 60
 * characters; over that, `filled:<length>` only (never the content) so a
 * long textarea's draft never becomes a Class B disclosure inside what was
 * declared Class A (§3.7.23).
 */
function computeValueShape(el: Element, tag: string, isFile: boolean): string | undefined {
  if (isFile) return undefined;
  let raw: string | undefined;
  if (tag === 'input' || tag === 'textarea') {
    raw = (el as HTMLInputElement | HTMLTextAreaElement).value;
  } else if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    raw = sel.options[sel.selectedIndex]?.text;
  } else if ((el as HTMLElement).isContentEditable) {
    // [Phase 3 correction — found by tests/e2e/copilot.bench.ts's 40-action
    // sweep] Without this branch, every contenteditable region (quill.html)
    // reports valueShape: undefined forever, so lib/page/verifier.ts's
    // `type` case NEVER sees its write land — a genuine WRITE_REJECTED
    // false negative on every successful edit. Mirrors
    // lib/page/actuator.ts's own readValue(), which already reads
    // innerText/textContent for isContentEditable — the two
    // representations of "this element's current value" must agree, or
    // the verifier is comparing the actuator's before-state against a
    // representation the perception layer never produces.
    raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
  } else {
    return undefined;
  }
  if (raw === undefined) return undefined;
  if (raw.length === 0) return 'empty';
  if (raw.length <= 60) return raw;
  return `filled:${raw.length}`;
}

// ═══════════════════════════ 7.2 — Visibility ═══════════════════════════

interface CheckVisibilityCapable {
  checkVisibility?: (opts?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean;
}

export function visibilityOf(el: Element): { visible: boolean; inViewport: boolean } {
  const withCheck = el as unknown as CheckVisibilityCapable;
  let visible: boolean;
  if (typeof withCheck.checkVisibility === 'function') {
    visible = withCheck.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  } else {
    visible = manualVisibility(el);
  }
  if (!visible) return { visible: false, inViewport: false };

  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { visible: false, inViewport: false };
  const view = el.ownerDocument.defaultView ?? window;
  const inViewport = r.bottom > 0 && r.right > 0
    && r.top < view.innerHeight && r.left < view.innerWidth;
  return { visible: true, inViewport };
}

function manualVisibility(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  let style: CSSStyleDeclaration;
  try {
    style = view.getComputedStyle(el);
  } catch {
    return true;
  }
  if (style.display === 'none' || style.visibility === 'hidden'
      || style.visibility === 'collapse' || parseFloat(style.opacity) === 0) {
    return false;
  }
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

// ═══════════════════════════ 7.3 — Regions ═══════════════════════════

interface RegionDef {
  regionId: string;
  priority: 1 | 2 | 3 | 4;
  label: string;
  root: Element;
  /** For repeat regions only: the sibling block roots this region spans. */
  blockRoots?: Element[];
}

// A note on priority, since it has a real, known corner case: regionOf()
// below resolves an element's region by TYPE precedence (form > landmark >
// repeat > root), not by nearest ancestor. A repeat block physically nested
// inside a landmark (e.g. a product grid inside <main>) therefore reports
// as part of that landmark's completeness, not as its own repeat region —
// §7.3's worked example (2 forms, 4 landmarks, a 24-item grid → 7 regions)
// implicitly assumes the grid is NOT nested in one of those landmarks.
// Revisiting this — e.g. nearest-ancestor-wins instead of type-precedence —
// is deferred to whichever later phase's evidence (the Q3 pruning study, or
// a real count-verification miss in Phase 3) shows it actually matters.

interface RegionIndex {
  regions: RegionDef[];
  regionOf: (el: Element) => string;
}

const MIN_REPEAT_SIBLINGS = 3;

function deriveRegions(candidates: Candidate[], roots: (Document | ShadowRoot)[]): RegionIndex {
  const regions: RegionDef[] = [];
  const formRegionByEl = new Map<Element, RegionDef>();
  const landmarkRegionByEl = new Map<Element, RegionDef>();
  const blockRootToRegion = new Map<Element, RegionDef>();

  let formOrdinal = 0;
  const landmarkOrdinals = new Map<string, number>();

  for (const root of roots) {
    for (const form of Array.from(root.querySelectorAll('form'))) {
      const id = form.id ? form.id : `${formOrdinal}`;
      const label = computeAccessibleName(form).name || `Form ${formOrdinal + 1}`;
      const def: RegionDef = {
        regionId: `form:${id}`, priority: 1, label, root: form,
      };
      formOrdinal += 1;
      regions.push(def);
      formRegionByEl.set(form, def);
    }

    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (!isLandmark(el)) continue;
      const role = computeRole(el);
      // A <form> is ALSO a landmark under ARIA (isLandmark()/roles.ts is
      // correct about that in general), but §7.3's priority table already
      // claims every <form> at priority 1 specifically to keep it out of
      // this bucket — double-counting it here as priority 2 as well would
      // inflate the landmark count for every form on the page.
      if (role === 'form') continue;
      const n = landmarkOrdinals.get(role) ?? 0;
      landmarkOrdinals.set(role, n + 1);
      const label = computeAccessibleName(el).name
        || `${role.charAt(0).toUpperCase()}${role.slice(1)} ${n + 1}`;
      const def: RegionDef = {
        regionId: `landmark:${role}:${n}`, priority: 2, label, root: el,
      };
      regions.push(def);
      landmarkRegionByEl.set(el, def);
    }

    for (const container of Array.from(root.querySelectorAll('*'))) {
      const groups = new Map<string, Element[]>();
      for (const child of Array.from(container.children)) {
        const key = child.tagName;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(child);
      }
      for (const [, siblings] of groups) {
        if (siblings.length < MIN_REPEAT_SIBLINGS) continue;
        if (!structurallySimilar(siblings)) continue;
        // Skip if this exact block set was already registered from a
        // shallower container (avoids double-counting nested repeats).
        if (siblings.some((s) => blockRootToRegion.has(s))) continue;
        const hash = hashParentPath(container);
        const def: RegionDef = {
          regionId: `repeat:${hash}`, priority: 3,
          label: `a list of ${siblings.length} similar items`,
          root: container, blockRoots: siblings,
        };
        regions.push(def);
        for (const s of siblings) blockRootToRegion.set(s, def);
      }
    }
  }

  const rootRegion: RegionDef = { regionId: 'region:root', priority: 4, label: 'Page', root: document.documentElement };

  const regionOf = (el: Element): string => {
    // Self-membership checked directly (not via closest()) before falling
    // back to an ancestor search: the element itself IS the registered
    // form root in the common case where a <form> is its own structural
    // candidate (role="form" is in STRUCTURAL_ROLES), and closest()'s
    // return value for a self-match is not guaranteed reference-stable
    // across every DOM implementation this code may ever run under.
    const formEl = formRegionByEl.has(el) ? el
      : ('closest' in el ? (el as HTMLElement).closest('form') : null);
    if (formEl && formRegionByEl.has(formEl)) return formRegionByEl.get(formEl)!.regionId;

    let node: Element | null = el;
    while (node) {
      if (landmarkRegionByEl.has(node)) return landmarkRegionByEl.get(node)!.regionId;
      node = node.parentElement;
    }

    node = el;
    while (node) {
      if (blockRootToRegion.has(node)) return blockRootToRegion.get(node)!.regionId;
      node = node.parentElement;
    }

    return rootRegion.regionId;
  };

  return { regions: [...regions, rootRegion], regionOf };
}

/** Same child-tag sequence to depth 2 — deliberately structural, not
 *  class-based, so a product grid whose cards carry differing class
 *  attributes still matches (§7.3). */
function structurallySimilar(siblings: Element[]): boolean {
  const shapeOf = (el: Element): string =>
    Array.from(el.children).map((c) => c.tagName).join(',');
  const first = shapeOf(siblings[0]);
  if (!first) return false;   // no children at all — not a meaningful repeat
  return siblings.every((s) => shapeOf(s) === first);
}

function hashParentPath(el: Element): string {
  const path = domPath(el);
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// ═══════════════════════════ 7.4 — Ordering ═══════════════════════════

/**
 * Orders candidates so pruning drops the least useful things first: the
 * target region (explicit or the focused element's form) first, then
 * in-viewport interactive elements, then out-of-viewport interactive
 * elements, then structural orientation elements, then anything not
 * visible at all — each tier in document order.
 */
interface OrderResult {
  ordered: Candidate[];
  /** The resolved target region, or undefined when there genuinely is
   *  none — explicit and returned rather than left for prune() to guess
   *  from ordered[0], which would treat whatever tier-1 candidate happens
   *  to sort first as "the target" on a page with no form focus and no
   *  requested region, silently disabling Rule 1's actual purpose. */
  targetRegionId?: string;
}

function orderCandidates(candidates: Candidate[], explicitRegion?: string): OrderResult {
  const focusedForm = (document.activeElement instanceof HTMLElement)
    ? document.activeElement.closest('form') : null;
  const targetRegionId = explicitRegion
    ?? (focusedForm ? candidates.find((c) => c.formEl === focusedForm)?.regionId : undefined);

  const tierOf = (c: Candidate): number => {
    if (targetRegionId && c.regionId === targetRegionId) return 0;
    if (c.interactive && c.visible && c.inViewport) return 1;
    if (c.interactive && c.visible) return 2;
    if (!c.interactive) return 3;
    return 4;   // not visible at all
  };

  const ordered = candidates
    .map((c, i) => ({ c, i, tier: tierOf(c) }))
    .sort((a, b) => (a.tier - b.tier) || (a.i - b.i))
    .map((x) => x.c);

  return { ordered, targetRegionId };
}

// ═══════════════════════════ 7.5 — Pruning ═══════════════════════════

function serialiseCandidate(c: Candidate): string {
  return JSON.stringify({
    role: c.role, name: c.name, tag: c.tag, inputType: c.inputType,
    valueShape: c.valueShape, enabled: c.enabled, visible: c.visible,
    inViewport: c.inViewport, actionable: c.actionable, href: c.href,
    sensitiveKind: c.sensitiveKind, autocomplete: c.autocomplete,
    regionId: c.regionId,
  });
}

interface PruneResult {
  kept: Candidate[];
  regions: RegionCompleteness[];
  overBudgetBy?: number;
}

function prune(
  ordered: Candidate[], budget: number, regionDefs: RegionDef[], targetRegion?: string,
): PruneResult {
  const kept: Candidate[] = [];
  const droppedRegions = new Set<string>();   // repeat regions dropped whole
  let used = SNAPSHOT_ENVELOPE_TOKENS;
  let overshoot = 0;

  const repeatRegionIds = new Set(regionDefs.filter((r) => r.priority === 3).map((r) => r.regionId));
  const handledRepeats = new Set<string>();

  for (const c of ordered) {
    if (repeatRegionIds.has(c.regionId)) {
      if (handledRepeats.has(c.regionId)) continue;   // already resolved whole/none
      handledRepeats.add(c.regionId);
      const block = ordered.filter((x) => x.regionId === c.regionId);
      const blockCost = block.reduce((s, x) => s + countTokens(serialiseCandidate(x)), 0);
      if (used + blockCost <= budget) {
        kept.push(...block);
        used += blockCost;
      } else if (c.regionId === targetRegion) {
        // Rule 1 beats Rule 2 when the working region IS the repeat block.
        kept.push(...block);
        used += blockCost;
        overshoot += Math.max(0, used - budget);
      } else {
        droppedRegions.add(c.regionId);
      }
      continue;
    }

    const cost = countTokens(serialiseCandidate(c));
    if (used + cost <= budget) {
      kept.push(c);
      used += cost;
      continue;
    }

    // RULE 1: never truncate inside the region the current step targets.
    if (c.regionId === targetRegion) {
      kept.push(c);
      used += cost;
      overshoot += Math.max(0, used - budget);
      continue;
    }

    droppedRegions.add(c.regionId);
  }

  const regions = buildRegionReport(ordered, kept, regionDefs);
  return { kept, regions, overBudgetBy: overshoot > 0 ? overshoot : undefined };
}

function buildRegionReport(
  all: Candidate[], kept: Candidate[], regionDefs: RegionDef[],
): RegionCompleteness[] {
  const keptSet = new Set(kept);
  const report: RegionCompleteness[] = [];
  for (const def of regionDefs) {
    if (def.priority === 3 && def.blockRoots) {
      // Repeat regions are counted at BLOCK granularity (§7.3, task 2.9):
      // total is the number of repeated items, not their inner elements.
      // A block counts as "shown" when every candidate belonging to it
      // survived pruning (Rule 2: a repeat block is dropped whole or kept
      // whole, never split) — including a block that contributed no
      // candidates at all (nothing to prune means nothing was hidden from
      // it), which keeps this honest rather than defaulting to "complete"
      // whenever nothing in the block happened to match this region at all.
      const total = def.blockRoots.length;
      let shown = 0;
      for (const block of def.blockRoots) {
        const inBlock = all.filter((c) => nearestBlockRoot(c.node, def.blockRoots!) === block);
        if (inBlock.length === 0 || inBlock.every((c) => keptSet.has(c))) shown += 1;
      }
      report.push({
        regionId: def.regionId, label: def.label,
        complete: shown === total, shown, total,
      });
      continue;
    }

    const inRegion = all.filter((c) => c.regionId === def.regionId);
    if (inRegion.length === 0) continue;   // don't report empty regions
    const shown = inRegion.filter((c) => keptSet.has(c)).length;
    report.push({
      regionId: def.regionId, label: def.label,
      complete: shown === inRegion.length, shown, total: inRegion.length,
    });
  }
  return report;
}

function nearestBlockRoot(el: Element, blockRoots: Element[]): Element {
  let node: Element | null = el;
  while (node) {
    if (blockRoots.includes(node)) return node;
    node = node.parentElement;
  }
  return el;
}

// ══════════════════════ Resolution descriptor building ══════════════════════

/** Builds the ResolutionDescriptor the registry needs to re-resolve this
 *  element later (§4.1), computing ordinalWithinName / poolSizeWhenCaptured
 *  against the full ordered candidate list captured this epoch (not just
 *  the pruned subset — a dropped sibling still counts toward the pool). */
function toResolutionDescriptor(c: Candidate, allOrdered: Candidate[]): ResolutionDescriptor {
  const sameRoleAndName = allOrdered.filter((x) => x.role === c.role && x.name === c.name);
  const ordinalWithinName = sameRoleAndName.indexOf(c);
  return {
    role: c.role,
    name: c.name,
    tag: c.tag,
    inputType: c.inputType,
    formSignature: formSignature(c.formEl),
    ordinalWithinName: ordinalWithinName >= 0 ? ordinalWithinName : 0,
    poolSizeWhenCaptured: sameRoleAndName.length,
    domPath: domPath(c.node),
    textFingerprint: ownText(c.node) || undefined,
  };
}
