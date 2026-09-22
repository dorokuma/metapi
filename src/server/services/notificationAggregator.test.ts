import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');

const ALERT = {
  level: 'error',
  title: '代理全部失败',
  message: '模型=grok-4.6, 原因=No available channels after retries',
  eventType: 'proxy',
  relatedType: 'route',
} as const;

describe('notificationAggregator', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-notif-aggregator-'));
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
    config.notifyCooldownSec = 300;
  });

  afterAll(async () => {
    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();
    delete process.env.DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function evaluateOnce(model: string, reason: string) {
    const { evaluateAggregatedNotification } = await import('./notificationAggregator.js');
    return evaluateAggregatedNotification({
      ...ALERT,
      message: `模型=${model}, 原因=${reason}`,
      model,
      reason,
    });
  }

  it('pushes the first occurrence and writes exactly one storm row', async () => {
    const decision = await evaluateOnce('grok-4.6', 'No available channels after retries');

    expect(decision.shouldPush).toBe(true);
    expect(decision.mergedCount).toBe(0);

    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('模型=grok-4.6');
  });

  it('merges repeated alerts inside the cooldown into a single row without pushing', async () => {
    await evaluateOnce('grok-4.6', 'No available channels after retries');
    for (let i = 0; i < 5; i += 1) {
      const suppressed = await evaluateOnce('grok-4.6', 'No available channels after retries');
      expect(suppressed.shouldPush).toBe(false);
    }

    const { flushAggregatedState } = await import('./notificationAggregator.js');
    await flushAggregatedState();

    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('已累计 6 次');
  });

  it('merges across models and reasons instead of opening per-model windows', async () => {
    await evaluateOnce('grok-4.6', 'No available channels after retries');
    const second = await evaluateOnce('grok-4.7', 'upstream returned HTTP 400');
    const third = await evaluateOnce('glm-5.3-flash', 'upstream returned HTTP 400');

    expect(second.shouldPush).toBe(false);
    expect(third.shouldPush).toBe(false);

    const { flushAggregatedState } = await import('./notificationAggregator.js');
    await flushAggregatedState();

    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('grok-4.6');
    expect(rows[0].message).toContain('grok-4.7');
    expect(rows[0].message).toContain('glm-5.3-flash');
  });

  it('keeps the cooldown window across a restart via persisted settings state', async () => {
    await evaluateOnce('grok-4.6', 'No available channels after retries');

    // 模拟进程重启：清空内存但保留 settings 表
    const { resetAggregatedNotificationState, flushAggregatedState } = await import('./notificationAggregator.js');
    await flushAggregatedState();
    await resetAggregatedNotificationState();

    const afterRestart = await evaluateOnce('grok-4.7', 'upstream returned HTTP 400');
    expect(afterRestart.shouldPush).toBe(false);
  });

  it('falls back to per-alert behaviour when cooldown is disabled', async () => {
    config.notifyCooldownSec = 0;
    const first = await evaluateOnce('grok-4.6', 'No available channels after retries');
    const second = await evaluateOnce('grok-4.7', 'upstream returned HTTP 400');
    expect(first.shouldPush).toBe(true);
    expect(second.shouldPush).toBe(true);

    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(0);
  });

  it('opens a new storm row after the storm goes quiet', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first storm' });
    await flushAggregatedState();

    // 直接把冷却窗口拨到已过期，模拟冷静期结束
    const stored = JSON.parse(
      (await db.select().from(schema.settings)
        .where(eq(schema.settings.key, 'notification_aggregator_state_v1'))
        .get())?.value || '{}',
    ) as Record<string, { lastPushAtMs: number }>;
    for (const key of Object.keys(stored)) {
      stored[key].lastPushAtMs = Date.now() - 400_000;
    }
    const { upsertSetting } = await import('../db/upsertSetting.js');
    await upsertSetting('notification_aggregator_state_v1', stored);
    await resetForSecondStorm();

    const decision = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'second storm' });
    expect(decision.shouldPush).toBe(true);
    expect(decision.mergedCount).toBe(0);

    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(2);
  });
});

async function resetForSecondStorm(): Promise<void> {
  const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
  await resetAggregatedNotificationState();
}
