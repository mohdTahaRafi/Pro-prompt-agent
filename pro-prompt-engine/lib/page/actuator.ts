/**
 * Actuator — the part that actually touches the DOM. Content script only.
 * Docs/planning/phase_3_gate_actuation_verification.md §6.3.
 *
 * Replaces lib/ui/snippet-manager.ts's `el.value = text` + dispatched
 * `input` event — the technique that silently fails on React-controlled
 * inputs (architecture.md's gap table §3.2) — with the native-setter
 * technique below, verified against fixtures/react-form.html.
 *
 * SPEC NOTE: widened to take `runId` (see lib/actuation/backend.ts's header
 * note) so the stop check has a flag to read. chrome.storage.session is
 * made readable from this content-script context by a one-line
 * `setAccessLevel` call in entrypoints/background.ts's init — without it,
 * MV3 restricts session storage to trusted (extension-page/SW) contexts by
 * default and this file's very first check would always read undefined.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import { classifySensitive } from '@lib/page/sensitive';
import { visibilityOf } from '@lib/page/perception';
import { handleOf, type Action } from '@lib/schemas/action.schema';
import type { ElementRegistry } from '@lib/page/registry';
import type { ActEffect } from '@lib/actuation/backend';
import type { FailureCause } from '@lib/types/agent.types';

async function isStopped(runId: number): Promise<boolean> {
  try {
    const stopKey = `stop:${runId}`;
    const { [stopKey]: stopped } = await chrome.storage.session.get(stopKey);
    return Boolean(stopped);
  } catch {
    // storage.session unreachable from this context (access level not yet
    // granted, or a test environment with no chrome.storage.session double)
    // — fail OPEN on the stop check specifically would be wrong, so this
    // is treated as "not stopped" only because the gate's own check 7 (run
    // just before this) is the primary enforcement point; this is defence
    // in depth on top of it, not the only line.
    return false;
  }
}

export async function actuate(
  action: Action, epoch: number, registry: ElementRegistry, runId: number,
): Promise<Result<ActEffect, FailureCause>> {
  const t0 = performance.now();

  // ── STOP, checked one last time immediately before touching anything
  //    (architecture.md §3.7.7) ──
  if (await isStopped(runId)) return Err('STOPPED');

  const handle = handleOf(action);
  let el: Element | undefined;
  if (handle) {
    const r = registry.resolve(handle, epoch);
    if (r.kind === 'missing') return Err('TARGET_MISSING');
    if (r.kind === 'ambiguous') return Err('TARGET_AMBIGUOUS');
    el = r.node;

    // ── Pre-action target re-checks (PR-ACT-5). All five, in order. ──
    if (!el.isConnected) return Err('TARGET_MISSING');
    // The third independent sensitive check — snapshot, gate, actuator.
    // Should be unreachable; if it ever fires the journal records a gate
    // bypass, a hard-gate violation to investigate (§6.3).
    if (classifySensitive(el) !== null) return Err('NEVER_TIER_AT_ACTUATOR');
    const vis = visibilityOf(el);
    if (!vis.visible) return Err('TARGET_MISSING');
    if ('disabled' in el && (el as HTMLInputElement).disabled) return Err('TARGET_DISABLED');
    if (isObscured(el)) return Err('OBSCURED');
  }

  switch (action.verb) {
    case 'scroll': return doScroll(action, el, t0);
    case 'click': return el ? Ok(await doClick(el as HTMLElement, t0)) : Err('TARGET_MISSING');
    case 'type': return el ? doType(el as HTMLElement, action.text, action.mode, t0) : Err('TARGET_MISSING');
    case 'select': return el ? doSelect(el, action.value, t0) : Err('TARGET_MISSING');
    default:
      // Unreachable for the implemented verb set — the gate refuses every
      // other verb with NOT_YET_IMPLEMENTED before actuate() is ever called.
      return Err('TARGET_MISSING');
  }
}

/**
 * Occlusion check: is the element's centre point actually the element (or a
 * descendant of it)? A cookie banner or a modal covering the target is the
 * single most common reason a "successful" click does nothing.
 */
function isObscured(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return true;
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return isObscured(el);   // one retry after scrolling; recursion depth is 2
  }
  // elementFromPoint pierces open shadow roots via composedPath in Chrome.
  const top = document.elementFromPoint(cx, cy);
  if (!top) return true;
  return !(top === el || el.contains(top) || top.contains(el));
}

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// ── Scrolling ──

const SCROLL_DIRECTIONS = new Set(['up', 'down', 'top', 'bottom']);

