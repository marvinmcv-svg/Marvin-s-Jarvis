import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentRuns, type PhaseLogEntry, type RunMetrics } from '../db/schema.js';
import { usageSnapshot } from '../core/llm.js';
import { log } from '../core/logger.js';

/**
 * Episodic memory: one record per job execution.
 *
 * The reflection pass reads these back, so the phase log and metrics are not
 * just operator convenience — they are the raw material Hermes reasons over
 * when deciding what he did wrong.
 */
export class RunRecorder {
  readonly startedAt = Date.now();
  private readonly phases: PhaseLogEntry[] = [];
  private readonly metrics: RunMetrics = {};

  private constructor(
    readonly id: string,
    readonly job: string,
  ) {}

  static async start(job: string, ctx: { city?: string; niche?: string; batchId?: string } = {}): Promise<RunRecorder> {
    const [row] = await db
      .insert(agentRuns)
      .values({
        job,
        city: ctx.city ?? null,
        niche: ctx.niche ?? null,
        batchId: ctx.batchId ?? null,
        status: 'running',
        metrics: {},
        phaseLog: [],
      })
      .returning({ id: agentRuns.id });

    log.info(`run ${row!.id.slice(0, 8)} started (${job})`);
    return new RunRecorder(row!.id, job);
  }

  /** Record a phase outcome. Timings come from the caller so they include I/O. */
  phase(phase: string, status: PhaseLogEntry['status'], ms: number, note?: string): void {
    this.phases.push({ phase, status, ms, ...(note ? { note } : {}) });
  }

  metric(key: keyof RunMetrics | string, value: number): void {
    this.metrics[key as string] = value;
  }

  bump(key: string, by = 1): void {
    this.metrics[key] = (this.metrics[key] ?? 0) + by;
  }

  /** Merge LLM usage into the metrics so cost is visible per run. */
  private captureUsage(): void {
    const u = usageSnapshot();
    this.metrics.inputTokens = u.inputTokens;
    this.metrics.outputTokens = u.outputTokens;
    this.metrics.estimatedCostUsd = Number(u.estimatedCostUsd.toFixed(4));
    this.metrics.llmCalls = u.calls;
  }

  async finish(
    status: 'success' | 'partial' | 'failed' | 'aborted',
    extra: { error?: string; batchId?: string; city?: string; niche?: string } = {},
  ): Promise<void> {
    this.captureUsage();
    const durationMs = Date.now() - this.startedAt;

    await db
      .update(agentRuns)
      .set({
        status,
        finishedAt: new Date(),
        durationMs,
        metrics: this.metrics,
        phaseLog: this.phases,
        error: extra.error ?? null,
        ...(extra.batchId ? { batchId: extra.batchId } : {}),
        ...(extra.city ? { city: extra.city } : {}),
        ...(extra.niche ? { niche: extra.niche } : {}),
      })
      .where(eq(agentRuns.id, this.id));

    const secs = (durationMs / 1000).toFixed(1);
    const cost = this.metrics.estimatedCostUsd ?? 0;
    log.info(`run ${this.id.slice(0, 8)} ${status} in ${secs}s (~$${cost.toFixed(3)} of Claude)`);
  }

  /** Attach the reflection narrative written by the reflect job. */
  async saveReflection(text: string): Promise<void> {
    await db.update(agentRuns).set({ reflection: text }).where(eq(agentRuns.id, this.id));
  }

  snapshot(): { metrics: RunMetrics; phases: PhaseLogEntry[] } {
    this.captureUsage();
    return { metrics: { ...this.metrics }, phases: [...this.phases] };
  }
}
