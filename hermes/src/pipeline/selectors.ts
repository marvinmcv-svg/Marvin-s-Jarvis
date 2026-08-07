import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { selectorMemory } from '../db/schema.js';
import { log } from '../core/logger.js';

/**
 * Self-healing selector memory for the scraper.
 *
 * Google Maps' DOM shifts without warning. Rather than shipping one brittle
 * selector per field, Hermes keeps a ranked list per field: the ones that
 * worked recently are tried first, and when they all fail he can discover a
 * new one from the page and write it back here so the next run is already
 * healed.
 */

/** Selectors shipped in the code — the seed list, tried if memory is empty. */
export const SHIPPED_SELECTORS: Record<string, string[]> = {
  // The result feed and the individual business cards within it.
  resultFeed: ['div[role="feed"]', 'div[aria-label^="Results for"]'],
  resultCard: ['div[role="feed"] > div > div[jsaction]', 'a.hfpxzc'],
  // Fields read off the detail panel after a card is opened.
  name: ['h1.DUwDvf', 'h1[class*="fontHeadlineLarge"]'],
  rating: ['div.F7nice span[aria-hidden="true"]', 'span.MW4etd'],
  reviews: ['div.F7nice span[aria-label*="review"]', 'span.UY7F9'],
  website: ['a[data-item-id="authority"]', 'a[aria-label^="Website"]'],
  phone: ['button[data-item-id^="phone"]', 'button[aria-label^="Phone"]'],
  address: ['button[data-item-id="address"]', 'button[aria-label^="Address"]'],
};

/**
 * Ordered selector list for a field: learned-and-working first, then shipped.
 */
export async function selectorsFor(field: string): Promise<string[]> {
  const learned = await db
    .select()
    .from(selectorMemory)
    .where(and(eq(selectorMemory.source, 'gmaps'), eq(selectorMemory.field, field), eq(selectorMemory.active, true)))
    .orderBy(desc(selectorMemory.successCount), desc(selectorMemory.lastOkAt));

  const learnedSelectors = learned.map((r) => r.selector);
  const shipped = SHIPPED_SELECTORS[field] ?? [];

  // Learned winners first, then any shipped ones not already present.
  const seen = new Set(learnedSelectors);
  return [...learnedSelectors, ...shipped.filter((s) => !seen.has(s))];
}

/** Record that a selector worked, so it floats to the top next time. */
export async function selectorWorked(field: string, selector: string, learned = false): Promise<void> {
  await db
    .insert(selectorMemory)
    .values({
      source: 'gmaps',
      field,
      selector,
      successCount: 1,
      lastOkAt: new Date(),
      learned,
      active: true,
    })
    .onConflictDoUpdate({
      target: [selectorMemory.source, selectorMemory.field, selectorMemory.selector],
      set: {
        successCount: (await successCount(field, selector)) + 1,
        lastOkAt: new Date(),
        active: true,
      },
    });
  if (learned) log.memory(`learned a new selector for gmaps/${field}: ${selector}`);
}

async function successCount(field: string, selector: string): Promise<number> {
  const [row] = await db
    .select({ n: selectorMemory.successCount })
    .from(selectorMemory)
    .where(and(eq(selectorMemory.source, 'gmaps'), eq(selectorMemory.field, field), eq(selectorMemory.selector, selector)))
    .limit(1);
  return row?.n ?? 0;
}

/** Record that a selector failed. Repeated failure retires a learned selector. */
export async function selectorFailed(field: string, selector: string): Promise<void> {
  const [row] = await db
    .select()
    .from(selectorMemory)
    .where(and(eq(selectorMemory.source, 'gmaps'), eq(selectorMemory.field, field), eq(selectorMemory.selector, selector)))
    .limit(1);
  if (!row) return;

  const failures = row.failureCount + 1;
  await db
    .update(selectorMemory)
    .set({
      failureCount: failures,
      lastFailAt: new Date(),
      // Retire a learned selector that starts failing more than it works.
      active: !(row.learned && failures > row.successCount + 2),
    })
    .where(eq(selectorMemory.id, row.id));
}
