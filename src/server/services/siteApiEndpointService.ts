import { asc, eq } from 'drizzle-orm';
import { Headers, Response } from 'undici';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { RETRYABLE_TIMEOUT_PATTERNS } from './proxyRetryPolicy.js';
import { proxyChannelCoordinator, type ProxySiteLease } from './proxyChannelCoordinator.js';
import { copyObservedResponseMeta } from '../proxy-core/firstByteTimeout.js';
import { formatErrorCause } from './errorChain.js';
import {
  normalizeSiteApiEndpointCooldownSec,
  SITE_API_ENDPOINT_COOLDOWN_SEC_DEFAULT,
} from '../shared/siteApiEndpointCooldownSec.js';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 422]);
const NETWORK_FAILURE_PATTERNS = [
  /network error/i,
  /fetch failed/i,
  /socket hang up/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /ehostunreach/i,
  /ecanceled/i,
  ...RETRYABLE_TIMEOUT_PATTERNS,
];

/** 端点冷却时长（毫秒）：以 settings 的 `site_api_endpoint_cooldown_sec` 为准，非法值回落默认 60 秒。 */
function resolveSiteApiEndpointCooldownMs(): number {
  const normalized = normalizeSiteApiEndpointCooldownSec(config.siteApiEndpointCooldownSec);
  return (normalized ?? SITE_API_ENDPOINT_COOLDOWN_SEC_DEFAULT) * 1000;
}

type SiteRow = typeof schema.sites.$inferSelect;
type SiteApiEndpointRow = typeof schema.siteApiEndpoints.$inferSelect;

export interface SiteApiEndpointTarget {
  kind: 'site-fallback' | 'endpoint';
  siteId: number;
  endpointId: number | null;
  baseUrl: string;
  configuredEndpointCount: number;
  endpoint: SiteApiEndpointRow | null;
}

export interface SiteApiEndpointFailureInput {
  status?: number | null;
  message?: string | null;
  error?: unknown;
}

export interface SiteApiEndpointFailureDisposition {
  /** 是否值得在其它端点上重试（429/5xx/网络失败等瞬时失败）。 */
  retryable: boolean;
  /** 是否可以从当前端点换到下一个端点重试。 */
  rotateToNextEndpoint: boolean;
  /**
   * 是否允许把这次失败记为该端点的冷却起因。
   * 任何 4xx 都不写端点冷却（含边缘返回的 429、408）：站点只有 1 个端点时，
   * 写冷却等于把唯一出口拉黑，全站 503 且无法自愈。
   * 其中 408/429 仍可重试并可轮换；400/401/403/404/422 等认证/校验类 4xx 直接失败、不轮换。
   */
  triggersEndpointCooldown: boolean;
  failureReason: string;
}

export interface RecordedSiteApiEndpointFailure extends SiteApiEndpointFailureDisposition {
  cooldownUntil: string | null;
}

export class SiteApiEndpointRequestError extends Error {
  readonly status: number | null;
  readonly rawErrText: string | null;
  readonly firstByteLatencyMs: number | null;
  readonly siteConcurrencyTimeout: boolean;

  constructor(message: string, options?: {
    status?: number | null;
    rawErrText?: string | null;
    firstByteLatencyMs?: number | null;
    siteConcurrencyTimeout?: boolean;
    cause?: unknown;
  }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SiteApiEndpointRequestError';
    this.status = typeof options?.status === 'number' ? options.status : null;
    this.rawErrText = typeof options?.rawErrText === 'string' && options.rawErrText.trim()
      ? options.rawErrText
      : null;
    this.firstByteLatencyMs = typeof options?.firstByteLatencyMs === 'number' && Number.isFinite(options.firstByteLatencyMs)
      ? options.firstByteLatencyMs
      : null;
    this.siteConcurrencyTimeout = options?.siteConcurrencyTimeout === true;
  }
}

