import type { RequestInit as UndiciRequestInit } from 'undici';
import { withSiteProxyRequestInit } from './siteProxy.js';
import {
  buildNewApiCookieCandidates,
  fetchJsonWithShieldCookieRetry,
} from './platforms/newApiShield.js';
import {
  evaluateBillingExpr,
  parseBillingExpr,
  type ParsedBillingExpr,
} from './billingExpr.js';

const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;
const PRICE_CACHE_FAILURE_TTL_MS = 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_GROUP = 'default';
const ONE_HUB_PER_CALL_RATIO = 0.002;
const MIN_ROUTING_REFERENCE_COST = 1e-6;
const ROUTING_REFERENCE_USAGE = {
  promptTokens: 500_000,
  completionTokens: 500_000,
  totalTokens: 1_000_000,
};

export interface PricingModel {
  modelName: string;
  quotaType: number;
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  cacheCreationRatio?: number;
  modelPrice: number | { input: number; output: number } | null;
  enableGroups: string[];
  modelDescription?: string | null;
  tags?: string[];
  supportedEndpointTypes?: string[];
  ownerBy?: string | null;
  /** Which pricing path produced the model cost. 'expr' when billing_expr drives it. */
  pricingSource?: 'ratio' | 'expr';
  /** Raw billing expression from the upstream payload (kept for audit/debug). */
  billingExpr?: string | null;
  /** Compiled billing expression AST, only present when the expr path is active. */
  pricingExpr?: ParsedBillingExpr | null;
  /**
   * Set when a billing_expr was present but the ratio path is used anyway (unparseable
   * expression or unsupported billing_mode). Carries the human-readable reason so the
   * fallback is auditable in billing_details instead of silently distorting prices.
   */
  pricingFallbackReason?: string | null;
}

interface PricingData {
  models: Map<string, PricingModel>;
  groupRatio: Record<string, number>;
  /** 费率缓存版本戳（毫秒时间戳），用于 billing_details 审计 */
  fetchedAt: number;
}

export interface ProxyBillingPricingOverride {
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  cacheCreationRatio?: number;
  groupRatio?: number;
}

interface PricingCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  data: PricingData | null;
}

interface RoutingReferenceCostCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  costs: Map<string, number>;
}

export interface EstimateProxyCostInput {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
  modelName: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** 1h-TTL cache-creation tokens, only when upstream reports them separately (drives expr cc1h). */
  cacheCreationTokens1h?: number;
  promptTokensIncludeCache?: boolean | null;
  billingPricingOverride?: ProxyBillingPricingOverride | null;
  /** 请求账号实际 group（来自 account/site/token 配置），优先于 model.enableGroups 遍历 */
  group?: string | null;
}

interface ModelGroupPricing {
  quotaType: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheCreationPerMillion?: number;
  perCallInput?: number;
  perCallOutput?: number;
  perCallTotal?: number;
  /**
   * True when the per-M figures come from a billing_expr evaluated at the base tier
   * (len = 0, the lowest tier) — a static per-group estimate without concrete usage, not
   * the exact per-request price. Set so the UI can label it as an estimate.
   */
  exprEstimate?: boolean;
}

interface ModelPricingCatalogEntry {
  modelName: string;
  quotaType: number;
  modelDescription: string | null;
  tags: string[];
  supportedEndpointTypes: string[];
  ownerBy: string | null;
  enableGroups: string[];
  groupPricing: Record<string, ModelGroupPricing>;
}

interface ModelPricingCatalog {
  models: ModelPricingCatalogEntry[];
  groupRatio: Record<string, number>;
}

export interface ProxyBillingDetails {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** 1h-TTL cache-creation tokens (drives the expr cc1h variable); 0 when untracked. */
    cacheCreationTokens1h: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
    /** Which pricing path produced this cost: 'ratio' or 'expr' (per-call models return null details). */
    pricingSource: 'ratio' | 'expr' | 'fallback' | 'selflog-override';
    /** Raw billing expression actually used, for audit. null when the ratio path was used. */
    billingExpr?: string | null;
    /**
     * True when a billing_expr was present but the ratio path was used instead (silent-fallback
     * audit). Absent on the normal ratio path (no billing_expr) and on the expr path (no fallback).
     */
    exprFallback?: boolean;
    /** Human-readable reason for the ratio fallback (unparseable expr / unsupported mode / eval error). */
    exprFallbackReason?: string;
    /** 费率缓存版本戳（毫秒），用于事后审计同模型多版本费率 */
    pricingFetchedAt?: number;
    /** 兜底原因（fallbackTokenCost 场景） */
    fallbackReason?: string;
    /** 兜底除数（fallbackTokenCost 场景） */
    fallbackDivisor?: number;
    /** 兜底 tokens（fallbackTokenCost 场景） */
    fallbackTokens?: number;
    /** selflog override 与当前定价版本的关系 */
    overrideRelationship?: string;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    /** 1h cache-creation per-M coefficient (expr models with cc1h tracking only). */
    cc1hPerMillion?: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    /** 1h cache-creation cost (expr models with cc1h tracking only); included in totalCost. */
    cc1hCost?: number;
    totalCost: number;
  };
}

const pricingCache = new Map<string, PricingCacheEntry>();
const routingReferenceCostCache = new Map<string, RoutingReferenceCostCacheEntry>();

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function toPositiveInt(value: unknown): number {
  return Math.max(0, Math.round(toNumber(value, 0)));
}

