/**
 * 「上游钉选适配器映射」：存储/编译双形态 + 热路径解析（按站点选择注入适配器）。
 *
 * 双形态约定（与 rules 同构）：
 * - 存储形态：settings 键 `upstream_provider_pin_adapter_map` 下永远是原始 JSON 对象，
 *   键 = siteId 数字字符串（如 `{"49":"openrouter"}`），值 = 适配器 id；PUT/GET 也按该形状收发。
 * - 内存形态：`config.upstreamProviderPinAdapterMap` 持有编译产物 `Record<number, string>`。
 *   值类型放宽为 string：**未注册 id 必须存活到热路径**（M2：解析失败 → 零注入，绝不回落
 *   双姿势）；合法集合唯一事实源 = adapters/registry 键集（UPSTREAM_PIN_ADAPTER_IDS），
 *   `UpstreamPinAdapterId` 联合类型仅编译期便利。
 *
 * 三函数：
 * - `normalizeUpstreamPinAdapterMap`（宽松：hydration / env / 导入）：丢非法键值、保留未注册 id；
 * - `parseUpstreamPinAdapterMap`（严格 PUT）：键非正整数 / 值不在注册集合 / 归一后重复 → 400 中文报错；
 * - `resolveUpstreamPinAdapter`（热路径）：未配置站点 → generic-dual；未注册 id → 零注入；total 不抛。
 *
 * 键归一与 rules.ts `normalizeSiteId` 的**有意差异**：适配器映射的键是站点身份标识且必须稳定
 * 往返，不做小数截断——`"49.9"` 丢弃（而不是归一为 49，避免别名劫持 49 号站点的适配器）；
 * `"049"` / `"49 "` 归一为 49（归一后冲突保留先出现者，对齐 rules 宽松归一的去重口径；
 * 严格 PUT 对归一后重复直接 400，对齐 rules 严格校验的判重口径）。
 */
import { config } from '../../config.js';
import {
  GENERIC_DUAL_ADAPTER,
  UPSTREAM_PIN_ADAPTER_IDS,
  ZERO_INJECTION_ADAPTER,
  getUpstreamPinAdapter,
  isUpstreamPinAdapterId,
} from './adapters/registry.js';
import type { UpstreamPinAdapter, UpstreamPinAdapterId } from './adapters/types.js';

/** 编译形态：siteId → 适配器 id（值放宽为 string，未注册 id 存活到热路径兜底）。 */
export type CompiledUpstreamPinAdapterMap = Record<number, string>;

/** 存储/回显形态：站点 id 数字键归一为字符串键的原始 JSON 对象。 */
export type StoredUpstreamPinAdapterMap = Record<string, string>;

export type UpstreamPinAdapterMapParseResult =
  | { ok: true; map: Record<number, UpstreamPinAdapterId> }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 映射键归一：站点 id 只接受正整数。字符串键 trim 后按数值判定；
 * 小数（'49.9'）与 0/负数/非数一律丢弃（不做截断，见文件头口径说明）。
 */
function normalizeAdapterMapKey(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    return numeric;
  }
  return null;
}

/** 宽松值归一：非空字符串原样保留（含未注册 id，M2 兜底依赖其存活）；其余丢弃。 */
function normalizeAdapterMapValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function coerceAdapterMapObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isPlainObject(value) ? value : null;
}

/**
 * 宽松归一（hydration / env / 导入）：接受原始对象（string 时先 JSON.parse），
 * 丢弃非法键与非法值；同一 siteId 归一后出现多个键时保留先出现者；
 * **未注册 id 原样保留**（热路径零注入兜底，绝不静默回落 generic-dual）。
 * 非法/空输入一律返回 {}（= 全站点默认双姿势）。
 */
export function normalizeUpstreamPinAdapterMap(value: unknown): CompiledUpstreamPinAdapterMap {
  const rawObject = coerceAdapterMapObject(value);
  if (!rawObject) return {};

  const result: CompiledUpstreamPinAdapterMap = {};
  for (const [rawKey, rawValue] of Object.entries(rawObject)) {
    const siteId = normalizeAdapterMapKey(rawKey);
    if (siteId === null) continue;
    const adapterId = normalizeAdapterMapValue(rawValue);
    if (adapterId === null) continue;
    if (Object.prototype.hasOwnProperty.call(result, siteId)) continue;
    result[siteId] = adapterId;
  }
  return result;
}

