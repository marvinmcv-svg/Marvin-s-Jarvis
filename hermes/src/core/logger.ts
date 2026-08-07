import { env } from './env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function emit(level: Level, icon: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${stamp()} ${icon} ${msg}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

export const log = {
  debug: (m: string, x?: unknown) => emit('debug', '·', m, x),
  info: (m: string, x?: unknown) => emit('info', '›', m, x),
  warn: (m: string, x?: unknown) => emit('warn', '!', m, x),
  error: (m: string, x?: unknown) => emit('error', '✖', m, x),
  ok: (m: string, x?: unknown) => emit('info', '✓', m, x),

  /** Phase banner — makes the daily run readable in GitHub Actions logs. */
  phase: (n: number | string, title: string) => emit('info', '▸', `Phase ${n} — ${title}`),

  /** Memory-loop events get their own marker so the learning is visible in logs. */
  memory: (m: string, x?: unknown) => emit('info', '🧠', m, x),
};

/** Time an async step and return both its value and elapsed ms. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}
