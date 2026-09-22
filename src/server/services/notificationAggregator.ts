import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { config } from '../config.js';

const isTestEnv = (): boolean => {
  if (typeof process !== 'undefined' && (process as any).env?.NODE_ENV === 'test') return true;
  if (typeof import.meta !== 'undefined' && (import.meta as any).env?.MODE === 'test') return true;
  return false;
};

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
  pendingStorm: StormEntry | null;
};

/**
 * 持久化风暴条目，与内存中的 StormEntry 完全一致。
 * finalWritten 必须落库：重启后要据此区分"旧风暴已封板、可随过期一起丢弃"与
 * "旧风暴未封板、必须恢复并重试封板"，否则整段新风暴会随旧风暴一起被丢弃。
 */
type PersistedStorm = StormEntry;
type PersistedEntry = {
  lastPushAtMs: number;
  suppressedCount: number;
  pushGeneration: number;
  storm?: PersistedStorm | null;
  /** 尚未发布的下一段风暴：已插入 events 行但还没替换旧 storm，崩溃后必须可恢复 */
  pendingStorm?: PersistedStorm | null;
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
      if (isTestEnv() && typeof globalThis.__metapi_test_simulate_db_error === 'boolean' && globalThis.__metapi_test_simulate_db_error) {
        globalThis.__metapi_test_simulate_db_error = false;
        throw new Error('SQLITE_BUSY');
      }
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
          pushGeneration: Number(value.pushGeneration) || 0,
          pendingStorm: null,
        };
        // M2: 旧风暴未封板（finalWritten=false）即使已超过 STORM_CLOSE_MS 也要恢复，
        // 让 flush 能重试封板；仅丢弃已封板的旧风暴。若连同 pendingStorm 一起丢弃，
        // 崩溃/重启会静默丢掉整段新风暴（含已插入 events 行的计数）。
        const storm = restoreStorm(value.storm, nowMs, false);
        if (storm) entry.storm = storm;
        // M2: pendingStorm 与 storm 一样必须恢复，否则重启后上一段计数与 eventId 丢失。
        const pendingStorm = restoreStorm(value.pendingStorm, nowMs, true);
        if (pendingStorm) entry.pendingStorm = pendingStorm;
        // 有待重试的封板/发布时标记 dirty，重启后即使没有新告警也能在下一个周期完成写回
        if (entry.pendingStorm || (entry.storm && !entry.storm.finalWritten)) {
          dirtyGeneration += 1;
          dirty = true;
          // 静默重启（没有新告警触发评估）时也必须启动 flush 定时器，否则 dirty 永远
          // 等不到写回，events 行会停在 baseMessage。flush 成功后清 dirty，不会形成
          // 写放大循环；定时器本身是单例（ensureFlushTimer 内部判重）。
          ensureFlushTimer();
        }
        memoryState.set(key, entry);
      }
    } catch (dbError) {
      // DB 错误不缓存，允许下次重试（不重置内存态，但 loadPromise 也不会再排队）
      loadPromise = null;
      throw dbError;
    }
  })();
  return loadPromise;
}

/**
 * 从持久化 JSON 还原风暴条目。
 * - storm：未封板的一律恢复（哪怕已过期），已封板的过期风暴才丢弃；
 * - pendingStorm：同样一律恢复，它是"已插入 events 行但尚未发布"的计数，丢了就是静默丢数据。
 */
function restoreStorm(value: PersistedStorm | null | undefined, nowMs: number, isPending: boolean): StormEntry | null {
  if (!value || typeof value !== 'object') return null;
  const eventId = Number(value.eventId);
  if (!Number.isFinite(eventId) || eventId <= 0) return null;
  if (!value.meta || typeof value.meta !== 'object') return null;
  const finalWritten = value.finalWritten === true;
  // pendingStorm 永远保留；旧 storm 仅在"已封板且已过期"时丢弃
  if (!isPending && finalWritten && (nowMs - Number(value.lastAtMs || 0)) > STORM_CLOSE_MS) return null;
  return {
    eventId,
    count: Number(value.count) || 1,
    models: Array.isArray(value.models) ? value.models.filter((item) => typeof item === 'string') : [],
    reasons: Array.isArray(value.reasons) ? value.reasons.filter((item) => typeof item === 'string') : [],
    firstAtMs: Number(value.firstAtMs) || nowMs,
    lastAtMs: Number(value.lastAtMs) || nowMs,
    // 过期风暴恢复为非 active，等 closeExpiredStorm/下一次评估时走封板路径
    active: isPending ? true : (nowMs - Number(value.lastAtMs || 0)) <= STORM_CLOSE_MS,
    finalWritten,
    meta: value.meta,
  };
}

