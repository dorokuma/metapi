import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Settings from './Settings.js';

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

function buildRuntimeSettings(overrides: Record<string, unknown> = {}) {
  return {
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
    routingFallbackUnitCost: 1,
    routingWeights: {},
    adminIpAllowlist: [],
    systemProxyUrl: '',
    upstreamProviderDetectEnabled: false,
    upstreamProviderDetectSampleRate: 1,
    upstreamProviderDetectRetentionDays: 14,
    upstreamProviderDetectSiteIds: [],
    upstreamProviderPinEnabled: false,
    upstreamProviderPinRules: [],
    ...overrides,
  };
}

async function renderSettings(initialEntry = '/settings') {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={[initialEntry]}>
        <ToastProvider>
          <Settings />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root;
}

function getPinCard(root: ReactTestInstance): ReactTestInstance {
  return root.find((node) => (
    node.type === 'div'
    && node.props['data-settings-card'] === 'upstream-pin'
  ));
}

function findByData(root: ReactTestInstance, key: string, value: unknown): ReactTestInstance {
  return root.find((node) => node.props[key] === value);
}

function findPinAction(root: ReactTestInstance, action: string): ReactTestInstance {
  return findByData(root, 'data-upstream-pin-action', action);
}

function findPinField(root: ReactTestInstance, field: string): ReactTestInstance {
  return findByData(root, 'data-upstream-pin-field', field);
}

const RULE_A = { siteId: 9, model: 'cline-pass/*', providers: ['deepseek'], mode: 'only' as const };
const RULE_B = { siteId: 12, model: 'other/model', providers: ['alibaba'], mode: 'order' as const };

