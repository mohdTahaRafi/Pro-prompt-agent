/**
 * lib/page/actuator.ts — the five pre-action checks and the four DOM verbs.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.7.
 *
 * happy-dom performs no real layout — getBoundingClientRect() always
 * returns an all-zero rect, and document.elementFromPoint() always returns
 * null. Both are stubbed per-element/per-test below so the visibility and
 * occlusion checks can be exercised at all; the true, unstubbed behaviour
 * against a real engine is covered by tests/e2e/*.spec.ts's Playwright
 * fixtures (task 3.8), which run in real Chromium.
 */
import { describe, it, expect } from 'vitest';
import { actuate } from '@lib/page/actuator';
import { ElementRegistry, domPath, type ResolutionDescriptor } from '@lib/page/registry';
import { computeRole } from '@lib/page/roles';
import { accessibleName } from '@lib/page/accname';

const RUN_ID = 1;

function descriptorFor(el: Element): ResolutionDescriptor {
  return {
    role: computeRole(el), name: accessibleName(el), tag: el.tagName.toLowerCase(),
    ordinalWithinName: 0, poolSizeWhenCaptured: 1, domPath: domPath(el),
  };
}

function stubRect(el: Element, rect: Partial<DOMRect> = {}) {
  const full = { x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, toJSON() {}, ...rect };
  (el as any).getBoundingClientRect = () => full;
}

/** Sets up a registered, resolvable, visible-and-unobscured element and
 *  returns its handle + epoch. elementFromPoint defaults to returning the
 *  element itself (not obscured) unless overridden per test. */
function register(el: Element, registry: ElementRegistry): { handle: string; epoch: number } {
  document.body.appendChild(el);
  stubRect(el);
  (document as any).elementFromPoint = () => el;
  const epoch = registry.beginEpoch();
  const handle = registry.allocate(el, descriptorFor(el), '');
  return { handle, epoch };
}

describe('actuate — pre-action checks (PR-ACT-5)', () => {
  it('a disconnected node returns TARGET_MISSING', async () => {
    const registry = new ElementRegistry();
    const btn = document.createElement('button');
    btn.textContent = 'Go';
    const { handle, epoch } = register(btn, registry);
    btn.remove();   // disconnect AFTER registering, so resolve() finds it but isConnected is false
    const r = await actuate({ verb: 'click', handle }, epoch, registry, RUN_ID);
    expect(r).toEqual({ ok: false, error: 'TARGET_MISSING' });
  });

  it('an unresolvable handle returns TARGET_MISSING', async () => {
    const registry = new ElementRegistry();
    registry.beginEpoch();
    const r = await actuate({ verb: 'click', handle: 'e404' }, 1, registry, RUN_ID);
    expect(r).toEqual({ ok: false, error: 'TARGET_MISSING' });
  });

  it('an ambiguous re-resolution returns TARGET_AMBIGUOUS', async () => {
    document.body.innerHTML = `<div><button>Continue</button></div>`;
    const registry = new ElementRegistry();
    registry.beginEpoch();
    const original = document.querySelector('button')!;
    const desc = descriptorFor(original);
    desc.poolSizeWhenCaptured = 1;
    const handle = registry.allocate(original, desc, '');

    original.remove();
    const container = document.querySelector('div')!;
    for (let i = 0; i < 2; i++) {
      const b = document.createElement('button');
      b.textContent = 'Continue';
      container.appendChild(b);
    }

    const r = await actuate({ verb: 'click', handle }, 1, registry, RUN_ID);
    expect(r).toEqual({ ok: false, error: 'TARGET_AMBIGUOUS' });
  });

  it('a modal-covered button returns OBSCURED', async () => {
    const registry = new ElementRegistry();
    const btn = document.createElement('button');
    btn.textContent = 'Buy';
    const { handle, epoch } = register(btn, registry);
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    (document as any).elementFromPoint = () => overlay;   // something else covers the centre point

    const r = await actuate({ verb: 'click', handle }, epoch, registry, RUN_ID);
    expect(r).toEqual({ ok: false, error: 'OBSCURED' });
  });

  it('a disabled input returns TARGET_DISABLED', async () => {
    const registry = new ElementRegistry();
    const input = document.createElement('input');
    input.disabled = true;
    const { handle, epoch } = register(input, registry);
    const r = await actuate({ verb: 'type', handle, text: 'x', mode: 'replace' }, epoch, registry, RUN_ID);
    expect(r).toEqual({ ok: false, error: 'TARGET_DISABLED' });
  });

  it('a password field returns NEVER_TIER_AT_ACTUATOR — the third independent check', async () => {
    const registry = new ElementRegistry();
    const input = document.createElement('input');
    input.type = 'password';
    const { handle, epoch } = register(input, registry);
    const r = await actuate({ verb: 'type', handle, text: 'hunter2', mode: 'replace' }, epoch, registry, RUN_ID);
    expect(r).toEqual({ ok: false, error: 'NEVER_TIER_AT_ACTUATOR' });
  });

  it('the stop flag is checked before anything else touches the DOM', async () => {
    const registry = new ElementRegistry();
    const btn = document.createElement('button');
    const { handle, epoch } = register(btn, registry);
    await chrome.storage.session.set({ [`stop:${RUN_ID}`]: true });
    const r = await actuate({ verb: 'click', handle }, epoch, registry, RUN_ID);
    expect(r).toEqual({ ok: false, error: 'STOPPED' });
  });
});

