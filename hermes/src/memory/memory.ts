import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentMemory, type MemoryEntry, type NewMemoryEntry } from '../db/schema.js';
import { log } from '../core/logger.js';
import { env } from '../core/env.js';

/**
 * Hermes' long-term memory.
 *
 * Two operations matter:
 *   recall()   — pull the lessons relevant to what he's about to do, so they
 *                can be pasted into the prompt.
 *   remember() — write a conclusion back, reinforcing it if he's reached the
 *                same conclusion before.
 *
 * Everything else here supports those two: decay so stale lessons fade,
 * contradiction so a lesson can be retired, and a confidence floor so a
 * one-off observation doesn't get treated as gospel.
 */

export type MemoryKind = 'lesson' | 'observation' | 'fact' | 'preference' | 'failure';
export type MemoryScope = 'global' | 'city' | 'niche' | 'lead' | 'scraper';

export type RecallQuery = {
  city?: string;
  niche?: string;
  /** Only return memories tagged with at least one of these. */
  tags?: string[];
  kinds?: MemoryKind[];
  /** Ignore anything below this confidence. Default 0.35. */
  minConfidence?: number;
  limit?: number;
};

/** Stable key so the same lesson reinforces rather than duplicating. */
function hashContent(scope: string, scopeKey: string | null, content: string): string {
  const normalized = content.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${scope}::${scopeKey ?? ''}::${normalized}`).digest('hex');
}

/** `city::niche` composite key, used for the most specific scope. */
export function pairKey(city: string, niche: string): string {
  return `${city}::${niche}`;
}

/**
 * Retrieve memories relevant to the current run, most-specific first.
 *
 * Ordering is deliberate: a lesson learned about *dentists in NYC* should be
 * read after — and therefore weigh more than — a generic global lesson, because
 * the prompt lists them in order and later items land harder.
 */
export async function recall(q: RecallQuery = {}): Promise<MemoryEntry[]> {
  if (env.DISABLE_LEARNING) return [];

  const minConfidence = q.minConfidence ?? 0.35;
  const limit = q.limit ?? 12;

  const scopeMatches = [
    and(eq(agentMemory.scope, 'global'), isNull(agentMemory.scopeKey)),
    eq(agentMemory.scope, 'global'),
  ];
  if (q.city) scopeMatches.push(and(eq(agentMemory.scope, 'city'), eq(agentMemory.scopeKey, q.city))!);
  if (q.niche) scopeMatches.push(and(eq(agentMemory.scope, 'niche'), eq(agentMemory.scopeKey, q.niche))!);
  if (q.city && q.niche) {
    scopeMatches.push(
      and(eq(agentMemory.scope, 'niche'), eq(agentMemory.scopeKey, pairKey(q.city, q.niche)))!,
    );
  }

  const conditions = [
    eq(agentMemory.active, true),
    sql`${agentMemory.confidence} >= ${minConfidence}`,
    or(...scopeMatches)!,
  ];
  if (q.kinds?.length) conditions.push(inArray(agentMemory.kind, q.kinds));

  let rows = await db
    .select()
    .from(agentMemory)
    .where(and(...conditions))
    .orderBy(desc(agentMemory.confidence), desc(agentMemory.evidenceCount))
    .limit(limit * 3);

  if (q.tags?.length) {
    const wanted = new Set(q.tags);
    rows = rows.filter((r) => (r.tags ?? []).some((t) => wanted.has(t)));
  }

  // Specific beats general: global → city → niche → city::niche.
  const specificity = (r: MemoryEntry): number => {
    if (r.scope === 'global') return 0;
    if (r.scope === 'city') return 1;
    if (r.scopeKey?.includes('::')) return 3;
    return 2;
  };
  rows.sort((a, b) => specificity(a) - specificity(b) || b.confidence - a.confidence);

  const picked = rows.slice(0, limit);
  if (picked.length) await markUsed(picked.map((r) => r.id));
  return picked;
}

/** Convenience: recall as plain strings, ready for `memoryBlock()`. */
export async function recallText(q: RecallQuery = {}): Promise<string[]> {
  return (await recall(q)).map((m) => m.content);
}

async function markUsed(ids: string[]): Promise<void> {
  await db
    .update(agentMemory)
    .set({ lastUsedAt: new Date(), useCount: sql`${agentMemory.useCount} + 1` })
    .where(inArray(agentMemory.id, ids));
}

export type RememberInput = {
  kind: MemoryKind;
  content: string;
  scope?: MemoryScope;
  scopeKey?: string | null;
  tags?: string[];
  evidence?: Record<string, unknown>;
  /** Confidence for a brand-new memory. Reinforcement raises it from here. */
  confidence?: number;
  runId?: string | null;
};

/**
 * Write a conclusion to memory.
 *
 * If Hermes has reached this same conclusion before, the existing row is
 * reinforced instead of duplicated: evidence count goes up and confidence
 * moves toward 1 with diminishing returns, so the tenth corroboration matters
 * less than the second.
 */
export async function remember(input: RememberInput): Promise<void> {
  if (env.DISABLE_LEARNING) return;

  const scope = input.scope ?? 'global';
  const scopeKey = input.scopeKey ?? null;
  const content = input.content.trim();
  if (!content) return;

  const contentHash = hashContent(scope, scopeKey, content);
  const seed = Math.min(Math.max(input.confidence ?? 0.5, 0.05), 0.95);

  const row: NewMemoryEntry = {
    kind: input.kind,
    scope,
    scopeKey,
    content,
    contentHash,
    confidence: seed,
    evidenceCount: 1,
    tags: input.tags ?? [],
    evidence: input.evidence ?? {},
    sourceRunId: input.runId ?? null,
  };

  await db
    .insert(agentMemory)
    .values(row)
    .onConflictDoUpdate({
      target: agentMemory.contentHash,
      set: {
        evidenceCount: sql`${agentMemory.evidenceCount} + 1`,
        // Move a third of the remaining distance to 1.0 on each corroboration.
        confidence: sql`least(1.0, ${agentMemory.confidence} + (1.0 - ${agentMemory.confidence}) * 0.33)`,
        active: true,
        updatedAt: new Date(),
        evidence: row.evidence,
      },
    });

  log.memory(`remembered [${scope}${scopeKey ? `/${scopeKey}` : ''}] ${content.slice(0, 90)}`);
}

/**
 * Record that a memory turned out to be wrong.
 *
 * Confidence is halved; below the floor the memory is retired but kept for the
 * audit trail, so you can always see what Hermes used to believe.
 */
export async function contradict(memoryId: string, note?: string): Promise<void> {
  const [row] = await db.select().from(agentMemory).where(eq(agentMemory.id, memoryId)).limit(1);
  if (!row) return;

  const next = row.confidence * 0.5;
  await db
    .update(agentMemory)
    .set({
      confidence: next,
      active: next >= 0.15,
      updatedAt: new Date(),
      evidence: { ...(row.evidence ?? {}), contradictedNote: note ?? null, contradictedAt: new Date().toISOString() },
    })
    .where(eq(agentMemory.id, memoryId));

  log.memory(`contradicted (${row.confidence.toFixed(2)} → ${next.toFixed(2)}) ${row.content.slice(0, 70)}`);
}

/**
 * Age out memories that stopped being reinforced.
 *
 * Without this, a lesson learned once in March is still shouting at Hermes in
 * December. Anything untouched for 30 days loses 10% confidence per sweep;
 * below 0.15 it retires itself.
 */
export async function decay(): Promise<number> {
  const result = await db
    .update(agentMemory)
    .set({
      confidence: sql`${agentMemory.confidence} * 0.9`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentMemory.active, true),
        sql`coalesce(${agentMemory.lastUsedAt}, ${agentMemory.createdAt}) < now() - interval '30 days'`,
      ),
    )
    .returning({ id: agentMemory.id });

  await db
    .update(agentMemory)
    .set({ active: false })
    .where(and(eq(agentMemory.active, true), sql`${agentMemory.confidence} < 0.15`));

  if (result.length) log.memory(`decayed ${result.length} stale memories`);
  return result.length;
}

/** Everything Hermes currently believes — used by the `memory` CLI and the reflection prompt. */
export async function dumpActive(limit = 200): Promise<MemoryEntry[]> {
  return db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.active, true))
    .orderBy(desc(agentMemory.confidence))
    .limit(limit);
}
