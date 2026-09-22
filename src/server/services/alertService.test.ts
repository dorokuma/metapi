import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendNotificationMock = vi.fn();

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');

const ALERT = {
  level: 'error',
  title: '代理全部失败',
  message: '模型=grok-4.6, 原因=No available channels after retries',
} as const;

describe('alertService reportProxyAllFailed', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-alert-service-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
  });

  beforeEach(async () => {
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();
    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();
    sendNotificationMock.mockReset();
    config.notifyCooldownSec = 1;
  });

  afterAll(async () => {
    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();
    delete process.env.DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('releases with the generation sampled before send: a push landing while send is pending must not rewrite the window (behavior)', async () => {
    const { reportProxyAllFailed } = await import('./alertService.js');
    const { buildAggregatedSignature } = await import('./notificationAggregator.js');
    const { evaluateAggregatedNotification, getAggregatorEntry, releaseAggregatedPushWindow } = await import('./notificationAggregator.js');
    const sig = buildAggregatedSignature('error', '代理全部失败');

    // sendNotification 挂起：由测试控制在发送期间推进代际
    let resolveSend: (value: unknown) => void = () => {};
    sendNotificationMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 穿过 alertService 调用路径：评估 → 采样代际 → sendNotification 挂起
      const reportPromise = reportProxyAllFailed({ model: 'grok-4.6', reason: 'r1' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendNotificationMock).toHaveBeenCalledTimes(1);

      const generationBeforeSend = getAggregatorEntry(sig)?.pushGeneration ?? 0;
      expect(generationBeforeSend).toBeGreaterThan(0);

      // 发送挂起期间：冷静期过去，一次新推送把代际加一并前移窗口
      vi.setSystemTime(Date.now() + 1_500);
      const second = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'r2' });
      expect(second.shouldPush).toBe(true);
      const generationAfterNewPush = getAggregatorEntry(sig)?.pushGeneration ?? 0;
      const windowAfterNewPush = getAggregatorEntry(sig)?.lastPushAtMs ?? 0;
      expect(generationAfterNewPush).toBeGreaterThan(generationBeforeSend);

      // 迟到的发送失败：alertService 必须用发送前保存的旧代际 release
      resolveSend({ throttled: false, attempted: 1, succeeded: 0, failed: 1, failedChannels: ['telegram'] });
      await reportPromise;

      const afterLateRelease = getAggregatorEntry(sig);
      expect(afterLateRelease?.pushGeneration).toBe(generationAfterNewPush);
      // 迟到 release 不得改写新推送刚刚建立的窗口
      expect(afterLateRelease?.lastPushAtMs).toBe(windowAfterNewPush);

      // 证明 release 通路本身可用：换成发送后的新代际才真正改写窗口
      await releaseAggregatedPushWindow('error', '代理全部失败', generationAfterNewPush);
      expect(getAggregatorEntry(sig)?.lastPushAtMs).not.toBe(windowAfterNewPush);
    } finally {
      vi.useRealTimers();
    }
  });
});
