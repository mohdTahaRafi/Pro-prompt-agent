/**
 * lib/page/readable.ts — read_page, the class-B disclosure and its token
 * cap. Phase 2 §8, task 2.12.
 */
import { describe, it, expect } from 'vitest';
import { readPage, READ_PAGE_DEFAULT_TOKEN_CAP } from '@lib/page/readable';
import { countTokens } from '@lib/page/token-budget';
import { OVERLAY_ROOT_ATTR } from '@lib/page/overlay/mount';

describe('readPage — class B and shape (§8)', () => {
  it('returns {class: "B", text, origin, url, capturedAt}', () => {
    document.title = 'Article title';
    document.body.innerHTML = `
      <article>
        <h1>Article title</h1>
        <p>This is the first paragraph of a real article with enough
        content that Readability should recognise it as the main body text
        rather than falling back to the raw DOM strip.</p>
        <p>A second paragraph continues the same thought, giving the parser
        two solid blocks of prose to work with.</p>
      </article>`;
    const result = readPage();
    expect(result.class).toBe('B');
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.origin).toBe(location.origin);
    expect(result.url).toBe(location.href);
    expect(typeof result.capturedAt).toBe('number');
  });

  it('text is capped at the requested token budget (default 4,000)', () => {
    document.body.innerHTML = `<p>${'word '.repeat(20000)}</p>`;
    const result = readPage();
    expect(countTokens(result.text)).toBeLessThanOrEqual(READ_PAGE_DEFAULT_TOKEN_CAP);
  });

  it('a custom token cap is honoured', () => {
    document.body.innerHTML = `<p>${'word '.repeat(5000)}</p>`;
    const result = readPage(100);
    expect(countTokens(result.text)).toBeLessThanOrEqual(100);
  });

  it("the extension's own overlay shadow host contributes no text", () => {
    document.body.innerHTML = `<p>Real page content that is long enough for Readability to treat as an article body over several sentences.</p>`;
    const host = document.createElement('div');
    host.setAttribute(OVERLAY_ROOT_ATTR, '');
    host.textContent = 'SECRET-OVERLAY-TEXT-should-never-appear';
    document.body.appendChild(host);

    const result = readPage();
    expect(result.text).not.toContain('SECRET-OVERLAY-TEXT-should-never-appear');
  });

  it('falls back to a DOM strip when Readability finds no article', () => {
    document.body.innerHTML = `<div>Just some plain unstructured text with no article-like markup around it at all, but still real content a user would want summarised somehow.</div>`;
    const result = readPage();
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('strips script/style/nav/footer noise from the fallback path', () => {
    document.body.innerHTML = `
      <nav>Navigation links here</nav>
      <div>Actual body content that should survive the strip and appear in the output text.</div>
      <footer>Footer boilerplate</footer>
      <script>window.x = 1;</script>`;
    const result = readPage();
    expect(result.text).toContain('Actual body content');
    expect(result.text).not.toContain('window.x');
  });
});
