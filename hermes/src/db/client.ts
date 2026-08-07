import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
import { env } from '../core/env.js';

/**
 * Single Postgres connection for the whole process.
 *
 * These jobs are short-lived batch runs, so we keep the pool tiny and let
 * Supabase's pooler do the heavy lifting. `prepare: false` is required when
 * connecting through Supabase's transaction pooler (pgbouncer).
 */
const client = postgres(env.DATABASE_URL, {
  max: 4,
  idle_timeout: 20,
  connect_timeout: 15,
  prepare: false,
});

export const db = drizzle(client, { schema });

export { schema };

/** Close the connection so a Node job can exit cleanly. */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}

/** Cheap liveness probe used by the Phase 0 health check. */
export async function pingDb(): Promise<boolean> {
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  }
}
