import { db, pingDb } from '../db/client.js';
import { scraperHealth } from '../db/schema.js';
import { pingLlm } from '../core/llm.js';
import { scrapeGoogleMaps } from './02-scrape.js';
import { localDate } from '../core/config.js';
import { hasEmailTransport } from '../core/env.js';
import { log } from '../core/logger.js';

/**
 * Phase 0 — health check + canary (master prompt §7 Phase 0).
 *
 * This is the self-healing guarantee: if the scrapers are down, Hermes aborts
 * and emails an alert rather than quietly delivering 8 leads. A tiny canary
 * scrape is the real test — env vars and DB connectivity are necessary but not
 * sufficient, because Maps can break while everything else is fine.
 */

export type HealthReport = {
  ok: boolean;
  db: boolean;
  llm: boolean;
  email: boolean;
  canaryFound: number;
  reasons: string[];
};

/** Expected minimum for the canary to count as "scrapers up". */
const CANARY_EXPECTED = 3;

export async function healthCheck(opts: { runCanary: boolean } = { runCanary: true }): Promise<HealthReport> {
  const reasons: string[] = [];
  const runDate = localDate();

  const dbOk = await pingDb();
  if (!dbOk) reasons.push('Supabase/Postgres unreachable');
  await logHealth(runDate, 'db', dbOk, null, null, dbOk ? 'ok' : 'ping failed');

  const llmOk = await pingLlm();
  if (!llmOk) reasons.push('Anthropic API canary failed');
  await logHealth(runDate, 'llm', llmOk, null, null, llmOk ? 'ok' : 'ping failed');

  const emailOk = hasEmailTransport();
  if (!emailOk) reasons.push('no email transport configured (Resend or SMTP)');

  // The load-bearing check: can we actually scrape right now?
  let canaryFound = 0;
  if (opts.runCanary && dbOk) {
    try {
      const canary = await scrapeGoogleMaps({
        city: 'New York City',
        niche: 'coffee shops',
        want: 5,
        timeoutMs: 90_000,
      });
      canaryFound = canary.length;
    } catch (err) {
      reasons.push(`canary scrape threw: ${(err as Error).message}`);
    }
    const scrapeOk = canaryFound >= CANARY_EXPECTED;
    if (!scrapeOk) reasons.push(`canary scrape returned ${canaryFound} (< ${CANARY_EXPECTED}) — scrapers likely down`);
    await logHealth(runDate, 'gmaps', scrapeOk, canaryFound, CANARY_EXPECTED, scrapeOk ? 'ok' : 'below threshold');
  }

  // A run is viable if the DB, the LLM, and the scraper all work. Email being
  // down degrades to "sheet on disk" rather than aborting.
  const scrapeViable = !opts.runCanary || canaryFound >= CANARY_EXPECTED;
  const ok = dbOk && llmOk && scrapeViable;

  return { ok, db: dbOk, llm: llmOk, email: emailOk, canaryFound, reasons };
}

async function logHealth(
  runDate: string,
  source: string,
  ok: boolean,
  found: number | null,
  expected: number | null,
  note: string,
): Promise<void> {
  await db.insert(scraperHealth).values({ runDate, source, ok, found, expected, note }).catch((err) => {
    log.debug(`could not log health row: ${(err as Error).message}`);
  });
}
