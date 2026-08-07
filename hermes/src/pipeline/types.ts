import type { LeadAudit } from '../db/schema.js';

/** A raw business as pulled from Google Maps, before dedup/enrich/audit. */
export type Candidate = {
  placeId: string | null;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewsCount: number | null;
  /** The Maps listing URL — kept so a lead can be reopened for re-scraping. */
  sourceUrl: string | null;
  city: string;
  niche: string;
  raw: Record<string, unknown>;
};

/** Contact + social data discovered by the website/socials enrichment pass. */
export type Enrichment = {
  email: string | null;
  whatsapp: string | null;
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  otherSocials: Array<{ platform: string; url: string }>;
  /** Short signals the audit prompt can use: has-ordering, mobile-broken, etc. */
  siteSignals: string[];
  /** Trimmed page text, so the auditor reasons over real content not guesses. */
  siteExcerpt: string | null;
};

/** A candidate that survived dedup, ready to be enriched and audited. */
export type WorkingLead = Candidate & {
  enrichment?: Enrichment;
  audit?: LeadAudit;
  qualityScore?: number;
  scoreBreakdown?: Record<string, number>;
};

/** A fully-processed lead with its two drafted pitch variants. */
export type ScoredLead = WorkingLead & {
  qualityScore: number;
  scoreBreakdown: Record<string, number>;
  audit: LeadAudit;
  pitches: PitchDraft[];
};

export type PitchDraft = {
  variant: 'A' | 'B';
  angle: string;
  subject: string;
  body: string;
  personalizationHook: string | null;
};
