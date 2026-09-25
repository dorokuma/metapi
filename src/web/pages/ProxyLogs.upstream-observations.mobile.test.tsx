import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ProxyLogs from './ProxyLogs.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getProxyLogs: vi.fn(),
    getProxyLogsQuery: vi.fn(),
    getProxyLogsMeta: vi.fn(),
    getProxyLogDetail: vi.fn(),
    getProxyDebugTraces: vi.fn(),
    getProxyDebugTraceDetail: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getSites: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    getUpstreamObservationDistribution: vi.fn(),
    getUpstreamObservationFallbacks: vi.fn(),
    getUpstreamObservationSession: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).trim() === text
  ));
}

const PROXY_LOG = {
  id: 101,
  createdAt: '2026-03-09 16:00:00',
  modelRequested: 'deepseek/deepseek-v4.1-flash',
  modelActual: 'deepseek/deepseek-v4.1-flash',
  status: 'success',
  latencyMs: 120,
  firstByteLatencyMs: 35,
  isStream: false,
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  retryCount: 0,
  estimatedCost: 1.23,
  errorMessage: 'downstream: /v1/chat upstream: /api/chat',
  username: 'tester',
  siteName: 'main-site',
  siteUrl: 'https://api.cline.bot',
};

const UPSTREAM_OBSERVATION = {
  id: 501,
  createdAt: '2026-03-09 16:00:01',
  finalProvider: 'deepseek',
  resolvedProvider: 'deepseek',
  canonicalSlug: 'deepseek/deepseek-v4.1-flash',
  originalModelId: 'deepseek/deepseek-v4.1-flash',
  affinityOutcome: 'confirmed',
  affinityPinnedProvider: 'deepseek',
  clientSessionId: 'sess-mobile-1',
  clientSessionIdSource: 'explicit',
  fallbacks: ['alibaba', 'baseten'],
  fallbackCount: 2,
  cacheHitTokens: 1,
  cacheMissTokens: 34,
  systemFingerprint: 'fp-mobile',
  usageCost: 0.000013,
  usageGatewayCost: 0.000027,
  usageMarketCost: 0.000027,
  gatewayCostText: '0.000027',
  gatewayInferenceCostText: null,
  gatewayGenerationId: 'gen-mobile',
  modelAttemptCount: 1,
  totalProviderAttemptCount: 1,
  attemptsTruncated: false,
};

