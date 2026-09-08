/**
 * lib/page/registry.ts — allocation, epochs, three-epoch retention, and the
 * five-step re-resolution ladder. Phase 2 §4, tasks 2.4/2.5.
 */
import { describe, it, expect } from 'vitest';
import { ElementRegistry, domPath, type ResolutionDescriptor } from '@lib/page/registry';
import { computeRole } from '@lib/page/roles';
import { accessibleName } from '@lib/page/accname';

function descriptorFor(el: Element): ResolutionDescriptor {
  return {
    role: computeRole(el),
    name: accessibleName(el),
    tag: el.tagName.toLowerCase(),
    ordinalWithinName: 0,
    poolSizeWhenCaptured: 1,
    domPath: domPath(el),
  };
}

describe('ElementRegistry — allocation and epochs (§4.2)', () => {
  it('handles are e<n>, unique within an epoch, starting at e0', () => {
    document.body.innerHTML = `<button>A</button><button>B</button>`;
    const [a, b] = Array.from(document.querySelectorAll('button'));
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const h1 = reg.allocate(a, descriptorFor(a), '');
    const h2 = reg.allocate(b, descriptorFor(b), '');
    expect(h1).toBe('e0');
    expect(h2).toBe('e1');
  });

  it('nextIndex resets to e0 at the start of each new epoch', () => {
    document.body.innerHTML = `<button>A</button>`;
    const a = document.querySelector('button')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    reg.allocate(a, descriptorFor(a), '');
    reg.beginEpoch();
    const handle = reg.allocate(a, descriptorFor(a), '');
    expect(handle).toBe('e0');
  });

  it('an entry from epoch N-3 is gone after beginEpoch (three-epoch retention)', () => {
    document.body.innerHTML = `<button>A</button>`;
    const a = document.querySelector('button')!;
    const reg = new ElementRegistry();

    reg.beginEpoch();               // epoch 1
    reg.allocate(a, descriptorFor(a), '');
    reg.beginEpoch();               // epoch 2
    reg.beginEpoch();               // epoch 3
    reg.beginEpoch();               // epoch 4 — floor is 4-2=2, epoch 1 entries dropped
    expect(reg.resolve('e0', 1).kind).toBe('missing');
  });

  it('an entry from epoch N-2 is still retained (three epochs total: current + 2 back)', () => {
    document.body.innerHTML = `<button>A</button>`;
    const a = document.querySelector('button')!;
    const reg = new ElementRegistry();

    reg.beginEpoch();               // epoch 1
    reg.allocate(a, descriptorFor(a), '');
    reg.beginEpoch();               // epoch 2
    reg.beginEpoch();               // epoch 3 — floor is 3-2=1, epoch 1 retained
    // node is still connected, so this resolves 'exact', proving the entry
    // itself was not dropped (a dropped entry would resolve 'missing').
    expect(reg.resolve('e0', 1).kind).toBe('exact');
  });

  it('beginEpoch does not clear epoch N-1 entries', () => {
    document.body.innerHTML = `<button>A</button><button>B</button>`;
    const [a, b] = Array.from(document.querySelectorAll('button'));
    const reg = new ElementRegistry();

    reg.beginEpoch();               // epoch 1
    reg.allocate(a, descriptorFor(a), '');
    reg.beginEpoch();               // epoch 2
    reg.allocate(b, descriptorFor(b), '');

    // epoch 1's e0 must still resolve — beginEpoch(2) must not have cleared it.
    expect(reg.resolve('e0', 1).kind).toBe('exact');
    expect(reg.resolve('e0', 2).kind).toBe('exact');
  });

  it('an unknown handle in the current epoch resolves missing', () => {
    const reg = new ElementRegistry();
    reg.beginEpoch();
    expect(reg.resolve('e99', 1).kind).toBe('missing');
  });
});

