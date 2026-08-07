import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, scoreWeights, type ScoreWeightsRow } from '../db/schema.js';
import { log } from '../core/logger.js';
import { env } from '../core/env.js';

/**
 * Self-tuning quality-score weights.
 *
 * Phase 6 scores each lead 0–100 from a set of signals. Those weights start as
 * Marvin's hand-written priors, and then Hermes grades himself: he compares the
 * scores he assigned against which leads actually replied, and nudges the
 * weights toward the signals that predicted replies.
 *
 * Deliberately a small, damped nudge rather than a real optimizer — with ~50
 * leads a day and a low reply rate, anything more aggressive would just fit
 * noise. It also keeps every version, so a bad tune is one query to roll back.
 */

/** The signal vocabulary. Adding a signal here requires adding it in `06-score.ts`. */
export const SIGNALS = [
  'noWebsite', // no site at all — the single strongest fit for the free-preview offer
  'brokenSite', // site exists but is broken/slow/not mobile
  'weakSite', // site exists but is dated or thin
  'noOnlineOrdering', // restaurants/retail with no ordering or booking path
  'weakSocial', // thin or stale Instagram/Facebook — video & clipping fit
  'noSocial', // no social presence found at all
  'missingWhatsapp', // no WhatsApp — a contactability penalty, not a fit signal
  'hasEmail', // reachable by email at all (needed to send anything)
  'highReviewsLowRating', // busy but unhappy — has budget and a visible problem
  'highReviewsHighRating', // busy and well-liked — has budget, harder sell
  'lowReviewVolume', // little traction — may be too small to pay
  'multiServiceFit', // audit found fits across more than one of Marvin's services
] as const;

export type Signal = (typeof SIGNALS)[number];
export type WeightVector = Record<Signal, number>;

/**
 * Marvin's priors. Positive = more likely to convert, negative = less.
 * The scorer sums the active signals and maps the total into 0–100.
 */
export const DEFAULT_WEIGHTS: WeightVector = {
  noWebsite: 30,
  brokenSite: 24,
  weakSite: 14,
  noOnlineOrdering: 10,
  weakSocial: 12,
  noSocial: 8,
  missingWhatsapp: -6,
  hasEmail: 10,
  highReviewsLowRating: 18,
  highReviewsHighRating: 8,
  lowReviewVolume: -12,
  multiServiceFit: 14,
};

/** The active weight vector, falling back to the priors on a fresh install. */
export async function activeWeights(): Promise<{ weights: WeightVector; version: number }> {
  const [row] = await db
    .select()
    .from(scoreWeights)
    .where(eq(scoreWeights.isActive, true))
    .limit(1);

  if (!row) {
    const created = await seedDefaults();
    return { weights: created.weights as WeightVector, version: created.version };
  }
  // Merge over defaults so a newly added signal doesn't read as undefined.
  return {
    weights: { ...DEFAULT_WEIGHTS, ...(row.weights as Partial<WeightVector>) },
    version: row.version,
  };
}

