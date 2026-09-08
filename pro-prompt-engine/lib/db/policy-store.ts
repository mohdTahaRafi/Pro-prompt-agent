/**
 * Policy store — sitePolicy accessors.
 *
 * A revoked origin keeps its row with revokedAt set. Deleting it would make
 * "was this site ever granted?" unanswerable, and any run history that
 * references it would dangle. See
 * Docs/planning/phase_1_foundation_preconditions.md §3.3.
 */
import { db } from '@lib/db/dexie-db';
import type { Verb } from '@lib/schemas/action.schema';

export interface SitePolicy {
  origin: string;                     // primary key, e.g. "https://example.com"
  capabilities: Verb[];               // narrower than the vocabulary, never wider (PR-SEC-6)
  defaultMode: 'suggest' | 'step' | 'supervised';
  grantedAt: number;
  revokedAt?: number;                 // set rather than deleted, so history is auditable
}

export async function getSitePolicy(origin: string): Promise<SitePolicy | undefined> {
  return db.sitePolicy.get(origin);
}

export async function getActiveSitePolicies(): Promise<SitePolicy[]> {
  return db.sitePolicy.filter((r) => r.revokedAt === undefined).toArray();
}

export async function putSitePolicy(policy: SitePolicy): Promise<void> {
  await db.sitePolicy.put(policy);
}

export async function markRevoked(origin: string, revokedAt: number): Promise<void> {
  await db.sitePolicy.update(origin, { revokedAt });
}
