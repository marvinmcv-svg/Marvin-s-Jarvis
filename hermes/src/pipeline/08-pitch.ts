import type { PitchDraft, ScoredLead } from './types.js';
import type { Scored } from './06-score.js';
import { tryAskJson } from '../core/anthropic.js';
import { personaPreamble, memoryBlock } from '../core/persona.js';
import { recallText } from '../memory/memory.js';
import { pitchGuidance, preferredAngles, isPitchAngle } from '../memory/playbook.js';
import { log } from '../core/logger.js';

/**
 * Phase 8 — draft two personalized outreach variants per lead (Claude, Sonnet).
 *
 * The two variants use *different angles* so Marvin learns what pulls replies
 * (master prompt level-up feature #6). Which angles Claude reaches for is biased
 * by `playbook.ts` — the angles that earned replies in past weeks are surfaced
 * as guidance, so the A/B test compounds instead of restarting every day.
 *
 * Every pitch is a DRAFT. Nothing here sends anything (§7 Phase 8).
 */

const PITCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    variants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variant: { type: 'string', enum: ['A', 'B'] },
          angle: {
            type: 'string',
            enum: ['proof-first', 'problem-spot', 'social-proof', 'missed-revenue', 'competitor-gap', 'quick-win'],
          },
          subject: { type: 'string' },
          body: { type: 'string' },
          personalizationHook: { type: 'string', description: 'The specific detail this pitch opens on.' },
        },
        required: ['variant', 'angle', 'subject', 'body', 'personalizationHook'],
      },
    },
  },
  required: ['variants'],
} as const;

type PitchResponse = { variants: PitchDraft[] };

export async function draftAll(leads: Scored[], city: string, niche: string): Promise<ScoredLead[]> {
  const [lessons, guidance, angleOrder] = await Promise.all([
    recallText({ city, niche, tags: ['pitch'], kinds: ['lesson', 'preference'], limit: 8 }),
    pitchGuidance(niche),
    preferredAngles(niche),
  ]);

  const system = [
    personaPreamble(),
    '',
    memoryBlock(lessons),
    '',
    guidance,
    '',
    'You write cold outreach that never reads like a template. Every message opens on something specific and true ' +
      'about THIS business — a recent detail, a weakness the audit found, a bad review, their actual name. ' +
      'The core offer is always the same: Marvin has already built them a FREE preview website; here is the link, ' +
      'no obligation; if they like it, they can talk about making it theirs. Keep it short, human, and easy to reply to. ' +
      'Never fabricate details. Never promise anything beyond the free preview.',
  ].join('\n');

  const queue = [...leads];
  const out: ScoredLead[] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const lead = queue.shift();
      if (!lead) return;
      const pitches = await draftOne(lead, system, angleOrder);
      out.push({
        ...lead,
        audit: lead.audit ?? { strengths: [], weaknesses: [], serviceFit: [] },
        pitches,
      });
    }
  }
  // Sonnet is pricier and slower — keep concurrency lower than the audit pass.
  await Promise.all(Array.from({ length: 3 }, worker));

  // Preserve the score ranking the sheet depends on.
  out.sort((a, b) => b.qualityScore - a.qualityScore);
  const withPitches = out.filter((l) => l.pitches.length > 0).length;
  log.info(`drafted A/B pitches for ${withPitches}/${leads.length} leads`);
  return out;
}

async function draftOne(lead: Scored, system: string, angleOrder: string[]): Promise<PitchDraft[]> {
  const audit = lead.audit;
  const hooks = audit?.personalizationHooks?.length
    ? audit.personalizationHooks.join('; ')
    : audit?.summary ?? 'no specific hook found — use their name and niche';

  const profile = [
    `Business: ${lead.name} (${lead.niche} in ${lead.city})`,
    `Rating: ${lead.rating ?? '?'} / ${lead.reviewsCount ?? '?'} reviews`,
    `Website: ${lead.website ?? 'NONE — big opening for the free preview'}`,
    `Fits for Marvin's services: ${audit?.serviceFit?.join('; ') || 'general web presence'}`,
    `Weaknesses found: ${audit?.weaknesses?.join('; ') || 'n/a'}`,
    `Personalization hooks: ${hooks}`,
    `Reply-channel: ${lead.enrichment?.email ? 'email' : lead.enrichment?.whatsapp ? 'whatsapp' : 'unknown'}`,
  ].join('\n');

  const res = await tryAskJson<PitchResponse>({
    tier: 'quality',
    label: `pitch:${lead.name.slice(0, 24)}`,
    system,
    schema: PITCH_SCHEMA,
    maxTokens: 1400,
    user:
      `Write TWO outreach variants (A and B) for this lead, each using a DIFFERENT angle. ` +
      `Given what's worked lately, prefer angles from the front of this list but pick what genuinely fits: ${angleOrder.join(', ')}.\n\n` +
      `${profile}\n\n` +
      `Each variant: a short subject line and a 4–7 sentence body. Open on the specific hook, name the free preview site, ` +
      `and end with one low-friction question.`,
  });

  if (!res?.variants?.length) return [];

  // Guard the enum in case the model returns an off-list angle.
  return res.variants
    .filter((v) => v.variant === 'A' || v.variant === 'B')
    .map((v) => ({ ...v, angle: isPitchAngle(v.angle) ? v.angle : 'proof-first' }));
}
