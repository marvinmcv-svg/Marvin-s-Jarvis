import * as cheerio from 'cheerio';
import type { Candidate, Enrichment, WorkingLead } from './types.js';
import { log } from '../core/logger.js';

/**
 * Phase 4 — fill contact gaps from the business's own website.
 *
 * Free path (master prompt §6): fetch the site, parse with Cheerio for
 * `mailto:`, `tel:`, `wa.me`/WhatsApp links and footer social icons. Prioritize
 * WhatsApp — dig the page even when Maps had a phone. No login-wall defeating.
 *
 * // PAID-UPGRADE: deep LinkedIn / socials enrichment needs an Apify LinkedIn
 * // actor — LinkedIn blocks scraping and the free path only gets you the handle
 * // if it's linked from the site. Don't pretend free gets deep LinkedIn data.
 */

const FETCH_TIMEOUT_MS = 12_000;
const MAX_CONCURRENCY = 5;

export async function enrichAll(leads: Array<Candidate & { dedupHash: string }>): Promise<WorkingLead[]> {
  const out: WorkingLead[] = [];
  // Bounded concurrency — a pool of workers draining a shared queue.
  const queue = [...leads];
  let enriched = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const lead = queue.shift();
      if (!lead) return;
      const enrichment = await enrichOne(lead);
      out.push({ ...lead, enrichment });
      if (enrichment.email || enrichment.whatsapp || enrichment.instagram) enriched++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, leads.length) }, worker));
  log.info(`enriched ${leads.length} leads — found new contact channels on ${enriched}`);
  return out;
}

async function enrichOne(lead: Candidate): Promise<Enrichment> {
  const empty: Enrichment = {
    email: null,
    whatsapp: normalizeWhatsapp(lead.phone),
    instagram: null,
    facebook: null,
    linkedin: null,
    otherSocials: [],
    siteSignals: [],
    siteExcerpt: null,
  };

  if (!lead.website) return empty;

  const html = await fetchHtml(lead.website);
  if (!html) return empty;

  const $ = cheerio.load(html);
  const signals: string[] = [];

  // ── Contact channels ─────────────────────────────────────────────────────
  let email: string | null = null;
  let whatsapp: string | null = empty.whatsapp;
  const socials: Record<string, string> = {};

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;

    if (href.startsWith('mailto:') && !email) {
      const addr = href.slice(7).split('?')[0]!.trim();
      if (isPlausibleEmail(addr)) email = addr.toLowerCase();
    } else if (/wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//.test(href)) {
      whatsapp = extractWhatsapp(href) ?? whatsapp;
    } else if (/instagram\.com\//.test(href)) {
      socials.instagram ??= cleanSocialUrl(href);
    } else if (/facebook\.com\//.test(href)) {
      socials.facebook ??= cleanSocialUrl(href);
    } else if (/linkedin\.com\//.test(href)) {
      socials.linkedin ??= cleanSocialUrl(href);
    } else if (/(twitter|x)\.com\/|tiktok\.com\/|youtube\.com\//.test(href)) {
      const platform = href.includes('tiktok') ? 'tiktok' : href.includes('youtube') ? 'youtube' : 'x';
      socials[platform] ??= cleanSocialUrl(href);
    }
  });

  // Fallback: scrape a visible email out of the page text if none was linked.
  if (!email) {
    const m = $.text().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    if (m && isPlausibleEmail(m[0])) email = m[0].toLowerCase();
  }

  // ── Site-quality signals for the auditor ────────────────────────────────
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const lower = bodyText.toLowerCase();
  const hasViewport = $('meta[name="viewport"]').length > 0;
  if (!hasViewport) signals.push('no-mobile-viewport');
  if (/order online|order now|add to cart|checkout|reserv|book (a )?table|book now|schedule/i.test(lower)) {
    signals.push('has-ordering-or-booking');
  } else {
    signals.push('no-online-ordering');
  }
  if (!socials.instagram) signals.push('no-instagram-link');
  if (bodyText.length < 400) signals.push('very-thin-site');
  if ($('img').length === 0) signals.push('no-images');
  if (/copyright.{0,8}(19|20)[0-2]\d/i.test(lower) && !lower.includes('2025') && !lower.includes('2026')) {
    signals.push('stale-copyright');
  }

  const known: Record<string, string> = { instagram: 'instagram', facebook: 'facebook', linkedin: 'linkedin' };
  const otherSocials = Object.entries(socials)
    .filter(([p]) => !known[p])
    .map(([platform, url]) => ({ platform, url }));

  return {
    email,
    whatsapp,
    instagram: socials.instagram ?? null,
    facebook: socials.facebook ?? null,
    linkedin: socials.linkedin ?? null,
    otherSocials,
    siteSignals: signals,
    siteExcerpt: bodyText.slice(0, 1200) || null,
  };
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(normalizeUrl(url), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) return null;
    // Cap the body so a giant page can't blow memory.
    const text = await res.text();
    return text.slice(0, 500_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

function isPlausibleEmail(addr: string): boolean {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(addr)) return false;
  // Drop the common junk: image filenames, sentry/wix noise.
  return !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(addr) && !/sentry|example\.com|wixpress/i.test(addr);
}

function normalizeWhatsapp(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.length >= 8 ? digits : null;
}

function extractWhatsapp(href: string): string | null {
  const m = href.match(/(?:wa\.me\/|phone=)(\+?\d{6,15})/);
  return m ? (m[1]!.startsWith('+') ? m[1]! : `+${m[1]!}`) : null;
}

function cleanSocialUrl(href: string): string {
  try {
    const u = new URL(normalizeUrl(href));
    return `${u.origin}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return href;
  }
}