describe('ProxyLogs upstream observations (mobile)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const localStorageState = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => (localStorageState.has(key) ? localStorageState.get(key)! : null)),
        setItem: vi.fn((key: string, value: string) => {
          localStorageState.set(String(key), String(value));
        }),
        removeItem: vi.fn((key: string) => {
          localStorageState.delete(String(key));
        }),
        clear: vi.fn(() => {
          localStorageState.clear();
        }),
      },
      configurable: true,
      writable: true,
    });
    apiMock.getSites.mockResolvedValue([{ id: 9, name: 'main-site', status: 'active' }]);
    apiMock.getRuntimeSettings.mockResolvedValue({
      proxyDebugTraceEnabled: false,
      proxyDebugCaptureHeaders: true,
      proxyDebugCaptureBodies: false,
      proxyDebugCaptureStreamChunks: false,
      proxyDebugTargetSessionId: '',
      proxyDebugTargetClientKind: '',
      proxyDebugTargetModel: '',
      proxyDebugRetentionHours: 24,
      proxyDebugMaxBodyBytes: 262144,
    });
    apiMock.getProxyLogs.mockResolvedValue({
      items: [PROXY_LOG],
      total: 1,
      page: 1,
      pageSize: 50,
      summary: { totalCount: 1, successCount: 1, failedCount: 0, totalCost: 1.23, totalTokensAll: 15 },
      clientOptions: [],
    });
    apiMock.getProxyLogsQuery.mockImplementation((params: any) => apiMock.getProxyLogs(params));
    apiMock.getProxyLogsMeta.mockResolvedValue({
      summary: { totalCount: 1, successCount: 1, failedCount: 0, totalCost: 1.23, totalTokensAll: 15 },
      clientOptions: [],
      sites: [{ id: 9, name: 'main-site', status: 'active' }],
    });
    apiMock.getProxyLogDetail.mockResolvedValue({
      ...PROXY_LOG,
      upstreamObservation: UPSTREAM_OBSERVATION,
    });
    apiMock.getProxyDebugTraces.mockResolvedValue({ items: [] });
    apiMock.getProxyDebugTraceDetail.mockResolvedValue({ trace: null, attempts: [] });
    apiMock.updateRuntimeSettings.mockImplementation(async (payload: any) => ({ success: true, ...payload }));
    apiMock.getUpstreamObservationDistribution.mockResolvedValue([
      { provider: 'deepseek', requests: 3, cacheHitTokens: 10, cacheMissTokens: 90 },
    ]);
    apiMock.getUpstreamObservationFallbacks.mockResolvedValue({
      items: [
        {
          siteId: 9,
          requestedModel: 'deepseek/deepseek-v4.1-flash',
          canonicalSlug: 'deepseek/deepseek-v4.1-flash',
          finalProvider: 'deepseek',
          latestCreatedAt: '2026-03-09 16:00:00',
          fallbacks: ['baseten'],
          fallbackCount: 1,
        },
      ],
      truncated: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the upstream observation block in the expanded mobile card', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      await act(async () => {
        findButton(root.root, '详情').props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('实际上游');
      expect(text).toContain('上游自报，非 metapi 计费');
      expect(text).toContain('deepseek');
      // 值层映射：confirmed → 已确认、explicit → 显式（桌面/移动共用出口）
      expect(text).toContain('结果 已确认');
      expect(text).toContain('客户端会话 sess-mobile-1（显式）');
      expect(text).not.toContain('confirmed');
      expect(text).not.toContain('explicit');
      expect(text).toContain('baseten');
      expect(text).toContain('命中 1 / 未命中 34');
      expect(text).toContain('网关成本 $0.000027');
      expect(text).toContain('市场成本 $0.000027');
      expect(text).toContain('网关推理成本 --');
      expect(text).toContain('gen-mobile');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('passes unmapped affinity outcome and session source values through unchanged on mobile', async () => {
    apiMock.getProxyLogDetail.mockResolvedValue({
      ...PROXY_LOG,
      upstreamObservation: {
        ...UPSTREAM_OBSERVATION,
        affinityOutcome: 'miss',
        clientSessionId: 'sess-mobile-2',
        clientSessionIdSource: 'heuristic',
      },
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      await act(async () => {
        findButton(root.root, '详情').props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      // 未知值不做猜测映射，原样透传
      expect(text).toContain('结果 miss');
      expect(text).toContain('客户端会话 sess-mobile-2（heuristic）');
      expect(text).not.toContain('已确认');
      expect(text).not.toContain('显式');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('renders the distribution panel with MobileCard primitives on mobile', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/logs']}>
            <ToastProvider>
              <ProxyLogs />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      await act(async () => {
        findButton(root.root, '展开分布面板').props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('deepseek');
      expect(text).toContain('缓存未命中');
      expect(text).toContain('baseten');

      // 面板头部的「配置」入口在移动端同样可用（跳设置页上游探测分区）
      expect(findButton(root.root, '配置')).toBeTruthy();

      const fieldLabels = root.root
        .findAll((node) => node.props?.className === 'mobile-field-label')
        .map((node) => collectText(node).trim());
      expect(fieldLabels).toContain('观测数');
      expect(fieldLabels).toContain('回退数');
      expect(fieldLabels).not.toContain('请求数');
      expect(fieldLabels).not.toContain('渠道数');
      expect(text).toContain('当前回退清单');

      const mobileCards = root.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('mobile-card')
      ));
      expect(mobileCards.length).toBeGreaterThan(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
