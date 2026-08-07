import { chromium, type Browser, type Page } from 'playwright';
import type { Candidate } from './types.js';
import { selectorsFor, selectorWorked, selectorFailed } from './selectors.js';
import { log } from '../core/logger.js';

/**
 * Phase 2 — scrape Google Maps for "{niche} in {city}".
 *
 * Free path (master prompt §6): Playwright-driven headless Chromium, realistic
 * UA, randomized delays, a scroll loop to load enough cards, then read each
 * business off the detail panel. Selectors come from `selectors.ts` so a DOM
 * shift heals instead of hard-failing.
 *
 * // PAID-UPGRADE: swap this whole module for the Apify Google Maps Scraper
 * // actor or the Google Places API the moment free scraping gets rate-limited
 * // or the DOM breaks often enough to hurt. Both return the same Candidate
 * // shape, so only this file changes. ~cents per run.
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

export type ScrapeOptions = {
  city: string;
  niche: string;
  /** Total number of candidates to try to collect (target × overshoot). */
  want: number;
  /** Overrides the search phrase; used by the widening step. */
  searchPhrase?: string;
  /** Hard ceiling on wall-clock time, so a stuck scrape can't hang the job. */
  timeoutMs?: number;
};

export async function scrapeGoogleMaps(opts: ScrapeOptions): Promise<Candidate[]> {
  const phrase = opts.searchPhrase ?? `${opts.niche} in ${opts.city}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 4 * 60 * 1000);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      userAgent: pick(USER_AGENTS),
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    const url = `https://www.google.com/maps/search/${encodeURIComponent(phrase)}?hl=en`;
    log.debug(`scraping: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await dismissConsent(page);

    const cardLinks = await collectCardLinks(page, opts.want, deadline);
    log.info(`found ${cardLinks.length} listings for "${phrase}"`);

    const out: Candidate[] = [];
    for (const href of cardLinks) {
      if (Date.now() > deadline) {
        log.warn('scrape deadline hit — returning what we have');
        break;
      }
      const candidate = await scrapeDetail(page, href, opts.city, opts.niche);
      if (candidate) out.push(candidate);
      await sleep(rand(400, 1100)); // be a good citizen
    }
    return out;
  } finally {
    await browser?.close();
  }
}

/** Google's cookie/consent interstitial, when it appears. */
async function dismissConsent(page: Page): Promise<void> {
  for (const sel of ['button[aria-label*="Accept all"]', 'button[aria-label*="Reject all"]', 'form[action*="consent"] button']) {
    const btn = page.locator(sel).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await sleep(600);
      return;
    }
  }
}

/**
 * Scroll the result feed, collecting unique listing links until we have enough
 * or the feed stops growing.
 */
async function collectCardLinks(page: Page, want: number, deadline: number): Promise<string[]> {
  const feedSelectors = await selectorsFor('resultFeed');
  const feed = await firstMatching(page, feedSelectors, 'resultFeed');
  if (!feed) {
    log.warn('no result feed found — Maps layout may have changed');
    return [];
  }

  const links = new Set<string>();
  let stalls = 0;

  while (links.size < want && stalls < 4 && Date.now() < deadline) {
    const hrefs = await page.$$eval('a.hfpxzc, div[role="feed"] a[href*="/maps/place/"]', (els) =>
      els.map((e) => (e as HTMLAnchorElement).href).filter((h) => h.includes('/maps/place/')),
    );
    const before = links.size;
    for (const h of hrefs) links.add(h);

    if (links.size === before) stalls++;
    else stalls = 0;

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTop = el.scrollHeight;
    }, feedSelectors[0] ?? 'div[role="feed"]');
    await sleep(rand(700, 1400));
  }

  return [...links].slice(0, want);
}

/** Open a listing and read the business off the detail panel. */
async function scrapeDetail(page: Page, href: string, city: string, niche: string): Promise<Candidate | null> {
  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(rand(500, 1000));

    const name = await readField(page, 'name');
    if (!name) return null; // no name = not a real listing

    const ratingText = await readField(page, 'rating');
    const reviewsText = await readField(page, 'reviews');
    const website = await readAttr(page, 'website', 'href');
    const phoneRaw = await readAttr(page, 'phone', 'aria-label');
    const addressRaw = await readAttr(page, 'address', 'aria-label');

    return {
      placeId: extractPlaceId(page.url()),
      name,
      address: cleanLabel(addressRaw, 'Address:'),
      phone: cleanLabel(phoneRaw, 'Phone:'),
      website: website && !website.includes('google.com') ? website : null,
      rating: ratingText ? Number.parseFloat(ratingText.replace(',', '.')) || null : null,
      reviewsCount: reviewsText ? parseReviewCount(reviewsText) : null,
      sourceUrl: page.url(),
      city,
      niche,
      raw: { name, ratingText, reviewsText, scrapedAt: new Date().toISOString() },
    };
  } catch (err) {
    log.debug(`detail scrape failed for ${href.slice(0, 60)}: ${(err as Error).message}`);
    return null;
  }
}

/** Try each selector for a field; record which worked so it's tried first next time. */
async function readField(page: Page, field: string): Promise<string | null> {
  const selectors = await selectorsFor(field);
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        const text = (await loc.textContent({ timeout: 2000 }))?.trim();
        if (text) {
          await selectorWorked(field, sel);
          return text;
        }
      }
      await selectorFailed(field, sel);
    } catch {
      await selectorFailed(field, sel);
    }
  }
  return null;
}

async function readAttr(page: Page, field: string, attr: string): Promise<string | null> {
  const selectors = await selectorsFor(field);
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        const val = await loc.getAttribute(attr, { timeout: 2000 });
        if (val) {
          await selectorWorked(field, sel);
          return val;
        }
      }
      await selectorFailed(field, sel);
    } catch {
      await selectorFailed(field, sel);
    }
  }
  return null;
}

async function firstMatching(page: Page, selectors: string[], field: string): Promise<string | null> {
  for (const sel of selectors) {
    if (await page.locator(sel).first().count().catch(() => 0)) {
      await selectorWorked(field, sel);
      return sel;
    }
  }
  return null;
}

/** place_id is the dedup gold standard; parse it out of the listing URL. */
function extractPlaceId(url: string): string | null {
  const hex = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  if (hex) return hex[1]!;
  const cid = url.match(/!19s([^!?]+)/);
  if (cid) return decodeURIComponent(cid[1]!);
  return null;
}

function cleanLabel(raw: string | null, prefix: string): string | null {
  if (!raw) return null;
  return raw.replace(prefix, '').trim() || null;
}

function parseReviewCount(text: string): number | null {
  const m = text.replace(/[(),.]/g, '').match(/\d+/);
  return m ? Number.parseInt(m[0]!, 10) : null;
}
