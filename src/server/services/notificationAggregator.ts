import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { config } from '../config.js';

/**
 * 告警风暴聚合器。
 *
 * 背景：`代理全部失败` 这类告警在故障期间会跨模型、跨请求地高频触发。历史实现有两个
 * 问题：节流签名把完整 message 算进去（模型一变窗口重开），且 events 落库发生在节流
 * 判定之前（冷静期对消息中心毫无作用）。
 *
 * 本模块把同一类告警（level + title）收敛成一条"风暴行"：
 * - 冷却窗口打开时插入一条 events 行并推送；窗口内后续全部只累计次数
 * - 累计计数、涉及模型、最近原因以固定频率刷写到该 events 行（原地更新，不再逐条插）
 * - 冷却窗口与风暴行状态持久化在 settings 表中，进程重启不丢窗口、可续写原行
 * - 风暴静默超过 STORM_CLOSE_MS 后封板，下一次触发开启新的风暴行
 *
 * 单进程语义：状态为进程内 Map + settings 行持久化，多实例会互相覆盖 state blob。
 */

const AGGREGATOR_STATE_SETTING_KEY = 'notification_aggregator_state_v1';
const STORM_CLOSE_MS = 10 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5_000;
const MAX_TRACKED_MODELS = 8;
const MAX_TRACKED_REASONS = 3;
const MAX_TEXT_LENGTH = 200;

type StormMeta = {
  level: string;
  title: string;
  type: string;
  relatedType: string;
  baseMessage: string;
};

type StormEntry = {
  eventId: number;
  count: number;
  models: string[];
  reasons: string[];
  firstAtMs: number;
  lastAtMs: number;
  active: boolean;
  finalWritten: boolean;
  meta: StormMeta;
};

type AggregatorEntry = {
  lastPushAtMs: number;
  suppressedCount: number;
  storm: StormEntry | null;
  /** 每次更新 lastPushAtMs 递增，用于 release 时识别过期代际 */
  pushGeneration: number;
};

type PersistedStorm = Omit<StormEntry, 'finalWritten'>;
type PersistedEntry = {
  lastPushAtMs: number;
  suppressedCount: number;
  storm?: PersistedStorm | null;
};
type PersistedState = Record<string, PersistedEntry>;

const memoryState = new Map<string, AggregatorEntry>();
let flushTimer: NodeJS.Timeout | null = null;
let dirty = false;
let dirtyGeneration = 0;
let loadPromise: Promise<void> | null = null;

/** 同一 signature 的评估串行化：并发告警不能各插一行、各推一次。 */
const signatureQueues = new Map<string, Promise<void>>();

function withSignatureLock<T>(signature: string, task: () => Promise<T>): Promise<T> {
  const previous = signatureQueues.get(signature) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.then(() => undefined, () => undefined);
  signatureQueues.set(signature, tail);
  void tail.finally(() => {
    if (signatureQueues.get(signature) === tail) signatureQueues.delete(signature);
  });
  return result;
}

/** flush 全局串行化，避免定时器刷写与评估内刷写交错。 */
let flushChain: Promise<void> = Promise.resolve();

function withFlushLock<T>(task: () => Promise<T>): Promise<T> {
  const result = flushChain.then(task, task);
  flushChain = result.then(() => undefined, () => undefined);
  return result;
}

function normalizeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw;
}

/** 签名只用 level + title：同一类故障天然合并，不受模型/原因文本差异影响。 */
export function buildAggregatedSignature(level: string, title: string): string {
  return [normalizeText(level, 32).toLowerCase(), normalizeText(title, 120)].join('||');
}

