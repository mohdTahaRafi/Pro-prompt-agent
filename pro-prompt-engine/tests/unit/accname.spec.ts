/**
 * lib/page/accname.ts — accessible name computation. Phase 2 §5.1, task 2.2.
 * 30 cases covering all six precedence sources, an aria-labelledby cycle,
 * and a name over 120 chars.
 */
import { describe, it, expect } from 'vitest';
import { accessibleName, computeAccessibleName } from '@lib/page/accname';

function el(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('accessible name — precedence order (§5.1)', () => {
  // 1. aria-labelledby
  it('aria-labelledby wins over aria-label', () => {
    const e = el(`
      <div>
        <span id="l1">Full name</span>
        <input aria-labelledby="l1" aria-label="ignored">
      </div>`).querySelector('input')!;
    expect(accessibleName(e)).toBe('Full name');
  });

  it('aria-labelledby concatenates multiple ids with single spaces', () => {
    const e = el(`
      <div>
        <span id="a">Billing</span>
        <span id="b">address</span>
        <input aria-labelledby="a b">
      </div>`).querySelector('input')!;
    expect(accessibleName(e)).toBe('Billing address');
  });

  it('aria-labelledby skips ids that do not exist', () => {
    const e = el(`
      <div>
        <span id="a">Name</span>
        <input aria-labelledby="a missing">
      </div>`).querySelector('input')!;
    expect(accessibleName(e)).toBe('Name');
  });

  it('aria-labelledby recursion is capped at depth 1 (chain, not a direct cycle)', () => {
    const e = el(`
      <div>
        <span id="c" aria-labelledby="d">fallback c text</span>
        <span id="d">Deepest</span>
        <input aria-labelledby="c">
      </div>`).querySelector('input')!;
    // Depth 0 (the input) resolves id "c" one level deep (into "d" = "Deepest");
    // deeper chains are not followed further.
    expect(accessibleName(e)).toBe('Deepest');
  });

  it('aria-labelledby self-reference (a 1-cycle) does not hang and falls back sanely', () => {
    const e = el(`<input id="self" aria-labelledby="self" aria-label="fallback">`);
    // The cap prevents infinite recursion; renderedText(self) at depth 1 finds
    // no text content on an <input>, so the labelledby result is empty and
    // the next precedence source (aria-label) wins.
    expect(accessibleName(e)).toBe('fallback');
  });

  // 2. aria-label
  it('aria-label is used and trimmed', () => {
    const e = el(`<button aria-label="  Close dialog  "></button>`);
    expect(accessibleName(e)).toBe('Close dialog');
  });

  it('an empty aria-label after trim falls through to the next source', () => {
    const e = el(`<button aria-label="   ">Submit</button>`);
    expect(accessibleName(e)).toBe('Submit');
  });

  // 3. Native host-language label
  it('<label for> is used', () => {
    document.body.innerHTML = `<label for="f">Email address</label><input id="f">`;
    const e = document.getElementById('f')!;
    expect(accessibleName(e)).toBe('Email address');
  });

  it('an ancestor <label> is used when no label[for] exists', () => {
    const e = el(`<label>Password <input type="password" name="x"></label>`).querySelector('input')!;
    expect(accessibleName(e)).toBe('Password');
  });

  it('input[type=submit] uses its value', () => {
    const e = el(`<input type="submit" value="Send application">`);
    expect(accessibleName(e)).toBe('Send application');
  });

  it('input[type=submit] with no value defaults to "Submit"', () => {
    const e = el(`<input type="submit">`);
    expect(accessibleName(e)).toBe('Submit');
  });

  it('input[type=reset] with no value defaults to "Reset"', () => {
    const e = el(`<input type="reset">`);
    expect(accessibleName(e)).toBe('Reset');
  });

  it('input[type=button] uses its value', () => {
    const e = el(`<input type="button" value="Cancel">`);
    expect(accessibleName(e)).toBe('Cancel');
  });

  it('img uses alt', () => {
    const e = el(`<img src="x.png" alt="Company logo">`);
    expect(accessibleName(e)).toBe('Company logo');
  });

  it('fieldset uses its legend', () => {
    const e = el(`<fieldset><legend>Shipping details</legend></fieldset>`);
    expect(accessibleName(e)).toBe('Shipping details');
  });

  it('table uses its caption', () => {
    const e = el(`<table><caption>Order history</caption></table>`);
    expect(accessibleName(e)).toBe('Order history');
  });

  // 4. Subtree text (name-from-content roles only)
  it('a link takes its name from subtree text', () => {
    const e = el(`<a href="/x">Continue <span>to checkout</span></a>`);
    expect(accessibleName(e)).toBe('Continue to checkout');
  });

  it('a button takes its name from subtree text', () => {
    const e = el(`<button><span>Submit</span> application</button>`);
    expect(accessibleName(e)).toBe('Submit application');
  });

  it('a heading takes its name from subtree text', () => {
    const e = el(`<h2>Account settings</h2>`);
    expect(accessibleName(e)).toBe('Account settings');
  });

  it('subtree text is NOT used for a textbox (no name-from-content)', () => {
    const e = el(`<textarea placeholder="fallback">user typed text</textarea>`);
    // textbox is not in NAME_FROM_CONTENT_ROLES — falls through past
    // content to title, then placeholder.
    expect(accessibleName(e)).toBe('fallback');
  });

  it('subtree text skips aria-hidden="true" descendants', () => {
    const e = el(`<button>Visible <span aria-hidden="true">(hidden icon)</span></button>`);
    expect(accessibleName(e)).toBe('Visible');
  });

  it('subtree text skips display:none descendants', () => {
    const e = el(`<button>Kept <span style="display:none">dropped</span></button>`);
    expect(accessibleName(e)).toBe('Kept');
  });

  // 5. title
  it('title is used when nothing else applies', () => {
    const e = el(`<div role="button" title="Expand section"></div>`);
    expect(accessibleName(e)).toBe('Expand section');
  });

  // 6. placeholder — deliberately included beyond ACCNAME
  it('placeholder is used as a last resort and tagged as such', () => {
    const e = el(`<input placeholder="Search products">`);
    const result = computeAccessibleName(e);
    expect(result.name).toBe('Search products');
    expect(result.source).toBe('placeholder');
  });

  it('an element with no name from any source returns empty with source "none"', () => {
    const e = el(`<div role="textbox"></div>`);
    const result = computeAccessibleName(e);
    expect(result.name).toBe('');
    expect(result.source).toBe('none');
  });

  // Normalisation
  it('collapses internal whitespace runs to a single space', () => {
    const e = el(`<button aria-label="  Submit    the   \n  form  "></button>`);
    expect(accessibleName(e)).toBe('Submit the form');
  });

  it('truncates a name over 120 characters with an ellipsis', () => {
    const long = 'x'.repeat(150);
    const e = el(`<button aria-label="${long}"></button>`);
    const name = accessibleName(e);
    expect(name.length).toBe(120);
    expect(name.endsWith('…')).toBe(true);
    expect(name.startsWith('x'.repeat(119))).toBe(true);
  });

  it('a name exactly at 120 characters is not truncated', () => {
    const exact = 'y'.repeat(120);
    const e = el(`<button aria-label="${exact}"></button>`);
    expect(accessibleName(e)).toBe(exact);
  });

  // Precedence ordering sanity checks
  it('native label beats subtree text', () => {
    document.body.innerHTML = `<label for="g">Label wins</label><button id="g">Content text</button>`;
    const e = document.getElementById('g')!;
    expect(accessibleName(e)).toBe('Label wins');
  });

  it('title beats placeholder', () => {
    const e = el(`<input title="Title wins" placeholder="Placeholder loses">`);
    expect(accessibleName(e)).toBe('Title wins');
  });

  it('labels[] (the DOM API) is used for a checkbox wrapped indirectly', () => {
    document.body.innerHTML = `<label for="chk">Accept terms</label><input type="checkbox" id="chk">`;
    const e = document.getElementById('chk')!;
    expect(accessibleName(e)).toBe('Accept terms');
  });
});
