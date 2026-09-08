/**
 * Element Registry — content script only. Phase 2 §4.
 *
 * A handle (`e<n>`) is an opaque string allocated by this registry,
 * meaningful only inside the epoch that allocated it, resolvable only
 * through this registry. The model never sees a selector, an XPath, or a
 * DOM node id, and cannot construct a reference to an element the snapshot
 * did not offer (architecture.md §3.7.2).
 */
import { accessibleName } from '@lib/page/accname';
import { computeRole } from '@lib/page/roles';

/** Everything needed to find this element again after the DOM has changed. */
export interface ResolutionDescriptor {
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  formSignature?: string;
  ordinalWithinName: number;
  /** The pool size (post role+name filtering) observed at capture time —
   *  the ordinal discriminator (§4.3 step 4) only trusts position when the
   *  pool has not changed size since. */
  poolSizeWhenCaptured: number;
  /** Structural path. NEVER used as a matching discriminator — recorded only
   *  for a human reading the journal (§4.3). */
  domPath: string;
  textFingerprint?: string;
}

interface RegistryEntry {
  handle: string;
  // WeakRef: a detached node must not be kept alive by us.
  node: WeakRef<Element>;
  descriptor: ResolutionDescriptor;
  epoch: number;
  frame: string;   // '' for top, else 'f0>f2' — the same-origin frame path
}

export type Resolution =
  | { kind: 'exact'; node: Element }
  | { kind: 'reresolved'; node: Element; confidence: number }
  | { kind: 'ambiguous'; candidates: Element[] }
  | { kind: 'missing' };

/** Entries older than epoch - RETENTION_EPOCHS are dropped on beginEpoch(). */
const RETENTION_EPOCHS = 2;   // 3 epochs total: current + 2 back (§4.2)

export class ElementRegistry {
  private epoch = 0;
  private entries = new Map<string, RegistryEntry>();
  private nextIndex = 0;
  /** Epochs whose settle window saw a mutation burst above the threshold
   *  (§3.7.3 Q10). resolve() against a suspect epoch never short-circuits
   *  to 'exact', even when the WeakRef still points at a connected node. */
  private suspectEpochs = new Set<number>();

