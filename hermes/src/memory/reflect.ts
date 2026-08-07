import { desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRuns, leads } from '../db/schema.js';
import type { ScoredLead } from '../pipeline/types.js';
import type { RunRecorder } from './run.js';
import { remember, decay, recallText, pairKey } from './memory.js';
import { recentPerformance } from './playbook.js';
import { tune } from './weights.js';
import { askJson } from '../core/anthropic.js';
import { personaPreamble } from '../core/persona.js';
import { log } from '../core/logger.js';
import { env } from '../core/env.js';

/**
 * The self-learning loop.
 *
 * This is what makes Hermes an agent that learns from himself rather than a
 * cron job. After a run, he looks at what he just did — the metrics, the score
 * spread, how the pitch angles are performing, what replies came back — and
 * writes durable lessons to memory. Those lessons are retrieved on the next
 * run's audit and pitch prompts, so tomorrow's Hermes starts ahead of today's.
 *
 * There are two moments:
 *   reflectOnBatch()  — a quick, cheap reflection right after a daily run.
 *   deepReflection()  — a heavier weekly pass that also tunes the score weights
 *                       and prunes stale memory.
 */

const LESSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    narrative: { type: 'string', description: "2–4 sentences: how did this run go and what stood out?" },
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', description: 'One durable, self-contained, imperative lesson.' },
          kind: { type: 'string', enum: ['lesson', 'observation', 'preference', 'failure'] },
          scope: { type: 'string', enum: ['global', 'city', 'niche'] },
          tags: { type: 'array', items: { type: 'string', enum: ['audit', 'pitch', 'scrape', 'scoring', 'enrichment'] } },
          confidence: { type: 'number', description: '0–1 — how sure are you this generalizes?' },
        },
        required: ['content', 'kind', 'scope', 'tags', 'confidence'],
      },
    },
  },
  required: ['narrative', 'lessons'],
} as const;

type LessonResponse = {
  narrative: string;
  lessons: Array<{
    content: string;
    kind: 'lesson' | 'observation' | 'preference' | 'failure';
    scope: 'global' | 'city' | 'niche';
    tags: string[];
    confidence: number;
  }>;
};

/**
 * Post-batch reflection: Claude reviews today's run and writes lessons.
 *
 * Kept cheap (bulk tier, small output) because it runs every day. It has access
 * to what Hermes already believes, so it's told to prefer *new* insight and to
 * flag beliefs the run contradicted.
 */
export async function reflectOnBatch(
  recorder: RunRecorder,
  scored: ScoredLead[],
  city: string,
  niche: string,
): Promise<void> {
  if (env.DISABLE_LEARNING) {
    log.memory('learning disabled — skipping reflection');
    return;
  }

  const { metrics } = recorder.snapshot();
  const existing = await recallText({ city, niche, limit: 10 });
  const scoreSpread = summarizeScores(scored);
  const topFits = topServiceFits(scored);
  const angleStandings = await recentPerformance(14);

  const system = `${personaPreamble()}\n\nYou are reviewing your own run to learn from it. Write lessons that will make your NEXT run better. Be specific to what you actually saw. Do not restate things you already know.`;

  const user = [
    `Run just finished: ${niche} in ${city}.`,
    '',
    `What you delivered: ${metrics.delivered ?? scored.length} leads from ${metrics.scraped ?? '?'} scraped ` +
      `(${metrics.afterDedup ?? '?'} survived dedup, ${metrics.enriched ?? '?'} got new contact channels).`,
    `Score spread: ${scoreSpread}`,
    `Most common service fits today: ${topFits}`,
    '',
    `Pitch angle performance (last 14 days): ${angleStandings.length ? angleStandings.map((a) => `${a.angle} ${(a.replyRate * 100).toFixed(0)}% (${a.replies}/${a.sent})`).join(', ') : 'no reply data yet'}`,
    '',
    `Things you already believe about ${city}/${niche}:`,
    existing.length ? existing.map((l) => `  - ${l}`).join('\n') : '  (nothing yet)',
    '',
    'Write a short narrative and 1–4 NEW durable lessons. Good lessons are specific and actionable next run, e.g. ' +
      '"restaurants in this city almost always have Instagram but no website — lead the audit with the ordering gap" or ' +
      '"the proof-first angle is pulling replies here, keep favoring it". Skip anything you already know.',
  ].join('\n');

  const res = await askJson<LessonResponse>({
    tier: 'bulk',
    label: 'reflect',
    system,
    schema: LESSON_SCHEMA,
    maxTokens: 1500,
    user,
  });

  await recorder.saveReflection(res.narrative);
  await writeLessons(res.lessons, city, niche, recorder.id);
  log.memory(`reflection: ${res.narrative}`);
  log.memory(`wrote ${res.lessons.length} lessons to memory`);
}