describe('actuate — click', () => {
  it('dispatches the full pointer sequence and reports the target rect', async () => {
    const registry = new ElementRegistry();
    const btn = document.createElement('button');
    btn.textContent = 'Continue';
    const events: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      btn.addEventListener(type, () => events.push(type));
    }
    const { handle, epoch } = register(btn, registry);

    const r = await actuate({ verb: 'click', handle }, epoch, registry, RUN_ID);
    expect(r.ok).toBe(true);
    expect(events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    if (r.ok) {
      expect(r.value.dispatched).toBe(true);
      expect(r.value.targetRect).toBeDefined();
    }
  });

  it('a plain el.click() would not fire pointerdown — this proves the actuator does not use it', async () => {
    const registry = new ElementRegistry();
    const div = document.createElement('div');
    div.setAttribute('onclick', 'void 0');   // behaviourally interactive
    let pointerdownSeen = false;
    div.addEventListener('pointerdown', () => { pointerdownSeen = true; });
    const { handle, epoch } = register(div, registry);
    await actuate({ verb: 'click', handle }, epoch, registry, RUN_ID);
    expect(pointerdownSeen).toBe(true);
  });
});

describe('actuate — type, the native-value-setter technique', () => {
  it('writes through the prototype setter so a shadowed instance setter (the React pattern) still sees the change', async () => {
    const registry = new ElementRegistry();
    const input = document.createElement('input');
    const { handle, epoch } = register(input, registry);

    // Simulate what React does: an instance-level setter that swallows a
    // plain `el.value = x` assignment without updating anything a naive
    // technique could observe.
    let shadowedCalls = 0;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return HTMLInputElement.prototype.__lookupGetter__('value')!.call(this); },
      set(_v: string) { shadowedCalls += 1; /* deliberately does nothing */ },
    });

    const r = await actuate({ verb: 'type', handle, text: 'Mohd Taha', mode: 'replace' }, epoch, registry, RUN_ID);
    expect(r.ok).toBe(true);
    // The shadowed instance setter was never invoked — the native
    // prototype setter was called directly instead.
    expect(shadowedCalls).toBe(0);
    expect(HTMLInputElement.prototype.__lookupGetter__('value')!.call(input)).toBe('Mohd Taha');
  });

  it('append mode concatenates onto the existing value', async () => {
    const registry = new ElementRegistry();
    const input = document.createElement('input');
    input.value = 'Hello ';
    const { handle, epoch } = register(input, registry);
    const r = await actuate({ verb: 'type', handle, text: 'World', mode: 'append' }, epoch, registry, RUN_ID);
    expect(r.ok).toBe(true);
    expect(input.value).toBe('Hello World');
  });

  it('dispatches bubbling input and change events', async () => {
    const registry = new ElementRegistry();
    const input = document.createElement('input');
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push('input'));
    input.addEventListener('change', () => seen.push('change'));
    const { handle, epoch } = register(input, registry);
    await actuate({ verb: 'type', handle, text: 'x', mode: 'replace' }, epoch, registry, RUN_ID);
    expect(seen).toEqual(['input', 'change']);
  });

  it('reports focusFailed (never throws) when focus cannot be confirmed', async () => {
    const registry = new ElementRegistry();
    const input = document.createElement('input');
    const { handle, epoch } = register(input, registry);
    // happy-dom's document.activeElement after .focus() on a connected,
    // visible, enabled element normally IS that element — force the
    // "focus never landed" branch by stealing focus back immediately.
    const other = document.createElement('input');
    document.body.appendChild(other);
    const realFocus = input.focus.bind(input);
    (input as any).focus = () => { realFocus(); other.focus(); };

    const r = await actuate({ verb: 'type', handle, text: 'x', mode: 'replace' }, epoch, registry, RUN_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.focusFailed).toBe(true);
  });
});

