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
  // [Phase 5 §7, §11 task 5.8] Supervised mode acts freely below Always
  // EXCEPT Medium tier where this origin's policy says otherwise. Not an
  // indexed Dexie field, so no schema version bump is needed to add it —
  // absent (undefined) means false, the same default a fresh grantOrigin()
  // row gets. No dedicated settings UI ships this phase; it exists so
  // lib/policy/gate.ts's requiresApproval() has a real, testable per-origin
  // lever rather than a hardcoded always-false.
  mediumRequiresApproval?: boolean;
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
