import { closeDb } from '../db/client.js';
import { resetUsage } from '../core/anthropic.js';
import { healthCheck } from '../pipeline/00-health.js';
import { sendAlert } from '../pipeline/11-email.js';
import { log } from '../core/logger.js';

/**
 * The `health` job — run Phase 0 on its own.
 *
 * Useful as a standalone canary (a separate, more frequent cron) or for a
 * quick "is everything wired up?" check after changing secrets. Emails an alert
 * and exits non-zero if anything critical is down.
 */
async function main(): Promise<void> {
  resetUsage();
  try {
    const report = await healthCheck({ runCanary: true });
    log.info(`health: db=${report.db} llm=${report.llm} email=${report.email} canary=${report.canaryFound} listings`);

    if (!report.ok) {
      await sendAlert('standalone health check failed', report.reasons.join('\n'));
      log.error(`unhealthy: ${report.reasons.join('; ')}`);
      process.exitCode = 1;
    } else {
      log.ok('all systems healthy');
    }
  } catch (err) {
    log.error(`health job crashed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

void main();
