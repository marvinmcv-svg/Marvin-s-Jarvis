import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* ────────────────────────────────────────────────────────────────────────────
 * CORE PIPELINE TABLES  (master prompt §4)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every business Hermes has ever touched. The dedup ledger. */
export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Google Maps place_id — the gold-standard dedup key. */
    placeId: text('place_id'),
    /** Fallback dedup key: sha256(normalized name + address). */
    dedupHash: text('dedup_hash').notNull(),

    name: text('name').notNull(),
    city: text('city').notNull(),
    niche: text('niche').notNull(),

    address: text('address'),
    phone: text('phone'),
    whatsapp: text('whatsapp'),
    email: text('email'),
    website: text('website'),
    linkedin: text('linkedin'),
    instagram: text('instagram'),
    facebook: text('facebook'),
    /** array of { platform, url } */
    otherSocials: jsonb('other_socials').$type<Array<{ platform: string; url: string }>>(),

    rating: numeric('rating'),
    reviewsCount: integer('reviews_count'),

    /** Full raw scrape payload, kept so a lead can be re-processed without re-scraping. */
    raw: jsonb('raw').$type<Record<string, unknown>>(),

    /** 0–100, produced by the (self-tuning) scorer. */
    qualityScore: integer('quality_score'),
    /** Which weight version produced qualityScore — lets Hermes grade its own past scoring. */
    scoreWeightsVersion: integer('score_weights_version'),
    /** Per-signal breakdown, for explainability and for the learning loop. */
    scoreBreakdown: jsonb('score_breakdown').$type<Record<string, number>>(),

    audit: jsonb('audit').$type<LeadAudit>(),

    /** new | sent | replied | won | dead */
    status: text('status').notNull().default('new'),

    batchId: uuid('batch_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    /** Top-N flag consumed by Marvin's separate preview-site generator (§9). */
    previewPending: boolean('preview_pending').notNull().default(false),
    previewPayload: jsonb('preview_payload').$type<Record<string, unknown>>(),
    previewUrl: text('preview_url'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('leads_place_id_uniq').on(t.placeId),
    uniqueIndex('leads_dedup_hash_uniq').on(t.dedupHash),
    index('leads_city_niche_idx').on(t.city, t.niche),
    index('leads_status_idx').on(t.status),
    index('leads_batch_idx').on(t.batchId),
  ],
);

/** Drafted pitches. Hermes never sends these — Marvin does. */
export const outreach = pgTable(
  'outreach',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),

    /** 'A' | 'B' */
    variant: text('variant').notNull(),
    /** Machine-readable angle tag, e.g. 'proof-first' — this is what the A/B learner scores. */
    angle: text('angle'),
    channel: text('channel').notNull().default('email'),

    subject: text('subject'),
    body: text('body').notNull(),

    /** The specific personalization hook Claude latched onto. Learned-from. */
    personalizationHook: text('personalization_hook'),

    /** draft | sent | replied */
    status: text('status').notNull().default('draft'),

    batchId: uuid('batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('outreach_lead_idx').on(t.leadId),
    index('outreach_angle_idx').on(t.angle),
    index('outreach_batch_idx').on(t.batchId),
  ],
);

/** Drives the weekly city+niche rotation. */
export const nicheRuns = pgTable(
  'niche_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    city: text('city').notNull(),
    niche: text('niche').notNull(),

    sentCount: integer('sent_count').notNull().default(0),
    weekCap: integer('week_cap').notNull().default(250),
    dailyTarget: integer('daily_target').notNull().default(50),

    isActive: boolean('is_active').notNull().default(false),
    exhausted: boolean('exhausted').notNull().default(false),
    /** Consecutive days the scrape came up short — 2 in a row marks the niche exhausted. */
    shortDays: integer('short_days').notNull().default(0),

    /** Position in the configured queue, so rotation is deterministic. */
    queueIndex: integer('queue_index'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('niche_runs_city_niche_uniq').on(t.city, t.niche),
    index('niche_runs_active_idx').on(t.isActive),
  ],
);

