/**
 * Cache Manager — LRU + Dexie Write-Through Coordinator
 * With gpt-tokenizer integration for Context.md token enforcement.
 */

import { LRUCache } from './lru-cache';
import { db } from '@lib/db/dexie-db';
import { countTokens, truncateToTokenLimit, MAX_CONTEXT_TOKENS } from '@lib/utils/token-counter';
import { type Result, Ok, Err } from '@lib/utils/result';
import type { Profile } from '@lib/types/profile.types';
import type { Snippet } from '@lib/types/snippet.types';

class CacheManager {
  private profileCache: LRUCache<number, Profile>;
  private snippetCache: LRUCache<string, Snippet[]>;
  private settingsCache: LRUCache<string, unknown>;
  private isWarmedUp = false;

  constructor() {
    this.profileCache = new LRUCache<number, Profile>(50);
    this.snippetCache = new LRUCache<string, Snippet[]>(20);
    this.settingsCache = new LRUCache<string, unknown>(30);
  }

  async warmUp(): Promise<void> {
    if (this.isWarmedUp) return;
    try {
      const active = await db.profiles.where('isActive').equals(1).first();
      if (active?.id !== undefined) this.profileCache.set(active.id, active);
      const allSnippets = await db.snippets.toArray();
      this.snippetCache.set('all', allSnippets);
      this.isWarmedUp = true;
    } catch (e) { console.warn('[CacheManager] Warm-up failed:', e); }
  }

  // ── Profile Ops ──
  async getProfile(id: number): Promise<Profile | undefined> {
    const cached = this.profileCache.get(id);
    if (cached) return cached;
    const profile = await db.profiles.get(id);
    if (profile?.id !== undefined) this.profileCache.set(profile.id, profile);
    return profile;
  }

  async getActiveProfile(): Promise<Profile | undefined> {
    for (const p of this.profileCache.values()) if (p.isActive === 1) return p;
    let profile = await db.profiles.where('isActive').equals(1).first();
    if (!profile) {
      // Invariant repair, not a silent fallback: something wrote isActive wrongly.
      // Promote the lowest-id profile, persist it, and log loudly.
      profile = await db.profiles.orderBy('id').first();
      if (profile?.id !== undefined) {
        console.error('[CacheManager] No active profile found — repairing to id', profile.id);
        await this.setActiveProfile(profile.id);
        profile.isActive = 1;
      }
    }
    if (profile?.id !== undefined) this.profileCache.set(profile.id, profile);
    return profile;
  }

  async getAllProfiles(): Promise<Profile[]> {
    const profiles = await db.profiles.toArray();
    for (const p of profiles) { if (p.id !== undefined) this.profileCache.set(p.id, p); }
    return profiles;
  }

  async saveProfile(profile: Profile): Promise<number> {
    const id = profile.id
      ? (await db.profiles.update(profile.id, { ...profile, updatedAt: Date.now() }), profile.id)
      : await db.profiles.add({ ...profile, createdAt: Date.now(), updatedAt: Date.now() });
    this.profileCache.set(id, { ...profile, id });
    return id;
  }

  async setActiveProfile(id: number): Promise<void> {
    await db.profiles.toCollection().modify({ isActive: 0 });
    await db.profiles.update(id, { isActive: 1 });
    const keys = Array.from(this.profileCache.keys());
    for (const k of keys) {
      const p = this.profileCache.get(k);
      if (p) { p.isActive = k === id ? 1 : 0; this.profileCache.set(k, p); }
    }
  }

  /**
   * Refuses to leave the database with no active profile (PRE-3). Deleting
   * the active profile promotes the lowest remaining id within the same
   * transaction; deleting the last remaining profile is refused outright.
   */
  async deleteProfile(id: number): Promise<Result<void, 'LAST_PROFILE'>> {
    return db.transaction('rw', db.profiles, async () => {
      const all = await db.profiles.toArray();
      if (all.length <= 1) return Err('LAST_PROFILE' as const);

      const deleted = all.find((p) => p.id === id);
      await db.profiles.delete(id);
      this.profileCache.delete(id);

      if (deleted?.isActive === 1) {
        const remaining = all.filter((p) => p.id !== id);
        const promoted = remaining.reduce((a, b) => (a.id! < b.id! ? a : b));
        await db.profiles.update(promoted.id!, { isActive: 1 });
        this.profileCache.delete(promoted.id!);
      }
      return Ok(undefined);
    });
  }

