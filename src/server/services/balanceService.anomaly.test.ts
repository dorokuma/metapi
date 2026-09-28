import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  getBalance: vi.fn(),
  login: vi.fn(),
};

const selectAllMock = vi.fn();
const selectGetMock = vi.fn();
const updateSetMock = vi.fn();
const insertValuesMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const sendNotificationMock = vi.fn();
const decryptAccountPwdMock = vi.fn();
const setAccountRuntimeHealthMock = vi.fn();
const extractRuntimeHealthMock = vi.fn();
const isUnsupportedCheckinRuntimeHealthMock = vi.fn();

vi.mock('../db/index.js', () => {
  const selectChain = {
    all: () => selectAllMock(),
    get: () => selectGetMock(),
    where: () => selectChain,
    innerJoin: () => selectChain,
    from: () => selectChain,
  };

  const updateWhereChain = {
    run: () => ({}),
  };

  const updateSetChain = {
    where: () => updateWhereChain,
  };

  const insertChain = {
    run: () => ({}),
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return insertChain;
    },
  };

  return {
    db: {
      select: () => selectChain,
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          updateSetMock(updates);
          return updateSetChain;
        },
      }),
      insert: () => insertChain,
    },
    schema: {
      accounts: {
        id: 'id',
        siteId: 'siteId',
        balance: 'balance',
        balanceUsed: 'balanceUsed',
        quota: 'quota',
        status: 'status',
        accessToken: 'accessToken',
        apiToken: 'apiToken',
        extraConfig: 'extraConfig',
        username: 'username',
      },
      sites: {
        id: 'id',
        status: 'status',
        platform: 'platform',
        name: 'name',
        url: 'url',
      },
    },
    eq: vi.fn(),
  };
});

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPwd: (...args: unknown[]) => decryptAccountPwdMock(...args),
}));

vi.mock('./accountHealthService.js', async () => {
  const actual = await vi.importActual('./accountHealthService.js');
  return {
    ...actual,
    setAccountRuntimeHealth: (accountId: number, health: unknown) => setAccountRuntimeHealthMock(accountId, health),
    extractRuntimeHealth: (extraConfig: unknown) => extractRuntimeHealthMock(extraConfig),
    isUnsupportedCheckinRuntimeHealth: (health: unknown) => isUnsupportedCheckinRuntimeHealthMock(health),
  };
});


vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

vi.mock('../services/siteProxy.js', () => ({
  withAccountProxyOverride: async (_proxyUrl: string, fn: () => Promise<unknown>) => fn(),
}));

import { refreshBalance } from './balanceService.js';

function buildAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 1,
    siteId: overrides.siteId ?? 1,
    balance: overrides.balance ?? 0,
    balanceUsed: overrides.balanceUsed ?? 0,
    quota: overrides.quota ?? 100,
    status: overrides.status ?? 'active',
    accessToken: overrides.accessToken ?? 'token',
    apiToken: overrides.apiToken ?? null,
    extraConfig: overrides.extraConfig ?? null,
    username: overrides.username ?? 'user',
  };
}

function buildSite(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 1,
    status: overrides.status ?? 'active',
    platform: overrides.platform ?? 'new-api',
    name: overrides.name ?? 'Test Site',
    url: overrides.url ?? 'https://example.com',
  };
}

describe('refreshBalance anomaly clearing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectAllMock.mockReturnValue([{ accounts: undefined, sites: undefined }]);
    selectGetMock.mockReturnValue(null);
    updateSetMock.mockReturnValue({ where: () => ({ run: () => ({}) }) });
    adapterMock.getBalance.mockResolvedValue({
      balance: 0,
      used: 0,
      quota: 100,
      todayIncome: undefined,
      subscriptionSummary: null,
    });
    extractRuntimeHealthMock.mockReturnValue(null);
    isUnsupportedCheckinRuntimeHealthMock.mockReturnValue(false);
  });

  it('clears balanceAnomalies when account recovers (balance >= 0 and used <= quota)', async () => {
    const account = buildAccount({
      balance: -10,
      balanceUsed: 150,
      quota: 100,
      extraConfig: JSON.stringify({
        balanceAnomalies: {
          detectedAt: '2026-01-01T00:00:00.000Z',
          reasons: ['negative_balance', 'used_exceeds_quota'],
          balance: -10,
          balanceUsed: 150,
          quota: 100,
        },
      }),
    });
    const site = buildSite();

    selectAllMock.mockReturnValueOnce([{ accounts: account, sites: site }]);
    selectGetMock.mockReturnValueOnce(null);
    adapterMock.getBalance.mockResolvedValueOnce({
      balance: 0,
      used: 50,
      quota: 100,
      todayIncome: undefined,
      subscriptionSummary: null,
    });

    await refreshBalance(account.id);

    const updateArg = updateSetMock.mock.calls[0][0];
    expect(updateArg.balance).toBe(0);
    expect(updateArg.balanceUsed).toBe(50);
    expect(updateArg.quota).toBe(100);
    const cleaned = JSON.parse(String(updateArg.extraConfig));
    expect(cleaned).not.toHaveProperty('balanceAnomalies');
  });

  it('preserves balanceAnomalies when account still has negative balance', async () => {
    const account = buildAccount({
      balance: -5,
      balanceUsed: 50,
      quota: 100,
      extraConfig: JSON.stringify({
        balanceAnomalies: {
          detectedAt: '2026-01-01T00:00:00.000Z',
          reasons: ['negative_balance'],
          balance: -5,
          balanceUsed: 50,
          quota: 100,
        },
      }),
    });
    const site = buildSite();

    selectAllMock.mockReturnValueOnce([{ accounts: account, sites: site }]);
    selectGetMock.mockReturnValueOnce(null);
    adapterMock.getBalance.mockResolvedValueOnce({
      balance: -5,
      used: 50,
      quota: 100,
      todayIncome: undefined,
      subscriptionSummary: null,
    });

    await refreshBalance(account.id);

    const updateArg = updateSetMock.mock.calls[0][0];
    const cleaned = JSON.parse(String(updateArg.extraConfig));
    expect(cleaned).toHaveProperty('balanceAnomalies');
  });

  it('preserves balanceAnomalies when used exceeds quota', async () => {
    const account = buildAccount({
      balance: 0,
      balanceUsed: 150,
      quota: 100,
      extraConfig: JSON.stringify({
        balanceAnomalies: {
          detectedAt: '2026-01-01T00:00:00.000Z',
          reasons: ['used_exceeds_quota'],
          balance: 0,
          balanceUsed: 150,
          quota: 100,
        },
      }),
    });
    const site = buildSite();

    selectAllMock.mockReturnValueOnce([{ accounts: account, sites: site }]);
    selectGetMock.mockReturnValueOnce(null);
    adapterMock.getBalance.mockResolvedValueOnce({
      balance: 0,
      used: 150,
      quota: 100,
      todayIncome: undefined,
      subscriptionSummary: null,
    });

    await refreshBalance(account.id);

    const updateArg = updateSetMock.mock.calls[0][0];
    const cleaned = JSON.parse(String(updateArg.extraConfig));
    expect(cleaned).toHaveProperty('balanceAnomalies');
  });
});
