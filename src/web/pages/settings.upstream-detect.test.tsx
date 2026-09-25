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

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).trim() === text
  ));
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

function getUpstreamDetectCard(root: ReactTestInstance): ReactTestInstance {
  return root.find((node) => (
    node.type === 'div'
    && node.props['data-settings-card'] === 'upstream-detect'
  ));
}

describe('Settings upstream provider detect section', () => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { document?: unknown }).document;
  });

  it('renders the relocated section with generic copy and site multi-select checkboxes', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue(buildRuntimeSettings({
      upstreamProviderDetectEnabled: true,
      upstreamProviderDetectSampleRate: 0.25,
      upstreamProviderDetectRetentionDays: 3,
      upstreamProviderDetectSiteIds: [9],
    }));

    const root = await renderSettings();
    try {
      const card = getUpstreamDetectCard(root.root);
      const cardText = collectText(card);

      expect(cardText).toContain('上游探测');
      expect(cardText).toContain('解析上游网关返回的路由元数据（provider_metadata.gateway.routing）');
      expect(cardText).toContain('适用于返回该结构的网关（例如 Cline）');
      // 去品牌化：功能名不再写成 Cline 专属
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
    const root = await renderSettings();
    try {
      const card = getUpstreamDetectCard(root.root);

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

      const reloadedCard = getUpstreamDetectCard(root.root);
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
    const root = await renderSettings();
    try {
      let card = getUpstreamDetectCard(root.root);
      expect(collectText(card)).toContain('未选择任何站点 = 不采集（即使总开关开启）');
      expect(collectText(card)).toContain('未选参与站点');

      await act(async () => {
        findButton(card, '全选').props.onClick();
      });

      card = getUpstreamDetectCard(root.root);
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
      card = getUpstreamDetectCard(root.root);
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

  it('scrolls to the upstream detect section when opened with ?section=upstream-detect', async () => {
    const scrollIntoView = vi.fn();
    const getElementById = vi.fn((id: string) => (
      id === 'settings-section-upstream-detect' ? { scrollIntoView } : null
    ));
    (globalThis as { document?: unknown }).document = { getElementById };

    const root = await renderSettings('/settings?section=upstream-detect');
    try {
      expect(getElementById).toHaveBeenCalledWith('settings-section-upstream-detect');
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
      expect(collectText(root.root)).toContain('解析上游网关返回的路由元数据');
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('does not try to scroll when the settings page is opened without a section param', async () => {
    const scrollIntoView = vi.fn();
    const getElementById = vi.fn(() => ({ scrollIntoView }));
    (globalThis as { document?: unknown }).document = { getElementById };

    const root = await renderSettings('/settings');
    try {
      expect(getElementById).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