function doScroll(
  action: Extract<Action, { verb: 'scroll' }>, el: Element | undefined, t0: number,
): Result<ActEffect, FailureCause> {
  if (el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return Ok({ dispatched: true, elapsedMs: Math.round(performance.now() - t0) });
  }
  if (!SCROLL_DIRECTIONS.has(action.target)) return Err('TARGET_MISSING');
  const px = ((action.amount ?? 10) / 10) * window.innerHeight;
  switch (action.target) {
    case 'up': window.scrollBy({ top: -px, behavior: 'instant' }); break;
    case 'down': window.scrollBy({ top: px, behavior: 'instant' }); break;
    case 'top': window.scrollTo({ top: 0, behavior: 'instant' }); break;
    case 'bottom': window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }); break;
  }
  return Ok({ dispatched: true, elapsedMs: Math.round(performance.now() - t0) });
}

// ── Clicking ──

async function doClick(el: HTMLElement, t0: number): Promise<ActEffect> {
  const beforeUrl = location.href;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  await raf();   // one frame, so layout settles

  // The full pointer sequence, in the order a real click produces it. A
  // bare el.click() skips pointerdown/mousedown, which many custom controls
  // and every drag-aware component listen for instead of `click`.
  const r = el.getBoundingClientRect();
  const init = {
    bubbles: true, cancelable: true, composed: true,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
  return {
    dispatched: true, preState: beforeUrl,
    targetRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    elapsedMs: Math.round(performance.now() - t0),
  };
}

// ── Typing, and the native-value-setter technique ──

function readValue(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  if (el.isContentEditable) return el.innerText ?? el.textContent ?? '';
  return '';
}

async function doType(
  el: HTMLElement, text: string, mode: 'replace' | 'append', t0: number,
): Promise<Result<ActEffect, FailureCause>> {
  const before = readValue(el);
  el.focus();
  if (document.activeElement !== el && !el.contains(document.activeElement)) {
    // Focus never landed — nothing below would actually reach the field.
    // Still reported as dispatched, not refused: the actuator records what
    // it observed itself doing, never whether it worked (§6.1) — it is
    // lib/page/verifier.ts's read-back that turns focusFailed into a
    // 'failed' verdict.
    return Ok({ dispatched: true, preState: before, elapsedMs: Math.round(performance.now() - t0), focusFailed: true });
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const next = mode === 'append' ? el.value + text : text;

    // THE TECHNIQUE. React (and Vue, and Angular) attach a value setter to
    // the element instance that shadows the prototype's. Assigning
    // el.value = x writes through the framework's own setter, which
    // updates the DOM but NOT the framework's internal state — so the
    // framework's next render overwrites it and the typing silently
    // vanishes. Calling the prototype's native setter directly, then
    // dispatching a bubbling `input` event, makes the framework's own
    // listener observe a real change and update its state.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(el, next);

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    // contenteditable has no value property; insertText is the path used
    // by real rich editors' own programmatic-input handling. Deprecated,
    // used anyway — no replacement has shipped. Verified empirically
    // (tests/e2e/actuation.spec.ts, fixtures/quill.html): a bubbling
    // `input` event reliably fires from this call and is what an editor's
    // own change-detection depends on; `beforeinput` is NOT reliably fired
    // by execCommand's programmatic path in the same way a real keystroke
    // fires it, so nothing here depends on it. When Chrome removes
    // execCommand, the fallback is a manual Range mutation + input dispatch.
    const sel = window.getSelection();
    if (mode === 'replace') {
      sel?.selectAllChildren(el);
    } else {
      sel?.selectAllChildren(el);
      sel?.collapseToEnd();
    }
    document.execCommand('insertText', false, text);
  } else {
    return Err('TARGET_MISSING');
  }

  // isTrusted === false on every event dispatched above. A site that checks
  // it will reject our input — that is WRITE_REJECTED, detected by the
  // verifier's read-back (§7.2), not here: this function only reports what
  // was dispatched, never whether it took effect.
  return Ok({ dispatched: true, preState: before, elapsedMs: Math.round(performance.now() - t0) });
}

// ── Selecting ──

function doSelect(el: Element, value: string, t0: number): Result<ActEffect, FailureCause> {
  if (!(el instanceof HTMLSelectElement)) return Err('TARGET_MISSING');
  const before = el.value;
  const options = Array.from(el.options);
  const match = options.find((o) => o.value === value) ?? options.find((o) => o.text.trim() === value.trim());
  if (!match) {
    // Never a nearest match (PP-6) — refused with the available labels
    // attached so the caller can report them.
    return Err('TARGET_MISSING', { availableOptions: options.map((o) => o.text.trim()) });
  }

  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el, match.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return Ok({ dispatched: true, preState: before, elapsedMs: Math.round(performance.now() - t0) });
}