function roundCost(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}

function normalizeModelPrice(value: unknown): number | { input: number; output: number } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;

  const input = toNumber((value as any).input, Number.NaN);
  const output = toNumber((value as any).output, Number.NaN);
  if (Number.isNaN(input) && Number.isNaN(output)) return null;

  return {
    input: Number.isNaN(input) ? 0 : input,
    output: Number.isNaN(output) ? 0 : output,
  };
}

function normalizeGroupRatio(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const ratio = toNumber(value, 1);
      if (ratio > 0) result[key] = ratio;
    }
  }

  if (Object.keys(result).length === 0) {
    result[DEFAULT_GROUP] = 1;
  } else if (!(DEFAULT_GROUP in result)) {
    result[DEFAULT_GROUP] = 1;
  }

  return result;
}

function normalizeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeRatio(value: unknown, fallback: number): number {
  const ratio = toNumber(value, Number.NaN);
  if (Number.isFinite(ratio) && ratio >= 0) return ratio;
  return fallback;
}

function normalizePricingModels(rawModels: unknown[]): Map<string, PricingModel> {
  const models = new Map<string, PricingModel>();

  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object') continue;

    const modelName = String((raw as any).model_name || '').trim();
    if (!modelName) continue;

    const quotaType = toPositiveInt((raw as any).quota_type);
    const modelRatio = toNumber((raw as any).model_ratio, 1);
    const completionRatio = toNumber((raw as any).completion_ratio, 1);
    const cacheRatio = normalizeRatio(
      (raw as any).cache_ratio ?? (raw as any).cacheRatio,
      1,
    );
    const cacheCreationRatio = normalizeRatio(
      (raw as any).cache_creation_ratio
        ?? (raw as any).cacheCreationRatio
        ?? (raw as any).create_cache_ratio
        ?? (raw as any).createCacheRatio,
      1,
    );
    const enableGroupsRaw = (raw as any).enable_groups;
    const enableGroups = Array.isArray(enableGroupsRaw)
      ? enableGroupsRaw.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [DEFAULT_GROUP];
    const modelDescriptionRaw = (raw as any).model_description;
    const modelDescription = typeof modelDescriptionRaw === 'string'
      ? (modelDescriptionRaw.trim() || null)
      : null;
    const tags = normalizeStringArray((raw as any).tags);
    const supportedEndpointTypes = normalizeStringArray((raw as any).supported_endpoint_types);
    const ownerByRaw = (raw as any).owner_by;
    const ownerBy = typeof ownerByRaw === 'string' ? (ownerByRaw.trim() || null) : null;

    // tiered_expr: upstream puts the real per-M price in billing_expr; model_ratio is only
    // a placeholder. Prefer the expression over ratio, and fall back to ratio (with a warning)
    // whenever the expression is absent, malformed, or uses syntax we do not cover.
    const billingExprRaw = (raw as any).billing_expr ?? (raw as any).billingExpr;
    const billingModeRaw = (raw as any).billing_mode ?? (raw as any).billingMode;
    const billingExprStr = typeof billingExprRaw === 'string' ? billingExprRaw.trim() : '';
    const billingModeStr = typeof billingModeRaw === 'string' ? billingModeRaw : '';

    let pricingSource: 'ratio' | 'expr' = 'ratio';
    let pricingExpr: ParsedBillingExpr | null = null;
    let billingExpr: string | null = null;
    let pricingFallbackReason: string | null = null;

    if (billingExprStr) {
      if (billingModeStr === '' || billingModeStr === 'tiered_expr') {
        billingExpr = billingExprStr;
        const compiled = parseBillingExpr(billingExprStr);
        if (compiled) {
          pricingSource = 'expr';
          pricingExpr = compiled;
        } else {
          // Keep billingExpr for audit so the ratio fallback is not silent.
          pricingFallbackReason = `billing_expr not parseable: ${billingExprStr}`;
          console.warn(
            `[model-pricing] model "${modelName}" billing_expr is not parseable, falling back to ratio path: ${billingExprStr}`,
          );
        }
      } else {
        billingExpr = billingExprStr;
        pricingFallbackReason = `unsupported billing_mode "${billingModeStr}"`;
        console.warn(
          `[model-pricing] model "${modelName}" has unsupported billing_mode "${billingModeStr}", falling back to ratio path`,
        );
      }
    }

    const canonicalName = modelName;
    const lowerName = modelName.toLowerCase();
    models.set(lowerName, {
      modelName: canonicalName,
      quotaType,
      modelRatio: modelRatio > 0 ? modelRatio : 1,
      completionRatio: completionRatio > 0 ? completionRatio : 1,
      cacheRatio,
      cacheCreationRatio,
      modelPrice: normalizeModelPrice((raw as any).model_price),
      enableGroups: enableGroups.length > 0 ? enableGroups : [DEFAULT_GROUP],
      modelDescription,
      tags,
      supportedEndpointTypes,
      ownerBy,
      pricingSource,
      billingExpr,
      pricingExpr,
      pricingFallbackReason,
    });
  }

  return models;
}

function unwrapPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  if ('data' in (payload as any)) return (payload as any).data;
  return payload;
}

function normalizeCommonPricingPayload(payload: unknown): PricingData | null {
  const maybeData = unwrapPayload(payload);
  if (!Array.isArray(maybeData)) return null;

  const models = normalizePricingModels(maybeData);
  if (models.size === 0) return null;

  const groupRatio = normalizeGroupRatio((payload as any)?.group_ratio);
  return { models, groupRatio, fetchedAt: Date.now() };
}

