import * as routeRefreshWorkflow from '../services/routeRefreshWorkflow.js';
import { proxyChannelCoordinator } from '../services/proxyChannelCoordinator.js';
import { canRetryProxyChannel } from '../services/proxyChannelRetry.js';
import type { DownstreamRoutingPolicy } from '../services/downstreamPolicyTypes.js';
import { tokenRouter } from '../services/tokenRouter.js';

type SelectedChannel = Awaited<ReturnType<typeof tokenRouter.selectChannel>>;

export const TESTER_FORCED_CHANNEL_HEADER = 'x-metapi-tester-forced-channel-id';
export const TESTER_REQUEST_HEADER = 'x-metapi-tester-request';

function headerValueEquals(
  headers: Record<string, unknown> | undefined,
  expectedKey: string,
  expectedValue: string,
): boolean {
  if (!headers) return false;
  const normalizedExpectedKey = expectedKey.trim().toLowerCase();
  const normalizedExpectedValue = expectedValue.trim().toLowerCase();
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedExpectedKey) continue;
    if (typeof rawValue === 'string' && rawValue.trim().toLowerCase() === normalizedExpectedValue) {
      return true;
    }
  }
  return false;
}

function isLoopbackClientIp(value: string | null | undefined): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;
  if (trimmed === '::1' || trimmed === '127.0.0.1') return true;
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length).trim() === '127.0.0.1';
  }
  return false;
}

export function normalizeForcedChannelId(value: unknown): number | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : NaN;
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

type TesterRequestInput = {
  headers?: Record<string, unknown>;
  clientIp?: string | null;
};

export function isTrustedTesterRequest(input?: TesterRequestInput): boolean {
  if (!input) return false;
  if (!isLoopbackClientIp(input.clientIp)) return false;
  return headerValueEquals(input.headers, TESTER_REQUEST_HEADER, '1');
}

export function getTesterForcedChannelId(input?: TesterRequestInput): number | null {
  if (!isTrustedTesterRequest(input)) return null;
  const headers = input?.headers;
  if (!headers) return null;
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== TESTER_FORCED_CHANNEL_HEADER) continue;
    return normalizeForcedChannelId(rawValue);
  }
  return null;
}

export function buildForcedChannelUnavailableMessage(forcedChannelId?: number | null): string {
  const normalizedForcedChannelId = normalizeForcedChannelId(forcedChannelId);
  if (normalizedForcedChannelId === null) {
    return 'No available channels for this model';
  }
  return `指定通道 #${normalizedForcedChannelId} 当前不可用，固定通道模式不会自动切换其他通道`;
}

export function canRetryChannelSelection(retryCount: number, forcedChannelId?: number | null): boolean {
  if (normalizeForcedChannelId(forcedChannelId) !== null) return false;
  return canRetryProxyChannel(retryCount);
}

/**
 * 「空选后按需刷新路由」的观测计数（纯观测，不参与任何选择决策）。
 *
 * 为什么要有内存计数：这条刷新路径在 140–182s 的挂起窗口里**零观测**（只有一行失败 warn），
 * 事后无法回答「刷了多少次 / 命中几次 / 各花了多久」。仓库内既有的指标设施都以 HTTP/日志为落点，
 * 而这里是请求内的选择阶段，故在此处就地累计，并由 `[proxy/route-refresh]` 结构化日志逐次输出。
 * 计数只读不写选择语义：不改变 `refreshedRoutes` 单次门禁、不改变返回值、不影响异常传播。
 */
export type RouteRefreshObservation = {
  /** 命中刷新路径的次数（受单次门禁限制，每次选择调用最多 +1）。 */
  attempts: number;
  successes: number;
  failures: number;
  /** 刷新总耗时（毫秒），含成功与失败。 */
  totalDurationMs: number;
};

const routeRefreshObservation: RouteRefreshObservation = {
  attempts: 0,
  successes: 0,
  failures: 0,
  totalDurationMs: 0,
};

