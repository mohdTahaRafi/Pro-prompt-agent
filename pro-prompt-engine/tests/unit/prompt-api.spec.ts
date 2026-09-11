/**
 * The Prompt API host — entrypoints/offscreen/main.ts's PROMPT_API_* message
 * handlers, and lib/model/engines/prompt-api.ts's SW-side proxy. §5.1.
 * Docs/planning/phase_4_model_tiers_routing.md §5.1, task 4.3.
 *
 * Drives the REAL offscreen-side base/clone logic (not a re-implementation
 * of it) against a mocked global `LanguageModel`, through the same
 * chrome.runtime message shape the SW-side proxy actually sends — this is
 * the "two message hops" boundary, exercised end to end within one process
 * via tests/setup.ts's chrome.runtime.sendMessage double.
 *
 * Because entrypoints/offscreen/main.ts registers its onMessage listener at
 * module-import time, and tests/setup.ts's global beforeEach installs a
 * FRESH chrome.* double before every test, the module is re-imported (via
 * vi.resetModules()) inside this file's own beforeEach so its listener is
 * always registered against the CURRENT double, never a stale one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function fakeSession(promptImpl?: (input: any, opts?: any) => Promise<string>) {
  return {
    inputUsage: 42,
    prompt: promptImpl ?? vi.fn(async () => 'a continuation'),
    clone: vi.fn(async function (this: any) { return fakeSession(promptImpl); }),
    destroy: vi.fn(),
  };
}

async function importOffscreen() {
  vi.resetModules();
  await import('../../entrypoints/offscreen/main');
}

function send(payload: any) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
}

describe('Prompt API host — availability', () => {
  beforeEach(async () => {
    // @ts-expect-error test-only global
    delete globalThis.LanguageModel;
    await importOffscreen();
  });

  it('reports "unavailable" when LanguageModel does not exist in this context', async () => {
    const res = await send({ type: 'PROMPT_API_AVAILABILITY' });
    expect(res.data.availability).toBe('unavailable');
  });
});

describe('Prompt API host — warm base session + clone() per request', () => {
  let createSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    createSpy = vi.fn(async () => fakeSession());
    // @ts-expect-error test-only global
    globalThis.LanguageModel = { availability: vi.fn(async () => 'available'), create: createSpy };
    await importOffscreen();
  });

  it('the FIRST infer for a system prompt creates a base session; subsequent infers with the SAME system prompt clone instead of creating', async () => {
    await send({ type: 'PROMPT_API_INFER', payload: { requestId: 'r1', system: 'sys-A', user: 'hello', maxTokens: 10 } });
    await send({ type: 'PROMPT_API_INFER', payload: { requestId: 'r2', system: 'sys-A', user: 'again', maxTokens: 10 } });
    await send({ type: 'PROMPT_API_INFER', payload: { requestId: 'r3', system: 'sys-A', user: 'again2', maxTokens: 10 } });

    expect(createSpy).toHaveBeenCalledTimes(1);   // ONE create() for three requests sharing a system prompt
    const stats = await send({ type: 'PROMPT_API_STATS' });
    expect(stats.data.creates).toBe(1);
    expect(stats.data.clones).toBe(3);
  });

  it('a DIFFERENT system prompt destroys the old base and creates a new one', async () => {
    await send({ type: 'PROMPT_API_INFER', payload: { requestId: 'r1', system: 'sys-A', user: 'hi', maxTokens: 10 } });
    await send({ type: 'PROMPT_API_INFER', payload: { requestId: 'r2', system: 'sys-B', user: 'hi', maxTokens: 10 } });
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it('returns the session content and reports responseConstraint usage when a jsonSchema is supplied', async () => {
    const res = await send({ type: 'PROMPT_API_INFER', payload: { requestId: 'r1', system: 'sys-A', user: 'hi', jsonSchema: { type: 'object' } } });
    expect(res.data.content).toBe('a continuation');
    expect(typeof res.data.latencyMs).toBe('number');
  });
});

describe('Prompt API host — availability() === "downloadable" returns ENGINE_DOWNLOADING, does not block', () => {
  beforeEach(async () => {
    // @ts-expect-error test-only global
    globalThis.LanguageModel = {
      availability: vi.fn(async () => 'downloadable'),
      create: vi.fn(async () => fakeSession()),
    };
    await importOffscreen();
  });

  it('returns ENGINE_DOWNLOADING immediately rather than awaiting the download', async () => {
    const start = Date.now();
    const res = await send({ type: 'PROMPT_API_INFER', payload: { requestId: 'r1', system: 'sys-A', user: 'hi' } });
    expect(res.error).toBe('ENGINE_DOWNLOADING');
    expect(Date.now() - start).toBeLessThan(200);   // did not block on the download
  });
});

describe('Prompt API host — abort', () => {
  it('PROMPT_API_ABORT aborts the in-flight session.prompt(), which rejects with AbortError', async () => {
    let rejectPrompt: ((e: any) => void) | undefined;
    const hangingSession = fakeSession(() => new Promise((_resolve, reject) => { rejectPrompt = reject; }));
    // @ts-expect-error test-only global
    globalThis.LanguageModel = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => hangingSession),
    };
    await importOffscreen();

    const inferPromise = send({ type: 'PROMPT_API_INFER', payload: { requestId: 'abort-me', system: 'sys-A', user: 'hi' } });
    // Give the handler a tick to register the controller before aborting.
    await new Promise((r) => setTimeout(r, 10));
    await send({ type: 'PROMPT_API_ABORT', payload: { requestId: 'abort-me' } });
    // Simulate what a real LanguageModel session does when its AbortSignal fires.
    rejectPrompt?.(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const res = await inferPromise;
    expect(res.error).toBe('ABORTED');
  });
});
