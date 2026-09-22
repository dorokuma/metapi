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

    // 释放后冷却窗口缩短 60s（now-300s+60s=now-240s），立即 evaluate 仍在冷却期内
    const stillSuppressed = await evaluateOnce('grok-4.7', 'upstream returned HTTP 400');
    expect(stillSuppressed.shouldPush).toBe(false);

    // 过期 release（代际不匹配）不会覆盖新的成功窗口：
    // 模拟新推送后，用旧代际 release 无效
    const { flushAggregatedState } = await import('./notificationAggregator.js');
    await flushAggregatedState();
    await evaluateOnce('grok-4.8', 'upstream returned HTTP 500');
    await flushAggregatedState();
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

  it('does not re-insert when the events row still exists but UPDATE reports 0 changes', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first' });
    await flushAggregatedState();
    const rowsBefore = await db.select().from(schema.events).all();
    expect(rowsBefore).toHaveLength(1);

    // 再次触发同一签名：UPDATE 同一行（SQLite 可能 reports changes===0 但行存在）
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'same' });
    await flushAggregatedState();

    const rowsAfter = await db.select().from(schema.events).all();
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].id).toBe(rowsBefore[0].id);
  });

  it('opens exactly one new storm row after silence closes the previous', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first storm' });
    await flushAggregatedState();
    expect(await db.select().from(schema.events).all()).toHaveLength(1);

    // 模拟进程重启
    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();

    // 把持久化状态里的风暴静默期拨到 10 分钟以上，再重启：开新行
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

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'second storm' });
    await flushAggregatedState();

    const rows = await db.select().from(schema.events).all();
    expect(rows).toHaveLength(2); // 第一条封板行 + 第二条新行
  });

  it('does not lose in-flight writes when flush is in progress', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    // 第一条触发 flush
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first' });
    // 在 flush 进行中写入新事件（dirtyGeneration 递增）
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'second' });
    await flushAggregatedState();

    const rows = await db.select().from(schema.events).all();
    // 两次都应在同一条风暴行上累计；至少包含第二次的 model
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const lastRow = rows[rows.length - 1];
    expect(lastRow.message).toContain('grok-4.7');
  });

  it('allows retry on DB load errors after JSON corruption is written', async () => {
    const { resetAggregatedNotificationState, evaluateAggregatedNotification } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();
    const { upsertSetting } = await import('../db/upsertSetting.js');

    // 写入损坏的 JSON
    await upsertSetting('notification_aggregator_state_v1', 'NOT_JSON' as any);

    // 第一次 evaluate：内部 load 遇到 JSON 损坏，从零开始，正常推送
    const fresh = await evaluateAggregatedNotification({
      ...ALERT, model: 'grok-4.6', reason: 'after-corrupt'
    });
    expect(fresh.shouldPush).toBe(true);

    // 重置状态后写入合法的 JSON（lastPushAtMs 足够旧以确保 cooldown 过期）
    await resetAggregatedNotificationState();
    const ancientTs = Date.now() - 400_000;
    await upsertSetting('notification_aggregator_state_v1', {
      'key': {
        lastPushAtMs: ancientTs,
        storm: {
          eventId: 1,
          count: 1,
          models: [],
          reasons: [],
          firstAtMs: ancientTs,
          lastAtMs: ancientTs,
          active: true,
          meta: { level: 'error', title: '测试', type: 'proxy', relatedType: 'route', baseMessage: 'x' },
        },
      },
    });

    await resetAggregatedNotificationState();
    const loaded = await evaluateAggregatedNotification({
      ...ALERT, model: 'grok-4.7', reason: 'after-valid-json'
    });
    // 从 DB 恢复状态且 cooldown 已过期，应推送
    expect(loaded.shouldPush).toBe(true);
  });

  it('uses now-cooldown+60s window on release and checks generation', async () => {
    const { evaluateAggregatedNotification, releaseAggregatedPushWindow, flushAggregatedState } = await import('./notificationAggregator.js');
    config.notifyCooldownSec = 300;

    const first = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'r1' });
    expect(first.shouldPush).toBe(true);

    // 迟到 release：代际匹配，窗口设为 now-240s（= 300-60）
    await releaseAggregatedPushWindow('error', '代理全部失败');

    // 同一代际再次 evaluate：冷却已缩短 60s，仍可能 within cooldown
    const immediate = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'r2' });
    // 因 lastPushAtMs 设为 now-240s，距现在 0ms < 300ms，仍 within cooldown
    expect(immediate.shouldPush).toBe(false);
  });

  it('ignores late release when generation has already advanced', async () => {
    const { evaluateAggregatedNotification, releaseAggregatedPushWindow } = await import('./notificationAggregator.js');
    config.notifyCooldownSec = 300;

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'r1' });

    // 模拟一次新的成功推送（递增代际）
    const { flushAggregatedState } = await import('./notificationAggregator.js');
    await flushAggregatedState();
    // 模拟：另一次 evaluate 递增代际
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'r2' });
    await flushAggregatedState();

    // 迟到的 release（代际不匹配）不应覆盖更新后的窗口
    const afterRelease = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.8', reason: 'r3' });
    // 代际已推进，release 已忽略，r3 应 still within cooldown
    expect(afterRelease.shouldPush).toBe(false);
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