/**
 * 严格校验（PUT）：string 输入先 JSON.parse（失败归为校验失败），再逐项严格校验。
 * 键必须归一为正整数站点 id、值必须命中注册表键集；归一后重复键判 400。
 * 成功输出 = 编译形态（siteId → 已注册 id）。
 * **不校验** siteId 是否存在于站点表：备份导入全量应用链路无站点白名单，
 * 站点删除后残留行保持合法（O6）。
 */
export function parseUpstreamPinAdapterMap(value: unknown): UpstreamPinAdapterMapParseResult {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      raw = {};
    } else {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return { ok: false, message: '上游钉选适配器映射不是合法的 JSON' };
      }
    }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, message: '上游钉选适配器映射必须是对象' };
  }

  const supportedIds = UPSTREAM_PIN_ADAPTER_IDS.join('、');
  const map: Record<number, UpstreamPinAdapterId> = {};
  const firstRawKeyBySiteId = new Map<number, string>();

  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const siteId = normalizeAdapterMapKey(rawKey);
    if (siteId === null) {
      return { ok: false, message: `站点键「${rawKey}」必须是正整数站点 id` };
    }
    const previousRawKey = firstRawKeyBySiteId.get(siteId);
    if (previousRawKey !== undefined) {
      return {
        ok: false,
        message: `站点键「${rawKey}」与「${previousRawKey}」归一为同一站点 id（${siteId}），存在重复`,
      };
    }
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      return { ok: false, message: `站点 ${siteId} 的适配器必须是 ${supportedIds} 之一` };
    }
    const adapterId = rawValue.trim();
    if (!isUpstreamPinAdapterId(adapterId)) {
      return {
        ok: false,
        message: `站点 ${siteId} 的适配器「${adapterId}」不在支持列表（${supportedIds}）中`,
      };
    }
    firstRawKeyBySiteId.set(siteId, rawKey);
    map[siteId] = adapterId;
  }

  return { ok: true, map };
}

/**
 * 把编译形态还原为存储/回显形态（对齐 `toUpstreamProviderPinStoredRules` 口径）：
 * 键统一为数字字符串（可稳定往返、重启等价），值原样保留（含未注册 id）。
 */
export function toStoredAdapterMap(
  map: Readonly<CompiledUpstreamPinAdapterMap> | null | undefined,
): StoredUpstreamPinAdapterMap {
  if (!isPlainObject(map)) return {};
  const stored: StoredUpstreamPinAdapterMap = {};
  for (const [rawKey, rawValue] of Object.entries(map)) {
    const siteId = normalizeAdapterMapKey(rawKey);
    if (siteId === null) continue;
    const adapterId = normalizeAdapterMapValue(rawValue);
    if (adapterId === null) continue;
    stored[String(siteId)] = adapterId;
  }
  return stored;
}

/**
 * 热路径适配器解析（total：畸形/未注册输入一律不抛）：
 * - siteId 非法或未配置映射 → `generic-dual`（逐字节回基线）；
 * - 命中且 id 已注册 → 该适配器；
 * - 命中但 id 未注册（版本回滚/已下线适配器）→ 零注入适配器（等同 none），
 *   **不回落 generic-dual**：向未知网关写双姿势 body 可能被透传给真厂商，宁可零注入。
 */
export function resolveUpstreamPinAdapter(siteId: number | null): UpstreamPinAdapter {
  const normalizedSiteId = normalizeAdapterMapKey(siteId);
  if (normalizedSiteId === null) return GENERIC_DUAL_ADAPTER;

  const rawMap: unknown = config.upstreamProviderPinAdapterMap;
  if (!isPlainObject(rawMap)) return GENERIC_DUAL_ADAPTER;

  const rawAdapterId = rawMap[normalizedSiteId];
  const adapterId = normalizeAdapterMapValue(rawAdapterId);
  if (adapterId === null) return GENERIC_DUAL_ADAPTER;

  return getUpstreamPinAdapter(adapterId) ?? ZERO_INJECTION_ADAPTER;
}