describe('Settings upstream provider pin section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings());
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getSites.mockResolvedValue([
      { id: 9, name: 'main-site', url: 'https://api.cline.bot', status: 'active' },
      { id: 12, name: 'second-site', url: 'https://api.example.com', status: 'active' },
    ]);
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.updateRuntimeSettings.mockImplementation(async (payload: any) => ({
      success: true,
      ...payload,
    }));
    apiMock.getUpstreamObservationDistribution.mockResolvedValue([
      { provider: 'deepseek', requests: 3, cacheHitTokens: 1, cacheMissTokens: 2 },
    ]);
    apiMock.getUpstreamObservationFallbacks.mockResolvedValue({
      items: [{ siteId: 9, requestedModel: 'cline-pass/*', canonicalSlug: null, finalProvider: 'deepseek', latestCreatedAt: '2026-09-26T00:00:00.000Z', fallbacks: ['deepseek', 'alibaba'], fallbackCount: 2 }],
      truncated: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { document?: unknown }).document;
  });

  it('renders the new card with pre-announcement copy, empty hint and reserved semantics', async () => {
    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
      const cardText = collectText(card);

      expect(cardText).toContain('上游供应商钉选');
      // 通用定位文案
      expect(cardText).toContain('适用于所有支持该字段约定的网关与聚合商');
      expect(cardText).toContain('不读取该约定的上游通常会忽略这些字段');
      expect(cardText).toContain('建议先从实测支持的站点启用');
      // 空列表提示
      expect(cardText).toContain('未配置规则 = 不注入任何字段');
      expect(cardText).toContain('未开启');

      const enabledToggle = findPinField(card, 'enabled');
      expect(enabledToggle.props.checked).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('adds rows, edits fields and saves only the three pin keys with the submitted values', async () => {
    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);

      await act(async () => {
        findPinAction(card, 'add-rule').props.onClick();
      });

      const ruleRow = findByData(card, 'data-upstream-pin-rule', 0);
      await act(async () => {
        findPinField(ruleRow, 'site-0').props.onChange({ target: { value: '9' } });
        findPinField(ruleRow, 'model-0').props.onChange({ target: { value: 'cline-pass/*' } });
        findPinField(ruleRow, 'mode-0').props.onChange({ target: { value: 'order' } });
      });
      // 逗号触发提交
      await act(async () => {
        findByData(ruleRow, 'data-upstream-pin-provider-input', 0)
          .props.onChange({ target: { value: 'deepseek,' } });
      });
      // 回车提交第二项
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
      // R6 模式提示文案
      expect(collectText(card)).toContain('严格 only：目标提供方不可用时请求直接失败，不会回退');

      await act(async () => {
        findPinAction(card, 'save').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledTimes(1);
      const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
      expect(Object.keys(payload).sort()).toEqual([
        'upstreamProviderPinAdapterMap',
        'upstreamProviderPinEnabled',
        'upstreamProviderPinRules',
      ]);
      // 未配置适配器 → 提交空对象（显式清空语义，服务端 PUT 按空映射处理）
      expect(payload.upstreamProviderPinAdapterMap).toEqual({});
      expect(payload.upstreamProviderPinRules).toEqual([
        { siteId: 9, model: 'cline-pass/*', providers: ['deepseek', 'alibaba'], mode: 'order' },
      ]);
      // 探测字段不得混入
      expect(payload).not.toHaveProperty('upstreamProviderDetectEnabled');
      expect(payload).not.toHaveProperty('upstreamProviderDetectSiteIds');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('removes a row and never submits it', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderPinEnabled: true,
      upstreamProviderPinRules: [RULE_A, RULE_B],
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
      await act(async () => {
        findPinAction(card, 'remove-0').props.onClick();
      });

      await act(async () => {
        findPinAction(card, 'save').props.onClick();
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
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderPinEnabled: true,
      upstreamProviderPinRules: [RULE_A, RULE_B],
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
      await act(async () => {
        findPinAction(card, 'move-up-1').props.onClick();
      });

      await act(async () => {
        findPinAction(card, 'save').props.onClick();
      });
      await flushMicrotasks();

      const payload = apiMock.updateRuntimeSettings.mock.calls[0][0];
      expect(payload.upstreamProviderPinRules).toEqual([RULE_B, RULE_A]);

      // 第一行上移按钮在顶部被禁用、末行下移按钮被禁用
      const firstRow = findByData(card, 'data-upstream-pin-rule', 0);
      const lastRow = findByData(card, 'data-upstream-pin-rule', 1);
      expect(findPinAction(firstRow, 'move-up-0').props.disabled).toBe(true);
      expect(findPinAction(lastRow, 'move-down-1').props.disabled).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('warns inline about duplicate site + model rows without blocking save', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderPinRules: [
        { siteId: 9, model: 'm', providers: ['a'], mode: 'only' },
        { siteId: 9, model: 'm', providers: ['b'], mode: 'order' },
      ],
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
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
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderDetectEnabled: true,
      upstreamProviderPinRules: [RULE_A],
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
      // 初始渲染零预取
      expect(apiMock.getUpstreamObservationDistribution).not.toHaveBeenCalled();

      await act(async () => {
        findPinAction(card, 'observe-0').props.onClick();
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

    // 降级：探测关闭时点击只显示提示，不发请求
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderDetectEnabled: false,
      upstreamProviderPinRules: [RULE_A],
    }));
    const degraded = await renderSettings();
    try {
      const card = getPinCard(degraded.root);
      await act(async () => {
        findPinAction(card, 'observe-0').props.onClick();
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
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderDetectEnabled: true,
      upstreamProviderPinRules: [RULE_A],
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
      expect(apiMock.getUpstreamObservationFallbacks).not.toHaveBeenCalled();
      expect(collectText(card)).toContain('候选来自上游探测词表、仅适用同一网关');

      await act(async () => {
        findPinAction(card, 'fill-0').props.onClick();
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

    // 探测关闭时按钮禁用，不发起请求
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderDetectEnabled: false,
      upstreamProviderPinRules: [RULE_A],
    }));
    const second = await renderSettings();
    try {
      const card = getPinCard(second.root);
      expect(findPinAction(card, 'fill-0').props.disabled).toBe(true);
      expect(apiMock.getUpstreamObservationFallbacks).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        second.unmount();
      });
    }
  });

  it('renders the adapter section with the default-dual empty hint', async () => {
    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
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
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderPinAdapterMap: { '9': 'generic-dual' },
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
      const row = findByData(card, 'data-upstream-pin-adapter-row', '9');
      const optionTexts = row.findAll((node) => node.type === 'option').map((node) => collectText(node));
      expect(optionTexts).toEqual(expect.arrayContaining([
        '通用双姿势（默认）',
        'OpenRouter',
        'Vercel AI Gateway',
        '不注入（无钉选机制）',
      ]));
      // Phase 1 只列出已实现适配器，不提供假选项
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
    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);

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
        findPinAction(card, 'save').props.onClick();
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
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderPinEnabled: true,
      upstreamProviderPinAdapterMap: { '9': 'openrouter' },
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
      const row = findByData(card, 'data-upstream-pin-adapter-row', '9');
      expect(collectText(row)).toContain('OpenRouter');

      await act(async () => {
        findByData(row, 'data-upstream-pin-adapter-action', 'remove-9').props.onClick();
      });
      await act(async () => {
        findPinAction(card, 'save').props.onClick();
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
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderPinEnabled: true,
      upstreamProviderPinRules: [RULE_A, RULE_B],
      upstreamProviderPinAdapterMap: { '9': 'none', '12': 'openrouter' },
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);

      // 规则 0（site 9, only）+ none：展示 none label + 无机制提示（不阻塞保存）
      const row0 = findByData(card, 'data-upstream-pin-rule', 0);
      expect(collectText(findByData(row0, 'data-upstream-pin-adapter-hint', 0))).toContain('不注入（无钉选机制）');
      expect(collectText(findByData(row0, 'data-upstream-pin-adapter-warning', 0)))
        .toContain('该网关无请求体钉选机制，规则不会注入');

      // 规则 1（site 12, order）+ openrouter：展示 label、无警告
      const row1 = findByData(card, 'data-upstream-pin-rule', 1);
      expect(collectText(findByData(row1, 'data-upstream-pin-adapter-hint', 1))).toContain('OpenRouter');
      expect(row1.findAll((node) => node.props['data-upstream-pin-adapter-warning'] !== undefined)).toHaveLength(0);

      await act(async () => {
        findPinAction(card, 'save').props.onClick();
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
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderPinRules: [RULE_A],
      upstreamProviderPinAdapterMap: { '9': 'portkey' },
    }));

    const root = await renderSettings();
    try {
      const card = getPinCard(root.root);
      const row0 = findByData(card, 'data-upstream-pin-rule', 0);
      expect(collectText(findByData(row0, 'data-upstream-pin-adapter-hint', 0))).toContain('未知适配器「portkey」');
      expect(collectText(findByData(row0, 'data-upstream-pin-adapter-warning', 0)))
        .toContain('该请求不会受本规则约束');

      // 未知 id 不下拉丢失：适配器行保留原值并提示不会注入
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
