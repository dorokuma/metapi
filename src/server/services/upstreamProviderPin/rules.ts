/**
 * 「上游供应商钉选注入」规则：归一（宽松）、严格校验（PUT）与热路径解析门禁。
 *
 * 规则双形态约定（全链路遵守）：
 * - 存储形态：settings 表 `upstream_provider_pin_rules` 键下永远是原始 JSON 数组，
 *   元素形状 = `{ siteId, model, providers, mode }` 四字段，不含 matcher/正则等编译产物；
 *   PUT/GET 也按该形状收发。
 * - 内存形态：`config.upstreamProviderPinRules` 持有编译产物（每条规则带预编译 matcher），
 *   供热路径 `resolveUpstreamProviderPin` 直接使用；hydration / env 解析各编译一次，
 *   运行期不构造正则。
 *
 * 匹配语义：匹配对象是下游请求模型（`resolveRequestedModelForPayloadRules` 的结果，
 * 不是实际发往上游的 actualModel）；`model` 支持精确字符串或 `*` 通配，全串锚定、
 * 大小写敏感、`*` 展开为转义后的 `.*`；多规则命中时数组顺序首个生效。
 */

import { config } from '../../config.js';

export type UpstreamProviderPinMode = 'only' | 'order';

/** 存储/回显形态：settings 表、PUT 请求与 GET 响应共用的四字段原始形状。 */
export type UpstreamProviderPinStoredRule = {
  siteId: number;
  model: string;
  providers: string[];
  mode: UpstreamProviderPinMode;
};

/** 内存/config 形态：四字段 + 归一化期预编译的 matcher（禁止热路径 new RegExp）。 */
export type UpstreamProviderPinRule = UpstreamProviderPinStoredRule & {
  match: (model: string) => boolean;
};

/** 热路径命中的注入目标。 */
export type UpstreamProviderPinTarget = {
  providers: string[];
  mode: UpstreamProviderPinMode;
};

export type UpstreamProviderPinParseResult =
  | { ok: true; rules: UpstreamProviderPinStoredRule[] }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 与 `normalizeUpstreamProviderDetectSiteIds` 同款归一：正整数（数字/数字字符串），非法返回 null。 */
function normalizeSiteId(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const truncated = Math.trunc(value);
    return truncated > 0 ? truncated : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    const truncated = Math.trunc(numeric);
    return truncated > 0 ? truncated : null;
  }
  return null;
}

