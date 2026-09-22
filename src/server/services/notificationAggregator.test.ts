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

    // 冷静期为 0 时保持历史行为：逐条落库，消息中心不为空
    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(2);
  });

  it('serializes concurrent alerts so only one row and one push happen at storm open', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    // 并发打开发瞬间：代理失败是 fire-and-forget 的，历史上每个调用都会占一个坑
    const decisions = await Promise.all(Array.from({ length: 12 }, (_unused, index) => evaluateAggregatedNotification({
      ...ALERT,
      message: `模型=model-${index}, 原因=No available channels after retries`,
      model: `model-${index}`,
      reason: 'No available channels after retries',
    })));

    const pushed = decisions.filter((decision) => decision.shouldPush);
    expect(pushed).toHaveLength(1);
    // 首推发生在队列最前，此刻风暴计数为 1；其余 11 条在冷却期内被累计进行情行
    expect(pushed[0].count).toBe(1);

    await flushAggregatedState();
    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('已累计 12 次');
  });

  it('does not consume the window when every channel fails and a retry is allowed', async () => {
    const { releaseAggregatedPushWindow } = await import('./notificationAggregator.js');

    const first = await evaluateOnce('grok-4.6', 'No available channels after retries');
    expect(first.shouldPush).toBe(true);

    // 模拟推送失败：调用方释放窗口
    await releaseAggregatedPushWindow('error', '代理全部失败');

    const second = await evaluateOnce('grok-4.7', 'upstream returned HTTP 400');
    expect(second.shouldPush).toBe(true);
  });

  it('re-creates the storm row when the events row was cleaned up', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first' });
    await flushAggregatedState();
    expect(await db.select().from(schema.events).all()).toHaveLength(1);

    // 用户在消息中心清空（或日志清理）后，聚合器必须重插而不是刷幽灵 id
    await db.delete(schema.events).run();
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'second' });
    await flushAggregatedState();

    const after = await db.select().from(schema.events).all();
    expect(after).toHaveLength(1);
    expect(after[0].message).toContain('涉及模型');
  });

  it('keeps event rows when the cooldown is disabled', async () => {
    config.notifyCooldownSec = 0;
    await evaluateOnce('grok-4.6', 'No available channels after retries');
    await evaluateOnce('grok-4.7', 'upstream returned HTTP 400');

    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(2);
  });

  it('opens a new storm row after the storm goes quiet', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first storm' });
    await flushAggregatedState();
    expect(await db.select().from(schema.events).all()).toHaveLength(1);

    // 模拟进程重启：清空内存但保留 settings 状态（含风暴行引用）
    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();

    // 静默未满 10 分钟：重启后续写原行，不开新行
    const resumed = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'still same storm' });
    expect(resumed.shouldPush).toBe(false);
    await flushAggregatedState();
    expect(await db.select().from(schema.events).all()).toHaveLength(1);

    // 把持久化状态里的风暴静默期拨到 10 分钟以上，再重启：应当开新行
    const stored = JSON.parse(
      (await db.select().from(schema.settings)
        .where(eq(schema.settings.key, 'notification_aggregator_state_v1'))
        .get())?.value || '{}',
    ) as Record<string, { lastPushAtMs: number; storm?: { lastAtMs: number } | null }>;
    for (const key of Object.keys(stored)) {
      stored[key].lastPushAtMs = Date.now() - 400_000;
      if (stored[key].storm) stored[key].storm!.lastAtMs = Date.now() - 11 * 60 * 1000;
    }
    const { upsertSetting } = await import('../db/upsertSetting.js');
    await upsertSetting('notification_aggregator_state_v1', stored);
    await resetAggregatedNotificationState();

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
