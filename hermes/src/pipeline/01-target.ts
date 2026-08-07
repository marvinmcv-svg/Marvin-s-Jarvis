import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { nicheRuns, type NicheRun } from '../db/schema.js';
import type { HermesConfig } from '../core/config.js';
import { log } from '../core/logger.js';
import type { QueueEntry } from '../../config/targets.js';

/**
 * Phase 1 — decide what Hermes hunts today.
 *
 * Rules (master prompt §7 Phase 1):
 *   - If a niche is active and still under its weekly cap, keep going.
 *   - If the active niche hit its cap or dried up, complete it and rotate.
 *   - If nothing is active, activate the next unfinished queue entry.
 *
 * The queue's *order* is authoritative, so Marvin can reprioritize by editing
 * `config/targets.ts` and the next rotation follows the new order.
 */

export type Target = {
  run: NicheRun;
  entry: QueueEntry;
};

export async function determineTarget(cfg: HermesConfig): Promise<Target | null> {
  // Is a niche already active and still has room?
  const [active] = await db.select().from(nicheRuns).where(eq(nicheRuns.isActive, true)).limit(1);

  if (active) {
    if (!active.exhausted && active.sentCount < active.weekCap) {
      const entry = findEntry(cfg, active);
      if (entry) {
        const dayInWeek = Math.floor(active.sentCount / active.dailyTarget) + 1;
        const totalDays = Math.ceil(active.weekCap / active.dailyTarget);
        log.info(`continuing ${active.city} / ${active.niche} — day ${dayInWeek}/${totalDays}, ${active.sentCount}/${active.weekCap} sent`);
        return { run: active, entry };
      }
      // Active row no longer maps to a queue entry (Marvin removed it) — retire it.
      log.warn(`active niche ${active.city}/${active.niche} is gone from the queue — completing it`);
    }
    await completeRun(active.id, active.exhausted ? 'exhausted' : 'cap reached');
  }

  return activateNext(cfg);
}

function findEntry(cfg: HermesConfig, run: { city: string; niche: string }): QueueEntry | undefined {
  return cfg.queue.find((e) => e.city === run.city && e.niche === run.niche);
}

async function completeRun(id: string, reason: string): Promise<void> {
  await db
    .update(nicheRuns)
    .set({ isActive: false, completedAt: new Date() })
    .where(eq(nicheRuns.id, id));
  log.ok(`completed a niche (${reason})`);
}

/**
 * Activate the first queue entry that has never been completed.
 *
 * A completed row stays in the table with `completedAt` set, so we skip it and
 * pick the next fresh entry, walking the queue in order.
 */
async function activateNext(cfg: HermesConfig): Promise<Target | null> {
  const existing = await db.select().from(nicheRuns).orderBy(asc(nicheRuns.queueIndex));
  const byKey = new Map(existing.map((r) => [`${r.city}::${r.niche}`, r]));

  for (let i = 0; i < cfg.queue.length; i++) {
    const entry = cfg.queue[i]!;
    const key = `${entry.city}::${entry.niche}`;
    const prior = byKey.get(key);

    // Skip entries that have already run to completion.
    if (prior?.completedAt) continue;

    if (prior) {
      // A previously-created-but-never-finished row (e.g. interrupted) — reactivate.
      const [row] = await db
        .update(nicheRuns)
        .set({ isActive: true, exhausted: false, startedAt: prior.startedAt ?? new Date() })
        .where(eq(nicheRuns.id, prior.id))
        .returning();
      log.ok(`activated ${entry.city} / ${entry.niche} (resumed)`);
      return { run: row!, entry };
    }

    const [row] = await db
      .insert(nicheRuns)
      .values({
        city: entry.city,
        niche: entry.niche,
        dailyTarget: entry.dailyTarget ?? cfg.dailyTarget,
        weekCap: entry.weekCap ?? cfg.weekCap,
        isActive: true,
        queueIndex: i,
        startedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [nicheRuns.city, nicheRuns.niche],
        set: { isActive: true, exhausted: false, queueIndex: i },
      })
      .returning();

    log.ok(`activated ${entry.city} / ${entry.niche} (fresh)`);
    return { run: row!, entry };
  }

  log.warn('every queue entry is complete — nothing left to hunt. Add more to config/targets.ts.');
  return null;
}

/** Mark the active niche exhausted (scraping dried up before the cap). */
export async function markExhausted(runId: string): Promise<void> {
  await db.update(nicheRuns).set({ exhausted: true }).where(eq(nicheRuns.id, runId));
  log.warn('marked niche exhausted — it will rotate on the next run');
}

/** Increment sent-count after a batch ships (Phase 12). */
export async function incrementSent(runId: string, by: number): Promise<NicheRun> {
  const [row] = await db
    .update(nicheRuns)
    .set({ sentCount: (await currentSent(runId)) + by })
    .where(eq(nicheRuns.id, runId))
    .returning();
  return row!;
}

async function currentSent(runId: string): Promise<number> {
  const [row] = await db.select({ n: nicheRuns.sentCount }).from(nicheRuns).where(eq(nicheRuns.id, runId)).limit(1);
  return row?.n ?? 0;
}

/** Bump the consecutive-short-day counter; two in a row ⇒ exhausted. */
export async function registerShortDay(run: NicheRun): Promise<boolean> {
  const shortDays = run.shortDays + 1;
  await db.update(nicheRuns).set({ shortDays }).where(eq(nicheRuns.id, run.id));
  if (shortDays >= 2) {
    await markExhausted(run.id);
    return true;
  }
  return false;
}

/** Reset the short-day counter after a healthy day. */
export async function clearShortDays(runId: string): Promise<void> {
  await db.update(nicheRuns).set({ shortDays: 0 }).where(and(eq(nicheRuns.id, runId)));
}
