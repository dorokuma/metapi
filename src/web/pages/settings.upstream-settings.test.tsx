import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import UpstreamSettings from './UpstreamSettings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    getBrandList: vi.fn(),
    getSites: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getUpstreamObservationDistribution: vi.fn(),
    getUpstreamObservationFallbacks: vi.fn(),
    testSystemProxy: vi.fn(),
    testExternalDatabaseConnection: vi.fn(),
    migrateExternalDatabase: vi.fn(),
    updateRuntimeDatabaseConfig: vi.fn(),
    clearRuntimeCache: vi.fn(),
    clearUsageData: vi.fn(),
    factoryReset: vi.fn(),
    testModelAvailability: vi.fn(),
    rebuildRoutes: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
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

async function renderUpstreamSettings(overrides = {}) {
  const defaultRuntime = {
    checkinCron: '0 8 * * *',
    checkinScheduleMode: 'interval',
    checkinIntervalHours: 6,
    balanceRefreshCron: '0 * * * *',
    logCleanupCron: '15 4 * * *',
    logCleanupUsageLogsEnabled: true,
    logCleanupProgramLogsEnabled: true,
    logCleanupRetentionDays: 14,
    codexUpstreamWebsocketEnabled: false,
    responsesCompactFallbackToResponsesEnabled: false,
    proxySessionChannelConcurrencyLimit: 4,
    proxySessionChannelQueueWaitMs: 3200,
    proxyEmptyContentFailEnabled: false,
    proxyErrorKeywords: [],
    proxyFirstByteTimeoutSec: 0,
    routingFallbackUnitCost: 1,
    routingWeights: {},
    tokenRouterFailureCooldownMaxSec: 30 * 24 * 60 * 60,
    adminIpAllowlist: [],
    systemProxyUrl: '',
    upstreamProviderDetectEnabled: false,
    upstreamProviderDetectSampleRate: 1,
    upstreamProviderDetectRetentionDays: 14,
    upstreamProviderDetectSiteIds: [],
    upstreamProviderPinEnabled: false,
    upstreamProviderPinRules: [],
    upstreamProviderPinAdapterMap: {},
    upstreamParamCompatEnabled: false,
    upstreamParamCompatSelfHealEnabled: false,
    upstreamParamCompatRules: [],
    modelAvailabilityProbeEnabled: false,
    payloadRules: {},
    oauthProviderSiteAutoCreateEnabled: false,
    disableCrossProtocolFallback: false,
    currentAdminIp: '127.0.0.1',
    globalBlockedBrands: [],
    globalAllowedModels: [],
    ...overrides,
  };

  apiMock.getRuntimeSettings.mockResolvedValue(defaultRuntime);
  apiMock.getSites.mockResolvedValue([
    { id: 9, name: 'main-site', url: 'https://api.cline.bot', status: 'active' },
    { id: 12, name: 'second-site', url: 'https://api.example.com', status: 'active' },
  ]);
  apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
  apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
  apiMock.getRoutesLite.mockResolvedValue([]);
  apiMock.getBrandList.mockResolvedValue({ brands: [] });
  apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
    active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
    saved: null,
    restartRequired: false,
  });
  apiMock.updateRuntimeSettings.mockImplementation(async (payload: any) => ({
    success: true,
    ...payload,
  }));
  apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
  apiMock.getUpstreamObservationDistribution.mockResolvedValue([
    { provider: 'deepseek', requests: 3, cacheHitTokens: 1, cacheMissTokens: 2 },
  ]);
  apiMock.getUpstreamObservationFallbacks.mockResolvedValue({
    items: [{ siteId: 9, requestedModel: 'cline-pass/*', canonicalSlug: null, finalProvider: 'deepseek', latestCreatedAt: '2026-09-26T00:00:00.000Z', fallbacks: ['deepseek', 'alibaba'], fallbackCount: 2 }],
    truncated: false,
  });

  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      <MemoryRouter>
        <ToastProvider>
          <UpstreamSettings />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root;
}

function getCard(root: ReactTestInstance, card: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'div'
    && node.props['data-settings-card'] === card
  ));
}

function findByData(root: ReactTestInstance, key: string, value: unknown): ReactTestInstance {
  return root.find((node) => node.props[key] === value);
}

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).trim() === text
  ));
}

const MODEL_AVAILABILITY_PROBE_CONFIRM_TEXT = '我确认我使用的中转站全部允许批量测活，如因开启此功能被中转站封号，自行负责。';