describe('actuate — select', () => {
  it('matches by option value and dispatches input/change', async () => {
    const registry = new ElementRegistry();
    const select = document.createElement('select');
    for (const [value, text] of [['us', 'United States'], ['uk', 'United Kingdom']]) {
      const opt = document.createElement('option');
      opt.value = value; opt.text = text;
      select.appendChild(opt);
    }
    const seen: string[] = [];
    select.addEventListener('input', () => seen.push('input'));
    select.addEventListener('change', () => seen.push('change'));
    const { handle, epoch } = register(select, registry);

    const r = await actuate({ verb: 'select', handle, value: 'uk' }, epoch, registry, RUN_ID);
    expect(r.ok).toBe(true);
    expect(select.value).toBe('uk');
    expect(seen).toEqual(['input', 'change']);
  });

  it('matches by trimmed visible option text when the value does not match', async () => {
    const registry = new ElementRegistry();
    const select = document.createElement('select');
    const opt = document.createElement('option');
    opt.value = 'US'; opt.text = 'United States';
    select.appendChild(opt);
    const { handle, epoch } = register(select, registry);
    const r = await actuate({ verb: 'select', handle, value: ' United States ' }, epoch, registry, RUN_ID);
    expect(r.ok).toBe(true);
    expect(select.value).toBe('US');
  });

  it('never guesses a nearest option — refuses with the available labels attached', async () => {
    const registry = new ElementRegistry();
    const select = document.createElement('select');
    const opt = document.createElement('option');
    opt.value = 'us'; opt.text = 'United States';
    select.appendChild(opt);
    const { handle, epoch } = register(select, registry);
    const r = await actuate({ verb: 'select', handle, value: 'Canada' }, epoch, registry, RUN_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('TARGET_MISSING');
      expect((r.detail as any).availableOptions).toEqual(['United States']);
    }
  });
});

describe('actuate — scroll', () => {
  it('scrolls a handle target into view', async () => {
    const registry = new ElementRegistry();
    const el = document.createElement('div');
    let scrolled = false;
    (el as any).scrollIntoView = () => { scrolled = true; };
    const { handle, epoch } = register(el, registry);
    const r = await actuate({ verb: 'scroll', target: handle }, epoch, registry, RUN_ID);
    expect(r.ok).toBe(true);
    expect(scrolled).toBe(true);
  });

  it('scrolls the viewport by direction when no handle is given', async () => {
    const registry = new ElementRegistry();
    registry.beginEpoch();
    const calls: any[] = [];
    (window as any).scrollBy = (arg: any) => calls.push(arg);
    const r = await actuate({ verb: 'scroll', target: 'down', amount: 10 }, 1, registry, RUN_ID);
    expect(r.ok).toBe(true);
    expect(calls[0].top).toBeGreaterThan(0);
  });
});
