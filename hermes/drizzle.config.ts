import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config.
 *
 * Supabase gives you a Postgres connection string under
 * Project Settings → Database → Connection string → URI.
 * Use the *session pooler* (port 5432) URI for migrations.
 */
const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;

if (!url) {
  throw new Error(
    'DATABASE_URL (or SUPABASE_DB_URL) must be set to run drizzle-kit. ' +
      'Copy it from Supabase → Project Settings → Database → Connection string (URI).',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
