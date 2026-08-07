import type { LeadAudit } from '../db/schema.js';
import type { WorkingLead } from './types.js';
import { tryAskJson } from '../core/anthropic.js';
import { personaPreamble, memoryBlock } from '../core/persona.js';
import { recallText } from '../memory/memory.js';
import { log } from '../core/logger.js';

/**
 * Phase 5 — audit each lead with Claude (Haiku, bulk tier).
 *
 * Returns structured JSON: strengths, weaknesses, and — the part that earns its
 * keep — where Marvin's services fit, across *all* of them (web, video/clipping,
 * social, ordering), not just websites. Memory from prior runs is injected so
 * Hermes applies lessons like "dentists here always have a site but it's dated"
 * instead of rediscovering them every day.
 */

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    strengths: { type: 'array', items: { type: 'string' }, description: "What this business has going for it." },
    weaknesses: { type: 'array', items: { type: 'string' }, description: 'Concrete, visible problems.' },
    serviceFit: {
      type: 'array',
      items: { type: 'string' },
      description: "Which of Marvin's services fit, each as a short phrase naming the service and the gap.",
    },
    personalizationHooks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific details a pitch could open with so it never reads like a template.',
    },
    summary: { type: 'string', description: 'One sentence: the single best reason to reach out.' },
  },
  required: ['strengths', 'weaknesses', 'serviceFit', 'personalizationHooks', 'summary'],
} as const;

export async function auditAll(leads: WorkingLead[], city: string, niche: string): Promise<WorkingLead[]> {
  const lessons = await recallText({ city, niche, kinds: ['lesson', 'observation'], tags: ['audit'], limit: 8 });
  const system = `${personaPreamble()}\n\n${memoryBlock(lessons)}\n\nYou are auditing a business as a sales-fit assessment. Judge only on the data given. Never invent facts.`;

  let audited = 0;
  // Modest concurrency so we don't hammer the API; Haiku is fast and cheap.
  const queue = [...leads];
  const out: WorkingLead[] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const lead = queue.shift();
      if (!lead) return;
      const audit = await auditOne(lead, system);
      if (audit) audited++;
      out.push({ ...lead, audit: audit ?? undefined });
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));

  log.info(`audited ${audited}/${leads.length} leads`);
  return out;
}

async function auditOne(lead: WorkingLead, system: string): Promise<LeadAudit | null> {
  const e = lead.enrichment;
  const profile = [
    `Name: ${lead.name}`,
    `City / niche: ${lead.city} / ${lead.niche}`,
    `Rating: ${lead.rating ?? 'unknown'} from ${lead.reviewsCount ?? 'unknown'} reviews`,
    `Website: ${lead.website ?? 'NONE FOUND'}`,
    `Email: ${e?.email ?? 'none'}  |  WhatsApp: ${e?.whatsapp ?? 'none'}`,
    `Instagram: ${e?.instagram ?? 'none'}  |  Facebook: ${e?.facebook ?? 'none'}`,
    `Site signals: ${e?.siteSignals?.join(', ') || 'n/a'}`,
    e?.siteExcerpt ? `Site text (excerpt): ${e.siteExcerpt}` : 'Site text: none available',
  ].join('\n');

  return tryAskJson<LeadAudit>({
    tier: 'bulk',
    label: `audit:${lead.name.slice(0, 24)}`,
    system,
    schema: AUDIT_SCHEMA,
    maxTokens: 1200,
    user:
      `Audit this ${lead.niche} business for sales fit. Flag every one of Marvin's services that fits ` +
      `(a missing or broken website, no online ordering, a weak or stale Instagram that video/clipping could fix, ` +
      `no social presence, etc.) — not just websites.\n\n${profile}`,
  });
}
