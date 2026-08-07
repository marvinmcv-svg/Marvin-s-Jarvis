import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leads, outreach, type NewLead, type NewOutreach } from '../db/schema.js';
import type { ScoredLead } from './types.js';
import { recordSent } from '../memory/playbook.js';
import { log } from '../core/logger.js';

/**
 * Phase 12 — persist the batch and mark it sent.
 *
 * "Sent" here means "delivered to Marvin's inbox as a drafted batch", not
 * "emailed to the lead" — Hermes never contacts leads. Storing them is what
 * guarantees Marvin never sees the same lead twice (the dedup ledger).
 */

export type PersistResult = {
  batchId: string;
  leadIds: string[];
  storedLeads: number;
  storedPitches: number;
};

export async function persistBatch(scored: ScoredLead[], city: string, niche: string): Promise<PersistResult> {
  const batchId = randomUUID();
  const now = new Date();

  const leadIds: string[] = [];
  let storedPitches = 0;

  for (const lead of scored) {
    const row: NewLead = {
      placeId: lead.placeId,
      dedupHash: (lead as ScoredLead & { dedupHash: string }).dedupHash,
      name: lead.name,
      city,
      niche,
      address: lead.address,
      phone: lead.phone,
      whatsapp: lead.enrichment?.whatsapp ?? null,
      email: lead.enrichment?.email ?? null,
      website: lead.website,
      instagram: lead.enrichment?.instagram ?? null,
      facebook: lead.enrichment?.facebook ?? null,
      linkedin: lead.enrichment?.linkedin ?? null,
      otherSocials: lead.enrichment?.otherSocials ?? [],
      rating: lead.rating != null ? String(lead.rating) : null,
      reviewsCount: lead.reviewsCount,
      raw: lead.raw,
      qualityScore: lead.qualityScore,
      scoreWeightsVersion: (lead as ScoredLead & { scoreWeightsVersion?: number }).scoreWeightsVersion ?? null,
      scoreBreakdown: lead.scoreBreakdown,
      audit: lead.audit,
      status: 'sent',
      batchId,
      sentAt: now,
    };

    // Insert the lead. A dedup collision here is theoretically possible if two
    // runs raced; onConflictDoNothing makes that a skip, not a crash.
    const [inserted] = await db
      .insert(leads)
      .values(row)
      .onConflictDoNothing({ target: leads.dedupHash })
      .returning({ id: leads.id });

    if (!inserted) {
      log.debug(`skipped storing "${lead.name}" — raced dedup`);
      continue;
    }
    leadIds.push(inserted.id);

    // Store both pitch variants as drafts.
    if (lead.pitches.length) {
      const pitchRows: NewOutreach[] = lead.pitches.map((p) => ({
        leadId: inserted.id,
        variant: p.variant,
        angle: p.angle,
        channel: lead.enrichment?.email ? 'email' : 'whatsapp',
        subject: p.subject,
        body: p.body,
        personalizationHook: p.personalizationHook,
        status: 'draft',
        batchId,
      }));
      await db.insert(outreach).values(pitchRows);
      storedPitches += pitchRows.length;

      // Feed the A/B learner: every angle that went out is a "sent" for that bucket.
      for (const p of lead.pitches) {
        await recordSent(p.angle, niche, city, p.variant);
      }
    }
  }

  log.ok(`stored ${leadIds.length} leads and ${storedPitches} pitch drafts (batch ${batchId.slice(0, 8)})`);
  return { batchId, leadIds, storedLeads: leadIds.length, storedPitches };
}

/**
 * Phase 9 — flag the top N leads for Marvin's separate preview-site generator.
 *
 * This is a PLACEHOLDER seam (master prompt §9). Hermes writes the flag and the
 * data payload a generator would need, and calls `generatePreviewSite`, which
 * does nothing but log. The real generator plugs in there later — it is
 * deliberately not coupled to this agent.
 */
export async function flagForPreview(leadIds: string[], topN: number): Promise<number> {
  const chosen = leadIds.slice(0, topN);
  if (chosen.length === 0) return 0;

  const rows = await db.select().from(leads).where(inArray(leads.id, chosen));
  for (const lead of rows) {
    const payload = {
      name: lead.name,
      niche: lead.niche,
      city: lead.city,
      website: lead.website,
      phone: lead.phone ?? lead.whatsapp,
      audit: lead.audit,
    };
    await db.update(leads).set({ previewPending: true, previewPayload: payload }).where(eq(leads.id, lead.id));
    generatePreviewSite(payload);
  }

  log.info(`flagged ${chosen.length} leads for a preview-site build`);
  return chosen.length;
}

/**
 * PLACEHOLDER — Marvin's separate preview-site system plugs in here.
 *
 * Do NOT build a website generator in this project (master prompt §9). This
 * seam exists so the flag has somewhere to call; today it only logs.
 */
export function generatePreviewSite(payload: Record<string, unknown>): void {
  log.debug(`TODO: Marvin's preview system plugs in here → ${(payload as { name?: string }).name}`);
}

/** Count today's drafts, for the reflection prompt. */
export async function batchStats(batchId: string): Promise<{ leads: number; withEmail: number }> {
  const [row] = await db
    .select({
      leads: sql<number>`count(*)::int`,
      withEmail: sql<number>`count(*) filter (where ${leads.email} is not null)::int`,
    })
    .from(leads)
    .where(eq(leads.batchId, batchId));
  return row ?? { leads: 0, withEmail: 0 };
}