  /**
   * Append context to a profile's Context.md with token limit enforcement.
   * Uses gpt-tokenizer to ensure the 4000-token cap.
   */
  async appendContext(profileId: number, contextBlock: string): Promise<{ truncated: boolean; tokenCount: number }> {
    const profile = await this.getProfile(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);

    const timestamp = new Date().toISOString();
    const entry = `## Added ${timestamp}\n\n${contextBlock}`;
    const newContext = profile.contextMd
      ? profile.contextMd + '\n\n---\n\n' + entry
      : entry;

    // Enforce 4000-token limit using gpt-tokenizer
    const tokenCount = countTokens(newContext);
    let finalContext = newContext;
    let wasTruncated = false;

    if (tokenCount > MAX_CONTEXT_TOKENS) {
      const { truncated } = truncateToTokenLimit(newContext, MAX_CONTEXT_TOKENS);
      finalContext = truncated;
      wasTruncated = true;
      console.warn(`[CacheManager] Context truncated from ${tokenCount} to ${MAX_CONTEXT_TOKENS} tokens`);
    }

    await db.profiles.update(profileId, { contextMd: finalContext, updatedAt: Date.now() });
    profile.contextMd = finalContext;
    profile.updatedAt = Date.now();
    this.profileCache.set(profileId, profile);

    return { truncated: wasTruncated, tokenCount: countTokens(finalContext) };
  }

  // ── Snippet Ops ──
  async getAllSnippets(): Promise<Snippet[]> {
    const cached = this.snippetCache.get('all');
    if (cached) return cached;
    const snippets = await db.snippets.toArray();
    this.snippetCache.set('all', snippets);
    return snippets;
  }

  async searchSnippets(query: string): Promise<Snippet[]> {
    const all = await this.getAllSnippets();
    const q = query.toLowerCase();
    return all.filter(s => s.prefix.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }

  async saveSnippet(snippet: Snippet): Promise<number> {
    const now = Date.now();
    const id = snippet.id
      ? (await db.snippets.update(snippet.id, { ...snippet, updatedAt: now }), snippet.id)
      : await db.snippets.add({ ...snippet, createdAt: now, updatedAt: now });
    this.snippetCache.delete('all');
    return id;
  }

  async deleteSnippet(id: number): Promise<void> {
    await db.snippets.delete(id);
    this.snippetCache.delete('all');
  }

  // ── Settings ──
  async getSetting<T>(key: string): Promise<T | undefined> {
    const cached = this.settingsCache.get(key);
    if (cached !== undefined) return cached as T;
    const setting = await db.settings.get(key);
    if (setting) { this.settingsCache.set(key, setting.value); return setting.value as T; }
    return undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await db.settings.put({ key, value });
    this.settingsCache.set(key, value);
  }

  // ── History & Analytics ──
  async savePromptHistory(entry: { profileId: number; originalPrompt: string; refinedPrompt: string; score: number; iterations: number; provider: string; tokensUsed: number }): Promise<void> {
    await db.promptHistory.add({ ...entry, createdAt: Date.now() });
  }

  async getPromptHistory(profileId?: number, limit = 50) {
    if (profileId !== undefined) return db.promptHistory.where('profileId').equals(profileId).reverse().limit(limit).toArray();
    return db.promptHistory.orderBy('createdAt').reverse().limit(limit).toArray();
  }

  clearAll(): void {
    this.profileCache.clear();
    this.snippetCache.clear();
    this.settingsCache.clear();
    this.isWarmedUp = false;
  }
}

export const cacheManager = new CacheManager();
