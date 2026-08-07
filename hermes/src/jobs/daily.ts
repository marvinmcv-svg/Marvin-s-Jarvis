import { closeDb } from '../db/client.js';
import { resetUsage } from '../core/llm.js';
import { loadConfig } from '../core/config.js';
import { log, timed } from '../core/logger.js';
import { RunRecorder } from '../memory/run.js';
import { reflectOnBatch } from '../memory/reflect.js';
import { recall } from '../memory/memory.js';

import { healthCheck } from '../pipeline/00-health.js';
import { determineTarget, incrementSent, registerShortDay, clearShortDays } from '../pipeline/01-target.js';
import { scrapeGoogleMaps } from '../pipeline/02-scrape.js';
import { dedup } from '../pipeline/03-dedup.js';
import { enrichAll } from '../pipeline/04-enrich.js';
import { auditAll } from '../pipeline/05-audit.js';
import { scoreAndRank } from '../pipeline/06-score.js';
import { draftAll } from '../pipeline/08-pitch.js';
import { persistBatch, flagForPreview } from '../pipeline/persist.js';
import { buildWorkbook } from '../pipeline/10-sheet.js';
import { sendDigest, sendAlert } from '../pipeline/11-email.js';

import type { Candidate } from '../pipeline/types.js';

/**
 * The `daily` orchestrator — wires Phases 0–12 in the exact order the master
 * prompt specifies (§7). Every phase is timed and logged into the run record,
 * and the whole thing is bracketed by a RunRecorder so the reflection pass has
 * real material to learn from.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  resetUsage();
  const recorder = await RunRecorder.start('daily');

  try {
    // ── Phase 0 — health check + canary ──────────────────────────────────
    log.phase(0, 'health check');
    const { value: health, ms: healthMs } = await timed(() => healthCheck({ runCanary: true }));
    recorder.phase('health', health.ok ? 'ok' : 'fail', healthMs, health.reasons.join('; '));

    if (!health.ok) {
      // Self-healing guarantee: abort loudly rather than under-deliver.
      const body = [
        'Hermes aborted this morning because a health check failed:',
        ...health.reasons.map((r) => `  - ${r}`),
        '',
        `db=${health.db} llm=${health.llm} email=${health.email} canary=${health.canaryFound} listings`,
      ].join('\n');
      await sendAlert('scrapers/health down — no batch delivered', body);
      recorder.metric('delivered', 0);
      await recorder.finish('aborted', { error: health.reasons.join('; ') });
      return;
    }

    // ── Phase 1 — determine today's target ───────────────────────────────
    log.phase(1, "determine today's target");
    const target = await determineTarget(cfg);
    if (!target) {
      await sendAlert('queue exhausted', 'Every city+niche in config/targets.ts is complete. Add more entries to keep Hermes running.');
      await recorder.finish('aborted', { error: 'queue exhausted' });
      return;
    }
    const { run, entry } = target;
    const city = run.city;
    const niche = run.niche;

    // Surface what Hermes remembers about this target, for the log.
    const memoryHits = await recall({ city, niche, limit: 12 });
    recorder.metric('memoriesInjected', memoryHits.length);
    if (memoryHits.length) log.memory(`recalled ${memoryHits.length} lessons for ${city}/${niche}`);

    // ── Phase 2 — scrape candidates (with widening built in) ─────────────
    log.phase(2, 'scrape candidates');
    const want = Math.ceil(run.dailyTarget * cfg.scrapeOvershoot);
    const { value: candidates, ms: scrapeMs } = await timed(() => scrapeWithWidening(city, niche, want, entry.widenWith ?? []));
    recorder.phase('scrape', candidates.length >= want * 0.5 ? 'ok' : 'warn', scrapeMs, `${candidates.length} candidates`);
    recorder.metric('scraped', candidates.length);

    // ── Phase 3 — dedup ──────────────────────────────────────────────────
    log.phase(3, 'dedup against everything ever sent');
    const { fresh, droppedExisting } = await dedup(candidates);
    recorder.metric('afterDedup', fresh.length);
    recorder.metric('droppedExisting', droppedExisting);

    if (fresh.length < run.dailyTarget) {
      const exhausted = await registerShortDay(run);
      log.warn(`only ${fresh.length} fresh leads (< ${run.dailyTarget})${exhausted ? ' — niche now marked exhausted' : ''}`);
    } else {
      await clearShortDays(run.id);
    }
    if (fresh.length === 0) {
      await sendAlert(`no fresh leads for ${niche} · ${city}`, 'Every scraped business was already in the ledger. The niche may be exhausted — it will rotate next run.');
      recorder.metric('delivered', 0);
      await recorder.finish('partial', { city, niche, error: 'no fresh leads' });
      return;
    }

    // ── Phase 4 — enrich ─────────────────────────────────────────────────
    log.phase(4, 'enrich from website + socials');
    const { value: enriched, ms: enrichMs } = await timed(() => enrichAll(fresh));
    recorder.phase('enrich', 'ok', enrichMs);
    recorder.metric('enriched', enriched.filter((l) => l.enrichment?.email || l.enrichment?.whatsapp).length);

    // ── Phase 5 — audit (Claude) ─────────────────────────────────────────
    log.phase(5, 'audit each lead (Claude)');
    const { value: audited, ms: auditMs } = await timed(() => auditAll(enriched, city, niche));
    recorder.phase('audit', 'ok', auditMs);
    recorder.metric('audited', audited.filter((l) => l.audit).length);

    // ── Phase 6 & 7 — score, rank, take top 50 ───────────────────────────
    log.phase('6–7', 'score, rank, take top 50');
    const top = await scoreAndRank(audited, run.dailyTarget);

    // ── Phase 8 — draft A/B pitches (Claude) ─────────────────────────────
    log.phase(8, 'draft A/B outreach (Claude)');
    const { value: scored, ms: pitchMs } = await timed(() => draftAll(top, city, niche));
    recorder.phase('pitch', 'ok', pitchMs);

    // ── Phase 12 (storage) — persist + mark sent ─────────────────────────
    log.phase(12, 'persist batch + log');
    const persisted = await persistBatch(scored, city, niche);
    recorder.metric('delivered', persisted.storedLeads);

    // ── Phase 9 — preview-site hook (placeholder) ────────────────────────
    log.phase(9, 'flag top leads for preview build');
    await flagForPreview(persisted.leadIds, cfg.previewTopN);

    // ── Phase 10 — spreadsheet ───────────────────────────────────────────
    log.phase(10, 'build spreadsheet');
    const sheetPath = await buildWorkbook(scored, city, niche);

    // ── Phase 11 — deliver ───────────────────────────────────────────────
    log.phase(11, 'email the digest');
    await sendDigest({ filePath: sheetPath, leads: scored, run, city, niche });

    // ── Phase 12 (rotation) — increment the weekly counter ───────────────
    await incrementSent(run.id, persisted.storedLeads);

    // ── Learning — reflect on this run and write lessons to memory ────────
    log.phase('L', 'reflect and learn');
    const { ms: reflectMs } = await timed(() => reflectOnBatch(recorder, scored, city, niche));
    recorder.phase('reflect', 'ok', reflectMs);

    await recorder.finish('success', { batchId: persisted.batchId, city, niche });
    log.ok(`morning run complete — ${persisted.storedLeads} leads delivered for ${city} / ${niche}`);
  } catch (err) {
    const message = (err as Error).stack ?? (err as Error).message;
    log.error(`daily run failed: ${message}`);
    await sendAlert('daily run crashed', message).catch(() => {});
    await recorder.finish('failed', { error: (err as Error).message });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

/**
 * Scrape the primary phrase; if that comes up short, widen into the adjacent
 * categories Marvin listed for this entry (master prompt §7 Phase 3 widening).
 */
async function scrapeWithWidening(city: string, niche: string, want: number, widenWith: string[]): Promise<Candidate[]> {
  const collected: Candidate[] = [];
  const seenKeys = new Set<string>();

  const add = (batch: Candidate[]): void => {
    for (const c of batch) {
      const key = c.placeId ?? `${c.name}|${c.address}`.toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      collected.push(c);
    }
  };

  add(await scrapeGoogleMaps({ city, niche, want }));

  // Widen only if the primary search left us short — extra searches cost time.
  let i = 0;
  while (collected.length < want && i < widenWith.length) {
    const phrase = `${widenWith[i]} in ${city}`;
    log.info(`widening search: "${phrase}" (have ${collected.length}/${want})`);
    add(await scrapeGoogleMaps({ city, niche, want: want - collected.length, searchPhrase: phrase }));
    i++;
  }

  return collected;
}

void main();
