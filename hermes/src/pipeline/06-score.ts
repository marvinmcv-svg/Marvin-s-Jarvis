import type { WorkingLead } from './types.js';
import { activeWeights, type Signal, type WeightVector } from '../memory/weights.js';
import { log } from '../core/logger.js';

/**
 * Phase 6 & 7 — score each lead 0–100, rank, take the top 50.
 *
 * The score is a weighted sum of boolean signals derived from the scrape,
 * enrichment and audit. Crucially the *weights* are not hard-coded here — they
 * come from `weights.ts`, which Hermes tunes against real reply outcomes. So
 * two runs a month apart can score the same lead differently, because he has
 * learned which signals actually predict a reply.
 */

export type Scored = WorkingLead & {
  qualityScore: number;
  scoreBreakdown: Record<string, number>;
  scoreWeightsVersion: number;
};

/** Derive the boolean signal set for a lead from everything known about it. */
export function signalsFor(lead: WorkingLead): Record<Signal, boolean> {
  const e = lead.enrichment;
  const audit = lead.audit;
  const site = lead.website;
  const signals = new Set((e?.siteSignals ?? []).map((s) => s.toLowerCase()));
  const fitCount = audit?.serviceFit?.length ?? 0;
  const reviews = lead.reviewsCount ?? 0;
  const rating = lead.rating ?? 0;

  const brokenMarkers = ['no-mobile-viewport', 'very-thin-site', 'no-images', 'stale-copyright'];
  const looksBroken = brokenMarkers.some((m) => signals.has(m));

  return {
    noWebsite: !site,
    brokenSite: Boolean(site) && looksBroken,
    weakSite: Boolean(site) && !looksBroken && (signals.has('stale-copyright') || signals.has('very-thin-site')),
    noOnlineOrdering: signals.has('no-online-ordering'),
    weakSocial: Boolean(e?.instagram) && signals.has('no-instagram-link') === false && fitCount > 0 && looksSocialWeak(audit),
    noSocial: !e?.instagram && !e?.facebook,
    missingWhatsapp: !e?.whatsapp,
    hasEmail: Boolean(e?.email),
    highReviewsLowRating: reviews >= 50 && rating > 0 && rating < 4.0,
    highReviewsHighRating: reviews >= 50 && rating >= 4.5,
    lowReviewVolume: reviews > 0 && reviews < 10,
    multiServiceFit: fitCount >= 2,
  };
}

function looksSocialWeak(audit: WorkingLead['audit']): boolean {
  const fit = (audit?.serviceFit ?? []).join(' ').toLowerCase();
  const weak = (audit?.weaknesses ?? []).join(' ').toLowerCase();
  return /video|clip|instagram|social|reel|tiktok/.test(fit) || /weak.*social|stale.*(insta|social)/.test(weak);
}

/** Map a raw weighted sum onto 0–100 with a soft floor and ceiling. */
function toScore(raw: number): number {
  // Empirically the raw sum lands roughly in [-20, 110]; squash into 0–100.
  const clamped = Math.max(-20, Math.min(120, raw));
  return Math.round(((clamped + 20) / 140) * 100);
}

export async function scoreAndRank(leads: WorkingLead[], keepTop: number): Promise<Scored[]> {
  const { weights, version } = await activeWeights();

  const scored: Scored[] = leads.map((lead) => {
    const signals = signalsFor(lead);
    const breakdown: Record<string, number> = {};
    let raw = 0;

    for (const [signal, present] of Object.entries(signals)) {
      const w = weights[signal as Signal] ?? 0;
      const contribution = present ? w : 0;
      breakdown[signal] = contribution;
      raw += contribution;
    }
    // A lead with no email can't actually be contacted — floor it so it sinks.
    if (!lead.enrichment?.email && !lead.enrichment?.whatsapp && !lead.phone) raw -= 25;

    return { ...lead, qualityScore: toScore(raw), scoreBreakdown: breakdown, scoreWeightsVersion: version };
  });

  scored.sort((a, b) => b.qualityScore - a.qualityScore);
  const top = scored.slice(0, keepTop);

  log.info(
    `scored ${leads.length} with weights v${version} — keeping top ${top.length} ` +
      `(range ${top[top.length - 1]?.qualityScore ?? 0}–${top[0]?.qualityScore ?? 0})`,
  );
  return top;
}

/** Used by the reflection prompt: the weight vector, for narration. */
export function describeWeights(w: WeightVector): string {
  return Object.entries(w)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}
