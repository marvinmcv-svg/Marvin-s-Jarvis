import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pitchPerformance } from '../db/schema.js';
import { log } from '../core/logger.js';
import { env } from '../core/env.js';

/**
 * A/B pitch learning.
 *
 * Every drafted pitch carries an `angle` tag. When a reply lands, the reply is
 * attributed back to the angle that earned it. The pitch prompt then reads the
 * standings and is told which angles are pulling — so the copy Hermes writes in
 * week six is shaped by what actually got answered in weeks one to five.
 */

/** The angle vocabulary. Claude must pick from this list, so buckets stay comparable. */
export const PITCH_ANGLES = [
  'proof-first', // lead with the preview site itself
  'problem-spot', // lead with a specific weakness the audit found
  'social-proof', // lead with their reviews / local standing
  'missed-revenue', // lead with money they're leaving on the table
  'competitor-gap', // lead with what similar businesses nearby are doing
  'quick-win', // lead with one small fix, low commitment
] as const;

export type PitchAngle = (typeof PITCH_ANGLES)[number];

export function isPitchAngle(v: string): v is PitchAngle {
  return (PITCH_ANGLES as readonly string[]).includes(v);
}

/** Record that a pitch went out. Called from Phase 12 once the batch is sent. */
export async function recordSent(angle: string, niche: string, city: string, variant: string): Promise<void> {
  await db
    .insert(pitchPerformance)
    .values({
      angle,
      niche,
      city,
      variant,
      sentCount: 1,
      lastSentAt: new Date(),
      replyRate: 0,
    })
    .onConflictDoUpdate({
      target: [pitchPerformance.angle, pitchPerformance.niche, pitchPerformance.city],
      set: {
        sentCount: sql`${pitchPerformance.sentCount} + 1`,
        lastSentAt: new Date(),
        replyRate: sql`${pitchPerformance.replyCount}::real / greatest(${pitchPerformance.sentCount} + 1, 1)`,
        updatedAt: new Date(),
      },
    });
}

/** Record a reply against the angle that earned it. Called from the reply-check job. */
export async function recordReply(
  angle: string,
  niche: string,
  city: string,
  sentiment: 'positive' | 'neutral' | 'negative' | 'unsubscribe',
): Promise<void> {
  const positive = sentiment === 'positive' ? 1 : 0;
  const negative = sentiment === 'negative' || sentiment === 'unsubscribe' ? 1 : 0;

  await db
    .update(pitchPerformance)
    .set({
      replyCount: sql`${pitchPerformance.replyCount} + 1`,
      positiveCount: sql`${pitchPerformance.positiveCount} + ${positive}`,
      negativeCount: sql`${pitchPerformance.negativeCount} + ${negative}`,
      replyRate: sql`(${pitchPerformance.replyCount} + 1)::real / greatest(${pitchPerformance.sentCount}, 1)`,
      lastReplyAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pitchPerformance.angle, angle),
        eq(pitchPerformance.niche, niche),
        eq(pitchPerformance.city, city),
      ),
    );

  log.memory(`reply attributed to angle "${angle}" (${sentiment})`);
}

export type AngleStanding = {
  angle: string;
  sent: number;
  replies: number;
  positive: number;
  replyRate: number;
};

/**
 * Current standings for a niche, most effective first.
 *
 * Buckets with fewer than `minSample` sends are excluded — a 1-for-1 angle is
 * not a 100% reply rate, it's noise, and Hermes should not chase it.
 */
export async function standings(niche: string, minSample = 20): Promise<AngleStanding[]> {
  if (env.DISABLE_LEARNING) return [];

  const rows = await db
    .select({
      angle: pitchPerformance.angle,
      sent: sql<number>`sum(${pitchPerformance.sentCount})::int`,
      replies: sql<number>`sum(${pitchPerformance.replyCount})::int`,
      positive: sql<number>`sum(${pitchPerformance.positiveCount})::int`,
    })
    .from(pitchPerformance)
    .where(eq(pitchPerformance.niche, niche))
    .groupBy(pitchPerformance.angle)
    .having(sql`sum(${pitchPerformance.sentCount}) >= ${minSample}`);

  return rows
    .map((r) => ({ ...r, replyRate: r.sent > 0 ? r.replies / r.sent : 0 }))
    .sort((a, b) => b.replyRate - a.replyRate);
}

/**
 * The guidance block injected into the pitch prompt.
 *
 * Deliberately conservative in wording: it tells Claude what the data says and
 * lets it write, rather than hard-forcing the winning angle. Forcing collapses
 * exploration, and then the A/B test stops producing new information.
 */
export async function pitchGuidance(niche: string): Promise<string> {
  const rows = await standings(niche);
  if (rows.length < 2) {
    return 'PITCH PERFORMANCE: not enough data yet. Pick the two angles that best fit this specific lead, and keep the pair varied so we learn what works.';
  }

  const best = rows.slice(0, 2);
  const worst = rows[rows.length - 1]!;
  const lines = rows.map(
    (r) => `  - ${r.angle}: ${(r.replyRate * 100).toFixed(1)}% reply rate (${r.replies}/${r.sent}, ${r.positive} positive)`,
  );

  return [
    `PITCH PERFORMANCE for ${niche} — measured from real replies:`,
    ...lines,
    '',
    `Lean toward ${best.map((b) => `"${b.angle}"`).join(' and ')}. ` +
      `Avoid "${worst.angle}" unless this lead specifically calls for it. ` +
      'Still use two different angles per lead — we need to keep learning, not just exploit.',
  ].join('\n');
}

/** Angles worth trying, ordered. Used to bias variant selection without forcing it. */
export async function preferredAngles(niche: string): Promise<string[]> {
  const rows = await standings(niche);
  if (rows.length === 0) return [...PITCH_ANGLES];
  const ranked = rows.map((r) => r.angle);
  const rest = PITCH_ANGLES.filter((a) => !ranked.includes(a));
  return [...ranked, ...rest];
}

/** Recent movement, for the reflection prompt. */
export async function recentPerformance(days = 14): Promise<AngleStanding[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      angle: pitchPerformance.angle,
      sent: sql<number>`sum(${pitchPerformance.sentCount})::int`,
      replies: sql<number>`sum(${pitchPerformance.replyCount})::int`,
      positive: sql<number>`sum(${pitchPerformance.positiveCount})::int`,
    })
    .from(pitchPerformance)
    .where(gte(pitchPerformance.updatedAt, since))
    .groupBy(pitchPerformance.angle)
    .orderBy(desc(sql`sum(${pitchPerformance.replyCount})`));

  return rows.map((r) => ({ ...r, replyRate: r.sent > 0 ? r.replies / r.sent : 0 }));
}
