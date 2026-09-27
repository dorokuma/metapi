import { describe, expect, it } from 'vitest';

import { buildDelayedResponse } from '../test-fixtures/delayedResponseTestUtils.js';
import {
  fetchWithObservedFirstByte,
  getObservedResponseMeta,
  isObservedFirstByteTimeoutResponse,
} from './firstByteTimeout.js';

describe('fetchWithObservedFirstByte', () => {
  it('replays the first chunk and records first-byte latency when upstream responds in time', async () => {
    const response = await fetchWithObservedFirstByte(
      async () => buildDelayedResponse('hello world', 5),
      {
        firstByteTimeoutMs: 100,
        startedAtMs: Date.now(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello world');

    const meta = getObservedResponseMeta(response);
    expect(meta?.timedOutBeforeFirstByte).toBe(false);
    expect(meta?.firstByteLatencyMs).not.toBeNull();
    expect((meta?.firstByteLatencyMs || 0)).toBeGreaterThanOrEqual(0);
    expect((meta?.firstByteLatencyMs || 0)).toBeLessThan(100);
  });

  it('returns a synthetic timeout response when upstream sends no first byte before the deadline', async () => {
    const response = await fetchWithObservedFirstByte(
      async () => buildDelayedResponse('too late', 80),
      {
        firstByteTimeoutMs: 10,
        startedAtMs: Date.now(),
      },
    );

    expect(response.status).toBe(408);
    expect(await response.text()).toContain('first byte timeout');
    expect(isObservedFirstByteTimeoutResponse(response)).toBe(true);

    const meta = getObservedResponseMeta(response);
    expect(meta?.timedOutBeforeFirstByte).toBe(true);
    expect(meta?.firstByteLatencyMs).toBeNull();
  });

  it('swallows the late write of a cancelled body instead of leaking an unhandled error', async () => {
    const response = await fetchWithObservedFirstByte(
      async () => buildDelayedResponse('never delivered', 60),
      {
        firstByteTimeoutMs: 10,
        startedAtMs: Date.now(),
      },
    );

    expect(response.status).toBe(408);
    // 停到 60ms 迟到写入的到期点之后：假流若不感知 cancel，这里会抛出
    // ERR_INVALID_STATE 的无主异常，让本文件失败（而不是在 teardown 后偶发拖垮整轮）。
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(getObservedResponseMeta(response)?.timedOutBeforeFirstByte).toBe(true);
  });
});