function normalizeOneHubPricingPayload(availablePayload: unknown, groupPayload: unknown): PricingData | null {
  const available = unwrapPayload(availablePayload);
  if (!available || typeof available !== 'object') return null;

  const transformed: unknown[] = [];
  for (const [modelName, rawValue] of Object.entries(available as Record<string, unknown>)) {
    const item = rawValue as any;
    const price = item?.price || {};
    const input = toNumber(price.input, 0);
    const output = toNumber(price.output, input);
    const cacheRead = toNumber(
      price.input_cache_read ?? price.inputCacheRead ?? price.cache_read ?? price.cacheRead,
      Number.NaN,
    );
    const cacheWrite = toNumber(
      price.input_cache_write ?? price.inputCacheWrite ?? price.cache_write ?? price.cacheWrite,
      Number.NaN,
    );
    const isTokenType = String(price.type || '').toLowerCase() === 'tokens';

    transformed.push({
      model_name: modelName,
      model_description: item?.description || item?.desc || '',
      quota_type: isTokenType ? 0 : 1,
      model_ratio: 1,
      completion_ratio: input > 0 ? output / input : 1,
      cache_ratio: input > 0 && Number.isFinite(cacheRead) && cacheRead >= 0 ? (cacheRead / input) : 1,
      cache_creation_ratio: input > 0 && Number.isFinite(cacheWrite) && cacheWrite >= 0 ? (cacheWrite / input) : 1,
      model_price: { input, output },
      enable_groups: Array.isArray(item?.groups) && item.groups.length > 0 ? item.groups : [DEFAULT_GROUP],
      supported_endpoint_types: Array.isArray(item?.supported_endpoint_types) ? item.supported_endpoint_types : [],
      tags: Array.isArray(item?.tags) ? item.tags : [],
      owner_by: item?.owned_by || item?.provider || null,
    });
  }

  const models = normalizePricingModels(transformed);
  if (models.size === 0) return null;

  const groupMap = unwrapPayload(groupPayload);
  const groupRatioSource: Record<string, number> = {};
  if (groupMap && typeof groupMap === 'object') {
    for (const [key, group] of Object.entries(groupMap as Record<string, any>)) {
      groupRatioSource[key] = toNumber(group?.ratio, 1);
    }
  }

  const groupRatio = normalizeGroupRatio(groupRatioSource);
  return { models, groupRatio, fetchedAt: Date.now() };
}

