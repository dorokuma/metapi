import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import {
  isUpstreamProviderObservationPruneSchedulerRunning,
  resolveUpstreamProviderObservationPruneIntervalMs,
  runUpstreamProviderObservationPruneOnce,
  startUpstreamProviderObservationPruneScheduler,
  stopUpstreamProviderObservationPruneScheduler,
} from './pruneScheduler.js';

const { pruneMock } = vi.hoisted(() => ({
  pruneMock: vi.fn(),
}));

vi.mock('./store.js', () => ({
  pruneUpstreamProviderObservations: pruneMock,
}));

describe('upstreamProviderDetect prune scheduler (D5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pruneMock.mockReset();
    pruneMock.mockResolvedValue({
      enabled: true,
      retentionDays: 14,
      cutoffUtc: '2026-09-11 07:00:00',
      deleted: 3,
    });
    stopUpstreamProviderObservationPruneScheduler();
  });

  afterEach(() => {
    stopUpstreamProviderObservationPruneScheduler();
    vi.useRealTimers();
  });

  it('runs once on start and then on the configured interval, and stops cleanly', async () => {
    const intervalMs = resolveUpstreamProviderObservationPruneIntervalMs();
    expect(intervalMs).toBeGreaterThanOrEqual(60_000);

    startUpstreamProviderObservationPruneScheduler();
    expect(isUpstreamProviderObservationPruneSchedulerRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(pruneMock).toHaveBeenCalledTimes(1);
    expect(pruneMock.mock.calls[0]?.[0]).toBe(config.upstreamProviderDetectRetentionDays);

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(pruneMock).toHaveBeenCalledTimes(2);

    stopUpstreamProviderObservationPruneScheduler();
    expect(isUpstreamProviderObservationPruneSchedulerRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(intervalMs * 3);
    expect(pruneMock).toHaveBeenCalledTimes(2);
  });

  it('does not stack duplicate timers when started twice', async () => {
    startUpstreamProviderObservationPruneScheduler();
    startUpstreamProviderObservationPruneScheduler();

    await vi.advanceTimersByTimeAsync(0);
    expect(pruneMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(resolveUpstreamProviderObservationPruneIntervalMs());
    expect(pruneMock).toHaveBeenCalledTimes(2);
  });

  it('treats retention <= 0 as disabled and stays silent', async () => {
    pruneMock.mockResolvedValue({
      enabled: false,
      retentionDays: 0,
      cutoffUtc: null,
      deleted: 0,
    });

    await expect(runUpstreamProviderObservationPruneOnce()).resolves.toBeUndefined();
    expect(pruneMock).toHaveBeenCalledTimes(1);
  });

  it('warns at most once per process when prune keeps failing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pruneMock.mockRejectedValue(new Error('db is gone'));

      await runUpstreamProviderObservationPruneOnce();
      await runUpstreamProviderObservationPruneOnce();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('prune failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('swallows prune failures so the server lifecycle is never affected', async () => {
    pruneMock.mockRejectedValue(new Error('db is gone'));

    await expect(runUpstreamProviderObservationPruneOnce()).resolves.toBeUndefined();
    expect(pruneMock).toHaveBeenCalledTimes(1);
  });
});
