import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment contract. Parsed once, at import time, so a misconfigured run
 * dies immediately with a readable message instead of halfway through a scrape.
 */
const EnvSchema = z
  .object({
    // ── Database ───────────────────────────────────────────────────────────
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Supabase → Database → Connection string)'),
    SUPABASE_URL: z.string().optional(),
    SUPABASE_SERVICE_KEY: z.string().optional(),

    // ── LLM (the one thing that is paid on day one, by design) ─────────────
    ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
    /**
     * Cheap bulk model: audits, reply classification, memory maintenance.
     * §12 of the master prompt: "Haiku for cheap bulk". $1/$5 per MTok.
     */
    ANTHROPIC_BULK_MODEL: z.string().default('claude-haiku-4-5'),
    /**
     * Quality model: outreach copy and the reflection write-up.
     * §12: "Sonnet optional for pitch quality". $3/$15 per MTok.
     */
    ANTHROPIC_PITCH_MODEL: z.string().default('claude-sonnet-5'),

    // ── Email delivery ─────────────────────────────────────────────────────
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Hermes <onboarding@resend.dev>'),
    EMAIL_TO: z.string().min(1, 'EMAIL_TO is required'),

    // SMTP fallback (Gmail app password) when Resend is not configured.
    SMTP_HOST: z.string().default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().default(465),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    // ── Reply tracking (IMAP) ──────────────────────────────────────────────
    IMAP_HOST: z.string().default('imap.gmail.com'),
    IMAP_PORT: z.coerce.number().default(993),
    IMAP_USER: z.string().optional(),
    IMAP_PASS: z.string().optional(),

    // ── Behaviour knobs ────────────────────────────────────────────────────
    TZ: z.string().default('America/La_Paz'),
    DAILY_TARGET: z.coerce.number().int().positive().default(50),
    WEEK_CAP: z.coerce.number().int().positive().default(250),
    SCRAPE_OVERSHOOT: z.coerce.number().positive().default(2.0),
    PREVIEW_TOP_N: z.coerce.number().int().nonnegative().default(5),

    /** Skip the browser + LLM calls; useful for wiring tests. */
    DRY_RUN: z
      .string()
      .optional()
      .transform((v) => v === '1' || v?.toLowerCase() === 'true'),
    /** Write the xlsx to disk but don't email it. */
    NO_EMAIL: z
      .string()
      .optional()
      .transform((v) => v === '1' || v?.toLowerCase() === 'true'),
    /** Turn the learning loop off (scores/pitches use shipped defaults only). */
    DISABLE_LEARNING: z
      .string()
      .optional()
      .transform((v) => v === '1' || v?.toLowerCase() === 'true'),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    OUT_DIR: z.string().default('./out'),
  })
  .transform((e) => ({
    ...e,
    DRY_RUN: e.DRY_RUN ?? false,
    NO_EMAIL: e.NO_EMAIL ?? false,
    DISABLE_LEARNING: e.DISABLE_LEARNING ?? false,
  }));

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment.\n${issues}\n\nSee hermes/.env.example.`);
  }
  return parsed.data;
}

export const env: Env = parseEnv();

/** True when a real email transport is configured. */
export function hasEmailTransport(): boolean {
  return Boolean(env.RESEND_API_KEY || (env.SMTP_USER && env.SMTP_PASS));
}

/** True when the IMAP reply-check job can run. */
export function hasImap(): boolean {
  return Boolean(env.IMAP_USER && env.IMAP_PASS);
}
