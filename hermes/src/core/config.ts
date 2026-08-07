import { env } from './env.js';
import { QUEUE, type QueueEntry } from '../../config/targets.js';

/**
 * Runtime config: the env knobs plus the niche queue.
 *
 * Env wins over the file so a one-off run can be retargeted without editing
 * (and committing) `config/targets.ts`.
 */
export type HermesConfig = {
  timezone: string;
  deliverAt: string;
  emailTo: string;
  dailyTarget: number;
  weekCap: number;
  /** Scrape this multiple of the target so dedup + enrichment losses still leave 50. */
  scrapeOvershoot: number;
  /** How many top leads get flagged for a preview-site build. */
  previewTopN: number;
  queue: QueueEntry[];
};

export function loadConfig(): HermesConfig {
  if (QUEUE.length === 0) {
    throw new Error('config/targets.ts: QUEUE is empty — Hermes has nowhere to hunt.');
  }

  const seen = new Set<string>();
  for (const entry of QUEUE) {
    const key = `${entry.city}::${entry.niche}`.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`config/targets.ts: duplicate queue entry "${entry.city} / ${entry.niche}".`);
    }
    seen.add(key);
  }

  return {
    timezone: env.TZ,
    deliverAt: '10:00',
    emailTo: env.EMAIL_TO,
    dailyTarget: env.DAILY_TARGET,
    weekCap: env.WEEK_CAP,
    scrapeOvershoot: env.SCRAPE_OVERSHOOT,
    previewTopN: env.PREVIEW_TOP_N,
    queue: QUEUE,
  };
}

/** Today's date in Marvin's timezone, as YYYY-MM-DD. */
export function localDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Human date for email subjects, e.g. "Mon 3 Aug 2026". */
export function displayDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