async function persistState(): Promise<void> {
  const payload: PersistedState = {};
  for (const [key, value] of memoryState.entries()) {
    const entry: PersistedEntry = {
      lastPushAtMs: value.lastPushAtMs,
      suppressedCount: value.suppressedCount,
      pushGeneration: value.pushGeneration,
    };
    if (value.storm && value.storm.eventId > 0) {
      entry.storm = { ...value.storm };
    }
    // M2: pendingStorm 必须落库，否则进程崩溃/重启后上一段风暴（连同已插入的
    // events 行与计数）会被静默丢弃——"最多丢 5 秒"的说法不成立。
    if (value.pendingStorm && value.pendingStorm.eventId > 0) {
      entry.pendingStorm = { ...value.pendingStorm };
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
async function writeStormRow(entry: AggregatorEntry, stormOverride?: StormEntry): Promise<void> {
  const storm = stormOverride ?? entry.storm;
  if (!storm || storm.eventId <= 0) return;

  if (isTestEnv() && typeof globalThis.__metapi_test_simulate_write_error === 'boolean' && globalThis.__metapi_test_simulate_write_error) {
    globalThis.__metapi_test_simulate_write_error = false;
    throw new Error('simulated write error');
  }

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
      let pendingSeal = false;

      // 封板写回放进 flush 锁内：写失败不替换旧 storm，避免计数丢失
      if (entry.pendingStorm && entry.storm && !entry.storm.active && entry.storm.eventId > 0 && !entry.storm.finalWritten) {
        try {
          await writeStormRow(entry, entry.storm);
        } catch {
          ok = false;
          pendingSeal = true;
        }
        if (!pendingSeal) {
          entry.storm.finalWritten = true;
        }
      }

      if (pendingSeal) continue;

      // 写成功后发布新 storm
      if (entry.pendingStorm) {
        entry.storm = entry.pendingStorm;
        entry.pendingStorm = null;
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
    try {
      await loadPersistedState();
    } catch {
      // DB 错误不推送、不落盘，正常返回
      return {
        shouldPush: false,
        mergedCount: 0,
        message: input.message,
        models: [],
        count: 1,
      };
    }

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
      entry = { lastPushAtMs: 0, suppressedCount: 0, storm: null, pushGeneration: 0, pendingStorm: null };
      memoryState.set(signature, entry);
    }

    const withinCooldown = (nowMs - entry.lastPushAtMs) < cooldownMs;
    closeExpiredStorm(entry, nowMs);

    const stormExpired = !entry.storm
      || !entry.storm.active
      || (nowMs - entry.storm.lastAtMs) > STORM_CLOSE_MS;
    // M1: 旧 storm 已 inactive 但上一段 pendingStorm 还没发布（封板写失败、或进程刚恢复）时，
    // 必须续写原对象而不是无条件新建：新建会丢掉 pendingStorm 连同它已插入的 events 行与
    // 计数，并再 insert 一条孤儿行（旧行永远停在 baseMessage、count 回 1）。
    // 新 storm 的发布权只属于 flush：封板写成功后才替换旧 storm。
    if (stormExpired && !entry.pendingStorm) {
      entry.pendingStorm = {
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

    const storm = (entry.pendingStorm ?? entry.storm) as StormEntry;
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
        const previousEventId = storm.eventId;
        storm.eventId = created.id;
        if (previousEventId !== storm.eventId) {
          dirtyGeneration += 1;
        }
      } catch {
        const previousEventId = storm.eventId;
        storm.eventId = 0;
        if (previousEventId !== 0) {
          dirtyGeneration += 1;
        }
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