async function fetchJson(url: string, options?: UndiciRequestInit): Promise<unknown> {
  const { fetch } = await import('undici');
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, PRICING_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...(await withSiteProxyRequestInit(url, {
        ...options,
        signal: controller.signal,
        body: options?.body ?? undefined,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      })),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`pricing fetch timeout (${Math.round(PRICING_FETCH_TIMEOUT_MS / 1000)}s)`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

function normalizeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function buildTokenCandidates(input: EstimateProxyCostInput): string[] {
  const candidates = [
    input.account.accessToken,
    input.account.apiToken,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return Array.from(new Set(candidates));
}

async function fetchCommonPricing(baseUrl: string, token?: string, sitePlatform?: string): Promise<PricingData | null> {
  const normalizedPlatform = (sitePlatform || '').trim().toLowerCase();
  const shouldTryShieldCookie = !!token && (normalizedPlatform === 'anyrouter' || token.includes('='));
  if (shouldTryShieldCookie) {
    const payload = await fetchJsonViaNewApiShield(`${baseUrl}/api/pricing`, token!);
    const data = normalizeCommonPricingPayload(payload);
    if (data) return data;
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = await fetchJson(`${baseUrl}/api/pricing`, { headers });
  return normalizeCommonPricingPayload(payload);
}

async function fetchOneHubPricing(baseUrl: string, token?: string): Promise<PricingData | null> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const [availablePayload, groupPayload] = await Promise.all([
    fetchJson(`${baseUrl}/api/available_model`, { headers }),
    fetchJson(`${baseUrl}/api/user_group_map`, { headers }),
  ]);

  return normalizeOneHubPricingPayload(availablePayload, groupPayload);
}

function getCacheKey(input: EstimateProxyCostInput): string {
  return `${input.site.id}:${input.account.id}`;
}

function normalizeModelKey(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function buildRoutingReferenceCostMap(data: PricingData): Map<string, number> {
  const costs = new Map<string, number>();
  for (const model of data.models.values()) {
    const cost = calculateModelUsageCost(model, ROUTING_REFERENCE_USAGE, data.groupRatio, undefined);
    if (!Number.isFinite(cost)) continue;
    costs.set(normalizeModelKey(model.modelName), Math.max(cost, MIN_ROUTING_REFERENCE_COST));
  }
  return costs;
}

function syncRoutingReferenceCostCache(
  key: string,
  fetchedAt: number,
  ttlMs: number,
  data: PricingData | null,
): void {
  if (!data) {
    routingReferenceCostCache.delete(key);
    return;
  }

  routingReferenceCostCache.set(key, {
    fetchedAt,
    ttlMs,
    costs: buildRoutingReferenceCostMap(data),
  });
}

async function fetchPricingData(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const baseUrl = normalizeUrl(input.site.url);
  const tokenCandidates = buildTokenCandidates(input);

  const fetcher = input.site.platform === 'one-hub' || input.site.platform === 'done-hub'
    ? (baseUrl: string, token?: string) => fetchOneHubPricing(baseUrl, token)
    : (baseUrl: string, token?: string) => fetchCommonPricing(baseUrl, token, input.site.platform);

  for (const token of tokenCandidates) {
    try {
      const data = await fetcher(baseUrl, token);
      if (data && data.models.size > 0) return data;
    } catch {}
  }

  // Some sites expose pricing publicly.
  try {
    const data = await fetcher(baseUrl, undefined);
    if (data && data.models.size > 0) return data;
  } catch {}

  return null;
}

async function getPricingDataCached(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const key = getCacheKey(input);
  const now = Date.now();
  const cached = pricingCache.get(key);
  if (cached && now - cached.fetchedAt < cached.ttlMs) {
    if (cached.data && !routingReferenceCostCache.has(key)) {
      syncRoutingReferenceCostCache(key, cached.fetchedAt, cached.ttlMs, cached.data);
    }
    return cached.data;
  }

  const data = await fetchPricingData(input);
  if (data) {
    data.fetchedAt = now;
  }
  const ttlMs = data ? PRICE_CACHE_TTL_MS : PRICE_CACHE_FAILURE_TTL_MS;
  pricingCache.set(key, {
    fetchedAt: now,
    ttlMs,
    data,
  });
  syncRoutingReferenceCostCache(key, now, ttlMs, data);
  return data;
}

async function refreshPricingDataCache(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const key = getCacheKey(input);
  const now = Date.now();
  const data = await fetchPricingData(input);
  if (data) {
    data.fetchedAt = now;
  }
  const ttlMs = data ? PRICE_CACHE_TTL_MS : PRICE_CACHE_FAILURE_TTL_MS;
  pricingCache.set(key, {
    fetchedAt: now,
    ttlMs,
    data,
  });
  syncRoutingReferenceCostCache(key, now, ttlMs, data);
  return data;
}

export function getCachedModelRoutingReferenceCost(input: {
  siteId: number;
  accountId: number;
  modelName: string;
}): number | null {
  const key = `${input.siteId}:${input.accountId}`;
  const cached = routingReferenceCostCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.fetchedAt >= cached.ttlMs) {
    return null;
  }

  const cost = cached.costs.get(normalizeModelKey(input.modelName));
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }

  return cost;
}

function resolveModel(modelName: string, data: PricingData): PricingModel | null {
  const lower = modelName.toLowerCase();
  return data.models.get(lower) ?? null;
}

export function resolveGroupMultiplier(model: PricingModel, groupRatio: Record<string, number>, requestGroup?: string | null): number {
  const normalizedRequestGroup = typeof requestGroup === 'string' ? requestGroup.trim() : '';
  if (normalizedRequestGroup && groupRatio[normalizedRequestGroup]) {
    return groupRatio[normalizedRequestGroup];
  }

  if (model.enableGroups.includes(DEFAULT_GROUP) && groupRatio[DEFAULT_GROUP]) {
    return groupRatio[DEFAULT_GROUP];
  }

  for (const group of model.enableGroups) {
    if (groupRatio[group]) return groupRatio[group];
  }

  const first = Object.values(groupRatio).find((ratio) => ratio > 0);
  return first || 1;
}

function calculatePerCallCost(
  modelPrice: number | { input: number; output: number } | null,
  multiplier: number,
): number {
  if (typeof modelPrice === 'number') {
    return modelPrice * multiplier;
  }

  if (modelPrice && typeof modelPrice === 'object') {
    // done-hub/one-hub times pricing follows input ratio only.
    return toNumber(modelPrice.input, 0) * multiplier * ONE_HUB_PER_CALL_RATIO;
  }

  return 0;
}

function calculatePerCallPricing(
  modelPrice: number | { input: number; output: number } | null,
  multiplier: number,
): { input?: number; output?: number; total: number } {
  if (typeof modelPrice === 'number') {
    const total = roundCost(modelPrice * multiplier);
    return { total };
  }

  if (modelPrice && typeof modelPrice === 'object') {
    const input = roundCost(toNumber(modelPrice.input, 0) * multiplier * ONE_HUB_PER_CALL_RATIO);
    const output = roundCost(toNumber(modelPrice.output, 0) * multiplier * ONE_HUB_PER_CALL_RATIO);
    return {
      input,
      output,
      total: input,
    };
  }

  return { total: 0 };
}

function buildPricingOverrideModel(
  modelName: string,
  pricingOverride: ProxyBillingPricingOverride,
): { model: PricingModel; groupRatio: Record<string, number> } {
  const groupRatio = normalizeRatio(pricingOverride.groupRatio, 1);
  return {
    model: {
      modelName,
      quotaType: 0,
      modelRatio: normalizeRatio(pricingOverride.modelRatio, 1),
      completionRatio: normalizeRatio(pricingOverride.completionRatio, 1),
      cacheRatio: normalizeRatio(pricingOverride.cacheRatio, 1),
      cacheCreationRatio: normalizeRatio(pricingOverride.cacheCreationRatio, 1),
      modelPrice: null,
      enableGroups: [DEFAULT_GROUP],
    },
    groupRatio: { [DEFAULT_GROUP]: groupRatio },
  };
}

function normalizeUsageBreakdownInput(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreationTokens1h?: number;
  promptTokensIncludeCache?: boolean | null;
}) {
  const promptTokens = toPositiveInt(usage.promptTokens);
  const completionTokens = toPositiveInt(usage.completionTokens);
  const totalTokensRaw = toPositiveInt(usage.totalTokens);
  const totalTokens = Math.max(totalTokensRaw, promptTokens + completionTokens);
  const cacheReadTokens = toPositiveInt(usage.cacheReadTokens);
  const cacheCreationTokens = toPositiveInt(usage.cacheCreationTokens);
  // 1h-TTL cache-creation tokens; 0 when upstream does not report them separately.
  const cacheCreationTokens1h = toPositiveInt(usage.cacheCreationTokens1h);
  const promptTokensIncludeCache = usage.promptTokensIncludeCache ?? null;
  const hasSplit = promptTokens > 0 || completionTokens > 0;
  const effectivePromptTokens = hasSplit ? promptTokens : totalTokens;
  const billablePromptTokens = promptTokensIncludeCache === false
    ? effectivePromptTokens
    : Math.max(0, effectivePromptTokens - cacheReadTokens - cacheCreationTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheCreationTokens1h,
    billablePromptTokens,
    promptTokensIncludeCache,
  };
}

