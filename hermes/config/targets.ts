/**
 * The niche rotation queue — Marvin edits this file.
 *
 * Hermes walks the queue one entry at a time. An entry stays active until it
 * hits `weekCap` sent leads (250 = 50/day × 5 weekdays) or the scrape dries up,
 * then he completes it and activates the next one automatically.
 *
 * Reorder, add, or remove entries freely: rotation is driven by the entry's
 * position here, and already-completed entries are never re-activated.
 */

export type QueueEntry = {
  city: string;
  niche: string;
  /** Optional per-entry override of the global daily target. */
  dailyTarget?: number;
  /** Optional per-entry override of the weekly cap. */
  weekCap?: number;
  /**
   * Extra search phrases tried when the primary "{niche} in {city}" search
   * comes up short of 50 survivors after dedup (Phase 3's widening step).
   */
  widenWith?: string[];
};

export const QUEUE: QueueEntry[] = [
  {
    city: 'New York City',
    niche: 'restaurants',
    widenWith: ['bistros', 'cafes', 'diners', 'pizzerias', 'family restaurants'],
  },
  {
    city: 'New York City',
    niche: 'dentists',
    widenWith: ['dental clinics', 'orthodontists', 'cosmetic dentistry', 'pediatric dentists'],
  },
  {
    city: 'New York City',
    niche: 'gyms',
    widenWith: ['fitness studios', 'crossfit boxes', 'yoga studios', 'personal trainers'],
  },
  {
    city: 'Miami',
    niche: 'law firms',
    widenWith: ['personal injury lawyers', 'immigration attorneys', 'family law attorneys'],
  },
  {
    city: 'Miami',
    niche: 'barbershops',
    widenWith: ['hair salons', 'beauty salons', 'nail salons', 'spas'],
  },
  {
    city: 'Santa Cruz de la Sierra',
    niche: 'restaurantes',
    widenWith: ['cafeterías', 'pizzerías', 'heladerías', 'churrasquerías'],
  },
];