/** 单飞加载：重启后第一波并发告警只读一次 settings，且必须等加载完成再判定窗口。 */
function loadPersistedState(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const row = await db.select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, AGGREGATOR_STATE_SETTING_KEY))
        .get();
      if (!row?.value) return;
      let parsed: PersistedState;
      try {
        parsed = JSON.parse(row.value) as PersistedState;
      } catch (jsonError) {
        // JSON 损坏时从零开始，绝不影响告警主链路
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const nowMs = Date.now();
      for (const [key, value] of Object.entries(parsed)) {
        const lastPushAtMs = Number(value?.lastPushAtMs);
        if (!Number.isFinite(lastPushAtMs) || lastPushAtMs <= 0) continue;
        const entry: AggregatorEntry = {
          lastPushAtMs,
          suppressedCount: Number(value.suppressedCount) || 0,
          storm: null,
          pushGeneration: 0,
        };
        const storm = value.storm;
        if (
          storm
          && Number.isFinite(storm.eventId)
          && storm.eventId > 0
          && storm.meta
          && (nowMs - Number(storm.lastAtMs || 0)) <= STORM_CLOSE_MS
        ) {
          entry.storm = {
            eventId: Number(storm.eventId),
            count: Number(storm.count) || 1,
            models: Array.isArray(storm.models) ? storm.models.filter((item) => typeof item === 'string') : [],
            reasons: Array.isArray(storm.reasons) ? storm.reasons.filter((item) => typeof item === 'string') : [],
            firstAtMs: Number(storm.firstAtMs) || nowMs,
            lastAtMs: Number(storm.lastAtMs) || nowMs,
            active: true,
            finalWritten: false,
            meta: storm.meta,
          };
        }
        memoryState.set(key, entry);
      }
    } catch (dbError) {
      // DB 错误不缓存，允许下次重试（不重置内存态，但 loadPromise 也不会再排队）
      loadPromise = null;
    }
  })();
  return loadPromise;
}

async function persistState(): Promise<void> {
  const payload: PersistedState = {};
  for (const [key, value] of memoryState.entries()) {
    const entry: PersistedEntry = {
      lastPushAtMs: value.lastPushAtMs,
      suppressedCount: value.suppressedCount,
    };
    if (value.storm && value.storm.eventId > 0) {
      const { finalWritten: _finalWritten, ...storm } = value.storm;
      entry.storm = storm;
    }
    payload[key] = entry;
  }
  await upsertSetting(AGGREGATOR_STATE_SETTING_KEY, payload);
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushAggregatedState();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

export function buildStormMessage(baseMessage: string, storm: StormEntry | null): string {
  const models = storm?.models.length ? storm.models.join(' / ') : '';
  const lastReason = storm?.reasons.length ? storm.reasons[storm.reasons.length - 1] : '';
  const lines = [baseMessage];
  if (storm && storm.count > 1) {
    lines.push(`[风暴聚合] 已累计 ${storm.count} 次${models ? `，涉及模型：${models}` : ''}`);
    if (lastReason) lines.push(`最近原因：${lastReason}`);
  } else if (models) {
    lines.push(`涉及模型：${models}`);
  }
  return lines.join('\n');
}

function pushCapped(list: string[], value: string): void {
  if (!value) return;
  if (list.includes(value)) return;
  if (list.length >= MAX_TRACKED_MODELS) return;
  list.push(value);
}

function closeExpiredStorm(entry: AggregatorEntry, nowMs: number): void {
  const storm = entry.storm;
  if (!storm || !storm.active) return;
  if ((nowMs - storm.lastAtMs) <= STORM_CLOSE_MS) return;
  storm.active = false;
  // 封板写回推迟到 flush 锁内，避免与定时器并发双插
  dirtyGeneration += 1;
  dirty = true;
}

/**
 * 把风暴计数刷写到 events 行。
 * UPDATE 影响 0 行时先 SELECT 确认行是否存在：不存在才重插（修复 SQLite 幽灵行问题）。
 * 行不存在时不设置 finalWritten，使封板状态可在新行上继续完成。
 */
async function writeStormRow(entry: AggregatorEntry): Promise<void> {
  const storm = entry.storm;
  if (!storm || storm.eventId <= 0) return;

  const message = buildStormMessage(storm.meta.baseMessage, storm);
  const result = await db.update(schema.events)
    .set({ message })
    .where(eq(schema.events.id, storm.eventId))
    .run();
  const changes = Number((result as { changes?: number } | null | undefined)?.changes ?? 0);

  if (changes > 0) {
    if (!storm.active) storm.finalWritten = true;
    return;
  }

  // UPDATE 影响 0 行：先 SELECT 确认是否存在
  const existing = await db.select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.id, storm.eventId))
    .get();
  if (existing) {
    // 行存在但 UPDATE 无影响（SQLite 某些情况），视为已写入
    if (!storm.active) storm.finalWritten = true;
    return;
  }

  // 行不存在：重插一条
  const created = await insertAndGetById<{ id: number }>({
    table: schema.events,
    idColumn: schema.events.id,
    values: {
      type: storm.meta.type,
      title: storm.meta.title,
      message,
      level: storm.meta.level,
      relatedType: storm.meta.relatedType,
    },
    insertErrorMessage: 'failed to re-create aggregated alert event row',
  });
  storm.eventId = created.id;
  storm.finalWritten = false;
}

