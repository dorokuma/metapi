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
      upstreamProviderDetectEnabled: false,
      upstreamProviderDetectSampleRate: 1,
      upstreamProviderDetectRetentionDays: 14,
      upstreamProviderDetectPlatforms: ['cline.bot'],
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
      expect(text).toContain('confirmed');
      expect(text).toContain('上游钉选 deepseek');
      expect(text).toContain('sess-desktop-1');
      expect(text).toContain('explicit');
      expect(text).toContain('2 个（展开列名）');
      expect(text).toContain('alibaba、baseten');
      expect(text).toContain('hit 0 / miss 34');
      expect(text).toContain('fp-desktop');
      expect(text).toContain('$0.000013');
      expect(text).toContain('0.000027');
      expect(text).toContain('0.000028');
      expect(text).toContain('gen-desktop');
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
      expect(text).toContain('采样率 1（数值为观测数，非全量请求数）');
      expect(text).toContain('提供方分布（按观测数排序，共 4 次观测）');
      expect(text).toContain('deepseek');
      expect(text).toContain('alibaba');
      expect(text).toContain('缓存命中');
      expect(text).toContain('当前渠道清单');
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

  it('edits the upstream detect switch, sample rate, retention days and platform suffixes through the debug settings modal', async () => {
    const root = await renderProxyLogs();
    try {
      await act(async () => {
        findButton(root.root, '调试设置').props.onClick();
      });
      await flushMicrotasks();

      const enabledToggle = root.root.find((node) => (
        node.type === 'input' && node.props['data-upstream-setting'] === 'detect-enabled'
      ));
      const sampleRateInput = root.root.find((node) => (
        node.type === 'input' && node.props['data-upstream-setting'] === 'detect-sample-rate'
      ));
      const retentionInput = root.root.find((node) => (
        node.type === 'input' && node.props['data-upstream-setting'] === 'detect-retention-days'
      ));
      const platformsInput = root.root.find((node) => (
        node.type === 'input' && node.props['data-upstream-setting'] === 'detect-platforms'
      ));

      expect(platformsInput.props.value).toBe('cline.bot');

      await act(async () => {
        enabledToggle.props.onChange({ target: { checked: true } });
        sampleRateInput.props.onChange({ target: { value: '0.5' } });
        retentionInput.props.onChange({ target: { value: '7' } });
        platformsInput.props.onChange({ target: { value: 'cline.bot, example.com' } });
      });

      await act(async () => {
        findButton(root.root, '保存调试设置').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
        upstreamProviderDetectEnabled: true,
        upstreamProviderDetectSampleRate: 0.5,
        upstreamProviderDetectRetentionDays: 7,
        upstreamProviderDetectPlatforms: 'cline.bot, example.com',
      }));
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('maps array platforms from the settings response and warns when the suffix list is cleared (E3)', async () => {
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
      upstreamProviderDetectEnabled: true,
      upstreamProviderDetectSampleRate: 0.25,
      upstreamProviderDetectRetentionDays: 3,
      upstreamProviderDetectPlatforms: ['cline.bot', 'example.com'],
    });

    const root = await renderProxyLogs();
    try {
      await act(async () => {
        findButton(root.root, '调试设置').props.onClick();
      });
      await flushMicrotasks();

      const enabledToggle = root.root.find((node) => (
        node.type === 'input' && node.props['data-upstream-setting'] === 'detect-enabled'
      ));
      const sampleRateInput = root.root.find((node) => (
        node.type === 'input' && node.props['data-upstream-setting'] === 'detect-sample-rate'
      ));
      const retentionInput = root.root.find((node) => (
        node.type === 'input' && node.props['data-upstream-setting'] === 'detect-retention-days'
      ));
      const platformsInput = root.root.find((node) => (
        node.type === 'input' && node.props['data-upstream-setting'] === 'detect-platforms'
      ));

      expect(enabledToggle.props.checked).toBe(true);
      expect(sampleRateInput.props.value).toBe(0.25);
      expect(retentionInput.props.value).toBe(3);
      expect(platformsInput.props.value).toBe('cline.bot, example.com');

      await act(async () => {
        platformsInput.props.onChange({ target: { value: '' } });
      });

      expect(collectText(root.root)).toContain('后缀留空 = 不收集任何站点');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