function buildSiteConcurrencyBusyMessage(waitMs: number): string {
  return waitMs > 0
    ? `Site busy: waited ${waitMs}ms for an available concurrency slot`
    : 'Site busy: no concurrency slot available';
}

function isResponseLike(value: unknown): value is Response {
  return !!value
    && typeof value === 'object'
    && typeof (value as { body?: unknown }).body !== 'undefined'
    && typeof (value as { status?: unknown }).status === 'number';
}

function wrapResponseWithSiteLease(response: Response, lease: ProxySiteLease): Response {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };

  if (!response.body || response.bodyUsed) {
    release();
    return response;
  }

  // 请求已完成，后续只根据真实的流读取进度续租，避免客户端停止读取后永久占用站点槽位。
  lease.pauseKeepalive();
  const reader = response.body.getReader();
  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          release();
          controller.close();
          return;
        }
        lease.touch();
        controller.enqueue(result.value);
      } catch (error) {
        try {
          await reader.cancel(error);
        } catch {
          // 读取失败时尽力取消底层 reader，随后仍必须释放站点租约。
        } finally {
          release();
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  let wrappedBodyResponse: Response | null = null;
  const getWrappedBodyResponse = () => {
    if (!wrappedBodyResponse) {
      wrappedBodyResponse = new Response(wrappedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    }
    return wrappedBodyResponse;
  };

  const wrappedResponse = new Proxy(response, {
    get(target, property, receiver) {
      if (property === 'body') return wrappedBody;
      if (property === 'text' || property === 'json' || property === 'arrayBuffer' || property === 'blob' || property === 'formData') {
        return (...args: unknown[]) => Promise.resolve(
          (getWrappedBodyResponse()[property as 'text'] as (...params: unknown[]) => Promise<unknown>)(...args),
        ).finally(release);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  copyObservedResponseMeta(response, wrappedResponse);
  return wrappedResponse;
}

function attachSiteLeaseToResult<T>(result: T, lease: ProxySiteLease): { result: T; held: boolean } {
  if (!lease.isActive()) {
    return { result, held: false };
  }
  if (isResponseLike(result)) {
    return { result: wrapResponseWithSiteLease(result, lease) as T, held: !!result.body && !result.bodyUsed };
  }
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['upstream', 'response']) {
      const candidate = record[key];
      if (!isResponseLike(candidate)) continue;
      const wrapped = wrapResponseWithSiteLease(candidate, lease);
      return { result: { ...record, [key]: wrapped } as T, held: !!candidate.body && !candidate.bodyUsed };
    }
  }
  lease.release();
  return { result, held: false };
}

export function normalizeSiteApiEndpointBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function toIsoTimestamp(now?: string | Date): string {
  if (typeof now === 'string' && now.trim()) return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

function compareNullableTimeAsc(left?: string | null, right?: string | null): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.localeCompare(right);
}

function isCooldownActive(cooldownUntil: string | null | undefined, nowIso: string): boolean {
  return !!cooldownUntil && cooldownUntil > nowIso;
}

function isEndpointCoolingDown(endpoint: SiteApiEndpointRow, nowIso: string): boolean {
  return isCooldownActive(endpoint.cooldownUntil, nowIso);
}

function isClientErrorStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

function extractFailureMessage(input: SiteApiEndpointFailureInput): string {
  const direct = typeof input.message === 'string' ? input.message.trim() : '';
  if (direct) return direct;
  // 只取 .message 会丢掉 `.cause` 链里的 ECONNRESET / ETIMEDOUT 等，交由 util 摊平。
  return formatErrorCause(input.error);
}

function formatFailureReason(status: number | null, message: string): string {
  if (status && message) {
    if (message.match(new RegExp(`^HTTP\\s+${status}\\b`, 'i'))) {
      return message;
    }
    return `HTTP ${status}: ${message}`;
  }
  if (status) return `HTTP ${status}`;
  return message || 'endpoint failure';
}

function parseStatusFromFailureMessage(message: string): number | null {
  const matched = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (!matched) return null;
  const status = Number.parseInt(matched[1] || '', 10);
  return Number.isFinite(status) ? status : null;
}

export function classifySiteApiEndpointFailure(
  input: SiteApiEndpointFailureInput,
): SiteApiEndpointFailureDisposition {
  const message = extractFailureMessage(input);
  const status = typeof input.status === 'number'
    ? input.status
    : parseStatusFromFailureMessage(message);
  const failureReason = formatFailureReason(status, message);

  if (status !== null) {
    if (RETRYABLE_STATUS_CODES.has(status)) {
      return {
        retryable: true,
        rotateToNextEndpoint: true,
        triggersEndpointCooldown: !isClientErrorStatus(status),
        failureReason,
      };
    }
    if (NON_RETRYABLE_STATUS_CODES.has(status)) {
      return {
        retryable: false,
        rotateToNextEndpoint: false,
        triggersEndpointCooldown: false,
        failureReason,
      };
    }
  }

  if (NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      retryable: true,
      rotateToNextEndpoint: true,
      // 文案匹配分支不看 status，故这里显式兜底：任何 4xx（表外的 402/405/409 等）一律不写端点冷却。
      triggersEndpointCooldown: !(status !== null && isClientErrorStatus(status)),
      failureReason,
    };
  }

  return {
    retryable: false,
    rotateToNextEndpoint: false,
    triggersEndpointCooldown: false,
    failureReason,
  };
}

export async function selectSiteApiEndpointTarget(
  site: SiteRow,
  now?: string | Date,
): Promise<SiteApiEndpointTarget | null> {
  const nowIso = toIsoTimestamp(now);
  const endpoints = await db.select().from(schema.siteApiEndpoints)
    .where(eq(schema.siteApiEndpoints.siteId, site.id))
    .orderBy(asc(schema.siteApiEndpoints.sortOrder), asc(schema.siteApiEndpoints.id))
    .all();

  if (endpoints.length === 0) {
    return {
      kind: 'site-fallback',
      siteId: site.id,
      endpointId: null,
      baseUrl: normalizeSiteApiEndpointBaseUrl(site.url),
      configuredEndpointCount: 0,
      endpoint: null,
    };
  }

  const eligible = endpoints
    .filter((endpoint) => (endpoint.enabled ?? true) && !isEndpointCoolingDown(endpoint, nowIso))
    .sort((left, right) => {
      const sortOrder = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
      if (sortOrder !== 0) return sortOrder;
      const selectionOrder = compareNullableTimeAsc(left.lastSelectedAt, right.lastSelectedAt);
      if (selectionOrder !== 0) return selectionOrder;
      return (left.id ?? 0) - (right.id ?? 0);
    });

  const selected = eligible[0];
  if (!selected) return null;

  return {
    kind: 'endpoint',
    siteId: site.id,
    endpointId: selected.id,
    baseUrl: normalizeSiteApiEndpointBaseUrl(selected.url),
    configuredEndpointCount: endpoints.length,
    endpoint: selected,
  };
}

export async function resolveSiteApiBaseUrl(
  site: SiteRow,
  now?: string | Date,
): Promise<string | null> {
  const target = await selectSiteApiEndpointTarget(site, now);
  return target?.baseUrl || null;
}

export async function requireSiteApiBaseUrl(
  site: SiteRow,
  now?: string | Date,
): Promise<string> {
  const baseUrl = await resolveSiteApiBaseUrl(site, now);
  if (baseUrl) return baseUrl;
  throw new Error('当前站点的 API 请求地址均不可用');
}

export async function recordSiteApiEndpointFailure(
  endpointId: number,
  input: SiteApiEndpointFailureInput,
  now?: string | Date,
): Promise<RecordedSiteApiEndpointFailure> {
  const nowIso = toIsoTimestamp(now);
  const disposition = classifySiteApiEndpointFailure(input);

  // 已有冷却必须原样保留：非重试失败（4xx 校验/鉴权等）不得把端点从冷却里放出来，
  // 冷却期内的失败也不得把窗口往后推（否则冷却期内并发在途的失败会把窗口无限往后推）。
  // 取舍：triggersEndpointCooldown 为 false 时保留已有冷却（含已过期时间戳）⇒ 4xx 不再提前解除已有端点冷却；
  // 代价是 4xx 期间最多多等一个窗口、期间零流量（详见 .agents/notes/20260930-fetch-failed-fingerprints.md 遗留 K）。
  const current = await db.select().from(schema.siteApiEndpoints)
    .where(eq(schema.siteApiEndpoints.id, endpointId))
    .get();
  const existingCooldownUntil = current?.cooldownUntil ?? null;
  const cooldownUntil = disposition.triggersEndpointCooldown
    && !isCooldownActive(existingCooldownUntil, nowIso)
    ? new Date(Date.parse(nowIso) + resolveSiteApiEndpointCooldownMs()).toISOString()
    : existingCooldownUntil;

  await db.update(schema.siteApiEndpoints).set({
    cooldownUntil,
    lastFailedAt: nowIso,
    lastFailureReason: disposition.failureReason,
    updatedAt: nowIso,
  }).where(eq(schema.siteApiEndpoints.id, endpointId)).run();

  return {
    ...disposition,
    cooldownUntil,
  };
}

export async function recordSiteApiEndpointSuccess(
  endpointId: number,
  now?: string | Date,
): Promise<void> {
  const nowIso = toIsoTimestamp(now);
  await db.update(schema.siteApiEndpoints).set({
    cooldownUntil: null,
    lastSelectedAt: nowIso,
    lastFailureReason: null,
    updatedAt: nowIso,
  }).where(eq(schema.siteApiEndpoints.id, endpointId)).run();
}

export async function runWithSiteApiEndpointPool<T>(
  site: SiteRow,
  operation: (target: SiteApiEndpointTarget) => Promise<T>,
): Promise<T> {
  const leaseResult = await proxyChannelCoordinator.acquireSiteLease({
    siteId: site.id,
    maxConcurrency: site.maxConcurrency,
  });
  if (leaseResult.status === 'timeout') {
    throw new SiteApiEndpointRequestError(buildSiteConcurrencyBusyMessage(leaseResult.waitMs), {
      status: 503,
      siteConcurrencyTimeout: true,
    });
  }
  const siteLease = leaseResult.lease;
  let leaseHeldByResult = false;
  const attemptedEndpointIds = new Set<number>();
  let lastError: unknown;

  try {
    while (true) {
      const target = await selectSiteApiEndpointTarget(site);
      if (!target) {
        if (lastError) throw lastError;
        throw new Error('当前站点的 API 请求地址均不可用');
      }
      if (target.endpointId && attemptedEndpointIds.has(target.endpointId)) {
        if (lastError) throw lastError;
        throw new Error('当前站点的 API 请求地址均不可用');
      }

      try {
        const result = await operation(target);
        if (target.endpointId) {
          try {
            await recordSiteApiEndpointSuccess(target.endpointId);
          } catch (error) {
            console.warn('[siteApiEndpointService] failed to record endpoint success', error);
          }
        }
        const attached = attachSiteLeaseToResult(result, siteLease);
        leaseHeldByResult = attached.held;
        return attached.result;
      } catch (error) {
        lastError = error;
        if (!target.endpointId) {
          throw error;
        }

        const recordedFailure = await recordSiteApiEndpointFailure(target.endpointId, {
          status: error instanceof SiteApiEndpointRequestError ? error.status : undefined,
          // 带上 `.cause` 链，让 NETWORK_FAILURE_PATTERNS 能吃到 ECONNRESET 等。
          message: formatErrorCause(error),
          error,
        });
        if (!recordedFailure.rotateToNextEndpoint) {
          throw error;
        }

        attemptedEndpointIds.add(target.endpointId);
      }
    }
  } finally {
    if (!leaseHeldByResult) siteLease.release();
  }
}
