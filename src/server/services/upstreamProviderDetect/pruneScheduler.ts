/**
 * D5: retention for upstream-provider observations is self-scheduled.
 *
 * The design amendment explicitly moves pruning out of
 * `proxyLogRetentionService` (a legacy fallback that mostly does not run) and
 * `logCleanupService` (shared with the usage/token work): this module owns its
 * own `unref`ed interval and is stopped from the Fastify `onClose` hook in
 * `server/index.ts`.
 *
 * - Retention default 14 days (`config.upstreamProviderDetectRetentionDays`),
 *   `<= 0` disables pruning (the store returns `enabled: false`).
 * - Interval reuses the proxy-log retention prune interval (30 min by default)
 *   so both cleanups run on the same cadence without adding another setting.
 * - Runs once on start, then every interval; failures only warn (the first
 *   failure per process warns, repeated cycles stay silent to avoid log spam
 *   when the table is missing / the DB is flapping).
 */

import { config } from '../../config.js';
import { pruneUpstreamProviderObservations } from './store.js';

let pruneTimer: ReturnType<typeof setInterval> | null = null;
let pruneFailureWarned = false;

export function resolveUpstreamProviderObservationPruneIntervalMs(): number {
  const minutes = Math.max(1, Math.trunc(config.proxyLogRetentionPruneIntervalMinutes));
  return minutes * 60 * 1000;
}

export async function runUpstreamProviderObservationPruneOnce(nowMs = Date.now()): Promise<void> {
  try {
    const result = await pruneUpstreamProviderObservations(config.upstreamProviderDetectRetentionDays, nowMs);
    if (!result.enabled || result.deleted <= 0) return;
    console.info(`[upstream-provider-detect] pruned ${result.deleted} observations before ${result.cutoffUtc}`);
  } catch (error) {
    if (pruneFailureWarned) return;
    pruneFailureWarned = true;
    console.warn('[upstream-provider-detect] prune failed (repeated failures are throttled)', error);
  }
}

export function startUpstreamProviderObservationPruneScheduler(): void {
  if (pruneTimer) return;

  void runUpstreamProviderObservationPruneOnce();
  pruneTimer = setInterval(() => {
    void runUpstreamProviderObservationPruneOnce();
  }, resolveUpstreamProviderObservationPruneIntervalMs());
  pruneTimer.unref?.();
}

export function stopUpstreamProviderObservationPruneScheduler(): void {
  if (!pruneTimer) return;
  clearInterval(pruneTimer);
  pruneTimer = null;
}

export function isUpstreamProviderObservationPruneSchedulerRunning(): boolean {
  return pruneTimer !== null;
}