/**
 * 把内存中的风暴计数刷写到数据库。任何一步失败都保留 dirty，下个周期重试；
 * 崩溃最多丢失一个刷新周期（5 秒）的计数，不影响冷却窗口语义。
 */
export async function flushAggregatedState(): Promise<void> {
  return withFlushLock(async () => {
    if (!dirty) return;
    const snapshotGeneration = dirtyGeneration;
    let ok = true;
    for (const entry of memoryState.values()) {
      if (!entry.storm) continue;
      // 封板写回放进 flush 锁内：写失败不替换旧 storm，避免计数丢失
      if (!entry.storm.active && entry.storm.eventId > 0 && !entry.storm.finalWritten) {
        try {
          await writeStormRow(entry);
        } catch {
          ok = false;
        }
      }
      if (!entry.storm) continue;
      if (!entry.storm.active && entry.storm.finalWritten) continue;
      try {
        await writeStormRow(entry);
      } catch {
        ok = false;
      }
    }
    try {
      await persistState();
    } catch {
      ok = false;
    }
    if (!ok) {
      dirty = true;
      return;
    }
    // 仅在代数未变时清 dirty，await 期间新写入不会丢失
    if (dirtyGeneration === snapshotGeneration) {
      dirty = false;
    }
  });
}

export type AggregatedNotificationDecision = {
  shouldPush: boolean;
  mergedCount: number;
  message: string;
  models: string[];
  count: number;
};

/**
 * 评估一次告警是否应当推送，并维护对应的 events 风暴行。
 * 同一 signature 的调用在进程内串行执行，避免并发占坑竞态。
 * 未配置冷却（notifyCooldownSec = 0）时退化为逐条处理，保持历史行为。
 */