describe('ElementRegistry — resolution (§4.3)', () => {
  it('a live, connected node resolves exact via WeakRef', () => {
    document.body.innerHTML = `<button id="btn">Save</button>`;
    const node = document.getElementById('btn')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const handle = reg.allocate(node, descriptorFor(node), '');
    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('exact');
    expect(res.kind === 'exact' && res.node).toBe(node);
  });

  it('a detached node (removed from the DOM) falls through to re-resolution and returns missing when nothing matches', () => {
    document.body.innerHTML = `<div></div>`;
    const orphan = document.createElement('button');
    orphan.textContent = 'Ghost';
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const handle = reg.allocate(orphan, descriptorFor(orphan), '');
    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('missing');
  });

  it('a node replaced by an identical one re-resolves at confidence >= 0.9', () => {
    document.body.innerHTML = `<form id="f1"><button>Continue</button></form>`;
    const original = document.querySelector('button')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const desc = descriptorFor(original);
    desc.formSignature = 'form:f1';
    const handle = reg.allocate(original, desc, '');

    // Simulate a re-render: remove the original, insert an identical clone.
    original.remove();
    const replacement = document.createElement('button');
    replacement.textContent = 'Continue';
    document.getElementById('f1')!.appendChild(replacement);

    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('reresolved');
    expect(res.kind === 'reresolved' && res.confidence).toBeGreaterThanOrEqual(0.9);
    expect(res.kind === 'reresolved' && res.node).toBe(replacement);
  });

  it('two identical siblings return ambiguous with both candidates', () => {
    // Captured when the page had exactly one "Continue" button.
    document.body.innerHTML = `<div><button>Continue</button></div>`;
    const original = document.querySelector('button')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const desc = descriptorFor(original);
    desc.poolSizeWhenCaptured = 1;   // does not match the re-rendered pool of 2
    const handle = reg.allocate(original, desc, '');

    // Re-render: the original node is detached (isConnected: false — forces
    // re-resolution even though the WeakRef itself is still alive), and the
    // page now has TWO identical "Continue" buttons — no formSignature was
    // captured, and the pool-size mismatch disqualifies the ordinal step, so
    // the ladder is forced all the way to the final ambiguous fallback.
    original.remove();
    const container = document.querySelector('div')!;
    for (let i = 0; i < 2; i++) {
      const b = document.createElement('button');
      b.textContent = 'Continue';
      container.appendChild(b);
    }

    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('ambiguous');
    expect(res.kind === 'ambiguous' && res.candidates.length).toBe(2);
  });

  it('a removed node with no surviving match returns missing', () => {
    document.body.innerHTML = `<button>Unique Label</button>`;
    const node = document.querySelector('button')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const handle = reg.allocate(node, descriptorFor(node), '');
    node.remove();
    expect(reg.resolve(handle, 1).kind).toBe('missing');
  });

  it('domPath never appears in a matching decision — a domPath-only match is not enough', () => {
    document.body.innerHTML = `<div><button id="a">Save</button></div>`;
    const original = document.getElementById('a')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const desc = descriptorFor(original);
    const handle = reg.allocate(original, desc, '');

    // Replace with a DIFFERENT role/name at the exact same domPath — if
    // domPath were used as a discriminator this would incorrectly resolve;
    // instead it must fail role/name matching entirely.
    original.remove();
    const different = document.createElement('span');
    different.setAttribute('role', 'note');
    different.textContent = 'Unrelated';
    document.querySelector('div')!.appendChild(different);

    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('missing');
  });

  it('the ordinal discriminator only trusts position when the pool size is unchanged', () => {
    document.body.innerHTML = `
      <div>
        <button>Continue</button>
        <button>Continue</button>
      </div>`;
    const buttons = Array.from(document.querySelectorAll('button'));
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const desc = descriptorFor(buttons[1]);
    desc.ordinalWithinName = 1;
    desc.poolSizeWhenCaptured = 2;   // matches the current pool size of 2
    const handle = reg.allocate(buttons[1], desc, '');
    buttons[1].remove();
    // Re-add a fresh second "Continue" button so pool size is still 2.
    const replacement = document.createElement('button');
    replacement.textContent = 'Continue';
    document.querySelector('div')!.appendChild(replacement);

    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('reresolved');
    expect(res.kind === 'reresolved' && res.confidence).toBe(0.6);
  });

  it('the ordinal discriminator is NOT trusted when the pool size has changed', () => {
    document.body.innerHTML = `
      <div>
        <button>Continue</button>
        <button>Continue</button>
      </div>`;
    const buttons = Array.from(document.querySelectorAll('button'));
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const desc = descriptorFor(buttons[1]);
    desc.ordinalWithinName = 1;
    desc.poolSizeWhenCaptured = 2;   // captured pool size — page now has 4
    const handle = reg.allocate(buttons[1], desc, '');
    buttons[1].remove();
    // Page now has FOUR "Continue" buttons where it had two.
    for (let i = 0; i < 3; i++) {
      const b = document.createElement('button');
      b.textContent = 'Continue';
      document.querySelector('div')!.appendChild(b);
    }

    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('ambiguous');
  });
});