/** Reply-tracking loop (§10). */
export const replies = pgTable(
  'replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),

    /** Which drafted variant the reply is attributed to — the A/B signal. */
    outreachId: uuid('outreach_id').references(() => outreach.id, { onDelete: 'set null' }),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    fromEmail: text('from_email'),
    subject: text('subject'),
    snippet: text('snippet'),

    /** positive | neutral | negative | unsubscribe — classified by Claude, feeds learning. */
    sentiment: text('sentiment'),

    /** Idempotency key so an hourly IMAP sweep can't double-insert. */
    messageId: text('message_id'),

    handled: boolean('handled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replies_message_id_uniq').on(t.messageId),
    index('replies_lead_idx').on(t.leadId),
  ],
);

/** Self-healing canary log (Phase 0). */
export const scraperHealth = pgTable(
  'scraper_health',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runDate: date('run_date').notNull(),
    /** 'gmaps' | 'website' | 'socials' | 'db' | 'llm' | 'email' */
    source: text('source').notNull(),
    ok: boolean('ok').notNull(),
    found: integer('found'),
    expected: integer('expected'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('scraper_health_date_idx').on(t.runDate, t.source)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * MEMORY + LEARNING TABLES
 *
 * This is what makes Hermes an agent rather than a cron job. Every run is
 * recorded, every outcome is attributed back to the decision that caused it,
 * and the conclusions are written back as memory that seeds the next run's
 * prompts and weights.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One row per job execution. The episodic spine of Hermes' memory. */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'daily' | 'reply-check' | 'reflect' | 'health' */
    job: text('job').notNull(),

    city: text('city'),
    niche: text('niche'),
    batchId: uuid('batch_id'),

    /** running | success | partial | failed | aborted */
    status: text('status').notNull().default('running'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    /** Per-phase counters: scraped, deduped, enriched, audited, delivered, tokens, cost… */
    metrics: jsonb('metrics').$type<RunMetrics>(),
    /** Ordered phase log — what happened, in order, with timings. */
    phaseLog: jsonb('phase_log').$type<PhaseLogEntry[]>(),

    error: text('error'),
    /** Claude's own post-run narrative, written by the reflection pass. */
    reflection: text('reflection'),
  },
  (t) => [index('agent_runs_job_idx').on(t.job, t.startedAt), index('agent_runs_batch_idx').on(t.batchId)],
);

/**
 * Hermes' long-term memory: durable lessons, observations and preferences.
 *
 * Retrieval is scope-first (global → city → niche → lead), then by confidence.
 * Entries decay: unreinforced memories lose confidence over time so a lesson
 * that stops being true stops being repeated.
 */
export const agentMemory = pgTable(
  'agent_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** lesson | observation | fact | preference | failure */
    kind: text('kind').notNull(),
    /** global | city | niche | lead | scraper */
    scope: text('scope').notNull().default('global'),
    /** e.g. 'New York City', 'dentists', 'New York City::dentists', a lead id */
    scopeKey: text('scope_key'),

    /** Short, imperative, self-contained. This text is injected into prompts verbatim. */
    content: text('content').notNull(),
    /** Stable dedup key so the same lesson reinforces instead of duplicating. */
    contentHash: text('content_hash').notNull(),

    /** 0–1. Rises with corroboration, decays with age and with contradiction. */
    confidence: real('confidence').notNull().default(0.5),
    /** How many independent runs/outcomes support this. */
    evidenceCount: integer('evidence_count').notNull().default(1),

    /** Free-form tags for retrieval, e.g. ['pitch','subject-line']. */
    tags: jsonb('tags').$type<string[]>(),
    /** Structured backing data (counts, rates) so a lesson can be re-derived. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),

    sourceRunId: uuid('source_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),

    /** Retired memories stay for the audit trail but are never retrieved. */
    active: boolean('active').notNull().default(true),
    supersededBy: uuid('superseded_by'),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_memory_hash_uniq').on(t.contentHash),
    index('agent_memory_scope_idx').on(t.scope, t.scopeKey, t.active),
    index('agent_memory_kind_idx').on(t.kind, t.active),
  ],
);