/** Result of an expr breakdown: a full breakdown, or the reason the expr path failed. */
type ExprBreakdownOutcome =
  | { ok: true; breakdown: ProxyBillingDetails }
  | { ok: false; reason: string };

/**
 * Build a billing breakdown from a compiled billing expression. Token variables are
 * expressed in millions (tokens / 1e6) so the $/M coefficients multiply directly into
 * dollars; the group multiplier is applied on top.
 *
 * Each token dimension is evaluated in isolation (all other token vars = 0) so, for the
 * (linear) expressions used upstream, the cost parts decompose exactly and sum to the
 * total. This also captures the cc1h (1h cache-creation) dimension, which has its own
 * coefficient and would be lost by a four-dimension derivation. `len` is reconstructed to
 * reflect the full input context when cache tokens are tracked separately
 * (promptTokensIncludeCache === false). Returns { ok: false, reason } (and logs a warning)
 * when evaluation fails so the caller can fall back to the ratio path with an audit trail.
 */
function buildExprBreakdown(
  model: PricingModel,
  normalizedUsage: ReturnType<typeof normalizeUsageBreakdownInput>,
  multiplier: number,
  pricingFetchedAt?: number,
): ExprBreakdownOutcome {
  const parsed = model.pricingExpr;
  if (!parsed) return { ok: false, reason: 'billing_expr AST missing' };

  // len is the raw context length used only for tier selection. When cache tokens are
  // tracked separately (Claude-style, promptTokensIncludeCache === false) the reported
  // prompt excludes them, so the true input context is prompt + cacheRead + cacheCreation.
  // Otherwise the reported prompt already includes cache (or is unknown); fall back to
  // total tokens when the prompt is missing.
  let len: number;
  if (normalizedUsage.promptTokensIncludeCache === false) {
    len = normalizedUsage.promptTokens
      + normalizedUsage.cacheReadTokens
      + normalizedUsage.cacheCreationTokens;
  } else {
    len = normalizedUsage.promptTokens;
  }
  if (!(len > 0)) len = normalizedUsage.totalTokens;

  const now = new Date();
  const hasCc1h = normalizedUsage.cacheCreationTokens1h > 0;

  try {
    // Evaluate one dimension at a time (others = 0) to isolate each $/M coefficient.
    const coeff = (p: number, c: number, cr: number, cc: number, cc1h: number): number =>
      roundCost(evaluateBillingExpr(parsed, { p, c, cr, cc, cc1h, len, now }) * multiplier);

    const inputPerMillion = coeff(1, 0, 0, 0, 0);
    const outputPerMillion = coeff(0, 1, 0, 0, 0);
    const cacheReadPerMillion = coeff(0, 0, 1, 0, 0);
    const cacheCreationPerMillion = coeff(0, 0, 0, 1, 0);
    const cc1hPerMillion = hasCc1h ? coeff(0, 0, 0, 0, 1) : 0;

    const inputCost = roundCost((normalizedUsage.billablePromptTokens / 1_000_000) * inputPerMillion);
    const outputCost = roundCost((normalizedUsage.completionTokens / 1_000_000) * outputPerMillion);
    const cacheReadCost = roundCost((normalizedUsage.cacheReadTokens / 1_000_000) * cacheReadPerMillion);
    const cacheCreationCost = roundCost((normalizedUsage.cacheCreationTokens / 1_000_000) * cacheCreationPerMillion);
    const cc1hCost = roundCost((normalizedUsage.cacheCreationTokens1h / 1_000_000) * cc1hPerMillion);
    const totalCost = roundCost(inputCost + outputCost + cacheReadCost + cacheCreationCost + cc1hCost);

    const breakdown: ProxyBillingDetails['breakdown'] = {
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion,
      cacheCreationPerMillion,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheCreationCost,
      totalCost,
    };
    if (hasCc1h) {
      breakdown.cc1hPerMillion = cc1hPerMillion;
      breakdown.cc1hCost = cc1hCost;
    }

    return {
      ok: true,
      breakdown: {
        quotaType: model.quotaType,
        usage: normalizedUsage,
        pricing: {
          modelRatio: model.modelRatio,
          completionRatio: model.completionRatio,
          cacheRatio: model.cacheRatio ?? 1,
          cacheCreationRatio: model.cacheCreationRatio ?? 1,
          groupRatio: multiplier,
          pricingSource: 'expr',
          billingExpr: model.billingExpr ?? null,
          ...(pricingFetchedAt ? { pricingFetchedAt } : {}),
        },
        breakdown,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[model-pricing] model "${model.modelName}" billing_expr evaluation failed (${message}), falling back to ratio path: ${model.billingExpr ?? ''}`,
    );
    return { ok: false, reason: `billing_expr evaluation failed: ${message}` };
  }
}

/**
 * Effective per-M figures for the pricing catalog, evaluated at the base tier
 * (len = 0 selects the lowest tier) and the current time. The catalog is a static
 * per-group summary without a concrete usage, so this is a BASE-TIER ESTIMATE, not the
 * exact per-request price (real per-request tiering uses the request's `len`). The
 * catalog builder marks the result with `exprEstimate: true` so the UI labels it as an
 * estimate rather than a definitive price.
 */
function computeExprPerMillionForCatalog(
  parsed: ParsedBillingExpr,
  multiplier: number,
): {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreationPerMillion: number;
} | null {
  const now = new Date();
  try {
    const evalPerMillion = (p: number, c: number, cr: number, cc: number): number =>
      roundCost(evaluateBillingExpr(parsed, { p, c, cr, cc, cc1h: 0, len: 0, now }) * multiplier);
    return {
      inputPerMillion: evalPerMillion(1, 0, 0, 0),
      outputPerMillion: evalPerMillion(0, 1, 0, 0),
      cacheReadPerMillion: evalPerMillion(0, 0, 1, 0),
      cacheCreationPerMillion: evalPerMillion(0, 0, 0, 1),
    };
  } catch {
    return null;
  }
}

export function calculateModelUsageBreakdown(
  model: PricingModel,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    cacheCreationTokens1h?: number;
    promptTokensIncludeCache?: boolean | null;
  },
  groupRatio: Record<string, number>,
  pricingFetchedAt?: number,
  requestGroup?: string | null,
): ProxyBillingDetails | null {
  if (model.quotaType === 1) {
    return null;
  }

  const multiplier = resolveGroupMultiplier(model, groupRatio, requestGroup);
  const normalizedUsage = normalizeUsageBreakdownInput(usage);

  // Determine why a billing_expr, if present, did NOT drive this cost, so the ratio
  // fallback is auditable (exprFallback + reason) rather than silently distorting prices.
  let exprFallbackReason: string | null = null;
  if (model.pricingSource === 'expr' && model.pricingExpr) {
    const outcome = buildExprBreakdown(model, normalizedUsage, multiplier, pricingFetchedAt);
    if (outcome.ok) return outcome.breakdown;
    // buildExprBreakdown already logged a warning; fall back to the ratio path below.
    exprFallbackReason = outcome.reason;
  } else if (model.billingExpr) {
    // Model had a billing_expr but the ratio path is used (rejected at normalization:
    // unparseable or unsupported billing_mode). Surface the stored reason.
    exprFallbackReason = model.pricingFallbackReason ?? 'billing_expr rejected at normalization';
  }

  // 无法确证为真实 ratio 时拒绝 ratio 计价，改走 fallback。
  // 典型场景：上游带 billing_expr 但表达式无法解析，此时 model_ratio 可能是占位值。
  if (model.pricingFallbackReason) {
    return {
      quotaType: model.quotaType,
      usage: normalizedUsage,
      pricing: {
        modelRatio: model.modelRatio,
        completionRatio: model.completionRatio,
        cacheRatio: model.cacheRatio ?? 1,
        cacheCreationRatio: model.cacheCreationRatio ?? 1,
        groupRatio: multiplier,
        pricingSource: 'fallback',
        billingExpr: model.billingExpr ?? null,
        exprFallback: true as const,
        exprFallbackReason: model.pricingFallbackReason,
        ...(pricingFetchedAt ? { pricingFetchedAt } : {}),
      },
      breakdown: {
        inputPerMillion: 0,
        outputPerMillion: 0,
        cacheReadPerMillion: 0,
        cacheCreationPerMillion: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheCreationCost: 0,
        totalCost: 0,
      },
    };
  }

  const cacheRatio = model.cacheRatio ?? 1;
  const cacheCreationRatio = model.cacheCreationRatio ?? 1;
  const inputPerMillion = roundCost(model.modelRatio * 2 * multiplier);
  const outputPerMillion = roundCost(model.modelRatio * model.completionRatio * 2 * multiplier);
  const cacheReadPerMillion = roundCost(model.modelRatio * cacheRatio * 2 * multiplier);
  const cacheCreationPerMillion = roundCost(model.modelRatio * cacheCreationRatio * 2 * multiplier);
  const inputCost = roundCost((normalizedUsage.billablePromptTokens / 1_000_000) * inputPerMillion);
  const outputCost = roundCost((normalizedUsage.completionTokens / 1_000_000) * outputPerMillion);
  const cacheReadCost = roundCost((normalizedUsage.cacheReadTokens / 1_000_000) * cacheReadPerMillion);
  const cacheCreationCost = roundCost((normalizedUsage.cacheCreationTokens / 1_000_000) * cacheCreationPerMillion);
  const totalCost = roundCost(inputCost + outputCost + cacheReadCost + cacheCreationCost);

  return {
    quotaType: model.quotaType,
    usage: normalizedUsage,
    pricing: {
      modelRatio: model.modelRatio,
      completionRatio: model.completionRatio,
      cacheRatio,
      cacheCreationRatio,
      groupRatio: multiplier,
      pricingSource: 'ratio',
      billingExpr: model.billingExpr ?? null,
      ...(exprFallbackReason ? { exprFallback: true as const, exprFallbackReason } : {}),
      ...(pricingFetchedAt ? { pricingFetchedAt } : {}),
    },
    breakdown: {
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion,
      cacheCreationPerMillion,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheCreationCost,
      totalCost,
    },
  };
}

export function calculateModelUsageCost(
  model: PricingModel,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    promptTokensIncludeCache?: boolean | null;
  },
  groupRatio: Record<string, number>,
  requestGroup?: string | null,
): number {
  const multiplier = resolveGroupMultiplier(model, groupRatio, requestGroup);

  if (model.quotaType === 1) {
    return roundCost(calculatePerCallCost(model.modelPrice, multiplier));
  }

  return calculateModelUsageBreakdown(model, usage, groupRatio, undefined, requestGroup)?.breakdown.totalCost ?? 0;
}

function buildModelPricingCatalogFromData(pricingData: PricingData): ModelPricingCatalog {
  const groups = Array.from(new Set([DEFAULT_GROUP, ...Object.keys(pricingData.groupRatio)]));
  const defaultMultiplier = pricingData.groupRatio[DEFAULT_GROUP] || 1;

  const models: ModelPricingCatalogEntry[] = Array.from(pricingData.models.values())
    .map((model) => {
      const allowedGroups = Array.from(new Set([...(model.enableGroups || []), DEFAULT_GROUP]));
      const modelGroups = groups.filter((group) => allowedGroups.includes(group));
      const effectiveGroups = modelGroups.length > 0 ? modelGroups : [DEFAULT_GROUP];

      const groupPricing = effectiveGroups.reduce<Record<string, ModelGroupPricing>>((acc, group) => {
        const multiplier = pricingData.groupRatio[group] || defaultMultiplier;
        if (model.quotaType === 1) {
          const perCall = calculatePerCallPricing(model.modelPrice, multiplier);
          acc[group] = {
            quotaType: 1,
            perCallInput: perCall.input,
            perCallOutput: perCall.output,
            perCallTotal: perCall.total,
          };
          return acc;
        }

        const exprPerMillion = model.pricingSource === 'expr' && model.pricingExpr
          ? computeExprPerMillionForCatalog(model.pricingExpr, multiplier)
          : null;
        if (exprPerMillion) {
          acc[group] = {
            quotaType: 0,
            inputPerMillion: exprPerMillion.inputPerMillion,
            outputPerMillion: exprPerMillion.outputPerMillion,
            cacheReadPerMillion: exprPerMillion.cacheReadPerMillion,
            cacheCreationPerMillion: exprPerMillion.cacheCreationPerMillion,
            exprEstimate: true,
          };
          return acc;
        }

        acc[group] = {
          quotaType: 0,
          inputPerMillion: roundCost(model.modelRatio * 2 * multiplier),
          outputPerMillion: roundCost(model.modelRatio * model.completionRatio * 2 * multiplier),
          cacheReadPerMillion: roundCost(model.modelRatio * (model.cacheRatio ?? 1) * 2 * multiplier),
          cacheCreationPerMillion: roundCost(model.modelRatio * (model.cacheCreationRatio ?? 1) * 2 * multiplier),
        };
        return acc;
      }, {});

      return {
        modelName: model.modelName,
        quotaType: model.quotaType,
        modelDescription: model.modelDescription || null,
        tags: model.tags || [],
        supportedEndpointTypes: model.supportedEndpointTypes || [],
        ownerBy: model.ownerBy || null,
        enableGroups: model.enableGroups || [DEFAULT_GROUP],
        groupPricing,
      };
    })
    .sort((a, b) => a.modelName.localeCompare(b.modelName));

  return {
    models,
    groupRatio: pricingData.groupRatio,
  };
}

export async function fetchModelPricingCatalog(input: EstimateProxyCostInput): Promise<ModelPricingCatalog | null> {
  const pricingData = await getPricingDataCached(input);
  if (!pricingData) return null;
  return buildModelPricingCatalogFromData(pricingData);
}

export async function refreshModelPricingCatalog(input: EstimateProxyCostInput): Promise<ModelPricingCatalog | null> {
  const pricingData = await refreshPricingDataCache(input);
  if (!pricingData) return null;
  return buildModelPricingCatalogFromData(pricingData);
}

export function fallbackTokenCost(totalTokens: number, platform: string): number {
  const divisor = platform === 'veloera' ? 1_000_000 : 500_000;
  return roundCost(toPositiveInt(totalTokens) / divisor);
}

export async function estimateProxyCost(input: EstimateProxyCostInput): Promise<number> {
  const promptTokens = toPositiveInt(input.promptTokens);
  const completionTokens = toPositiveInt(input.completionTokens);
  const totalTokens = toPositiveInt(input.totalTokens || (promptTokens + completionTokens));
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    cacheCreationTokens1h: input.cacheCreationTokens1h,
    promptTokensIncludeCache: input.promptTokensIncludeCache,
  };

  try {
    if (input.billingPricingOverride) {
      const pricingOverride = buildPricingOverrideModel(input.modelName, input.billingPricingOverride);
      return calculateModelUsageCost(pricingOverride.model, usage, pricingOverride.groupRatio, input.group);
    }

    const pricingData = await getPricingDataCached(input);
    if (!pricingData) {
      return fallbackTokenCost(totalTokens, input.site.platform);
    }

    const model = resolveModel(input.modelName, pricingData);
    if (!model || model.pricingFallbackReason) {
      return fallbackTokenCost(totalTokens, input.site.platform);
    }

    return calculateModelUsageCost(model, usage, pricingData.groupRatio, input.group);
  } catch {
    return fallbackTokenCost(totalTokens, input.site.platform);
  }
}

async function fetchJsonViaNewApiShield(url: string, token: string): Promise<unknown> {
  for (const cookie of buildNewApiCookieCandidates(token)) {
    const result = await fetchJsonWithShieldCookieRetry(url, {
      headers: { Cookie: cookie },
    });
    if (result.data) return result.data;
  }

  return null;
}

export async function buildProxyBillingDetails(input: EstimateProxyCostInput): Promise<ProxyBillingDetails | null> {
  const promptTokens = toPositiveInt(input.promptTokens);
  const completionTokens = toPositiveInt(input.completionTokens);
  const totalTokens = toPositiveInt(input.totalTokens || (promptTokens + completionTokens));
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    cacheCreationTokens1h: input.cacheCreationTokens1h,
    promptTokensIncludeCache: input.promptTokensIncludeCache,
  };

  try {
    if (input.billingPricingOverride) {
      const pricingOverride = buildPricingOverrideModel(input.modelName, input.billingPricingOverride);
      const overrideDetails = calculateModelUsageBreakdown(pricingOverride.model, usage, pricingOverride.groupRatio, undefined, input.group);
      if (overrideDetails) {
        // 标注来源为 selflog-override 并尝试与当前定价版本对比。
        const currentPricingData = await getPricingDataCached(input);
        const currentModel = currentPricingData ? resolveModel(input.modelName, currentPricingData) : null;
        let overrideRelationship: string | undefined;
        if (currentModel) {
          const ratioChanged = currentModel.modelRatio !== pricingOverride.model.modelRatio
            || currentModel.completionRatio !== pricingOverride.model.completionRatio
            || (currentModel.cacheRatio ?? 1) !== pricingOverride.model.cacheRatio
            || (currentModel.cacheCreationRatio ?? 1) !== pricingOverride.model.cacheCreationRatio;
          if (ratioChanged) {
            overrideRelationship = 'override_newer_than_catalog';
          } else {
            overrideRelationship = 'override_equals_catalog';
          }
        } else {
          overrideRelationship = 'override_no_catalog_for_comparison';
        }
        return {
          ...overrideDetails,
          pricing: {
            ...overrideDetails.pricing,
            pricingSource: 'selflog-override',
            overrideRelationship,
          },
        };
      }
      return null;
    }

    const pricingData = await getPricingDataCached(input);
    if (!pricingData) {
      // No pricing catalog available: emit a zero-cost fallback breakdown so the
      // billing_details column is never empty, and the divisor/tokens are auditable.
      const platform = input.site?.platform ?? 'unknown';
      const divisor = platform === 'veloera' ? 1_000_000 : 500_000;
      const normalizedUsage = normalizeUsageBreakdownInput(usage);
      return {
        quotaType: 0,
        usage: normalizedUsage,
        pricing: {
          modelRatio: 0,
          completionRatio: 0,
          cacheRatio: 1,
          cacheCreationRatio: 1,
          groupRatio: 1,
          pricingSource: 'fallback',
          fallbackReason: 'pricing catalog unavailable',
          fallbackDivisor: divisor,
          fallbackTokens: normalizedUsage.totalTokens,
        },
        breakdown: {
          inputPerMillion: 0,
          outputPerMillion: 0,
          cacheReadPerMillion: 0,
          cacheCreationPerMillion: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheCreationCost: 0,
          totalCost: 0,
        },
      };
    }

    const model = resolveModel(input.modelName, pricingData);
    if (!model || model.quotaType === 1) {
      // Model not found in catalog or per-call model: emit a fallback breakdown.
      const platform = input.site?.platform ?? 'unknown';
      const divisor = platform === 'veloera' ? 1_000_000 : 500_000;
      const normalizedUsage = normalizeUsageBreakdownInput(usage);
      return {
        quotaType: 0,
        usage: normalizedUsage,
        pricing: {
          modelRatio: 0,
          completionRatio: 0,
          cacheRatio: 1,
          cacheCreationRatio: 1,
          groupRatio: 1,
          pricingSource: 'fallback',
          fallbackReason: model ? 'per-call model rejected' : 'model not found in catalog',
          fallbackDivisor: divisor,
          fallbackTokens: normalizedUsage.totalTokens,
          ...(pricingData.fetchedAt ? { pricingFetchedAt: pricingData.fetchedAt } : {}),
        },
        breakdown: {
          inputPerMillion: 0,
          outputPerMillion: 0,
          cacheReadPerMillion: 0,
          cacheCreationPerMillion: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheCreationCost: 0,
          totalCost: 0,
        },
      };
    }

    return calculateModelUsageBreakdown(model, usage, pricingData.groupRatio, pricingData.fetchedAt, input.group);
  } catch {
    return null;
  }
}
