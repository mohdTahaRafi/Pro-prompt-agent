/**
 * lib/model/posture.ts — probePosture() and the disclosure payload. §3.2.
 * Docs/planning/phase_4_model_tiers_routing.md §3.2, task 4.1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probePosture, __resetPostureCache } from '@lib/model/posture';

beforeEach(() => {
  __resetPostureCache();
  vi.unstubAllGlobals();
});

describe('probePosture — Local-only, planner unavailable', () => {
  it('Ollama down, no remote key: planner.available is false, reason names localhost:11434', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const cap = await probePosture('local-only');
    expect(cap.planner.available).toBe(false);
    expect(cap.planner.reason).toContain('localhost:11434');
    expect(cap.disclosure.summary).toMatch(/can't start/);
  });

  it('Ollama reachable but only tinyllama installed: reason names the size problem and suggests a pull command', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ models: [{ name: 'tinyllama:latest' }] }),
    }));
    const cap = await probePosture('local-only');
    expect(cap.planner.available).toBe(false);
    expect(cap.planner.reason).toMatch(/too small/);
    expect(cap.planner.reason).toContain('ollama pull');
  });

  it('no models installed at all: reason still suggests a pull command', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }));
    const cap = await probePosture('local-only');
    expect(cap.planner.available).toBe(false);
    expect(cap.planner.reason).toContain('ollama pull');
  });

  it('a 14b instruct-tuned model installed: planner IS available and names it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ models: [{ name: 'qwen2.5:14b-instruct' }] }),
    }));
    const cap = await probePosture('local-only');
    expect(cap.planner.available).toBe(true);
    expect(cap.planner.engine).toBe('ollama');
    expect(cap.planner.model).toBe('qwen2.5:14b-instruct');
  });
});

describe('probePosture — Local-only disclosure never mentions a remote destination', () => {
  it('classA.willSend and classB.willSend are both false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:14b' }] }) }));
    const cap = await probePosture('local-only');
    expect(cap.disclosure.classA.willSend).toBe(false);
    expect(cap.disclosure.classB.willSend).toBe(false);
  });
});

describe('probePosture — caching', () => {
  it('caches for the same posture across calls (one fetch, not two)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:14b' }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    await probePosture('local-only');
    await probePosture('local-only');
    // getOllamaConfig + probeOllamaPlanner each call fetch once per probePosture
    // invocation when uncached; cached calls must not re-invoke fetch at all.
    const callsAfterFirst = fetchSpy.mock.calls.length;
    await probePosture('local-only');
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('forceRefresh bypasses the cache', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:14b' }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    await probePosture('local-only');
    const callsAfterFirst = fetchSpy.mock.calls.length;
    await probePosture('local-only', { forceRefresh: true });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