async function seedDefaults(): Promise<ScoreWeightsRow> {
  const [row] = await db
    .insert(scoreWeights)
    .values({
      version: 1,
      weights: DEFAULT_WEIGHTS,
      isActive: true,
      rationale: "Marvin's hand-written priors (v1).",
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row;
  const [existing] = await db.select().from(scoreWeights).where(eq(scoreWeights.version, 1)).limit(1);
  return existing!;
}

/**
 * Grade the active weight vector against reality.
 *
 * Calibration here is the mean score of leads that replied minus the mean score
 * of leads that didn't, normalized to roughly −1..1. Positive means the scores
 * are ranking real prospects higher, which is the only thing the score is for.
 */
export async function calibrate(): Promise<{ calibration: number; replied: number; sent: number } | null> {
  const [stats] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${leads.status} in ('sent','replied','won','dead'))::int`,
      replied: sql<number>`count(*) filter (where ${leads.status} in ('replied','won'))::int`,
      avgReplied: sql<number>`coalesce(avg(${leads.qualityScore}) filter (where ${leads.status} in ('replied','won')), 0)::real`,
      avgQuiet: sql<number>`coalesce(avg(${leads.qualityScore}) filter (where ${leads.status} = 'sent'), 0)::real`,
    })
    .from(leads)
    .where(isNotNull(leads.qualityScore));

  if (!stats || stats.replied < 10) return null; // not enough signal to grade anything

  const calibration = Math.max(-1, Math.min(1, (stats.avgReplied - stats.avgQuiet) / 50));
  return { calibration, replied: stats.replied, sent: stats.sent };
}

/**
 * Per-signal lift: how much more often a lead replied when the signal fired.
 *
 * This is what the tuner actually moves weights on — a signal present in
 * repliers far more than in non-repliers deserves more weight.
 */
async function signalLift(): Promise<Record<string, { lift: number; support: number }>> {
  const rows = await db
    .select({ breakdown: leads.scoreBreakdown, status: leads.status })
    .from(leads)
    .where(and(isNotNull(leads.scoreBreakdown), sql`${leads.status} in ('sent','replied','won')`));

  const tally: Record<string, { onReplied: number; onQuiet: number }> = {};
  let replied = 0;
  let quiet = 0;

  for (const r of rows) {
    const isReply = r.status === 'replied' || r.status === 'won';
    if (isReply) replied++;
    else quiet++;
    for (const [signal, value] of Object.entries(r.breakdown ?? {})) {
      if (value === 0) continue; // signal didn't fire for this lead
      tally[signal] ??= { onReplied: 0, onQuiet: 0 };
      if (isReply) tally[signal].onReplied++;
      else tally[signal].onQuiet++;
    }
  }

  const out: Record<string, { lift: number; support: number }> = {};
  if (replied === 0 || quiet === 0) return out;

  for (const [signal, t] of Object.entries(tally)) {
    const pReplied = t.onReplied / replied;
    const pQuiet = t.onQuiet / quiet;
    out[signal] = { lift: pReplied - pQuiet, support: t.onReplied + t.onQuiet };
  }
  return out;
}

/**
 * Tune the weights and publish a new active version.
 *
 * Guards, in order: learning must be enabled, there must be at least 25 replies
 * to learn from, and each signal needs 30 observations before it moves. Weight
 * changes are capped at ±20% per tune and clamped to the original sign, so the
 * vector can be refined but can't flip Marvin's domain judgement on its own.
 */
export async function tune(runId?: string): Promise<{ version: number; changed: string[] } | null> {
  if (env.DISABLE_LEARNING) return null;

  const grade = await calibrate();
  if (!grade || grade.replied < 25) {
    log.memory(`weight tuning skipped — only ${grade?.replied ?? 0} replies so far (need 25)`);
    return null;
  }

  const { weights: current, version } = await activeWeights();
  const lifts = await signalLift();

  const next: WeightVector = { ...current };
  const changed: string[] = [];

  for (const signal of SIGNALS) {
    const l = lifts[signal];
    if (!l || l.support < 30) continue;

    const base = current[signal];
    const prior = DEFAULT_WEIGHTS[signal];
    // Lift is roughly −1..1; scale it into at most a 20% move.
    const delta = base * Math.max(-0.2, Math.min(0.2, l.lift * 0.6));
    let tuned = base + delta;

    // Never let a tune flip the sign of Marvin's prior, and never let a weight
    // drift more than 2x from where it started.
    const lo = prior >= 0 ? 0 : prior * 2;
    const hi = prior >= 0 ? prior * 2 : 0;
    tuned = Math.max(lo, Math.min(hi, tuned));

    if (Math.abs(tuned - base) >= 0.5) {
      next[signal] = Number(tuned.toFixed(2));
      changed.push(`${signal} ${base.toFixed(1)}→${tuned.toFixed(1)}`);
    }
  }

  if (changed.length === 0) {
    log.memory('weight tuning ran — no signal moved enough to publish a new version');
    await recordGrade(version, grade);
    return null;
  }

  await recordGrade(version, grade);
  await db.update(scoreWeights).set({ isActive: false }).where(eq(scoreWeights.isActive, true));

  const [row] = await db
    .insert(scoreWeights)
    .values({
      version: version + 1,
      weights: next,
      isActive: true,
      rationale: `Tuned from v${version} on ${grade.replied} replies (calibration ${grade.calibration.toFixed(3)}). ${changed.join('; ')}`,
    })
    .returning({ version: scoreWeights.version });

  log.memory(`published score weights v${row!.version}: ${changed.join('; ')}`);
  void runId; // reserved: tie the tune to the run that produced it
  return { version: row!.version, changed };
}

async function recordGrade(version: number, grade: { calibration: number; replied: number; sent: number }): Promise<void> {
  await db
    .update(scoreWeights)
    .set({ calibration: grade.calibration, repliesSeen: grade.replied, leadsSent: grade.sent })
    .where(eq(scoreWeights.version, version));
}

/** Roll back to a previous version — the escape hatch if a tune goes wrong. */
export async function rollback(toVersion: number): Promise<boolean> {
  const [target] = await db.select().from(scoreWeights).where(eq(scoreWeights.version, toVersion)).limit(1);
  if (!target) return false;

  await db.update(scoreWeights).set({ isActive: false }).where(eq(scoreWeights.isActive, true));
  await db.update(scoreWeights).set({ isActive: true }).where(eq(scoreWeights.version, toVersion));
  log.warn(`rolled score weights back to v${toVersion}`);
  return true;
}

/** History, newest first — used by the memory CLI. */
export async function history(limit = 10): Promise<ScoreWeightsRow[]> {
  return db.select().from(scoreWeights).orderBy(desc(scoreWeights.version)).limit(limit);
}
