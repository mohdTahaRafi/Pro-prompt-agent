/**
 * Covers PRE-3: the active profile resolves on a cold start. Four cases per
 * Docs/planning/phase_1_foundation_preconditions.md §5.3:
 *  - a v1 database with isActive: true opens at v2 with exactly one profile
 *    at isActive: 1
 *  - a v1 database with no active profile promotes exactly one
 *  - getActiveProfile() on an empty cache returns a profile
 *  - deleting the active profile leaves exactly one active
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Dexie from 'dexie';
import { ProPromptDB } from '@lib/db/dexie-db';

let dbCounter = 0;
function uniqueDbName() { return `ProPromptTest_${Date.now()}_${dbCounter++}`; }

/** Opens a raw v1-shaped database (the historical schema, isActive: boolean). */
async function openLegacyV1(name: string, profiles: Array<{ name: string; isActive: boolean }>) {
  const legacy = new Dexie(name);
  legacy.version(1).stores({
    profiles: '++id, name, isActive, createdAt',
    snippets: '++id, prefix, profileId, createdAt',
    promptHistory: '++id, profileId, score, createdAt',
    settings: 'key',
    analytics: '++id, event, timestamp',
  });
  await legacy.open();
  const now = Date.now();
  for (const p of profiles) {
    await (legacy as any).table('profiles').add({
      name: p.name, description: '', icon: '🌐', isActive: p.isActive, isCustom: false,
      contextMd: '', promptGuidelinesMd: '', profileDescriptionMd: '',
      agentWeights: { refactor: 1, scorer: 1, generator: 1, comprehension: 1 },
      createdAt: now, updatedAt: now,
    });
  }
  legacy.close();
}

describe('Dexie v2 migration — isActive normalisation (PRE-3)', () => {
  it('a v1 database with isActive: true opens at v2 with exactly one profile at isActive: 1', async () => {
    const name = uniqueDbName();
    await openLegacyV1(name, [
      { name: 'Alpha', isActive: false },
      { name: 'Beta', isActive: true },
      { name: 'Gamma', isActive: false },
    ]);

    const db = new ProPromptDB(name);
    await db.open();
    const all = await db.profiles.toArray();
    const active = all.filter((p) => p.isActive === 1);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('Beta');
    expect(all.every((p) => p.isActive === 0 || p.isActive === 1)).toBe(true);
    db.close();
  });

  it('a v1 database with no active profile promotes exactly one (the lowest id)', async () => {
    const name = uniqueDbName();
    await openLegacyV1(name, [
      { name: 'Alpha', isActive: false },
      { name: 'Beta', isActive: false },
    ]);

    const db = new ProPromptDB(name);
    await db.open();
    const all = await db.profiles.toArray();
    const active = all.filter((p) => p.isActive === 1);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('Alpha'); // lowest id
    db.close();
  });

  it('the runs/runEvents/sitePolicy/tasks tables exist and analytics is dropped', async () => {
    const name = uniqueDbName();
    const db = new ProPromptDB(name);
    await db.open();
    const names = db.tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['runs', 'runEvents', 'sitePolicy', 'tasks']));
    expect(names).not.toContain('analytics');
    db.close();
  });
});

describe('CacheManager — cold-start repair and deletion invariant (PRE-3)', () => {
  beforeEach(() => {
    // Each test gets a fresh cacheManager module bound to a fresh Dexie
    // database name, so state never leaks between tests.
  });

  it('getActiveProfile() on an empty cache repairs and returns a profile when isActive is wrongly all-0', async () => {
    vi.resetModules();
    const dbName = uniqueDbName();
    vi.doMock('@lib/db/dexie-db', async () => {
      const actual = await vi.importActual<typeof import('@lib/db/dexie-db')>('@lib/db/dexie-db');
      const db = new actual.ProPromptDB(dbName);
      return { ...actual, db };
    });
    const { db } = await import('@lib/db/dexie-db');
    const now = Date.now();
    await db.profiles.bulkAdd([
      { name: 'One', description: '', icon: '🌐', isActive: 0, isCustom: false, contextMd: '', promptGuidelinesMd: '', profileDescriptionMd: '', agentWeights: { refactor: 1, scorer: 1, generator: 1, comprehension: 1 }, createdAt: now, updatedAt: now },
      { name: 'Two', description: '', icon: '🌐', isActive: 0, isCustom: false, contextMd: '', promptGuidelinesMd: '', profileDescriptionMd: '', agentWeights: { refactor: 1, scorer: 1, generator: 1, comprehension: 1 }, createdAt: now, updatedAt: now },
    ] as any);

    const { cacheManager } = await import('@lib/cache/cache-manager');
    const active = await cacheManager.getActiveProfile();
    expect(active).toBeDefined();
    expect(active!.isActive).toBe(1);

    const persisted = await db.profiles.get(active!.id!);
    expect(persisted!.isActive).toBe(1);
    vi.doUnmock('@lib/db/dexie-db');
  });

  it('deleting the active profile leaves exactly one active; deleting the last profile is refused', async () => {
    vi.resetModules();
    const dbName = uniqueDbName();
    vi.doMock('@lib/db/dexie-db', async () => {
      const actual = await vi.importActual<typeof import('@lib/db/dexie-db')>('@lib/db/dexie-db');
      const db = new actual.ProPromptDB(dbName);
      return { ...actual, db };
    });
    const { db } = await import('@lib/db/dexie-db');
    const now = Date.now();
    const ids = await db.profiles.bulkAdd([
      { name: 'One', description: '', icon: '🌐', isActive: 1, isCustom: false, contextMd: '', promptGuidelinesMd: '', profileDescriptionMd: '', agentWeights: { refactor: 1, scorer: 1, generator: 1, comprehension: 1 }, createdAt: now, updatedAt: now },
      { name: 'Two', description: '', icon: '🌐', isActive: 0, isCustom: false, contextMd: '', promptGuidelinesMd: '', profileDescriptionMd: '', agentWeights: { refactor: 1, scorer: 1, generator: 1, comprehension: 1 }, createdAt: now, updatedAt: now },
    ] as any, { allKeys: true });

    const { cacheManager } = await import('@lib/cache/cache-manager');
    const del1 = await cacheManager.deleteProfile(ids[0] as number);
    expect(del1.ok).toBe(true);
    const remaining = await db.profiles.toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining.filter((p) => p.isActive === 1)).toHaveLength(1);

    const del2 = await cacheManager.deleteProfile(remaining[0].id!);
    expect(del2.ok).toBe(false);
    if (!del2.ok) expect(del2.error).toBe('LAST_PROFILE');
    expect(await db.profiles.count()).toBe(1);
    vi.doUnmock('@lib/db/dexie-db');
  });
});
