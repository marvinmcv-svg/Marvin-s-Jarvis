import { closeDb } from '../db/client.js';
import { resetUsage } from '../core/anthropic.js';
import { RunRecorder } from '../memory/run.js';
import { deepReflection } from '../memory/reflect.js';
import { log } from '../core/logger.js';

/**
 * The `reflect` job — a standalone weekly deep-reflection pass.
 *
 * The daily run already reflects on itself, but this heavier pass tunes the
 * score weights against reply outcomes, decays stale memory, and writes global
 * lessons across many runs. Run it on a weekly cron (e.g. Sunday night) so the
 * weekday runs start each week a little sharper.
 */
async function main(): Promise<void> {
  resetUsage();
  const recorder = await RunRecorder.start('reflect');
  try {
    await deepReflection(recorder);
    await recorder.finish('success');
    log.ok('weekly deep reflection complete');
  } catch (err) {
    log.error(`reflect job failed: ${(err as Error).message}`);
    await recorder.finish('failed', { error: (err as Error).message });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
