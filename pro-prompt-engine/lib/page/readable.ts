/**
 * read_page — content script only. Phase 2 §8.
 *
 * Returns readable text and is a disclosure class B operation
 * (architecture.md §3.7.23): condensed prose, not raw markup, but still
 * page content that must not be sent remotely without local condensation
 * (the Phase 4 router's job — this module only produces and tags the
 * result).
 *
 * Readability is deliberately NOT used for read_structure (lib/page/
 * perception.ts) — it discards interactive chrome by design, which is
 * exactly why it is the right tool here and the wrong one there.
 */
import { Readability } from '@mozilla/readability';
import { countTokens } from '@lib/page/token-budget';
import { OVERLAY_ROOT_ATTR } from '@lib/page/overlay/mount';
import type { ReadPageResultSchema } from '@lib/schemas/snapshot.schema';
import type { z } from 'zod';

export const READ_PAGE_DEFAULT_TOKEN_CAP = 4_000;

/** Selectors stripped from the DOM-stripping fallback path — not for
 *  cleanliness, but because their text at the top of every extraction
 *  wastes budget on every page (§8 point 3). */
const NOISE_SELECTORS = [
  'script', 'style', 'nav', 'header', 'footer', 'noscript',
  '[aria-hidden="true"]',
  `[${OVERLAY_ROOT_ATTR}]`,
  '[role="alert"]',
  // Common cookie-consent banner shapes. Heuristic, not exhaustive — this
  // is a token-budget optimisation, not a privacy control.
  '[id*="cookie" i]', '[class*="cookie" i]',
  '[id*="consent" i]', '[class*="consent" i]',
];

export type ReadPageResult = z.infer<typeof ReadPageResultSchema>;

export function readPage(tokenCap: number = READ_PAGE_DEFAULT_TOKEN_CAP): ReadPageResult {
  const text = extractReadableText();
  const capped = capToTokens(text, tokenCap);
  return {
    class: 'B',
    text: capped,
    origin: location.origin,
    url: location.href,
    capturedAt: Date.now(),
  };
}

function extractReadableText(): string {
  try {
    const clone = document.cloneNode(true) as Document;
    stripNoise(clone);
    const reader = new Readability(clone);
    const article = reader.parse();
    if (article?.textContent) {
      return article.textContent.replace(/\s+/g, ' ').trim();
    }
  } catch (err) {
    console.warn('[Pro Prompt] Readability failed, falling back to basic extraction', err);
  }

  const bodyClone = (document.body ?? document.documentElement).cloneNode(true) as HTMLElement;
  stripNoise(bodyClone);
  return (bodyClone.textContent || '').replace(/\s+/g, ' ').trim();
}

function stripNoise(root: Document | HTMLElement): void {
  for (const sel of NOISE_SELECTORS) {
    root.querySelectorAll(sel).forEach((el) => el.remove());
  }
}

/** Token cap measured the same way as the snapshot budget (real BPE via
 *  gpt-tokenizer), not a character count — a 15,000-character cap and a
 *  4,000-token cap land at very different places once a page uses
 *  multi-byte text. */
function capToTokens(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) return text;
  // Binary-search the character cut so re-tokenising a huge page isn't
  // O(n) full re-encodes per character trimmed.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