  /** Called at the start of every structure read. Old handles become stale,
   *  not invalid — retained for descriptor re-resolution, not cleared. */
  beginEpoch(): number {
    this.epoch += 1;
    this.nextIndex = 0;
    const floor = this.epoch - RETENTION_EPOCHS;
    for (const [key, entry] of this.entries) {
      if (entry.epoch < floor) this.entries.delete(key);
    }
    for (const e of this.suspectEpochs) {
      if (e < floor) this.suspectEpochs.delete(e);
    }
    return this.epoch;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  markSuspect(epoch: number): void {
    this.suspectEpochs.add(epoch);
  }

  isSuspect(epoch: number): boolean {
    return this.suspectEpochs.has(epoch);
  }

  allocate(node: Element, descriptor: ResolutionDescriptor, frame: string): string {
    const handle = `e${this.nextIndex++}`;
    this.entries.set(`${this.epoch}:${handle}`, {
      handle, node: new WeakRef(node), descriptor, epoch: this.epoch, frame,
    });
    return handle;
  }

  /** Test/introspection only — not part of the resolution contract. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Called when the document itself is going away — pagehide, or the
   * content script's own context invalidated by an extension reload. Every
   * outstanding handle becomes unresolvable; there is no document left to
   * re-resolve descriptors against, so retention would only leak memory
   * for entries nothing can ever legitimately query again.
   */
  invalidateAll(_reason: 'PAGEHIDE' | 'CTX_INVALIDATED'): void {
    this.entries.clear();
    this.suspectEpochs.clear();
  }

  resolve(handle: string, epoch: number): Resolution {
    const entry = this.entries.get(`${epoch}:${handle}`);
    if (!entry) return { kind: 'missing' };

    if (!this.isSuspect(epoch)) {
      const live = entry.node.deref();
      if (live && live.isConnected) return { kind: 'exact', node: live };
    }

    return this.reresolve(entry.descriptor, entry.frame);
  }

  /**
   * Descriptor re-resolution. Deliberately ordered from most to least
   * trustworthy, and deliberately refuses to guess when more than one
   * candidate survives (§4.3).
   */
  private reresolve(d: ResolutionDescriptor, frame: string): Resolution {
    const doc = this.documentForFrame(frame);
    if (!doc) return { kind: 'missing' };

    // 1. Every element whose computed role matches. Role is the most stable
    //    property across a re-render; class names and ids are the least.
    let pool = Array.from(doc.querySelectorAll<Element>('*'))
      .filter((el) => computeRole(el) === d.role);

    // 2. Exact accessible name. Normalised the same way it was when captured.
    const byName = pool.filter((el) => accessibleName(el) === d.name);
    if (byName.length === 1) return { kind: 'reresolved', node: byName[0], confidence: 1.0 };
    if (byName.length > 1) {
      pool = byName;
    } else if (byName.length === 0 && d.name) {
      // 2b. The name changed. Fall back to the text fingerprint for
      //     links/buttons, which survives an aria-label edit that a name
      //     match would not.
      const byText = pool.filter(
        (el) => d.textFingerprint && ownText(el).slice(0, 40) === d.textFingerprint,
      );
      if (byText.length === 1) return { kind: 'reresolved', node: byText[0], confidence: 0.7 };
      if (byText.length === 0) return { kind: 'missing' };
      pool = byText;
    }

    // 3. Same enclosing form. Two "Continue" buttons in different forms are
    //    different buttons, and the form is usually the stable one.
    if (d.formSignature) {
      const sameForm = pool.filter(
        (el) => formSignature(el.closest('form')) === d.formSignature,
      );
      if (sameForm.length === 1) return { kind: 'reresolved', node: sameForm[0], confidence: 0.9 };
      if (sameForm.length > 0) pool = sameForm;
    }

    // 4. Ordinal among identically-named siblings. LAST discriminator, only
    //    trusted when the pool size matches what was captured — if the page
    //    now has four "Continue" buttons where it had two, position means
    //    nothing.
    if (pool.length > d.ordinalWithinName && pool.length === d.poolSizeWhenCaptured) {
      return { kind: 'reresolved', node: pool[d.ordinalWithinName], confidence: 0.6 };
    }

    if (pool.length === 0) return { kind: 'missing' };
    if (pool.length === 1) return { kind: 'reresolved', node: pool[0], confidence: 0.5 };
    return { kind: 'ambiguous', candidates: pool.slice(0, 4) };   // 4: enough for a
                                                                   // Phase 10 look_at grid
  }

  /** Resolves a same-origin frame path ('' | 'f0' | 'f0>f2' ...) to a Document. */
  private documentForFrame(frame: string): Document | null {
    if (!frame) return document;
    let doc: Document = document;
    for (const segment of frame.split('>')) {
      const idx = Number(segment.slice(1));
      const iframes = doc.querySelectorAll('iframe');
      const target = iframes[idx];
      if (!target) return null;
      try {
        const inner = (target as HTMLIFrameElement).contentDocument;
        if (!inner) return null;
        doc = inner;
      } catch {
        return null;   // cross-origin: not reachable
      }
    }
    return doc;
  }
}

/** First 40 chars of own text (not descendants' via other elements' names). */
export function ownText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** A stable signature for the form enclosing an element: id, name, or action. */
export function formSignature(form: HTMLFormElement | null): string | undefined {
  if (!form) return undefined;
  const key = form.id || form.getAttribute('name') || form.getAttribute('action') || '';
  return key ? `form:${key}` : undefined;
}

/** A structural path, recorded for the journal only — NEVER a discriminator. */
export function domPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === Node.ELEMENT_NODE && depth < 12) {
    const current: Element = node;
    const parent: Element | null = current.parentElement;
    if (!parent) { parts.unshift(current.tagName.toLowerCase()); break; }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
    const idx = siblings.indexOf(current);
    parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = parent;
    depth += 1;
  }
  return parts.join('>');
}