/**
 * Weekly deep reflection: tune the score weights, prune stale memory, and take
 * a longer view across many runs. This is where the compounding really happens.
 */
export async function deepReflection(recorder: RunRecorder): Promise<void> {
  if (env.DISABLE_LEARNING) return;

  // 1. Age out memory that stopped being reinforced.
  const decayed = await decay();

  // 2. Re-tune the score weights against actual reply outcomes.
  const tuned = await tune(recorder.id);

  // 3. Look across recent runs for cross-cutting patterns.
  const runs = await db
    .select({
      job: agentRuns.job,
      city: agentRuns.city,
      niche: agentRuns.niche,
      metrics: agentRuns.metrics,
      reflection: agentRuns.reflection,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .where(gte(agentRuns.startedAt, new Date(Date.now() - 14 * 86_400_000)))
    .orderBy(desc(agentRuns.startedAt))
    .limit(20);

  const outcomes = await replyOutcomes();
  const angleStandings = await recentPerformance(30);

  const system = `${personaPreamble()}\n\nYou are doing a weekly review of your own performance across many runs. Look for cross-cutting patterns worth remembering globally. Be selective — only write high-value, durable lessons.`;

  const user = [
    'Weekly review. Here is what happened across your recent runs:',
    '',
    'Run summaries:',
    ...runs
      .filter((r) => r.job === 'daily')
      .slice(0, 8)
      .map((r) => `  - ${r.city}/${r.niche}: ${r.reflection ?? 'no reflection'}`),
    '',
    `Reply outcomes so far: ${outcomes.replied} replied, ${outcomes.won} won, out of ${outcomes.sent} sent ` +
      `(${outcomes.sent ? ((outcomes.replied / outcomes.sent) * 100).toFixed(1) : '0'}% reply rate).`,
    `Best pitch angles (30d): ${angleStandings.slice(0, 3).map((a) => `${a.angle} ${(a.replyRate * 100).toFixed(0)}%`).join(', ') || 'n/a'}`,
    tuned ? `You just re-tuned your scoring weights: ${tuned.changed.join('; ')}.` : 'Scoring weights were not changed this week.',
    '',
    'Write 1–3 GLOBAL lessons that should shape how you hunt across all cities and niches going forward.',
  ].join('\n');

  const res = await askJson<LessonResponse>({
    tier: 'quality',
    label: 'deep-reflect',
    system,
    schema: LESSON_SCHEMA,
    maxTokens: 1600,
    user,
  });

  await recorder.saveReflection(res.narrative);
  await writeLessons(
    res.lessons.map((l) => ({ ...l, scope: 'global' as const })),
    null,
    null,
    recorder.id,
  );

  log.memory(`deep reflection: ${res.narrative}`);
  log.memory(`decayed ${decayed}, ${tuned ? `tuned weights to v${tuned.version}` : 'weights unchanged'}, wrote ${res.lessons.length} global lessons`);
}

/** Persist the lessons Claude produced, mapping scope to the right key. */
async function writeLessons(
  lessons: LessonResponse['lessons'],
  city: string | null,
  niche: string | null,
  runId: string,
): Promise<void> {
  for (const l of lessons) {
    let scopeKey: string | null = null;
    if (l.scope === 'city') scopeKey = city;
    else if (l.scope === 'niche') scopeKey = city && niche ? pairKey(city, niche) : niche;

    await remember({
      kind: l.kind,
      content: l.content,
      scope: l.scope,
      scopeKey,
      tags: l.tags,
      confidence: l.confidence,
      runId,
      evidence: { city, niche },
    });
  }
}

function summarizeScores(scored: ScoredLead[]): string {
  if (!scored.length) return 'no leads';
  const scores = scored.map((s) => s.qualityScore);
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return `top ${scores[0]}, median ~${scores[Math.floor(scores.length / 2)]}, bottom ${scores[scores.length - 1]}, avg ${avg}`;
}

function topServiceFits(scored: ScoredLead[]): string {
  const tally = new Map<string, number>();
  for (const lead of scored) {
    for (const fit of lead.audit?.serviceFit ?? []) {
      const key = fit.toLowerCase().slice(0, 40);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  return (
    [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => `${k} (${n})`)
      .join(', ') || 'none recorded'
  );
}

async function replyOutcomes(): Promise<{ sent: number; replied: number; won: number }> {
  const [row] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${leads.status} in ('sent','replied','won','dead'))::int`,
      replied: sql<number>`count(*) filter (where ${leads.status} in ('replied','won'))::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
    })
    .from(leads);
  return row ?? { sent: 0, replied: 0, won: 0 };
}