/** trim、去空、去重；数组或逗号分隔字符串（宽松归一场景）。 */
function normalizeProviders(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,，]/) : []);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of rawItems) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeMode(value: unknown): UpstreamProviderPinMode | null {
  return value === 'only' || value === 'order' ? value : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化期预编译 matcher：无 `*` 走字符串精确比较，有 `*` 编译一次全串锚定正则。 */
function compileModelMatcher(pattern: string): (model: string) => boolean {
  if (!pattern.includes('*')) {
    return (model: string) => model === pattern;
  }
  const compiled = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return (model: string) => compiled.test(model);
}

function coerceRuleArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 宽松归一（hydration / env 解析 / 导入）：接受原始四字段形状（string 时先 JSON.parse），
 * 丢弃非法项、按 siteId+model 去重，输出携带预编译 matcher 的编译形态。
 * 非法/空输入一律返回空数组（= 不注入）。
 */
export function normalizeUpstreamProviderPinRules(value: unknown): UpstreamProviderPinRule[] {
  const rawItems = coerceRuleArray(value);
  const seen = new Set<string>();
  const rules: UpstreamProviderPinRule[] = [];

  for (const item of rawItems) {
    if (!isRecord(item)) continue;
    const siteId = normalizeSiteId(item.siteId);
    if (siteId === null) continue;
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    if (!model) continue;
    const providers = normalizeProviders(item.providers);
    if (providers.length === 0) continue;
    const mode = normalizeMode(item.mode);
    if (mode === null) continue;
    const dedupeKey = `${siteId}\u0000${model}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rules.push({
      siteId,
      model,
      providers,
      mode,
      match: compileModelMatcher(model),
    });
  }

  return rules;
}

/**
 * 严格校验（PUT）：string 输入先 JSON.parse（失败归为校验失败），再逐项严格校验。
 * 失败一律返回具体中文 message；成功的输出是原始四字段形状（不含编译产物）。
 */
export function parseUpstreamProviderPinRules(value: unknown): UpstreamProviderPinParseResult {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      raw = [];
    } else {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return { ok: false, message: '上游钉选注入规则不是合法的 JSON' };
      }
    }
  }

  if (!Array.isArray(raw)) {
    return { ok: false, message: '上游钉选注入规则必须是数组' };
  }

  const rules: UpstreamProviderPinStoredRule[] = [];
  const firstIndexByKey = new Map<string, number>();

  for (let index = 0; index < raw.length; index += 1) {
    const item: unknown = raw[index];
    const position = `第 ${index + 1} 条规则`;
    if (!isRecord(item)) {
      return { ok: false, message: `${position}必须是对象` };
    }

    const siteId = normalizeSiteId(item.siteId);
    if (siteId === null) {
      return { ok: false, message: `${position}的 siteId 必须是正整数` };
    }

    if (typeof item.model !== 'string') {
      return { ok: false, message: `${position}的 model 必须是字符串` };
    }
    const model = item.model.trim();
    if (!model) {
      return { ok: false, message: `${position}的 model 不能为空` };
    }

    if (!Array.isArray(item.providers)) {
      return { ok: false, message: `${position}的 providers 必须是字符串数组` };
    }
    if (item.providers.some((provider) => typeof provider !== 'string')) {
      return { ok: false, message: `${position}的 providers 只能包含字符串` };
    }
    const providers = normalizeProviders(item.providers);
    if (providers.length === 0) {
      return { ok: false, message: `${position}的 providers 不能为空` };
    }

    const mode = normalizeMode(item.mode);
    if (mode === null) {
      return { ok: false, message: `${position}的 mode 只能是 only 或 order` };
    }

    const dedupeKey = `${siteId}\u0000${model}`;
    const firstIndex = firstIndexByKey.get(dedupeKey);
    if (firstIndex !== undefined) {
      return {
        ok: false,
        message: `${position}存在重复规则：与第 ${firstIndex + 1} 条的站点和模型完全相同`,
      };
    }
    firstIndexByKey.set(dedupeKey, index);

    rules.push({ siteId, model, providers, mode });
  }

  return { ok: true, rules };
}

/** 把内存/config 形态（或任意超集形状）还原为存储/回显的四字段原始形状。 */
export function toUpstreamProviderPinStoredRules(
  rules: readonly (UpstreamProviderPinStoredRule | UpstreamProviderPinRule)[],
): UpstreamProviderPinStoredRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule) => ({
    siteId: rule.siteId,
    model: rule.model,
    providers: [...rule.providers],
    mode: rule.mode,
  }));
}

/**
 * 热路径门禁与解析：总开关关闭、规则数组为空、siteId 不命中或模型不匹配时返回 null。
 * 小数组线性扫描 + 预编译 matcher，成本与 `isUpstreamProviderDetectSiteSelected` 同级。
 */
export function resolveUpstreamProviderPin(input: {
  siteId: number | null | undefined;
  requestedModel: string;
}): UpstreamProviderPinTarget | null {
  if (config.upstreamProviderPinEnabled !== true) return null;

  const rules = config.upstreamProviderPinRules;
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const siteId = normalizeSiteId(input.siteId);
  if (siteId === null) return null;

  const requestedModel = typeof input.requestedModel === 'string'
    ? input.requestedModel.trim()
    : '';
  // 空匹配键不注入（生产链路 requestedModel 由 modelName 兜底非空；空值视为异常输入，宁可不动请求）。
  if (!requestedModel) return null;

  for (const rule of rules) {
    if (!rule || rule.siteId !== siteId) continue;
    if (typeof rule.match !== 'function' || !rule.match(requestedModel)) continue;
    if (!Array.isArray(rule.providers) || rule.providers.length === 0) continue;
    return { providers: [...rule.providers], mode: rule.mode };
  }

  return null;
}
