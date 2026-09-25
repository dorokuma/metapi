import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
  clientFamily: 'codex',
  clientAppId: 'cherry_studio',
  clientAppName: 'Cherry Studio',
  clientConfidence: 'heuristic',
};

const UPSTREAM_OBSERVATION = {
  id: 501,
  createdAt: '2026-03-09 16:00:01',
  proxyLogId: null,
  siteId: 9,
  accountId: 11,
  routeId: 22,
  channelId: 33,
  downstreamApiKeyId: null,
  requestedModel: 'deepseek/deepseek-v4.1-flash',
  actualModel: 'deepseek/deepseek-v4.1-flash',
  upstreamPath: '/v1/chat/completions',
  isStream: false,
  parserId: 'cline-gateway',
  parserVersion: 1,
  finalProvider: 'deepseek',
  resolvedProvider: 'deepseek',
  canonicalSlug: 'deepseek/deepseek-v4.1-flash',
  originalModelId: 'deepseek/deepseek-v4.1-flash',
  affinityOutcome: 'confirmed',
  affinityPinnedProvider: 'deepseek',
  clientSessionId: 'sess-desktop-1',
  clientSessionIdSource: 'explicit',
  fallbacks: ['alibaba', 'baseten'],
  fallbackCount: 2,
  modelAttempts: [],
  attemptsTruncated: false,
  modelAttemptCount: 1,
  totalProviderAttemptCount: 1,
  cacheHitTokens: 0,
  cacheMissTokens: 34,
  systemFingerprint: 'fp-desktop',
  usageCost: 0.000013,
  usageGatewayCost: 0.000027,
  usageMarketCost: 0.000027,
  gatewayCostText: '0.000027',
  gatewayInferenceCostText: '0.000028',
  gatewayGenerationId: 'gen-desktop',
};

function buildListResponse() {
  return {
    items: [PROXY_LOG],
    total: 1,
    page: 1,
    pageSize: 50,
    summary: {
      totalCount: 1,
      successCount: 1,
      failedCount: 0,
      totalCost: 1.23,
      totalTokensAll: 15,
    },
    clientOptions: [],
  };
}

async function renderProxyLogs() {
  let root!: WebTestRenderer;
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
  return root;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

async function renderProxyLogsWithLocationProbe() {
  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={['/logs']}>
        <ToastProvider>
          <ProxyLogs />
          <LocationProbe />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root;
}

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).trim() === text
  ));
}

