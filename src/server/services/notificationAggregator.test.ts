import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');

const ALERT = {
  level: 'error',
  title: '代理全部失败',
  message: '模型=grok-4.6, 原因=No available channels after retries',
  eventType: 'proxy',
  relatedType: 'route',
} as const;

// Simple brace-aware function body extractor: scans for "export async function NAME"
// then finds the '{' that opens the function body (skipping type parameter { ... }) and
// returns everything up to the matching '}'.
function getFunctionBody(src: string, fnName: string): string {
  const decl = 'export async function ' + fnName;
  const idx = src.indexOf(decl);
  if (idx < 0) return '';
  // Find the function body: arrow functions add an extra () => { level.
  // We need the arrow's body brace, not the first (which might be a type param).
  // Strategy: scan forward from the function name to find '=> {' (function body arrow)
  let arrowBodyIdx = src.indexOf('=> {', idx + decl.length);
  let bodyStart = -1;
  if (arrowBodyIdx >= 0) {
    bodyStart = arrowBodyIdx + 3; // position of '{' in '=> {'
  } else {
    // No arrow: first '{' after function name is the body start
    bodyStart = src.indexOf('{', idx + decl.length);
  }
  if (bodyStart < 0) return '';
  let depth = 1;
  for (let j = bodyStart + 1; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(bodyStart + 1, j);
    }
  }
  return '';
}

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
    expect(rows).toHaveLength(2);
  });

  it('serializes concurrent alerts so only one row and one push happen at storm open', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    const decisions = await Promise.all(Array.from({ length: 12 }, (_unused, index) => evaluateAggregatedNotification({
      ...ALERT,
      message: `模型=model-${index}, 原因=No available channels after retries`,
      model: `model-${index}`,
      reason: 'No available channels after retries',
    })));

    const pushed = decisions.filter((decision) => decision.shouldPush);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].count).toBe(1);

    await flushAggregatedState();
    const rows = await db.select().from(schema.events)
      .where(eq(schema.events.title, '代理全部失败'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('已累计 12 次');
  });

  it('does not consume the window when every channel fails and a retry is allowed', async () => {
    const { evaluateAggregatedNotification, releaseAggregatedPushWindow, flushAggregatedState } = await import('./notificationAggregator.js');
    const { buildAggregatedSignature } = await import('./notificationAggregator.js');

    const first = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'r1' });
    expect(first.shouldPush).toBe(true);

    const sig = buildAggregatedSignature('error', '代理全部失败');
    const generation = (await import('./notificationAggregator.js')).getAggregatorEntry(sig)?.pushGeneration ?? 0;
    await releaseAggregatedPushWindow('error', '代理全部失败', generation);

    const stillSuppressed = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'r2' });
    expect(stillSuppressed.shouldPush).toBe(false);

    const { flushAggregatedState: flush2 } = await import('./notificationAggregator.js');
    await flush2();
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.8', reason: 'r3' });
    await flush2();
  });

  it('re-creates the storm row when the events row was cleaned up', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first' });
    await flushAggregatedState();
    expect(await db.select().from(schema.events).all()).toHaveLength(1);

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

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'same' });
    await flushAggregatedState();

    const rowsAfter = await db.select().from(schema.events).all();
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].id).toBe(rowsBefore[0].id);
  });

  it('opens exactly one new storm row after the storm goes quiet', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first storm' });
    await flushAggregatedState();
    expect(await db.select().from(schema.events).all()).toHaveLength(1);

    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();

    const resumed = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'still same storm' });
    expect(resumed.shouldPush).toBe(false);
    await flushAggregatedState();
    expect(await db.select().from(schema.events).all()).toHaveLength(1);

    // Extend storm silence past 10 minutes to trigger new row on restart
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

  it('does not lose in-flight writes when flush is in progress', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first' });
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'second' });
    await flushAggregatedState();

    const rows = await db.select().from(schema.events).all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const lastRow = rows[rows.length - 1];
    expect(lastRow.message).toContain('grok-4.7');
  });

  it('allows retry on DB load errors after JSON corruption is written', async () => {
    const { resetAggregatedNotificationState, evaluateAggregatedNotification } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();
    const { upsertSetting } = await import('../db/upsertSetting.js');

    await upsertSetting('notification_aggregator_state_v1', 'NOT_JSON' as any);

    const fresh = await evaluateAggregatedNotification({
      ...ALERT, model: 'grok-4.6', reason: 'after-corrupt'
    });
    expect(fresh.shouldPush).toBe(true);

    await resetAggregatedNotificationState();
    const ancientTs = Date.now() - 400_000;
    await upsertSetting('notification_aggregator_state_v1', {
      key: {
        lastPushAtMs: ancientTs,
        storm: {
          eventId: 1, count: 1, models: [], reasons: [],
          firstAtMs: ancientTs, lastAtMs: ancientTs,
          active: true,
          meta: { level: 'error', title: '测试', type: 'proxy', relatedType: 'route', baseMessage: 'x' },
        },
      },
    });

    await resetAggregatedNotificationState();
    const loaded = await evaluateAggregatedNotification({
      ...ALERT, model: 'grok-4.7', reason: 'after-valid-json'
    });
    expect(loaded.shouldPush).toBe(true);
  });

  it('uses now-cooldown+60s window on release and checks generation', async () => {
    const { evaluateAggregatedNotification, releaseAggregatedPushWindow, flushAggregatedState, getAggregatorEntry } = await import('./notificationAggregator.js');
    const { buildAggregatedSignature } = await import('./notificationAggregator.js');
    config.notifyCooldownSec = 300;

    const first = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'r1' });
    expect(first.shouldPush).toBe(true);

    const generation = getAggregatorEntry(buildAggregatedSignature('error', '代理全部失败'))?.pushGeneration ?? 0;
    await releaseAggregatedPushWindow('error', '代理全部失败', generation);

    const immediate = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'r2' });
    expect(immediate.shouldPush).toBe(false);
  });

  it('ignores late release when generation has already advanced', async () => {
    const { evaluateAggregatedNotification, releaseAggregatedPushWindow } = await import('./notificationAggregator.js');
    config.notifyCooldownSec = 300;

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'r1' });

    const { flushAggregatedState } = await import('./notificationAggregator.js');
    await flushAggregatedState();
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'r2' });
    await flushAggregatedState();

    const { buildAggregatedSignature, getAggregatorEntry } = await import('./notificationAggregator.js');
    const sig = buildAggregatedSignature('error', '代理全部失败');
    const beforeLastPushAtMs = getAggregatorEntry(sig)?.lastPushAtMs;
    await releaseAggregatedPushWindow('error', '代理全部失败', 0);

    const afterLastPushAtMs = (
      await import('./notificationAggregator.js')
    ).getAggregatorEntry(sig)?.lastPushAtMs;
    expect(afterLastPushAtMs).toBe(beforeLastPushAtMs);
  });

  it('late release with matching generation rewrites lastPushAtMs (must not be a no-op)', async () => {
    const { evaluateAggregatedNotification, releaseAggregatedPushWindow, flushAggregatedState, getAggregatorEntry } = await import('./notificationAggregator.js');
    const { buildAggregatedSignature } = await import('./notificationAggregator.js');
    config.notifyCooldownSec = 300;

    const first = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'r1' });
    expect(first.shouldPush).toBe(true);
    await flushAggregatedState();

    const sig = buildAggregatedSignature('error', '代理全部失败');
    const entryAfterPush = getAggregatorEntry(sig);
    await releaseAggregatedPushWindow('error', '代理全部失败', entryAfterPush!.pushGeneration);

    const entryAfterRelease = getAggregatorEntry(sig);
    expect(entryAfterRelease!.lastPushAtMs).toBeGreaterThan(0);
    expect(Date.now() - entryAfterRelease!.lastPushAtMs).toBeGreaterThanOrEqual(240_000);
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

    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();

    const resumed = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'still same storm' });
    expect(resumed.shouldPush).toBe(false);
    await flushAggregatedState();
    expect(await db.select().from(schema.events).all()).toHaveLength(1);

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

  it('DB error prevents push and does not overwrite settings (behavior)', async () => {
    const { evaluateAggregatedNotification } = await import('./notificationAggregator.js');
    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    const { upsertSetting } = await import('../db/upsertSetting.js');

    // 写入合法的持久化状态，确保 DB 有内容
    await upsertSetting('notification_aggregator_state_v1', {
      key: {
        lastPushAtMs: Date.now() - 400_000,
        suppressedCount: 0,
        storm: {
          eventId: 1,
          count: 1,
          models: [],
          reasons: [],
          firstAtMs: Date.now() - 400_000,
          lastAtMs: Date.now() - 400_000,
          active: true,
          meta: { level: 'error', title: '测试', type: 'proxy', relatedType: 'route', baseMessage: 'x' },
        },
      },
    });

    await resetAggregatedNotificationState();

    // 触发 loadPersistedState 内的 DB 错误模拟
    (globalThis as any).__metapi_test_simulate_db_error = true;

    const decision = await evaluateAggregatedNotification({ ...ALERT, model: 'm1', reason: 'r1' });
    expect(decision.shouldPush).toBe(false);

    // 确认 settings 表内容未被改写
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'notification_aggregator_state_v1'))
      .get();
    expect(row?.value).toContain('lastPushAtMs');
  });

  it('storm seal write failure keeps the pending storm, its event row and its count (behavior)', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState, getAggregatorEntry } = await import('./notificationAggregator.js');
    const { buildAggregatedSignature } = await import('./notificationAggregator.js');

    // 第一段风暴：落一条 events 行并推送
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first storm' });
    await flushAggregatedState();
    const sig = buildAggregatedSignature('error', '代理全部失败');
    const firstRows = await db.select().from(schema.events).all();
    expect(firstRows).toHaveLength(1);
    const oldEventId = firstRows[0].id;
    const oldMessage = firstRows[0].message;
    expect(getAggregatorEntry(sig)).toBeDefined();

    // 静默超过 10 分钟：旧 storm 在内存中变为 inactive，等待封板写回。
    // 不依赖 load 过期丢弃（那会让封板分支根本进不去），而是让 flush 真正走封板写失败路径。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);

      // 模拟封板写失败
      (globalThis as any).__metapi_test_simulate_write_error = true;
      const reopened = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'second' });
      expect(reopened.shouldPush).toBe(true);
      expect(reopened.count).toBe(1);

      // 封板失败后必须保留 pending 与旧 storm，不得插入新行
      const afterFailure = await db.select().from(schema.events).all();
      expect(afterFailure).toHaveLength(2);
      const pendingEventId = afterFailure.map((row) => row.id).find((id) => id !== oldEventId) as number;
      expect(pendingEventId).toBeGreaterThan(0);

      // 立刻再评估一次：必须续写原 pendingStorm 原对象，禁止新建、禁止再 insert
      const continued = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.8', reason: 'third' });
      expect(continued.shouldPush).toBe(false);
      // 计数不丢：pendingStorm 的 count 延续上一段，而不是回 1
      expect(continued.count).toBe(2);
      expect(continued.mergedCount).toBe(1);

      // 行数守恒：仍然只有旧行 + pending 行，没有第三条孤儿行
      const rows = await db.select().from(schema.events).all();
      expect(rows).toHaveLength(2);

      // 旧 eventId 保留：旧行内容未被改写
      const oldRow = rows.find((row) => row.id === oldEventId);
      expect(oldRow).toBeDefined();
      expect(oldRow?.message).toBe(oldMessage);

      // 新风暴行承载两段累计，不是停在 baseMessage 的孤儿行
      const pendingRow = rows.find((row) => row.id === pendingEventId);
      expect(pendingRow?.message).toContain('已累计 2 次');
      expect(pendingRow?.message).toContain('grok-4.7');
      expect(pendingRow?.message).toContain('grok-4.8');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('release uses the generation saved before send: stale generation keeps the window, fresh generation rewrites it (behavior)', async () => {
    const { evaluateAggregatedNotification, releaseAggregatedPushWindow, flushAggregatedState, getAggregatorEntry } = await import('./notificationAggregator.js');
    const { buildAggregatedSignature } = await import('./notificationAggregator.js');
    config.notifyCooldownSec = 1;

    const first = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'r1' });
    expect(first.shouldPush).toBe(true);
    const sig = buildAggregatedSignature('error', '代理全部失败');
    // 发送前保存当时的代际与窗口（与 alertService 的取值时机一致）
    const savedGeneration = getAggregatorEntry(sig)?.pushGeneration ?? 0;
    const windowAfterFirstPush = getAggregatorEntry(sig)?.lastPushAtMs ?? 0;
    expect(savedGeneration).toBeGreaterThan(0);
    expect(windowAfterFirstPush).toBeGreaterThan(0);

    // 发送挂起期间：冷静期过去，新推送把代际加一并前移窗口
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 1500);
      const second = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'r2' });
      expect(second.shouldPush).toBe(true);
      await flushAggregatedState();

      const generationAfterNewPush = getAggregatorEntry(sig)?.pushGeneration ?? 0;
      const windowAfterNewPush = getAggregatorEntry(sig)?.lastPushAtMs ?? 0;
      expect(generationAfterNewPush).toBeGreaterThan(savedGeneration);
      expect(windowAfterNewPush).toBeGreaterThan(windowAfterFirstPush);

      // 迟到 release：用发送前保存的代际，必须保持窗口不变（不能用 >0 这种恒真断言）
      await releaseAggregatedPushWindow('error', '代理全部失败', savedGeneration);
      const windowAfterStaleRelease = getAggregatorEntry(sig)?.lastPushAtMs ?? 0;
      expect(windowAfterStaleRelease).toBe(windowAfterNewPush);

      // 用发送后的新代际 release：必须真正改写窗口（now - cooldown + 60s）
      await releaseAggregatedPushWindow('error', '代理全部失败', generationAfterNewPush);
      const windowAfterFreshRelease = getAggregatorEntry(sig)?.lastPushAtMs ?? 0;
      expect(windowAfterFreshRelease).not.toBe(windowAfterNewPush);
      // 改写后的窗口应指向 now-cooldown+60s：距 now 约 60 秒之后
      expect(Date.now() - windowAfterFreshRelease).toBeLessThanOrEqual(0);

      // 窗口被改写为未来时刻后，下一次评估应被冷静期拦住（不推送）
      const third = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.8', reason: 'r3' });
      expect(third.shouldPush).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('persists and restores the pending storm so a restart does not lose the storm (behavior)', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState, resetAggregatedNotificationState } = await import('./notificationAggregator.js');

    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'r1' });
    await flushAggregatedState();
    const beforeRestart = await db.select().from(schema.events).all();
    expect(beforeRestart).toHaveLength(1);
    const oldEventId = beforeRestart[0].id;

    // 构造"新风暴已插入 events 行、但旧风暴尚未封板"的中间态，然后模拟进程重启
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      (globalThis as any).__metapi_test_simulate_write_error = true;
      await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'r2' });
      const midState = await db.select().from(schema.events).all();
      expect(midState).toHaveLength(2);
      const pendingEventId = midState.map((row) => row.id).find((id) => id !== oldEventId) as number;

      // 持久化的 JSON blob 必须带上 pendingStorm（settings JSON，无需 schema 迁移）
      const persisted = JSON.parse(
        (await db.select().from(schema.settings)
          .where(eq(schema.settings.key, 'notification_aggregator_state_v1'))
          .get())?.value || '{}',
      ) as Record<string, { pendingStorm?: { eventId?: number; count?: number } | null; storm?: { finalWritten?: boolean } | null }>;
      const persistedEntry = Object.values(persisted)[0];
      expect(persistedEntry?.pendingStorm?.eventId).toBe(pendingEventId);
      // finalWritten 必须落库，否则重启后无法区分"已封板可丢弃"与"未封板需重试"
      expect(persistedEntry?.storm).toHaveProperty('finalWritten');

      // 进程重启：清空内存态，下一次 evaluate 触发 load
      await resetAggregatedNotificationState();
      (globalThis as any).__metapi_test_simulate_write_error = false;

      // 旧风暴已超过 10 分钟但未封板：必须被恢复并允许重试封板，
      // 而不是连同 pendingStorm 一起被丢弃（那会让整段新风暴静默丢失）
      const resumed = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.8', reason: 'r3' });
      expect(resumed.count).toBe(2);
      expect(resumed.shouldPush).toBe(false);

      await flushAggregatedState();
      const afterRestart = await db.select().from(schema.events).all();
      // 行数守恒：没有因为重启而多插入孤儿行
      expect(afterRestart).toHaveLength(2);
      // 新风暴行承载两段累计，中间行不再永远停在 baseMessage
      const pendingRow = afterRestart.find((row) => row.id === pendingEventId);
      expect(pendingRow?.message).toContain('已累计 2 次');
      expect(pendingRow?.message).toContain('grok-4.7');
      expect(pendingRow?.message).toContain('grok-4.8');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
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

  async function seedUnsealedStorm(lastAtOffsetMs: number): Promise<number> {
    await db.insert(schema.events).values({
      type: 'proxy',
      title: '代理全部失败',
      message: '旧风暴基线消息',
      level: 'error',
      relatedType: 'route',
    }).run();
    const stormRowId = (await db.select().from(schema.events).all())[0].id;
    const nowMs = Date.now();
    const { buildAggregatedSignature } = await import('./notificationAggregator.js');
    const { upsertSetting } = await import('../db/upsertSetting.js');
    await upsertSetting('notification_aggregator_state_v1', {
      [buildAggregatedSignature('error', '代理全部失败')]: {
        lastPushAtMs: nowMs - 60_000,
        suppressedCount: 0,
        pushGeneration: 1,
        storm: {
          eventId: stormRowId,
          count: 3,
          models: ['grok-4.6'],
          reasons: ['No available channels after retries'],
          firstAtMs: nowMs + lastAtOffsetMs,
          lastAtMs: nowMs + lastAtOffsetMs,
          active: true,
          // 生产 blob 形态：未封板，重启后必须重试封板而不是丢弃
          finalWritten: false,
          meta: {
            level: 'error',
            title: '代理全部失败',
            type: 'proxy',
            relatedType: 'route',
            baseMessage: '旧风暴基线消息',
          },
        },
      },
    });
    const { resetAggregatedNotificationState } = await import('./notificationAggregator.js');
    await resetAggregatedNotificationState();
    return stormRowId;
  }

  it('writes back an unsealed storm after a silent restart with no new alert (behavior)', async () => {
    const stormRowId = await seedUnsealedStorm(-60_000);
    const { evaluateAggregatedNotification } = await import('./notificationAggregator.js');

    // 冷静期关闭：这次评估走历史逐条分支，不会触碰聚合器自己的 ensureFlushTimer。
    // 因此写回只能来自"load 标 dirty 时启动的 flush 定时器"——静默重启（无新告警）也要落盘。
    config.notifyCooldownSec = 0;

    vi.useFakeTimers();
    try {
      const decision = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'silent restart' });
      expect(decision.shouldPush).toBe(true);

      // 推进一个 flush 周期：期间没有任何新告警，写回也必须发生
      await vi.advanceTimersByTimeAsync(5_000);

      const stormRow = (await db.select().from(schema.events).all()).find((row) => row.id === stormRowId);
      expect(stormRow?.message).toContain('已累计 3 次');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores an expired but unsealed old storm after restart and retries sealing it (behavior)', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');
    const stormRowId = await seedUnsealedStorm(-11 * 60 * 1000);

    // 重启后第一条告警触发 load：旧风暴已过期但未封板，必须被恢复（而不是连同它一起丢弃）
    config.notifyCooldownSec = 0;
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'after restart' });

    // flush 重试封板：旧 storm 行被原地更新，而不是永远停在 baseMessage
    await flushAggregatedState();

    const stormRow = (await db.select().from(schema.events).all()).find((row) => row.id === stormRowId);
    expect(stormRow?.message).toContain('已累计 3 次');

    // 落库状态里的旧 storm 仍在且已封板：证明它被恢复并走完了封板，而不是被 restoreStorm 丢弃
    const persisted = JSON.parse(
      (await db.select().from(schema.settings)
        .where(eq(schema.settings.key, 'notification_aggregator_state_v1'))
        .get())?.value || '{}',
    ) as Record<string, { storm?: { eventId?: number; finalWritten?: boolean } | null }>;
    const persistedStorm = Object.values(persisted)[0]?.storm;
    expect(persistedStorm?.eventId).toBe(stormRowId);
    expect(persistedStorm?.finalWritten).toBe(true);
  });

  it('seal write failure keeps both the old storm and the pending storm in the same round (behavior)', async () => {
    const { evaluateAggregatedNotification, flushAggregatedState } = await import('./notificationAggregator.js');

    // 第一段风暴：落一条 events 行并推送
    await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.6', reason: 'first storm' });
    await flushAggregatedState();
    const firstRows = await db.select().from(schema.events).all();
    expect(firstRows).toHaveLength(1);
    const oldEventId = firstRows[0].id;
    const oldMessage = firstRows[0].message;

    // 静默超过 10 分钟：旧 storm 在内存中过期 inactive，新风暴开启，本轮封板写失败
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      (globalThis as any).__metapi_test_simulate_write_error = true;

      const reopened = await evaluateAggregatedNotification({ ...ALERT, model: 'grok-4.7', reason: 'second storm' });
      expect(reopened.shouldPush).toBe(true);

      // 写失败的当轮：blob 必须同时保留旧 storm 与 pendingStorm（写失败不得发布/替换）
      const persisted = JSON.parse(
        (await db.select().from(schema.settings)
          .where(eq(schema.settings.key, 'notification_aggregator_state_v1'))
          .get())?.value || '{}',
      ) as Record<string, {
        storm?: { eventId?: number; finalWritten?: boolean } | null;
        pendingStorm?: { eventId?: number } | null;
      }>;
      const persistedEntry = Object.values(persisted)[0];
      expect(persistedEntry?.storm?.eventId).toBe(oldEventId);
      expect(persistedEntry?.storm?.finalWritten).toBe(false);
      expect(persistedEntry?.pendingStorm?.eventId).toBeGreaterThan(0);
      expect(persistedEntry?.pendingStorm?.eventId).not.toBe(oldEventId);

      // 旧行内容未被改写（封板写失败时不得动旧 storm 行）
      const oldRow = (await db.select().from(schema.events).all()).find((row) => row.id === oldEventId);
      expect(oldRow?.message).toBe(oldMessage);
    } finally {
      (globalThis as any).__metapi_test_simulate_write_error = false;
      vi.useRealTimers();
    }
  });
});

function srcPath(): string {
  try {
    return new URL('./notificationAggregator.ts', import.meta.url).pathname;
  } catch {
    return '/root/workspace/metapi/src/server/services/notificationAggregator.ts';
  }
}