export function getRouteRefreshObservation(): RouteRefreshObservation {
  return { ...routeRefreshObservation };
}

export async function selectProxyChannelForAttempt(input: {
  requestedModel: string;
  downstreamPolicy: DownstreamRoutingPolicy;
  excludeChannelIds: number[];
  retryCount: number;
  stickySessionKey?: string | null;
  forcedChannelId?: number | null;
}): Promise<SelectedChannel> {
  const normalizedForcedChannelId = normalizeForcedChannelId(input.forcedChannelId);
  if (normalizedForcedChannelId !== null) {
    if (input.retryCount > 0) return null;
    return await tokenRouter.selectPreferredChannel(
      input.requestedModel,
      normalizedForcedChannelId,
      input.downstreamPolicy,
      input.excludeChannelIds,
    );
  }

  let selected: SelectedChannel = null;
  let refreshedRoutes = false;

  const refreshRoutesForFirstAttempt = async (): Promise<boolean> => {
    if (input.retryCount > 0 || refreshedRoutes) return false;
    refreshedRoutes = true;
    routeRefreshObservation.attempts += 1;
    const startedAtMs = Date.now();
    try {
      await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      routeRefreshObservation.successes += 1;
      routeRefreshObservation.totalDurationMs += durationMs;
      console.info('[proxy/route-refresh]', {
        trigger: 'empty-selection',
        outcome: 'success',
        durationMs,
        retryCount: input.retryCount,
        requestedModel: input.requestedModel,
        stickySession: !!input.stickySessionKey,
        attempts: routeRefreshObservation.attempts,
        successes: routeRefreshObservation.successes,
        failures: routeRefreshObservation.failures,
        totalDurationMs: routeRefreshObservation.totalDurationMs,
      });
      return true;
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      routeRefreshObservation.failures += 1;
      routeRefreshObservation.totalDurationMs += durationMs;
      console.warn('[proxy/route-refresh]', {
        trigger: 'empty-selection',
        outcome: 'failure',
        durationMs,
        retryCount: input.retryCount,
        requestedModel: input.requestedModel,
        stickySession: !!input.stickySessionKey,
        attempts: routeRefreshObservation.attempts,
        successes: routeRefreshObservation.successes,
        failures: routeRefreshObservation.failures,
        totalDurationMs: routeRefreshObservation.totalDurationMs,
      });
      console.warn('[proxy/surface] failed to refresh routes after empty selection', error);
      return false;
    }
  };

  if (input.retryCount === 0 && input.stickySessionKey) {
    const preferredChannelId = proxyChannelCoordinator.getStickyChannelId(input.stickySessionKey);
    if (preferredChannelId && !input.excludeChannelIds.includes(preferredChannelId)) {
      selected = await tokenRouter.selectPreferredChannel(
        input.requestedModel,
        preferredChannelId,
        input.downstreamPolicy,
        input.excludeChannelIds,
      );
      if (!selected) {
        const refreshSucceeded = await refreshRoutesForFirstAttempt();
        selected = await tokenRouter.selectPreferredChannel(
          input.requestedModel,
          preferredChannelId,
          input.downstreamPolicy,
          input.excludeChannelIds,
        );
        if (!selected && refreshSucceeded) {
          proxyChannelCoordinator.clearStickyChannel(input.stickySessionKey, preferredChannelId);
        }
      }
    }
  }

  if (!selected) {
    selected = input.retryCount === 0
      ? await tokenRouter.selectChannel(input.requestedModel, input.downstreamPolicy)
      : await tokenRouter.selectNextChannel(
        input.requestedModel,
        input.excludeChannelIds,
        input.downstreamPolicy,
      );
  }

  if (!selected && input.retryCount === 0 && !refreshedRoutes) {
    await refreshRoutesForFirstAttempt();
    selected = await tokenRouter.selectChannel(input.requestedModel, input.downstreamPolicy);
  }

  return selected;
}