describe('ProxyLogs upstream observations (desktop)', () => {
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
    apiMock.getProxyLogs.mockResolvedValue(buildListResponse());
    apiMock.getProxyLogsQuery.mockImplementation((params: any) => apiMock.getProxyLogs(params));
    apiMock.getProxyLogsMeta.mockResolvedValue({
      summary: buildListResponse().summary,
      clientOptions: [],
      sites: [{ id: 9, name: 'main-site', status: 'active' }],
    });
    apiMock.getProxyLogDetail.mockResolvedValue({
      ...PROXY_LOG,
      upstreamObservation: UPSTREAM_OBSERVATION,
    });
    apiMock.getProxyDebugTraces.mockResolvedValue({ items: [] });
    apiMock.getProxyDebugTraceDetail.mockResolvedValue({ trace: null, attempts: [] });
    apiMock.updateRuntimeSettings.mockImplementation(async (payload: any) => ({
      success: true,
      ...payload,
    }));
    apiMock.getUpstreamObservationDistribution.mockResolvedValue([
      { provider: 'deepseek', requests: 3, cacheHitTokens: 10, cacheMissTokens: 90 },
      { provider: 'alibaba', requests: 1, cacheHitTokens: 0, cacheMissTokens: 5 },
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

  it('renders the 实际上游 block with provider, affinity, session, fallbacks, cache and both cost sets', async () => {
    const root = await renderProxyLogs();
    try {
      const row = root.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('实际上游');
      expect(text).toContain('上游自报，非 metapi 计费');
      expect(text).toContain('deepseek');
      expect(text).toContain('deepseek/deepseek-v4.1-flash');
      // 值层映射：confirmed → 已确认、explicit → 显式（仅显示层，不渲染上游原值）
      expect(text).toContain('结果 已确认');
      expect(text).toContain('上游钉选 deepseek');
      expect(text).toContain('客户端会话 sess-desktop-1（显式）');
      expect(text).not.toContain('confirmed');
      expect(text).not.toContain('explicit');
      expect(text).toContain('2 个（展开列名）');
      expect(text).toContain('alibaba、baseten');
      expect(text).toContain('命中 0 / 未命中 34');
      expect(text).toContain('fp-desktop');
      expect(text).toContain('$0.000013');
      expect(text).toContain('实际成本 $0.000013');
      expect(text).toContain('网关成本 $0.000027');
      expect(text).toContain('市场成本 $0.000027');
      expect(text).toContain('网关推理成本 0.000028');
      expect(text).toContain('gen-desktop');
      // gateway.cost 不再单独成项
      expect(text).not.toContain('gateway.cost');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('passes unmapped affinity outcome and session source values through unchanged', async () => {
    apiMock.getProxyLogDetail.mockResolvedValue({
      ...PROXY_LOG,
      upstreamObservation: {
        ...UPSTREAM_OBSERVATION,
        affinityOutcome: 'miss',
        clientSessionId: 'sess-desktop-2',
        clientSessionIdSource: 'heuristic',
      },
    });
    const root = await renderProxyLogs();
    try {
      const row = root.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      // 未知值不做猜测映射，原样透传
      expect(text).toContain('结果 miss');
      expect(text).toContain('客户端会话 sess-desktop-2（heuristic）');
      expect(text).not.toContain('已确认');
      expect(text).not.toContain('显式');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('de-duplicates the cost block: 网关成本 falls back to gateway.cost when usage.gateway_cost is missing', async () => {
    apiMock.getProxyLogDetail.mockResolvedValue({
      ...PROXY_LOG,
      upstreamObservation: {
        ...UPSTREAM_OBSERVATION,
        usageGatewayCost: null,
        gatewayCostText: '0.000099',
      },
    });
    const root = await renderProxyLogs();
    try {
      const row = root.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('实际成本 $0.000013');
      // usage.gateway_cost 缺失时回退显示 gateway.cost（沿用 formatUpstreamCostText 的原始文本）
      expect(text).toContain('网关成本 0.000099');
      expect(text).toContain('市场成本 $0.000027');
      expect(text).toContain('网关推理成本 0.000028');

      const titles = root.root
        .findAll((node) => typeof node.props.title === 'string')
        .map((node) => String(node.props.title));
      const gatewayCostTitle = titles.find((title) => title.startsWith('usage.gateway_cost:'));
      expect(gatewayCostTitle).toBeDefined();
      expect(gatewayCostTitle).toContain('usage.gateway_cost: --');
      expect(gatewayCostTitle).toContain('gateway.cost: 0.000099');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('de-duplicates the cost block: usage.gateway_cost wins over gateway.cost when both exist', async () => {
    apiMock.getProxyLogDetail.mockResolvedValue({
      ...PROXY_LOG,
      upstreamObservation: {
        ...UPSTREAM_OBSERVATION,
        usageGatewayCost: 0.5,
        gatewayCostText: '9.900000',
      },
    });
    const root = await renderProxyLogs();
    try {
      const row = root.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('网关成本 $0.500000');
      expect(text).not.toContain('网关成本 $9.900000');
      // gateway.cost 不再单独成项（只在悬停提示里出现原始值）
      expect(text).not.toContain('gateway.cost');

      const titles = root.root
        .findAll((node) => typeof node.props.title === 'string')
        .map((node) => String(node.props.title));
      const gatewayCostTitle = titles.find((title) => title.startsWith('usage.gateway_cost:'));
      expect(gatewayCostTitle).toContain('usage.gateway_cost: $0.500000');
      expect(gatewayCostTitle).toContain('gateway.cost: 9.900000');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('treats usage.gateway_cost = 0 as a real value: shows $0.000000 and never falls back to gateway.cost', async () => {
    apiMock.getProxyLogDetail.mockResolvedValue({
      ...PROXY_LOG,
      upstreamObservation: {
        ...UPSTREAM_OBSERVATION,
        usageGatewayCost: 0,
        gatewayCostText: '9.900000',
      },
    });
    const root = await renderProxyLogs();
    try {
      const row = root.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      // 0 是有效真值，不能当成缺失回退到 gateway.cost 原文
      expect(text).toContain('网关成本 $0.000000');
      expect(text).not.toContain('网关成本 9.900000');

      const titles = root.root
        .findAll((node) => typeof node.props.title === 'string')
        .map((node) => String(node.props.title));
      const gatewayCostTitle = titles.find((title) => title.startsWith('usage.gateway_cost:'));
      expect(gatewayCostTitle).toBeDefined();
      expect(gatewayCostTitle).toContain('usage.gateway_cost: $0.000000');
      expect(gatewayCostTitle).toContain('gateway.cost: 9.900000');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('shows the F4 retention copy when the detail has no matching observation', async () => {
    apiMock.getProxyLogDetail.mockResolvedValue({
      ...PROXY_LOG,
      upstreamObservation: null,
    });
    const root = await renderProxyLogs();
    try {
      const row = root.root.find((node) => (
        node.type === 'tr' && node.props['data-testid'] === 'proxy-log-row-101'
      ));
      await act(async () => {
        row.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('实际上游');
      expect(text).toContain('未记录上游观测，可能超出保留期');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('loads the upstream distribution lazily on expand and renders providers and fallback groups', async () => {
    const root = await renderProxyLogs();
    try {
      expect(apiMock.getUpstreamObservationDistribution).not.toHaveBeenCalled();
      expect(apiMock.getUpstreamObservationFallbacks).not.toHaveBeenCalled();

      await act(async () => {
        findButton(root.root, '展开分布面板').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getUpstreamObservationDistribution).toHaveBeenCalledWith({});
      expect(apiMock.getUpstreamObservationFallbacks).toHaveBeenCalledWith({});

      const text = collectText(root.root);
      expect(text).toContain('开关、采样率与参与站点在「设置 → 上游探测」中配置');
      expect(text).toContain('提供方分布（按观测数排序，共 4 次观测）');
      expect(text).toContain('deepseek');
      expect(text).toContain('alibaba');
      expect(text).toContain('缓存命中');
      expect(text).toContain('当前回退清单');
      expect(text).toContain('baseten');

      const columnHeaders = root.root
        .findAll((node) => node.type === 'th')
        .map((node) => collectText(node).trim());
      expect(columnHeaders).toContain('观测数');
      expect(columnHeaders).not.toContain('请求数');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('surfaces upstream distribution API failures as toast + inline error without blanking the page', async () => {
    apiMock.getUpstreamObservationDistribution.mockRejectedValue(new Error('distribution boom'));
    const root = await renderProxyLogs();
    try {
      await act(async () => {
        findButton(root.root, '展开分布面板').props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('distribution boom');
      // The log list keeps rendering (no white screen).
      expect(text).toContain('deepseek/deepseek-v4.1-flash');
      expect(text).toContain('成功');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('no longer exposes the upstream detect settings inside the debug settings modal', async () => {
    const root = await renderProxyLogs();
    try {
      await act(async () => {
        findButton(root.root, '调试设置').props.onClick();
      });
      await flushMicrotasks();

      // 四项已迁到系统设置页：弹层里不再有相关输入/文案，也没有残留的 payload 触点
      expect(root.root.findAll((node) => node.props['data-upstream-setting'] !== undefined)).toHaveLength(0);
      const text = collectText(root.root);
      expect(text).toContain('保存调试设置');
      expect(text).not.toContain('站点后缀');
      expect(text).not.toContain('上游探测（Cline 网关）');
      expect(text).not.toContain('只对命中站点后缀的请求解析 Cline provider_metadata');

      await act(async () => {
        findButton(root.root, '保存调试设置').props.onClick();
      });
      await flushMicrotasks();

      const savedPayload = apiMock.updateRuntimeSettings.mock.calls.at(-1)?.[0] || {};
      expect(savedPayload).not.toHaveProperty('upstreamProviderDetectEnabled');
      expect(savedPayload).not.toHaveProperty('upstreamProviderDetectSampleRate');
      expect(savedPayload).not.toHaveProperty('upstreamProviderDetectRetentionDays');
      expect(savedPayload).not.toHaveProperty('upstreamProviderDetectSiteIds');
      expect(savedPayload).not.toHaveProperty('upstreamProviderDetectPlatforms');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('links from the upstream distribution panel header to the settings section', async () => {
    const root = await renderProxyLogsWithLocationProbe();
    try {
      expect(collectText(root.root)).toContain('/logs');

      await act(async () => {
        findButton(root.root, '配置').props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('/settings?section=upstream-detect');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
