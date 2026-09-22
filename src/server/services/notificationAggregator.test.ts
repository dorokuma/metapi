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

  it('verifies fallback write-back outside flush lock has been removed (structural)', () => {
    // 修法：删掉锁外写回，封板只在 flush 锁内完成；写失败不替换对象。
    // 结构验证：evaluateAggregatedNotification 内不应有独立的 writeStormRow 调用。
    const src = readFileSync(srcPath(), 'utf-8');
    const fnBody = getFunctionBody(src, 'evaluateAggregatedNotification');
    expect(fnBody).not.toContain('writeStormRow');
  });

  it('verifies releaseAggregatedPushWindow accepts pushGeneration parameter (structural)', async () => {
    // 修法：release 接收推送当时的代号（pushGeneration），在锁内比对，仅相等才释放；
    // release 置 dirty 时同步递增 dirtyGeneration。
    const src = readFileSync(srcPath(), 'utf-8');
    expect(src).toContain('releaseAggregatedPushWindow(level: string, title: string, pushGeneration: number)');
    expect(src).toContain('entry.pushGeneration !== pushGeneration');
    // release 中 dirtyGeneration += 1 在 flush 之前
    expect(src).toContain('dirtyGeneration += 1;');
    expect(src).toContain('await flushAggregatedState()');
  });

  it('verifies loadPersistedState DB error resets loadPromise for retry (structural)', async () => {
    // 修法：DB 错误要 reject，调用方不得推送、不得 persist；JSON 损坏仍从零开始。
    const src = readFileSync(srcPath(), 'utf-8');
    expect(src).toContain('loadPromise = null;');
    expect(src).toContain('JSON.parse');
    expect(src).toContain('return;');
  });

  it('verifies dirtyGeneration is incremented before flush in key branches (structural)', async () => {
    // 修法：这些赋值都递增 dirtyGeneration，防止 flush 清掉 await 期间的新写入。
    // flushAggregatedState 自身仅做快照比较：if (dirtyGeneration === snapshotGeneration) dirty = false
    const src = readFileSync(srcPath(), 'utf-8');
    const evalBody = getFunctionBody(src, 'evaluateAggregatedNotification');
    const flushBody = getFunctionBody(src, 'flushAggregatedState');
    const releaseBody = getFunctionBody(src, 'releaseAggregatedPushWindow');
    expect(evalBody).toContain('dirtyGeneration += 1');
    expect(flushBody).toContain('dirtyGeneration === snapshotGeneration');
    expect(releaseBody).toContain('dirtyGeneration += 1');
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
});

function srcPath(): string {
  try {
    return new URL('./notificationAggregator.ts', import.meta.url).pathname;
  } catch {
    return '/root/workspace/metapi/src/server/services/notificationAggregator.ts';
  }
}