/**
 * A/B pitch learning. One row per (angle × niche) bucket, updated as replies land.
 * The pitch prompt reads the winners and is told to lean into them.
 */
export const pitchPerformance = pgTable(
  'pitch_performance',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    angle: text('angle').notNull(),
    variant: text('variant'),
    niche: text('niche'),
    city: text('city'),

    sentCount: integer('sent_count').notNull().default(0),
    replyCount: integer('reply_count').notNull().default(0),
    positiveCount: integer('positive_count').notNull().default(0),
    negativeCount: integer('negative_count').notNull().default(0),

    /** replyCount / sentCount, materialized for cheap ranking. */
    replyRate: real('reply_rate').notNull().default(0),

    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    lastReplyAt: timestamp('last_reply_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pitch_perf_bucket_uniq').on(t.angle, t.niche, t.city),
    index('pitch_perf_rate_idx').on(t.replyRate),
  ],
);

/**
 * Versioned scoring weights. Hermes tunes these against actual reply outcomes,
 * keeps the version that performs, and can roll back to any prior vector.
 */
export const scoreWeights = pgTable(
  'score_weights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version: integer('version').notNull(),

    /** signal name → weight */
    weights: jsonb('weights').$type<Record<string, number>>().notNull(),

    isActive: boolean('is_active').notNull().default(false),

    /** Outcome stats accumulated while this version was live. */
    leadsScored: integer('leads_scored').notNull().default(0),
    leadsSent: integer('leads_sent').notNull().default(0),
    repliesSeen: integer('replies_seen').notNull().default(0),
    /** Rank-correlation between predicted score and actual reply. Higher = better calibrated. */
    calibration: real('calibration'),

    rationale: text('rationale'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('score_weights_version_uniq').on(t.version), index('score_weights_active_idx').on(t.isActive)],
);

/**
 * Scraper self-healing memory. Selectors that worked are remembered and tried
 * first next run; when the Google Maps DOM shifts, Hermes rediscovers a working
 * selector and writes it back here instead of just failing.
 */
export const selectorMemory = pgTable(
  'selector_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** 'gmaps' | 'website' */
    source: text('source').notNull(),
    /** Logical field: 'resultCard' | 'name' | 'rating' | 'website' … */
    field: text('field').notNull(),
    selector: text('selector').notNull(),

    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastFailAt: timestamp('last_fail_at', { withTimezone: true }),

    /** true when Claude discovered it from page HTML rather than shipping in the code. */
    learned: boolean('learned').notNull().default(false),
    active: boolean('active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('selector_memory_uniq').on(t.source, t.field, t.selector),
    index('selector_memory_lookup_idx').on(t.source, t.field, t.active),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * SHARED TYPES
 * ──────────────────────────────────────────────────────────────────────────── */

export type LeadAudit = {
  strengths: string[];
  weaknesses: string[];
  serviceFit: string[];
  /** Anything specific enough to open a pitch with. */
  personalizationHooks?: string[];
  summary?: string;
};

export type RunMetrics = {
  scraped?: number;
  afterDedup?: number;
  enriched?: number;
  audited?: number;
  delivered?: number;
  widenedSearches?: number;
  memoriesInjected?: number;
  memoriesWritten?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  [k: string]: number | undefined;
};

export type PhaseLogEntry = {
  phase: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  ms: number;
  note?: string;
};

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Outreach = typeof outreach.$inferSelect;
export type NewOutreach = typeof outreach.$inferInsert;
export type NicheRun = typeof nicheRuns.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type MemoryEntry = typeof agentMemory.$inferSelect;
export type NewMemoryEntry = typeof agentMemory.$inferInsert;
export type ScoreWeightsRow = typeof scoreWeights.$inferSelect;