describe('UpstreamSettings migrated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('upstream provider pin section', () => {
    const RULE_A = { siteId: 9, model: 'cline-pass/*', providers: ['deepseek'], mode: 'only' as const };
    const RULE_B = { siteId: 12, model: 'other/model', providers: ['alibaba'], mode: 'order' as const };

    it('renders the new card with pre-announcement copy, empty hint and reserved semantics', async () => {
      const root = await renderUpstreamSettings();
      try {
        const card = getCard(root.root, 'upstream-pin');
        const cardText = collectText(card);

        expect(cardText).toContain('上游供应商钉选');
        expect(cardText).toContain('适用于所有支持该字段约定的网关与聚合商');
        expect(cardText).toContain('不读取该约定的上游通常会忽略这些字段');
        expect(cardText).toContain('建议先从实测支持的站点启用');
        expect(cardText).toContain('未配置规则 = 不注入任何字段');
        expect(cardText).toContain('未开启');

        const enabledToggle = findByData(card, 'data-upstream-pin-field', 'enabled');
        expect(enabledToggle.props.checked).toBe(false);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('adds rows, edits fields and saves only the three pin keys with the submitted values', async () => {
      const root = await renderUpstreamSettings();
      try {
        const card = getCard(root.root, 'upstream-pin');

        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'add-rule').props.onClick();
        });

        const ruleRow = findByData(card, 'data-upstream-pin-rule', 0);
        await act(async () => {
          findByData(ruleRow, 'data-upstream-pin-field', 'site-0').props.onChange({ target: { value: '9' } });
          findByData(ruleRow, 'data-upstream-pin-field', 'model-0').props.onChange({ target: { value: 'cline-pass/*' } });
          findByData(ruleRow, 'data-upstream-pin-field', 'mode-0').props.onChange({ target: { value: 'order' } });
        });
        await act(async () => {
          findByData(ruleRow, 'data-upstream-pin-provider-input', 0)
            .props.onChange({ target: { value: 'deepseek,' } });
        });
        await act(async () => {
          const input = findByData(card, 'data-upstream-pin-provider-input', 0);
          input.props.onChange({ target: { value: 'alibaba' } });
        });
        await act(async () => {
          const input = findByData(card, 'data-upstream-pin-provider-input', 0);
          input.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
        });

        const updatedRow = findByData(card, 'data-upstream-pin-rule', 0);
        expect(findByData(updatedRow, 'data-upstream-pin-provider', 'deepseek')).toBeTruthy();
        expect(findByData(updatedRow, 'data-upstream-pin-provider', 'alibaba')).toBeTruthy();
        expect(collectText(card)).toContain('严格 only：目标提供方不可用时请求直接失败，不会回退');

        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'save').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).toHaveBeenCalledTimes(1);
        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(Object.keys(payload).sort()).toEqual([
          'upstreamProviderPinAdapterMap',
          'upstreamProviderPinEnabled',
          'upstreamProviderPinRules',
        ]);
        expect(payload.upstreamProviderPinAdapterMap).toEqual({});
        expect(payload.upstreamProviderPinRules).toEqual([
          { siteId: 9, model: 'cline-pass/*', providers: ['deepseek', 'alibaba'], mode: 'order' },
        ]);
        expect(payload).not.toHaveProperty('upstreamProviderDetectEnabled');
        expect(payload).not.toHaveProperty('upstreamProviderDetectSiteIds');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('removes a row and never submits it', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderPinEnabled: true,
        upstreamProviderPinRules: [RULE_A, RULE_B],
      });
      try {
        const card = getCard(root.root, 'upstream-pin');
        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'remove-0').props.onClick();
        });

        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'save').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamProviderPinRules).toEqual([RULE_B]);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('reorders rules with move up/down and saves the new array order', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderPinEnabled: true,
        upstreamProviderPinRules: [RULE_A, RULE_B],
      });
      try {
        const card = getCard(root.root, 'upstream-pin');
        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'move-up-1').props.onClick();
        });

        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'save').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamProviderPinRules).toEqual([RULE_B, RULE_A]);

        const firstRow = findByData(card, 'data-upstream-pin-rule', 0);
        const lastRow = findByData(card, 'data-upstream-pin-rule', 1);
        expect(findByData(firstRow, 'data-upstream-pin-action', 'move-up-0').props.disabled).toBe(true);
        expect(findByData(lastRow, 'data-upstream-pin-action', 'move-down-1').props.disabled).toBe(true);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('warns inline about duplicate site + model rows without blocking save', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderPinRules: [
          { siteId: 9, model: 'm', providers: ['a'], mode: 'only' },
          { siteId: 9, model: 'm', providers: ['b'], mode: 'order' },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-pin');
        expect(collectText(card)).toContain('与同站点 + 同模型的规则重复，服务端将拒绝保存');
        expect(findByData(card, 'data-upstream-pin-duplicate', 0)).toBeTruthy();
        expect(findByData(card, 'data-upstream-pin-duplicate', 1)).toBeTruthy();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('loads the recent upstream distribution lazily only when the link is clicked (Q3)', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderDetectEnabled: true,
        upstreamProviderPinRules: [RULE_A],
      });
      try {
        const card = getCard(root.root, 'upstream-pin');
        expect(apiMock.getUpstreamObservationDistribution).not.toHaveBeenCalled();

        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'observe-0').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.getUpstreamObservationDistribution).toHaveBeenCalledTimes(1);
        expect(apiMock.getUpstreamObservationDistribution).toHaveBeenCalledWith({
          siteId: 9,
          model: 'cline-pass/*',
        });
        const panel = findByData(card, 'data-upstream-pin-observation', 0);
        expect(collectText(panel)).toContain('deepseek · 3 次');
        expect(collectText(panel)).toContain('通配模式下按字面模型名查询');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }

      apiMock.getRuntimeSettings.mockResolvedValueOnce({
        ...apiMock.getRuntimeSettings.mock.results[0].value,
        upstreamProviderDetectEnabled: false,
        upstreamProviderPinRules: [RULE_A],
      });
      const degraded = await renderUpstreamSettings({
        upstreamProviderDetectEnabled: false,
        upstreamProviderPinRules: [RULE_A],
      });
      try {
        const card = getCard(degraded.root, 'upstream-pin');
        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'observe-0').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.getUpstreamObservationDistribution).toHaveBeenCalledTimes(1);
        const panel = findByData(card, 'data-upstream-pin-observation', 0);
        expect(collectText(panel)).toContain('暂无观测数据（需开启上游探测且有命中流量）');
      } finally {
        await act(async () => {
          degraded.unmount();
        });
      }
    });

    it('fills providers from observations only on click (Q4) and stays disabled without upstream detect', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderDetectEnabled: true,
        upstreamProviderPinRules: [RULE_A],
      });
      try {
        const card = getCard(root.root, 'upstream-pin');
        expect(apiMock.getUpstreamObservationFallbacks).not.toHaveBeenCalled();
        expect(collectText(card)).toContain('候选来自上游探测词表、仅适用同一网关');

        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'fill-0').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.getUpstreamObservationFallbacks).toHaveBeenCalledTimes(1);
        expect(apiMock.getUpstreamObservationFallbacks).toHaveBeenCalledWith({ siteId: 9 });
        const row = findByData(card, 'data-upstream-pin-rule', 0);
        expect(collectText(row)).toContain('alibaba');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }

      const second = await renderUpstreamSettings({
        upstreamProviderDetectEnabled: false,
        upstreamProviderPinRules: [RULE_A],
      });
      try {
        const card = getCard(second.root, 'upstream-pin');
        expect(findByData(card, 'data-upstream-pin-action', 'fill-0').props.disabled).toBe(true);
        expect(apiMock.getUpstreamObservationFallbacks).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => {
          second.unmount();
        });
      }
    });

    it('renders the adapter section with the default-dual empty hint', async () => {
      const root = await renderUpstreamSettings();
      try {
        const card = getCard(root.root, 'upstream-pin');
        const section = findByData(card, 'data-upstream-pin-adapter-section', '1');
        const sectionText = collectText(section);
        expect(sectionText).toContain('网关适配器');
        expect(sectionText).toContain('未配置 = 全部站点使用默认双姿势注入');
        expect(sectionText).toContain('未配置的站点使用默认双姿势注入');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('lists only implemented adapters in the adapter select (no fake options)', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderPinAdapterMap: { '9': 'generic-dual' },
      });
      try {
        const card = getCard(root.root, 'upstream-pin');
        const row = findByData(card, 'data-upstream-pin-adapter-row', '9');
        const optionTexts = row.findAll((node) => node.type === 'option').map((node) => collectText(node));
        expect(optionTexts).toEqual(expect.arrayContaining([
          '通用双姿势（默认）',
          'OpenRouter',
          'Vercel AI Gateway',
          '不注入（无钉选机制）',
        ]));
        expect(optionTexts.join('|')).not.toContain('Portkey');
        expect(optionTexts.join('|')).not.toContain('Helicone');
        expect(optionTexts.join('|')).not.toContain('LiteLLM');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('adds an adapter row through the selects and submits the raw site-id keyed map', async () => {
      const root = await renderUpstreamSettings();
      try {
        const card = getCard(root.root, 'upstream-pin');

        await act(async () => {
          findByData(card, 'data-upstream-pin-adapter-action', 'add').props.onClick();
        });

        const draftRow = findByData(card, 'data-upstream-pin-adapter-row', '');
        await act(async () => {
          findByData(draftRow, 'data-upstream-pin-adapter-field', 'site-').props.onChange({ target: { value: '9' } });
        });

        const row = findByData(card, 'data-upstream-pin-adapter-row', '9');
        await act(async () => {
          findByData(row, 'data-upstream-pin-adapter-field', 'adapter-9').props.onChange({ target: { value: 'openrouter' } });
        });
        expect(collectText(row)).toContain('原生契约');

        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'save').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamProviderPinAdapterMap).toEqual({ '9': 'openrouter' });
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('removes an adapter row and submits an explicit empty map (clearing semantics)', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderPinEnabled: true,
        upstreamProviderPinAdapterMap: { '9': 'openrouter' },
      });
      try {
        const card = getCard(root.root, 'upstream-pin');
        const row = findByData(card, 'data-upstream-pin-adapter-row', '9');
        expect(collectText(row)).toContain('OpenRouter');

        await act(async () => {
          findByData(row, 'data-upstream-pin-adapter-action', 'remove-9').props.onClick();
        });
        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'save').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamProviderPinAdapterMap).toEqual({});
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('shows the resolved adapter label per rule and warns inline (S2/O5) without blocking save', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderPinEnabled: true,
        upstreamProviderPinRules: [RULE_A, RULE_B],
        upstreamProviderPinAdapterMap: { '9': 'none', '12': 'openrouter' },
      });
      try {
        const card = getCard(root.root, 'upstream-pin');

        const row0 = findByData(card, 'data-upstream-pin-rule', 0);
        expect(collectText(findByData(row0, 'data-upstream-pin-adapter-hint', 0))).toContain('不注入（无钉选机制）');
        expect(collectText(findByData(row0, 'data-upstream-pin-adapter-warning', 0)))
          .toContain('该网关无请求体钉选机制，规则不会注入');

        const row1 = findByData(card, 'data-upstream-pin-rule', 1);
        expect(collectText(findByData(row1, 'data-upstream-pin-adapter-hint', 1))).toContain('OpenRouter');
        expect(row1.findAll((node) => node.props['data-upstream-pin-adapter-warning'] !== undefined)).toHaveLength(0);

        await act(async () => {
          findByData(card, 'data-upstream-pin-action', 'save').props.onClick();
        });
        await flushMicrotasks();
        expect(apiMock.updateRuntimeSettings).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('warns about unregistered adapter ids in rule rows (服务端零注入的 UI 镜像)', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderPinRules: [RULE_A],
        upstreamProviderPinAdapterMap: { '9': 'portkey' },
      });
      try {
        const card = getCard(root.root, 'upstream-pin');
        const row0 = findByData(card, 'data-upstream-pin-rule', 0);
        expect(collectText(findByData(row0, 'data-upstream-pin-adapter-hint', 0))).toContain('未知适配器「portkey」');
        expect(collectText(findByData(row0, 'data-upstream-pin-adapter-warning', 0)))
          .toContain('该请求不会受本规则约束');

        const adapterRow = findByData(card, 'data-upstream-pin-adapter-row', '9');
        expect(collectText(adapterRow)).toContain('未知适配器「portkey」（不会注入）');
        expect(collectText(adapterRow)).toContain('当前版本不支持该适配器 id');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });
  });

  describe('upstream provider detect section', () => {
    it('renders the relocated section with generic copy and site multi-select checkboxes', async () => {
      const root = await renderUpstreamSettings({
        upstreamProviderDetectEnabled: true,
        upstreamProviderDetectSampleRate: 0.25,
        upstreamProviderDetectRetentionDays: 3,
        upstreamProviderDetectSiteIds: [9],
      });
      try {
        const card = getCard(root.root, 'upstream-detect');
        const cardText = collectText(card);

        expect(cardText).toContain('上游探测');
        expect(cardText).toContain('解析上游网关返回的路由元数据（provider_metadata.gateway.routing）');
        expect(cardText).toContain('适用于返回该结构的网关（例如 Cline）');
        expect(cardText).not.toContain('上游探测（Cline 网关）');

        expect(cardText).toContain('已开启');
        expect(cardText).toContain('1 个参与站点');

        const enabledToggle = card.find((node) => (
          node.type === 'input' && node.props['data-upstream-detect-field'] === 'enabled'
        ));
        const sampleRateInput = card.find((node) => (
          node.type === 'input' && node.props['data-upstream-detect-field'] === 'sample-rate'
        ));
        const retentionInput = card.find((node) => (
          node.type === 'input' && node.props['data-upstream-detect-field'] === 'retention-days'
        ));
        expect(enabledToggle.props.checked).toBe(true);
        expect(sampleRateInput.props.value).toBe(0.25);
        expect(retentionInput.props.value).toBe(3);

        const firstSiteCheckbox = card.find((node) => (
          node.type === 'input' && node.props['data-upstream-detect-site'] === 9
        ));
        const secondSiteCheckbox = card.find((node) => (
          node.type === 'input' && node.props['data-upstream-detect-site'] === 12
        ));
        expect(firstSiteCheckbox.props.checked).toBe(true);
        expect(secondSiteCheckbox.props.checked).toBe(false);
        expect(cardText).toContain('main-site');
        expect(cardText).toContain('second-site');
        expect(cardText).not.toContain('未选择任何站点');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('saves the toggle, sample rate, retention days and selected sites, then hot-applies the response', async () => {
      const root = await renderUpstreamSettings();
      try {
        const card = getCard(root.root, 'upstream-detect');

        await act(async () => {
          card.find((node) => (
            node.type === 'input' && node.props['data-upstream-detect-field'] === 'enabled'
          )).props.onChange({ target: { checked: true } });
          card.find((node) => (
            node.type === 'input' && node.props['data-upstream-detect-field'] === 'sample-rate'
          )).props.onChange({ target: { value: '0.5' } });
          card.find((node) => (
            node.type === 'input' && node.props['data-upstream-detect-field'] === 'retention-days'
          )).props.onChange({ target: { value: '7' } });
          card.find((node) => (
            node.type === 'input' && node.props['data-upstream-detect-site'] === 9
          )).props.onChange({ target: { checked: true } });
        });

        await act(async () => {
          findButton(card, '保存上游探测设置').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
          upstreamProviderDetectEnabled: true,
          upstreamProviderDetectSampleRate: 0.5,
          upstreamProviderDetectRetentionDays: 7,
          upstreamProviderDetectSiteIds: [9],
        });

        const reloadedCard = getCard(root.root, 'upstream-detect');
        const reloadedText = collectText(reloadedCard);
        expect(reloadedText).toContain('已开启');
        expect(reloadedText).toContain('1 个参与站点');
        expect(collectText(root.root)).toContain('上游探测设置已保存，已热生效');

        const secondSiteCheckbox = reloadedCard.find((node) => (
          node.type === 'input' && node.props['data-upstream-detect-site'] === 12
        ));
        expect(secondSiteCheckbox.props.checked).toBe(false);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('warns that an empty selection collects nothing and can select/clear all sites', async () => {
      const root = await renderUpstreamSettings();
      try {
        let card = getCard(root.root, 'upstream-detect');
        expect(collectText(card)).toContain('未选择任何站点 = 不采集（即使总开关开启）');
        expect(collectText(card)).toContain('未选参与站点');

        await act(async () => {
          findButton(card, '全选').props.onClick();
        });

        card = getCard(root.root, 'upstream-detect');
        expect(card.find((node) => (
          node.type === 'input' && node.props['data-upstream-detect-site'] === 9
        )).props.checked).toBe(true);
        expect(card.find((node) => (
          node.type === 'input' && node.props['data-upstream-detect-site'] === 12
        )).props.checked).toBe(true);
        expect(collectText(card)).not.toContain('未选择任何站点 = 不采集（即使总开关开启）');
        expect(collectText(card)).toContain('2 个参与站点');

        await act(async () => {
          findButton(card, '清空').props.onClick();
        });
        card = getCard(root.root, 'upstream-detect');
        expect(collectText(card)).toContain('未选择任何站点 = 不采集（即使总开关开启）');

        await act(async () => {
          findButton(card, '保存上游探测设置').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
          upstreamProviderDetectSiteIds: [],
        }));
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('scrolls to the upstream detect section after loading when ?section=upstream-detect is present', async () => {
      const scrollIntoView = vi.fn();
      const getElementById = vi.fn((id: string) => (
        id === 'settings-section-upstream-detect' ? { scrollIntoView } : null
      ));
      (globalThis as any).document = { getElementById };

      let root!: ReturnType<typeof create>;
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/settings/upstream?section=upstream-detect']}>
            <ToastProvider>
              <UpstreamSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();
      // Wait for loading to finish (two rounds: initial + sites fetch)
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      try {
        // getElementById must be called with the correct anchor id
        expect(getElementById).toHaveBeenCalledWith('settings-section-upstream-detect');
        // scrollIntoView must be called only after cards are mounted
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
        // The detect section text should be present in the DOM
        expect(collectText(root.root)).toContain('解析上游网关返回的路由元数据');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('does not scroll when the upstream settings page is opened without a section param', async () => {
      const scrollIntoView = vi.fn();
      const getElementById = vi.fn(() => ({ scrollIntoView }));
      (globalThis as any).document = { getElementById };

      let root!: ReturnType<typeof create>;
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/settings/upstream']}>
            <ToastProvider>
              <UpstreamSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      try {
        // No section param → no scrolling attempted
        expect(getElementById).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });
  });

  describe('proxy transport section', () => {
    it('saves codex upstream websocket and session lease settings from the settings page', async () => {
      const root = await renderUpstreamSettings();
      try {
        const proxyTransportCard = getCard(root.root, 'proxy-transport');
        expect(collectText(proxyTransportCard)).toContain('HTTP 优先');
        expect(collectText(proxyTransportCard)).toContain('会话池 4 并发 / 3200ms');

        const websocketToggleLabel = root.root.find((node) => (
          node.type === 'label'
          && collectText(node).includes('允许 metapi 到 Codex 上游使用 WebSocket')
        ));
        const websocketToggle = websocketToggleLabel.findByType('input');
        expect(websocketToggle.props.checked).toBe(false);

        const compactFallbackToggleLabel = root.root.find((node) => (
          node.type === 'label'
          && collectText(node).includes('Compact 明确不支持时回退到普通 Responses')
        ));
        const compactFallbackToggle = compactFallbackToggleLabel.findByType('input');
        expect(compactFallbackToggle.props.checked).toBe(false);

        const concurrencyInput = root.root.find((node) => (
          node.type === 'input'
          && node.props.type === 'number'
          && node.props.value === 4
        ));
        const queueWaitInput = root.root.find((node) => (
          node.type === 'input'
          && node.props.type === 'number'
          && node.props.value === 3200
        ));

        await act(async () => {
          websocketToggle.props.onChange({ target: { checked: true } });
          compactFallbackToggle.props.onChange({ target: { checked: true } });
          concurrencyInput.props.onChange({ target: { value: '6' } });
          queueWaitInput.props.onChange({ target: { value: '4200' } });
        });

        expect(collectText(proxyTransportCard)).toContain('上游 WebSocket 已启用');
        expect(collectText(proxyTransportCard)).toContain('会话池 6 并发 / 4200ms');

        const saveButton = findButton(root.root, '保存传输与并发');
        await act(async () => {
          saveButton.props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
          codexUpstreamWebsocketEnabled: true,
          responsesCompactFallbackToResponsesEnabled: true,
          proxySessionChannelConcurrencyLimit: 6,
          proxySessionChannelQueueWaitMs: 4200,
        });
      } finally {
        root?.unmount();
      }
    });
  });

  describe('model availability probe confirmation', () => {
    it('requires the exact confirmation text before enabling model availability probing', async () => {
      const root = await renderUpstreamSettings({
        modelAvailabilityProbeEnabled: false,
      });
      try {
        const probeCard = getCard(root.root, 'model-availability-probe');
        expect(collectText(probeCard)).toContain('已关闭');
        expect(collectText(probeCard)).toContain('高风险操作');

        const toggleLabel = root.root.find((node) => (
          node.type === 'label'
          && collectText(node).includes('允许 metapi 后台主动批量测活')
        ));
        const toggle = toggleLabel.findByType('input');
        expect(toggle.props.checked).toBe(false);

        await act(async () => {
          toggle.props.onChange({ target: { checked: true } });
        });

        expect(collectText(probeCard)).toContain('待保存');

        const saveButton = findButton(root.root, '保存批量测活设置');
        await act(async () => {
          saveButton.props.onClick();
        });
        await flushMicrotasks();

        expect(JSON.stringify(root.toJSON())).toContain(MODEL_AVAILABILITY_PROBE_CONFIRM_TEXT);
        expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();

        const confirmButtonBeforeTyping = root.root.find((node) => (
          node.type === 'button'
          && collectText(node).trim() === '确认开启批量测活'
          && node.props.className === 'btn btn-danger'
        ));
        expect(confirmButtonBeforeTyping.props.disabled).toBe(true);

        const confirmInput = root.root.find((node) => (
          node.type === 'textarea'
          && node.props.placeholder === '请输入上方确认语句'
        ));
        await act(async () => {
          confirmInput.props.onChange({ target: { value: MODEL_AVAILABILITY_PROBE_CONFIRM_TEXT } });
        });

        const confirmButton = root.root.find((node) => (
          node.type === 'button'
          && collectText(node).trim() === '确认开启批量测活'
          && node.props.className === 'btn btn-danger'
        ));
        expect(confirmButton.props.disabled).toBe(false);

        await act(async () => {
          confirmButton.props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
          modelAvailabilityProbeEnabled: true,
        });
      } finally {
        root?.unmount();
      }
    });
  });

  describe('payload rules section', () => {
    it('loads saved payload rules into the editor', async () => {
      const root = await renderUpstreamSettings({
        payloadRules: {
          override: [
            {
              models: [{ name: 'gpt-*', protocol: 'codex' }],
              params: {
                'reasoning.effort': 'high',
              },
            },
          ],
        },
      });
      try {
        const overrideTextarea = root.root.find((node) => (
          node.type === 'textarea'
          && node.props['aria-label'] === 'Payload 规则 override'
        ));

        expect(String(overrideTextarea.props.value)).toContain('"reasoning.effort": "high"');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('fills the default section when applying the Codex default high-reasoning preset', async () => {
      const root = await renderUpstreamSettings();
      try {
        const presetButton = findButton(root.root, 'Codex 默认高推理');

        await act(async () => {
          presetButton.props.onClick();
        });

        const defaultTextarea = root.root.find((node) => (
          node.type === 'textarea'
          && node.props['aria-label'] === 'Payload 规则 default'
        ));

        expect(String(defaultTextarea.props.value)).toContain('"reasoning.effort": "high"');
        expect(String(defaultTextarea.props.value)).toContain('"protocol": "codex"');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('saves parsed payload rules through updateRuntimeSettings', async () => {
      const root = await renderUpstreamSettings();
      try {
        const overrideRawTextarea = root.root.find((node) => (
          node.type === 'textarea'
          && node.props['aria-label'] === 'Payload 规则 override-raw'
        ));

        await act(async () => {
          overrideRawTextarea.props.onChange({
            target: {
              value: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": {
      "response_format": "{\\"type\\":\\"json_schema\\"}"
    }
  }
]`,
            },
          });
        });

        const saveButton = findButton(root.root, '保存 Payload 规则');
        await act(async () => {
          saveButton.props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
          payloadRules: {
            'override-raw': [
              {
                models: [{ name: 'gpt-*', protocol: 'codex' }],
                params: {
                  response_format: '{"type":"json_schema"}',
                },
              },
            ],
          },
        });
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('saves a rule created from the visual builder', async () => {
      const root = await renderUpstreamSettings({
        payloadRules: {},
      });
      try {
        const addButton = findButton(root.root, '新增规则');

        await act(async () => {
          addButton.props.onClick();
        });

        const modelInput = root.root.find((node) => (
          node.type === 'input'
          && node.props['aria-label'] === 'Payload 规则可视化模型 1'
        ));
        const pathInput = root.root.find((node) => (
          node.type === 'input'
          && node.props['aria-label'] === 'Payload 规则可视化路径 1'
        ));
        const valueInput = root.root.find((node) => (
          node.props['aria-label'] === 'Payload 规则可视化值 1'
        ));

        await act(async () => {
          modelInput.props.onChange({ target: { value: 'gpt-*' } });
          pathInput.props.onChange({ target: { value: 'reasoning.effort' } });
          valueInput.props.onChange({ target: { value: 'high' } });
        });

        const saveButton = findButton(root.root, '保存 Payload 规则');
        await act(async () => {
          saveButton.props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
          payloadRules: {
            default: [
              {
                models: [{ name: 'gpt-*' }],
                params: {
                  'reasoning.effort': 'high',
                },
              },
            ],
            'default-raw': [],
            override: [],
            'override-raw': [],
            filter: [],
          },
        });
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('keeps the full payload-rule protocol option set in the visual editor', async () => {
      const root = await renderUpstreamSettings({
        payloadRules: {},
      });
      try {
        const addButton = findButton(root.root, '新增规则');

        await act(async () => {
          addButton.props.onClick();
        });

        const protocolSelect = root.root.find((node) => (
          node.props['data-testid'] === 'payload-rule-protocol-1'
        ));
        const options = Array.isArray(protocolSelect.props.options)
          ? protocolSelect.props.options
          : [];
        const values = options.map((option: { value: string }) => option.value);

        expect(values).toEqual(expect.arrayContaining([
          '',
          'sub2api',
          'new-api',
          'one-api',
          'gemini-cli',
          'anyrouter',
        ]));
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('blocks save when a payload-rule section contains invalid JSON', async () => {
      const root = await renderUpstreamSettings();
      try {
        const filterTextarea = root.root.find((node) => (
          node.type === 'textarea'
          && node.props['aria-label'] === 'Payload 规则 filter'
        ));

        await act(async () => {
          filterTextarea.props.onChange({ target: { value: '[' } });
        });

        const saveButton = findButton(root.root, '保存 Payload 规则');
        await act(async () => {
          saveButton.props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });
  });

  describe('upstream parameter compatibility layer', () => {
    it('renders the compatibility switch and saves only this page keys', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatEnabled: false,
        upstreamParamCompatSelfHealEnabled: false,
        upstreamParamCompatRules: [],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        expect(card).toBeTruthy();
        expect(collectText(card)).toContain('上游参数兼容层');

        const toggles = card.findAll((node) => (
          node.type === 'input' && node.props.type === 'checkbox'
        ));
        expect(toggles[0].props.checked).toBe(false);
        expect(toggles[1].props.checked).toBe(false);

        await act(async () => {
          toggles[0].props.onChange({ target: { checked: true } });
        });

        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(Object.keys(payload).sort()).toEqual([
          'upstreamParamCompatEnabled',
          'upstreamParamCompatRules',
          'upstreamParamCompatSelfHealEnabled',
        ]);
        expect(payload.upstreamParamCompatEnabled).toBe(true);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('adds and removes compatibility rules', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [
          { siteId: 9, model: 'gpt-*', params: ['reasoning_effort'] },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');

        await act(async () => {
          findButton(card, '添加规则').props.onClick();
        });

        const newRow = findByData(card, 'data-upstream-param-compat-rule', 1);
        await act(async () => {
          findByData(newRow, 'data-upstream-param-compat-field', 'site-1').props.onChange({ target: { value: '12' } });
          findByData(newRow, 'data-upstream-param-compat-field', 'model-1').props.onChange({ target: { value: 'claude-*' } });
          findByData(newRow, 'data-upstream-param-compat-field', 'params-1').props.onChange({ target: { value: 'custom_param' } });
        });

        await act(async () => {
          findByData(card, 'data-upstream-param-compat-action', 'remove-0').props.onClick();
        });

        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamParamCompatRules).toEqual([
          { siteId: 12, model: 'claude-*', params: ['custom_param'] },
        ]);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('disables add-rule button at 64 rules', async () => {
      const manyRules = Array.from({ length: 64 }, (_, i) => ({
        siteId: i + 1,
        model: 'm-*',
        params: [],
      }));
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: manyRules,
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        const addButton = findButton(card, '添加规则');
        expect(addButton.props.disabled).toBe(true);
        expect(collectText(card)).toContain('已达 64 条上限');
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('preserves endpoint scope selection in the rule form', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatEnabled: true,
        upstreamParamCompatSelfHealEnabled: true,
        upstreamParamCompatRules: [
          {
            siteId: 9,
            model: 'gpt-*',
            params: ['reasoning_effort'],
            endpoints: ['chat', 'responses'],
          },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        const toggles = card.findAll((node) => (
          node.type === 'input' && node.props.type === 'checkbox'
        ));
        // Card-level toggles: [0]=enabled, [1]=selfHeal
        expect(toggles[1].props.checked).toBe(true);

        const ruleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const endpointCheckboxes = ruleRow.findAll((node) => (
          node.type === 'input'
          && node.props.type === 'checkbox'
          && node.props.checked !== undefined
        ));
        // Order: chat, responses, messages (the 3 endpoint checkboxes)
        expect(endpointCheckboxes[0].props.checked).toBe(true);   // chat
        expect(endpointCheckboxes[1].props.checked).toBe(true);   // responses
        expect(endpointCheckboxes[2].props.checked).toBe(false);  // messages

        // When only 1 checked, the checkbox should be disabled
        await act(async () => {
          endpointCheckboxes[1].props.onChange({ target: { checked: false } });
        });

        const updatedRuleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const updatedEndpointCheckboxes = updatedRuleRow.findAll((node) => (
          node.type === 'input'
          && node.props.type === 'checkbox'
          && node.props.checked !== undefined
        ));
        expect(updatedEndpointCheckboxes[0].props.checked).toBe(true);   // chat stays
        expect(updatedEndpointCheckboxes[0].props.disabled).toBe(true);  // disabled when alone
        expect(updatedEndpointCheckboxes[1].props.checked).toBe(false);  // responses off
        expect(updatedEndpointCheckboxes[2].props.checked).toBe(false);  // messages off

        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamParamCompatSelfHealEnabled).toBe(true);
        expect(payload.upstreamParamCompatRules).toEqual([
          {
            siteId: 9,
            model: 'gpt-*',
            params: ['reasoning_effort'],
            endpoints: ['chat'],
          },
        ]);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('allows messages-only single selection and saves endpoints as messages', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatEnabled: true,
        upstreamParamCompatRules: [
          {
            siteId: 9,
            model: 'gpt-*',
            params: ['reasoning_effort'],
            endpoints: ['chat', 'responses'],
          },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        const ruleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const endpointCheckboxes = ruleRow.findAll((node) => (
          node.type === 'input'
          && node.props.type === 'checkbox'
          && node.props.checked !== undefined
        ));
        // First check messages while chat+responses are both still checked (3 endpoints)
        await act(async () => {
          endpointCheckboxes[2].props.onChange({ target: { checked: true } });
        });
        // Now un-check chat (responses+messages remain)
        let updatedRuleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        let updatedEndpointCheckboxes = updatedRuleRow.findAll((node) => (
          node.type === 'input'
          && node.props.type === 'checkbox'
          && node.props.checked !== undefined
        ));
        await act(async () => {
          updatedEndpointCheckboxes[0].props.onChange({ target: { checked: false } });
        });
        // Now un-check responses, leaving only messages
        updatedRuleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        updatedEndpointCheckboxes = updatedRuleRow.findAll((node) => (
          node.type === 'input'
          && node.props.type === 'checkbox'
          && node.props.checked !== undefined
        ));
        await act(async () => {
          updatedEndpointCheckboxes[1].props.onChange({ target: { checked: false } });
        });

        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamParamCompatRules).toEqual([
          {
            siteId: 9,
            model: 'gpt-*',
            params: ['reasoning_effort'],
            endpoints: ['messages'],
          },
        ]);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('omits endpoints field when default set (chat+responses) is saved', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatEnabled: true,
        upstreamParamCompatRules: [
          {
            siteId: 9,
            model: 'gpt-*',
            params: ['reasoning_effort'],
            endpoints: [],
          },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamParamCompatRules).toEqual([
          {
            siteId: 9,
            model: 'gpt-*',
            params: ['reasoning_effort'],
          },
        ]);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('shows default checked state for empty endpoints (chat + responses)', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [
          { siteId: 9, model: 'gpt-*', params: ['reasoning_effort'], endpoints: [] },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        const ruleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const endpointCheckboxes = ruleRow.findAll((node) => (
          node.type === 'input' && node.props.type === 'checkbox' && node.props.checked !== undefined
        ));
        // Empty endpoints [] should fall back to default: chat + responses checked, messages off
        expect(endpointCheckboxes[0].props.checked).toBe(true);   // chat
        expect(endpointCheckboxes[1].props.checked).toBe(true);   // responses
        expect(endpointCheckboxes[2].props.checked).toBe(false);  // messages
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('filters invalid endpoint enums when loading settings', async () => {
      apiMock.getRuntimeSettings.mockResolvedValueOnce({
        ...apiMock.getRuntimeSettings.mock.results[0]?.value,
        upstreamParamCompatRules: [
          { siteId: 9, model: 'gpt-*', params: ['reasoning_effort'], endpoints: ['chat', 'invalid_endpoint', 'responses', 'messages'] },
        ],
      });
      const root = await renderUpstreamSettings();
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        const ruleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const endpointCheckboxes = ruleRow.findAll((node) => (
          node.type === 'input' && node.props.type === 'checkbox' && node.props.checked !== undefined
        ));
        // Only valid enums (chat, responses, messages) should be checked; invalid dropped
        expect(endpointCheckboxes[0].props.checked).toBe(true);   // chat
        expect(endpointCheckboxes[1].props.checked).toBe(true);   // responses
        expect(endpointCheckboxes[2].props.checked).toBe(true);   // messages
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('blocks save when a rule has empty siteId or model and shows an error', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [
          { siteId: null, model: '', params: [], endpoints: [] },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('blocks save when a rule has siteId 0 (UI sentinel) and shows an error', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        // Add a new rule (siteId defaults to 0)
        await act(async () => {
          findButton(card, '添加规则').props.onClick();
        });
        // Try to save without selecting a site
        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('blocks save when a param is empty and shows an error', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [
          { siteId: 9, model: 'gpt-*', params: [], endpoints: [] },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        const ruleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const paramsInput = findByData(ruleRow, 'data-upstream-param-compat-field', 'params-0');
        await act(async () => {
          paramsInput.props.onChange({ target: { value: ',' } });
        });
        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('blocks save when a param is an invalid identifier or structural key', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [
          { siteId: 9, model: 'gpt-*', params: ['invalid-param'], endpoints: [] },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('blocks save when a param is a structural key like model', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [
          { siteId: 9, model: 'gpt-*', params: ['model'], endpoints: [] },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('blocks save when a param contains a dot (not a valid identifier)', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [
          { siteId: 9, model: 'gpt-*', params: ['prompt_cache_key.with.dot'], endpoints: [] },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });

    it('drafts param text without splitting on comma during typing', async () => {
      const root = await renderUpstreamSettings({
        upstreamParamCompatRules: [
          { siteId: 9, model: 'gpt-*', params: ['reasoning_effort'], endpoints: [] },
        ],
      });
      try {
        const card = getCard(root.root, 'upstream-param-compat');
        const ruleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const paramsInput = findByData(ruleRow, 'data-upstream-param-compat-field', 'params-0');

        // Simulate typing 'prompt_cache_key,' character by character
        await act(async () => {
          paramsInput.props.onChange({ target: { value: 'p' } });
        });
        await act(async () => {
          paramsInput.props.onChange({ target: { value: 'pr' } });
        });
        await act(async () => {
          paramsInput.props.onChange({ target: { value: 'pro' } });
        });
        await act(async () => {
          paramsInput.props.onChange({ target: { value: 'prompt_cache_key,' } });
        });

        // The input should still show the full draft including comma
        const updatedRuleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const updatedParamsInput = findByData(updatedRuleRow, 'data-upstream-param-compat-field', 'params-0');
        expect(updatedParamsInput.props.value).toBe('prompt_cache_key,');

        // Blur should parse the draft into rule.params
        await act(async () => {
          updatedParamsInput.props.onBlur();
        });

        const afterBlurRuleRow = findByData(card, 'data-upstream-param-compat-rule', 0);
        const afterBlurParamsInput = findByData(afterBlurRuleRow, 'data-upstream-param-compat-field', 'params-0');
        expect(afterBlurParamsInput.props.value).toBe('prompt_cache_key');

        // Save should submit the parsed params
        await act(async () => {
          findButton(card, '保存参数兼容层').props.onClick();
        });
        await flushMicrotasks();

        const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
        expect(payload.upstreamParamCompatRules).toEqual([
          {
            siteId: 9,
            model: 'gpt-*',
            params: ['prompt_cache_key'],
          },
        ]);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });
  });
});