export async function evaluateAggregatedNotification(input: {
  level: string;
  title: string;
  message: string;
  eventType?: string;
  relatedType?: string;
  model?: string | null;
  reason?: string | null;
}): Promise<AggregatedNotificationDecision> {
  const signature = buildAggregatedSignature(input.level, input.title);
  return withSignatureLock(signature, async () => {
    await loadPersistedState();

    const cooldownMs = Math.max(0, Math.trunc(config.notifyCooldownSec)) * 1000;
    const model = normalizeText(input.model, 80);
    const reason = normalizeText(input.reason, 200);
    const nowMs = Date.now();

    if (cooldownMs <= 0) {
      // 历史行为：逐条落库 + 逐条推送，消息中心不因聚合而空窗
      try {
        await insertAndGetById<{ id: number }>({
          table: schema.events,
          idColumn: schema.events.id,
          values: {
            type: input.eventType || 'proxy',
            title: input.title,
            message: input.message,
            level: input.level,
            relatedType: input.relatedType || 'route',
          },
          insertErrorMessage: 'failed to create alert event row',
        });
      } catch {
        // 事件行写失败不影响推送
      }
      return {
        shouldPush: true,
        mergedCount: 0,
        message: input.message,
        models: model ? [model] : [],
        count: 1,
      };
    }

    let entry = memoryState.get(signature);
    if (!entry) {
      entry = { lastPushAtMs: 0, suppressedCount: 0, storm: null, pushGeneration: 0 };
      memoryState.set(signature, entry);
    }

    const withinCooldown = (nowMs - entry.lastPushAtMs) < cooldownMs;
    closeExpiredStorm(entry, nowMs);

    const stormExpired = !entry.storm
      || !entry.storm.active
      || (nowMs - entry.storm.lastAtMs) > STORM_CLOSE_MS;
    if (stormExpired) {
      entry.storm = {
        eventId: 0,
        count: 0,
        models: [],
        reasons: [],
        firstAtMs: nowMs,
        lastAtMs: nowMs,
        active: true,
        finalWritten: false,
        meta: {
          level: input.level,
          title: input.title,
          type: input.eventType || 'proxy',
          relatedType: input.relatedType || 'route',
          baseMessage: input.message,
        },
      };
    }

    const storm = entry.storm as StormEntry;
    storm.count += 1;
    storm.lastAtMs = nowMs;
    storm.active = true;
    pushCapped(storm.models, model);
    if (reason) {
      if (storm.reasons.length < MAX_TRACKED_REASONS) {
        if (storm.reasons[storm.reasons.length - 1] !== reason) storm.reasons.push(reason);
      } else if (storm.reasons[storm.reasons.length - 1] !== reason) {
        storm.reasons[storm.reasons.length - 1] = reason;
      }
    }
    dirtyGeneration += 1;
    dirty = true;
    ensureFlushTimer();

    if (storm.eventId <= 0) {
      try {
        const created = await insertAndGetById<{ id: number }>({
          table: schema.events,
          idColumn: schema.events.id,
          values: {
            type: storm.meta.type,
            title: storm.meta.title,
            message: storm.meta.baseMessage,
            level: storm.meta.level,
            relatedType: storm.meta.relatedType,
          },
          insertErrorMessage: 'failed to create aggregated alert event row',
        });
        storm.eventId = created.id;
      } catch {
        storm.eventId = 0;
      }
    }

    if (withinCooldown) {
      entry.suppressedCount += 1;
      dirtyGeneration += 1;
      await flushAggregatedState();
      return {
        shouldPush: false,
        mergedCount: entry.suppressedCount,
        message: buildStormMessage(storm.meta.baseMessage, storm),
        models: [...storm.models],
        count: storm.count,
      };
    }

    entry.lastPushAtMs = nowMs;
    entry.suppressedCount = 0;
    entry.pushGeneration = (entry.pushGeneration || 0) + 1;
    dirtyGeneration += 1;
    await flushAggregatedState();
    return {
      shouldPush: true,
      mergedCount: Math.max(0, storm.count - 1),
      message: buildStormMessage(storm.meta.baseMessage, storm),
      models: [...storm.models],
      count: storm.count,
    };
  });
}

/**
 * 推送失败时释放冷却窗口，避免一次发送失败把整个冷静期消耗掉。
 * 仅当代际仍匹配时才释放（防止迟到 release 覆盖更新后的成功窗口）；
 * 窗口改为 now-cooldown+60s 而不是写 0，避免下一条代理失败立刻再推。
 */
export async function releaseAggregatedPushWindow(level: string, title: string, pushGeneration: number): Promise<void> {
  const signature = buildAggregatedSignature(level, title);
  await withSignatureLock(signature, async () => {
    await loadPersistedState();
    const entry = memoryState.get(signature);
    if (!entry) return;
    const cooldownMs = Math.max(0, Math.trunc(config.notifyCooldownSec)) * 1000;
    // 仅当代际仍匹配时才释放（防止迟到 release 覆盖更新后的成功窗口）
    if (entry.pushGeneration !== pushGeneration) return;
    entry.lastPushAtMs = Math.max(0, Date.now() - cooldownMs + 60_000);
    entry.suppressedCount = 0;
    dirtyGeneration += 1;
    dirty = true;
    await flushAggregatedState();
  });
}

/**
 * 仅测试使用：读取内存中的聚合器状态。
 */
export function getAggregatorEntry(signature: string): { pushGeneration: number; lastPushAtMs: number } | undefined {
  const entry = memoryState.get(signature);
  if (!entry) return undefined;
  return { pushGeneration: entry.pushGeneration, lastPushAtMs: entry.lastPushAtMs };
}

/** 仅测试使用：清空内存与持久化状态。 */
export async function resetAggregatedNotificationState(): Promise<void> {
  memoryState.clear();
  dirty = false;
  dirtyGeneration = 0;
  loadPromise = null;
  signatureQueues.clear();
  flushChain = Promise.resolve();
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
