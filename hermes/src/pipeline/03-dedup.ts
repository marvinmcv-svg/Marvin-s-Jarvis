import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads } from '../db/schema.js';
import type { Candidate } from './types.js';
import { log } from '../core/logger.js';

/**
 * Phase 3 — drop anything Hermes has ever touched before.
 *
 * Two keys (master prompt §4): `place_id` is the gold standard; when Maps
 * didn't expose one, a sha256 of the normalized name+address is the fallback.
 * A candidate is dropped if either key already exists in `leads`, so the same
 * business never reaches Marvin's inbox twice.
 */

/** Normalize name+address before hashing so trivial differences collapse. */
export function dedupHash(name: string, address: string | null): string {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip accents
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return createHash('sha256').update(`${norm(name)}|${norm(address ?? '')}`).digest('hex');
}

export type DedupResult = {
  fresh: Array<Candidate & { dedupHash: string }>;
  droppedExisting: number;
  droppedInBatch: number;
};

export async function dedup(candidates: Candidate[]): Promise<DedupResult> {
  // First collapse dupes within this batch (Maps often lists the same place twice).
  const byKey = new Map<string, Candidate & { dedupHash: string }>();
  let droppedInBatch = 0;

  for (const c of candidates) {
    const hash = dedupHash(c.name, c.address);
    const key = c.placeId ?? hash;
    if (byKey.has(key)) {
      droppedInBatch++;
      continue;
    }
    byKey.set(key, { ...c, dedupHash: hash });
  }

  const batch = [...byKey.values()];
  if (batch.length === 0) return { fresh: [], droppedExisting: 0, droppedInBatch };

  // Now check against everything ever stored.
  const placeIds = batch.map((c) => c.placeId).filter((p): p is string => Boolean(p));
  const hashes = batch.map((c) => c.dedupHash);

  const [seenPlaceRows, seenHashRows] = await Promise.all([
    placeIds.length
      ? db.select({ placeId: leads.placeId }).from(leads).where(inArray(leads.placeId, placeIds))
      : Promise.resolve([]),
    db.select({ dedupHash: leads.dedupHash }).from(leads).where(inArray(leads.dedupHash, hashes)),
  ]);

  const seenPlace = new Set(seenPlaceRows.map((r) => r.placeId));
  const seenHash = new Set(seenHashRows.map((r) => r.dedupHash));

  const fresh = batch.filter((c) => {
    const known = (c.placeId && seenPlace.has(c.placeId)) || seenHash.has(c.dedupHash);
    return !known;
  });

  const droppedExisting = batch.length - fresh.length;
  log.info(`dedup: ${candidates.length} scraped → ${fresh.length} fresh (${droppedExisting} seen before, ${droppedInBatch} dupes in batch)`);
  return { fresh, droppedExisting, droppedInBatch };
}
