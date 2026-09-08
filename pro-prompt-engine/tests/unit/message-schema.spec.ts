/**
 * lib/schemas/message.schema.ts — every message the service worker's router
 * accepts is parsed through ExtensionRequest before its handler runs. A
 * message that fails validation must never be coerced or partially handled.
 */
import { describe, it, expect } from 'vitest';
import { ExtensionRequest, OriginSchema, GrantOriginRequest } from '@lib/schemas/message.schema';

describe('OriginSchema', () => {
  it('accepts a bare http(s) origin', () => {
    expect(OriginSchema.safeParse('https://example.com').success).toBe(true);
    expect(OriginSchema.safeParse('http://localhost:5599').success).toBe(true);
  });
  it('rejects a URL with a path, a non-http(s) protocol, or garbage', () => {
    expect(OriginSchema.safeParse('https://example.com/path').success).toBe(false);
    expect(OriginSchema.safeParse('chrome://extensions').success).toBe(false);
    expect(OriginSchema.safeParse('not-a-url').success).toBe(false);
  });
});

describe('ExtensionRequest — the discriminated union every inbound message parses through', () => {
  it('accepts a well-formed PING', () => {
    expect(ExtensionRequest.safeParse({ type: 'PING' }).success).toBe(true);
  });

  it('accepts a well-formed GRANT_ORIGIN', () => {
    const result = GrantOriginRequest.safeParse({ type: 'GRANT_ORIGIN', payload: { origin: 'https://example.com' } });
    expect(result.success).toBe(true);
  });

  it('rejects GRANT_ORIGIN with a non-origin payload — the exact case from §7.1/1.2', () => {
    const result = ExtensionRequest.safeParse({ type: 'GRANT_ORIGIN', payload: { origin: 'not-a-url' } });
    expect(result.success).toBe(false);
  });

  it('rejects a message with an unknown type', () => {
    expect(ExtensionRequest.safeParse({ type: 'DEFINITELY_NOT_A_REAL_TYPE' }).success).toBe(false);
  });

  it('rejects a well-known type with a missing required payload field', () => {
    expect(ExtensionRequest.safeParse({ type: 'SCORE', payload: {} }).success).toBe(false);
    expect(ExtensionRequest.safeParse({ type: 'REVOKE_ORIGIN', payload: {} }).success).toBe(false);
  });

  it('accepts requests with no payload for no-payload types', () => {
    expect(ExtensionRequest.safeParse({ type: 'GET_ALL_PROFILES' }).success).toBe(true);
    expect(ExtensionRequest.safeParse({ type: 'OPEN_DASHBOARD' }).success).toBe(true);
  });

  // [Phase 2] GET_TAB_ID (agent.content.ts's own tab id) and
  // GET_ACTIVE_GRANTS (the Perception debug tab's origin dropdown, §9).
  it('accepts a well-formed GET_TAB_ID and GET_ACTIVE_GRANTS', () => {
    expect(ExtensionRequest.safeParse({ type: 'GET_TAB_ID' }).success).toBe(true);
    expect(ExtensionRequest.safeParse({ type: 'GET_ACTIVE_GRANTS' }).success).toBe(true);
  });

  it('accepts a SET_PROFILE update (id + partial fields) and a SET_PROFILE create (full shape, no id)', () => {
    const update = ExtensionRequest.safeParse({ type: 'SET_PROFILE', payload: { id: 1, contextMd: 'hello' } });
    expect(update.success).toBe(true);

    const create = ExtensionRequest.safeParse({
      type: 'SET_PROFILE',
      payload: {
        name: 'New', description: 'd', icon: '🙂', isActive: 0, isCustom: true,
        contextMd: '', promptGuidelinesMd: '', profileDescriptionMd: '',
        agentWeights: { refactor: 1, scorer: 1, generator: 1, comprehension: 1 },
      },
    });
    expect(create.success).toBe(true);
  });

  it('rejects a SET_PROFILE create missing required fields', () => {
    const result = ExtensionRequest.safeParse({ type: 'SET_PROFILE', payload: { name: 'incomplete' } });
    expect(result.success).toBe(false);
  });
});
