/**
 * lib/page/roles.ts — computed role mapping. Phase 2 §5.2, task 2.3.
 * Every native mapping, an invalid explicit role ignored, <div onclick> with
 * cursor:pointer classified interactive, a card wrapper with 8 children not.
 */
import { describe, it, expect } from 'vitest';
import { computeRole, isInteractive, isStructural, isLandmark } from '@lib/page/roles';

function el(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('computeRole — explicit role precedence', () => {
  it('a valid explicit role wins over the implicit mapping', () => {
    const e = el(`<div role="button"></div>`);
    expect(computeRole(e)).toBe('button');
  });

  it('an invalid explicit role is ignored, falling back to implicit', () => {
    const e = el(`<button role="submit-button"></button>`);
    expect(computeRole(e)).toBe('button');
  });

  it('a fallback role list uses the first valid token', () => {
    const e = el(`<div role="nonsense-role region"></div>`);
    expect(computeRole(e)).toBe('region');
  });
});

describe('computeRole — native mappings (§5.2)', () => {
  const cases: Array<[string, string]> = [
    ['<button></button>', 'button'],
    ['<a href="/x"></a>', 'link'],
    ['<a></a>', 'generic'],   // no href — not a link
    ['<textarea></textarea>', 'textbox'],
    ['<summary></summary>', 'button'],
    ['<nav></nav>', 'navigation'],
    ['<main></main>', 'main'],
    ['<aside></aside>', 'complementary'],
    ['<form></form>', 'form'],
    ['<table></table>', 'table'],
    ['<ul></ul>', 'list'],
    ['<li></li>', 'listitem'],
    ['<h1></h1>', 'heading'],
    ['<h6></h6>', 'heading'],
    ['<progress></progress>', 'progressbar'],
    ['<hr>', 'separator'],
    ['<article></article>', 'article'],
    ['<p></p>', 'paragraph'],
    ['<dialog></dialog>', 'dialog'],
    ['<option></option>', 'option'],
    ['<fieldset></fieldset>', 'group'],
  ];
  for (const [html, expected] of cases) {
    it(`${html} → ${expected}`, () => {
      expect(computeRole(el(html))).toBe(expected);
    });
  }

  it('input[type] mappings', () => {
    expect(computeRole(el(`<input type="button">`))).toBe('button');
    expect(computeRole(el(`<input type="submit">`))).toBe('button');
    expect(computeRole(el(`<input type="checkbox">`))).toBe('checkbox');
    expect(computeRole(el(`<input type="radio">`))).toBe('radio');
    expect(computeRole(el(`<input type="range">`))).toBe('slider');
    expect(computeRole(el(`<input type="number">`))).toBe('spinbutton');
    expect(computeRole(el(`<input type="search">`))).toBe('searchbox');
    expect(computeRole(el(`<input type="text">`))).toBe('textbox');
    expect(computeRole(el(`<input type="email">`))).toBe('textbox');
    expect(computeRole(el(`<input>`))).toBe('textbox');   // defaults to type=text
  });

  it('select maps to combobox, or listbox when multiple', () => {
    expect(computeRole(el(`<select></select>`))).toBe('combobox');
    expect(computeRole(el(`<select multiple></select>`))).toBe('listbox');
    expect(computeRole(el(`<select size="4"></select>`))).toBe('listbox');
  });

  it('img with non-empty alt is img; empty alt is presentation', () => {
    expect(computeRole(el(`<img alt="A photo">`))).toBe('img');
    expect(computeRole(el(`<img alt="">`))).toBe('presentation');
  });

  it('tr and td/th need a table context (bare markup is dropped by the parser)', () => {
    document.body.innerHTML = `<table><tbody><tr><td>a</td><th>b</th><th scope="row">c</th></tr></tbody></table>`;
    expect(computeRole(document.querySelector('tr')!)).toBe('row');
    expect(computeRole(document.querySelector('td')!)).toBe('cell');
    expect(computeRole(document.querySelectorAll('th')[0]!)).toBe('columnheader');
    expect(computeRole(document.querySelectorAll('th')[1]!)).toBe('rowheader');
  });

  it('header/footer are banner/contentinfo at top level, generic when scoped', () => {
    expect(computeRole(el(`<header></header>`))).toBe('banner');
    expect(computeRole(el(`<footer></footer>`))).toBe('contentinfo');
    document.body.innerHTML = `<article><header></header></article>`;
    expect(computeRole(document.querySelector('header')!)).toBe('generic');
  });

  it('an unnamed section is generic; a named one is a region', () => {
    expect(computeRole(el(`<section></section>`))).toBe('generic');
    expect(computeRole(el(`<section aria-label="Highlights"></section>`))).toBe('region');
  });

  it('an unrecognised element with no interactive markers is generic', () => {
    expect(computeRole(el(`<span></span>`))).toBe('generic');
  });
});

describe('isInteractive — role-based and behavioural (§5.2)', () => {
  it('a role-interactive element is interactive', () => {
    expect(isInteractive(el(`<button></button>`))).toBe(true);
    expect(isInteractive(el(`<input type="text">`))).toBe(true);
  });

  it('<div onclick> with cursor:pointer is classified interactive', () => {
    const e = el(`<div onclick="x()" style="cursor:pointer"></div>`);
    expect(isInteractive(e)).toBe(true);
  });

  it('a card wrapper with 8 children and cursor:pointer is NOT interactive (leaf constraint)', () => {
    const children = Array.from({ length: 8 }, (_, i) => `<span>${i}</span>`).join('');
    const e = el(`<div style="cursor:pointer">${children}</div>`);
    expect(isInteractive(e)).toBe(false);
  });

  it('a leaf-ish element (<=3 children) with cursor:pointer IS interactive', () => {
    const e = el(`<div style="cursor:pointer"><span>a</span><span>b</span></div>`);
    expect(isInteractive(e)).toBe(true);
  });

  it('tabindex >= 0 makes a generic element interactive', () => {
    expect(isInteractive(el(`<div tabindex="0"></div>`))).toBe(true);
    expect(isInteractive(el(`<div tabindex="-1"></div>`))).toBe(false);
  });

  it('contenteditable makes an element interactive', () => {
    expect(isInteractive(el(`<div contenteditable="true"></div>`))).toBe(true);
    expect(isInteractive(el(`<div contenteditable="false"></div>`))).toBe(false);
  });

  it('aria-hidden="true" makes an otherwise-interactive element non-interactive', () => {
    expect(isInteractive(el(`<button aria-hidden="true"></button>`))).toBe(false);
  });

  it('a plain <span> with no markers is not interactive', () => {
    expect(isInteractive(el(`<span>text</span>`))).toBe(false);
  });
});

describe('isStructural / isLandmark', () => {
  it('landmarks are structural', () => {
    expect(isStructural(el(`<nav></nav>`))).toBe(true);
    expect(isLandmark(el(`<nav></nav>`))).toBe(true);
  });

  it('a heading is structural but not a landmark', () => {
    expect(isStructural(el(`<h2></h2>`))).toBe(true);
    expect(isLandmark(el(`<h2></h2>`))).toBe(false);
  });

  it('a plain div is neither', () => {
    expect(isStructural(el(`<div></div>`))).toBe(false);
    expect(isLandmark(el(`<div></div>`))).toBe(false);
  });
});