describe('ElementRegistry — resolution step 3: same enclosing form', () => {
  it('disambiguates two identically-named buttons in different forms by formSignature', () => {
    document.body.innerHTML = `
      <form id="form-a"><button>Continue</button></form>
      <form id="form-b"><button>Continue</button></form>`;
    const buttonInA = document.querySelector('#form-a button')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const desc = descriptorFor(buttonInA);
    desc.formSignature = 'form:form-a';
    desc.poolSizeWhenCaptured = 99;   // disqualify the ordinal step
    const handle = reg.allocate(buttonInA, desc, '');

    buttonInA.remove();
    // Replace with a fresh "Continue" button back inside form-a — the pool
    // (both forms' buttons) has 2 candidates, but formSignature narrows it
    // to exactly the one inside form-a.
    const replacement = document.createElement('button');
    replacement.textContent = 'Continue';
    document.getElementById('form-a')!.appendChild(replacement);

    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('reresolved');
    expect(res.kind === 'reresolved' && res.confidence).toBe(0.9);
    expect(res.kind === 'reresolved' && res.node).toBe(replacement);
  });
});

describe('ElementRegistry — same-origin iframe frame paths (§4.1 frame field)', () => {
  it('resolves a handle inside a same-origin iframe via its frame path', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const innerDoc = iframe.contentDocument!;
    innerDoc.body.innerHTML = '<button id="inner-btn">Inside frame</button>';
    const innerButton = innerDoc.getElementById('inner-btn')!;

    const reg = new ElementRegistry();
    reg.beginEpoch();
    const handle = reg.allocate(innerButton, descriptorFor(innerButton), 'f0');

    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('exact');
    expect(res.kind === 'exact' && res.node).toBe(innerButton);
  });

  it('re-resolves inside the correct frame when the node is replaced there', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.contentDocument!.body.innerHTML = '<button id="inner-btn">Inside frame</button>';
    // Re-fetched rather than reused from a closure variable: some DOM
    // implementations (verified: happy-dom, in this test environment only)
    // do not guarantee `iframe.contentDocument` returns the identical
    // object reference on every access — a real browser's is stable for
    // the iframe's lifetime, but re-fetching is the robust way to address
    // "whatever documentForFrame() will see" either way.
    const original = iframe.contentDocument!.getElementById('inner-btn')!;

    const reg = new ElementRegistry();
    reg.beginEpoch();
    const handle = reg.allocate(original, descriptorFor(original), 'f0');

    original.remove();
    const liveDoc = iframe.contentDocument!;
    const replacement = liveDoc.createElement('button');
    replacement.textContent = 'Inside frame';
    liveDoc.body.appendChild(replacement);

    const res = reg.resolve(handle, 1);
    expect(res.kind).toBe('reresolved');
    expect(res.kind === 'reresolved' && (res.node as Element).textContent).toBe('Inside frame');
  });

  it('a frame path pointing at a non-existent iframe index returns missing', () => {
    document.body.innerHTML = '';   // no iframes at all
    const reg = new ElementRegistry();
    reg.beginEpoch();
    // Allocate against a detached node so resolve() is forced into
    // reresolve(), which then fails to locate frame 'f0'.
    const orphan = document.createElement('button');
    const handle = reg.allocate(orphan, descriptorFor(orphan), 'f0');
    expect(reg.resolve(handle, 1).kind).toBe('missing');
  });
});

describe('ElementRegistry — suspect epochs (Q10, §4.3)', () => {
  it('resolve() against a suspect epoch never returns exact even when the node is still connected', () => {
    document.body.innerHTML = `<button id="btn">Save</button>`;
    const node = document.getElementById('btn')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const handle = reg.allocate(node, descriptorFor(node), '');
    reg.markSuspect(reg.currentEpoch);

    const res = reg.resolve(handle, 1);
    // Node is still connected, but a suspect epoch always re-resolves —
    // which lands on the SAME node here, but via the 'reresolved' path,
    // not the 'exact' shortcut.
    expect(res.kind).not.toBe('exact');
  });
});

describe('ElementRegistry — invalidateAll', () => {
  it('clears every entry so no stale handle survives pagehide/context invalidation', () => {
    document.body.innerHTML = `<button id="btn">Save</button>`;
    const node = document.getElementById('btn')!;
    const reg = new ElementRegistry();
    reg.beginEpoch();
    const handle = reg.allocate(node, descriptorFor(node), '');
    reg.invalidateAll('PAGEHIDE');
    expect(reg.resolve(handle, 1).kind).toBe('missing');
  });
});
