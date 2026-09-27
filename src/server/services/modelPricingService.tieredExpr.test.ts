import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, withSiteProxyRequestInitMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  withSiteProxyRequestInitMock: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  withSiteProxyRequestInit: (...args: unknown[]) => withSiteProxyRequestInitMock(...args),
}));

import {
  buildProxyBillingDetails,
  estimateProxyCost,
  fetchModelPricingCatalog,
} from './modelPricingService.js';

const SITE_BASE = 'https://x.example';

function jsonResponse(body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
}

function mockPricingPayloadOnce(models: unknown[], groupRatio: Record<string, number> = { default: 1 }) {
  fetchMock.mockResolvedValueOnce(jsonResponse({ data: models, group_ratio: groupRatio, success: true }));
}

function site(id: number) {
  return { id, url: SITE_BASE, platform: 'new-api' };
}

beforeEach(() => {
  vi.clearAllMocks();
  withSiteProxyRequestInitMock.mockImplementation((requestInit: unknown) => requestInit);
});

describe('modelPricingService — tiered_expr pricing path', () => {
  it('uses the billing_expr price instead of the placeholder model_ratio', async () => {
    // placeholder ratio 37.5 would imply inputPerMillion 75 and total ~150 for 1M+1M.
    // The real expression prices 1M input + 1M output at 1.4 + 4.4 = 5.8.
    mockPricingPayloadOnce([
      {
        model_name: 'glm-5.3',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("base", p * 1.4 + c * 4.4 + cr * 0.26)',
      },
    ]);

    const details = await buildProxyBillingDetails({
      site: site(9021),
      account: { id: 9021 },
      modelName: 'glm-5.3',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    expect(details).not.toBeNull();
    expect(details!.pricing.pricingSource).toBe('expr');
    expect(details!.pricing.billingExpr).toBe('tier("base", p * 1.4 + c * 4.4 + cr * 0.26)');
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(1.4, 10);
    expect(details!.breakdown.outputPerMillion).toBeCloseTo(4.4, 10);
    expect(details!.breakdown.totalCost).toBeCloseTo(5.8, 10);
  });

  it('estimates cost through the billing_expr path', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'glm-5.3',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("base", p * 1.4 + c * 4.4 + cr * 0.26)',
      },
    ]);

    const cost = await estimateProxyCost({
      site: site(9026),
      account: { id: 9026 },
      modelName: 'glm-5.3',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    expect(cost).toBeCloseTo(5.8, 10);
  });

  it('selects the context-length tier from the usage length', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'gpt-6-sol',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 2,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr:
          'len <= 272000 ? tier("0_272k", p * 2 + cr * 0.2 + cc * 2.5 + c * 10) : tier("272k_plus", p * 4 + cr * 0.4 + cc * 5 + c * 15)',
      },
    ]);

    // 1M prompt is above the 272k boundary -> 272k_plus tier (p * 4)
    const over = await buildProxyBillingDetails({
      site: site(9022),
      account: { id: 9022 },
      modelName: 'gpt-6-sol',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });
    expect(over!.pricing.pricingSource).toBe('expr');
    expect(over!.breakdown.inputPerMillion).toBeCloseTo(4, 10);
    expect(over!.breakdown.totalCost).toBeCloseTo(4, 10);

    // 100k prompt is below the boundary -> 0_272k tier (p * 2)
    const under = await buildProxyBillingDetails({
      site: site(9022),
      account: { id: 9022 },
      modelName: 'gpt-6-sol',
      promptTokens: 100_000,
      completionTokens: 0,
      totalTokens: 100_000,
    });
    expect(under!.breakdown.inputPerMillion).toBeCloseTo(2, 10);
    expect(under!.breakdown.totalCost).toBeCloseTo(0.2, 10);
  });

  it('evaluates billing_expr with cc1h (cc1h maps to 0 when not tracked)', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'claude-opus-5-5',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("standard", p * 4 + cr * 0.2 + cc * 5 + cc1h * 8 + c * 20)',
      },
    ]);

    const details = await buildProxyBillingDetails({
      site: site(9025),
      account: { id: 9025 },
      modelName: 'claude-opus-5-5',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });

    expect(details!.pricing.pricingSource).toBe('expr');
    // p=1, everything else 0 -> 4
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(4, 10);
  });

  it('falls back to the ratio path when billing_expr is unparseable', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'bad-model',
        quota_type: 0,
        model_ratio: 2,
        completion_ratio: 2,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("base", p * 2 + ', // malformed, cut off
      },
    ]);

    const details = await buildProxyBillingDetails({
      site: site(9023),
      account: { id: 9023 },
      modelName: 'bad-model',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });

    // ratio fallback: inputPerMillion = model_ratio * 2 = 4
    expect(details!.pricing.pricingSource).toBe('ratio');
    // The fallback is auditable, not silent: the billing_expr was present but unparseable.
    expect(details!.pricing.exprFallback).toBe(true);
    expect(details!.pricing.exprFallbackReason).toContain('not parseable');
    expect(details!.pricing.billingExpr).toBe('tier("base", p * 2 +');
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(4, 10);
  });

  it('falls back to the ratio path for an unsupported billing_mode', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'odd-model',
        quota_type: 0,
        model_ratio: 3,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'per_call', // not tiered_expr
        billing_expr: 'p * 2', // valid expression, but mode is not tiered_expr
      },
    ]);

    const details = await buildProxyBillingDetails({
      site: site(9024),
      account: { id: 9024 },
      modelName: 'odd-model',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });

    // ratio fallback: inputPerMillion = model_ratio * 2 = 6
    expect(details!.pricing.pricingSource).toBe('ratio');
    // The fallback is auditable, not silent: the billing_expr was present but the mode is unsupported.
    expect(details!.pricing.exprFallback).toBe(true);
    expect(details!.pricing.exprFallbackReason).toContain('unsupported billing_mode');
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(6, 10);
  });

  it('leaves ratio models untouched (no billing_expr) on the ratio path', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'plain-model',
        quota_type: 0,
        model_ratio: 1.2,
        completion_ratio: 3,
        enable_groups: ['default'],
      },
    ]);

    const details = await buildProxyBillingDetails({
      site: site(9027),
      account: { id: 9027 },
      modelName: 'plain-model',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    expect(details!.pricing.pricingSource).toBe('ratio');
    expect(details!.pricing.billingExpr ?? null).toBeNull();
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(2.4, 10); // 1.2 * 2
    expect(details!.breakdown.outputPerMillion).toBeCloseTo(7.2, 10); // 1.2 * 3 * 2
  });

  it('marks catalog expr per-M as a base-tier estimate (len=0)', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'gpt-6-sol',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 2,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr:
          'len <= 272000 ? tier("0_272k", p * 2 + cr * 0.2 + cc * 2.5 + c * 10) : tier("272k_plus", p * 4 + cr * 0.4 + cc * 5 + c * 15)',
      },
    ]);

    const catalog = await fetchModelPricingCatalog({
      site: site(9030),
      account: { id: 9030 },
      modelName: 'gpt-6-sol',
    });

    expect(catalog).not.toBeNull();
    const entry = catalog!.models.find((m) => m.modelName === 'gpt-6-sol')!;
    const group = entry.groupPricing.default!;
    // expr path is taken and flagged as an estimate (base tier), not a definitive price.
    expect(group.exprEstimate).toBe(true);
    // base tier (len=0) -> 0_272k: input 2, output 10
    expect(group.inputPerMillion).toBeCloseTo(2, 10);
    expect(group.outputPerMillion).toBeCloseTo(10, 10);
  });

  it('smoothly falls back to ratio when billing_expr throws at runtime (invalid timezone)', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'tz-model',
        quota_type: 0,
        model_ratio: 2,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'hour("Not/ARealZone") * p', // parses fine, but hour() throws at eval
      },
    ]);

    const details = await buildProxyBillingDetails({
      site: site(9031),
      account: { id: 9031 },
      modelName: 'tz-model',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });

    // ratio fallback (model_ratio 2 -> inputPerMillion 4) with an auditable reason.
    expect(details!.pricing.pricingSource).toBe('ratio');
    expect(details!.pricing.exprFallback).toBe(true);
    expect(details!.pricing.exprFallbackReason).toContain('evaluation failed');
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(4, 10);
  });

  it('applies the group multiplier to expr per-M prices', async () => {
    mockPricingPayloadOnce(
      [
        {
          model_name: 'glm-5.3',
          quota_type: 0,
          model_ratio: 37.5,
          completion_ratio: 1,
          enable_groups: ['vip'], // not default -> the vip ratio is selected
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p * 1.4 + c * 4.4 + cr * 0.26)',
        },
      ],
      { default: 1, vip: 2 },
    );

    const details = await buildProxyBillingDetails({
      site: site(9032),
      account: { id: 9032 },
      modelName: 'glm-5.3',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
    });

    // vip group (multiplier 2): input 1.4 * 2 = 2.8
    expect(details!.pricing.groupRatio).toBeCloseTo(2, 10);
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(2.8, 10);
    expect(details!.breakdown.totalCost).toBeCloseTo(2.8, 10);
  });

  it('reconstructs len from prompt + cache when promptTokensIncludeCache is false', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'gpt-6-sol',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 2,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'len <= 272000 ? tier("0_272k", p * 2) : tier("272k_plus", p * 4)',
      },
    ]);

    // prompt is small (100k) but cache read is large (300k) and tracked separately
    // (promptTokensIncludeCache=false) -> len = 100k + 300k = 400k > 272k -> 272k_plus tier.
    const details = await buildProxyBillingDetails({
      site: site(9034),
      account: { id: 9034 },
      modelName: 'gpt-6-sol',
      promptTokens: 100_000,
      completionTokens: 0,
      totalTokens: 400_000,
      cacheReadTokens: 300_000,
      promptTokensIncludeCache: false,
    });

    expect(details!.pricing.pricingSource).toBe('expr');
    // Without the cache-inclusive len this would select 0_272k (inputPerMillion 2).
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(4, 10);
  });

  it('maps tracked 1h cache-creation into cc1h and bills it as its own dimension', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'claude-opus-5-5',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("standard", p * 4 + cr * 0.2 + cc * 5 + cc1h * 8 + c * 20)',
      },
    ]);

    const details = await buildProxyBillingDetails({
      site: site(9035),
      account: { id: 9035 },
      modelName: 'claude-opus-5-5',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      cacheCreationTokens: 1_000_000, // 5m
      cacheCreationTokens1h: 500_000, // 1h
      promptTokensIncludeCache: false, // prompt is separate from cache, so it stays fully billable
    });

    expect(details!.pricing.pricingSource).toBe('expr');
    expect(details!.usage.cacheCreationTokens1h).toBe(500_000);
    // p 1M*4=4, cc(5m) 1M*5=5, cc1h 0.5M*8=4 -> total 13
    expect(details!.breakdown.cacheCreationPerMillion).toBeCloseTo(5, 10);
    expect(details!.breakdown.cc1hPerMillion).toBeCloseTo(8, 10);
    expect(details!.breakdown.cacheCreationCost).toBeCloseTo(5, 10);
    expect(details!.breakdown.cc1hCost).toBeCloseTo(4, 10);
    expect(details!.breakdown.totalCost).toBeCloseTo(13, 10);
  });

  it('bills cc1h as 0 when claude_cache_creation_1_h_tokens is absent (end-to-end)', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'claude-opus-5-5',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("standard", p * 4 + cr * 0.2 + cc * 5 + cc1h * 8 + c * 20)',
      },
    ]);

    // Upstream did not report claude_cache_creation_1_h_tokens separately;
    // only the 5m share is present, so cc1h stays 0 and its cost is excluded.
    const details = await buildProxyBillingDetails({
      site: site(9036),
      account: { id: 9036 },
      modelName: 'claude-opus-5-5',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      cacheCreationTokens: 1_000_000, // only 5m
      // cacheCreationTokens1h omitted -> defaults to 0
      promptTokensIncludeCache: false,
    });

    expect(details!.pricing.pricingSource).toBe('expr');
    expect(details!.usage.cacheCreationTokens1h).toBe(0);
    // p 1M*4=4, cc(5m) 1M*5=5 -> total 9 (no cc1h component)
    expect(details!.breakdown.cacheCreationPerMillion).toBeCloseTo(5, 10);
    // cc1hPerMillion / cc1hCost are omitted entirely when cc1h is 0, not set to 0.
    expect(details!.breakdown.cc1hPerMillion).toBeUndefined();
    expect(details!.breakdown.cc1hCost).toBeUndefined();
    expect(details!.breakdown.cacheCreationCost).toBeCloseTo(5, 10);
    expect(details!.breakdown.totalCost).toBeCloseTo(9, 10);
  });

  it('bills 1h cache-creation as its own dimension when present (end-to-end)', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'claude-opus-5-5',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("standard", p * 4 + cr * 0.2 + cc * 5 + cc1h * 8 + c * 20)',
      },
    ]);

    // Both 5m and 1h cache-creation are reported separately.
    const details = await buildProxyBillingDetails({
      site: site(9037),
      account: { id: 9037 },
      modelName: 'claude-opus-5-5',
      promptTokens: 2_000_000,
      completionTokens: 500_000,
      totalTokens: 3_000_000,
      cacheReadTokens: 200_000,
      cacheCreationTokens: 300_000, // 5m
      cacheCreationTokens1h: 150_000, // 1h
      promptTokensIncludeCache: false,
    });

    expect(details!.pricing.pricingSource).toBe('expr');
    expect(details!.usage.cacheCreationTokens1h).toBe(150_000);
    // p 2M*4=8, cr 0.2M*0.2=0.04, cc(5m) 0.3M*5=1.5, cc1h 0.15M*8=1.2, c 0.5M*20=10 -> total 20.74
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(4, 10);
    expect(details!.breakdown.cacheReadPerMillion).toBeCloseTo(0.2, 10);
    expect(details!.breakdown.cacheCreationPerMillion).toBeCloseTo(5, 10);
    expect(details!.breakdown.cc1hPerMillion).toBeCloseTo(8, 10);
    expect(details!.breakdown.outputPerMillion).toBeCloseTo(20, 10);
    expect(details!.breakdown.inputCost).toBeCloseTo(8, 10);
    expect(details!.breakdown.cacheReadCost).toBeCloseTo(0.04, 10);
    expect(details!.breakdown.cacheCreationCost).toBeCloseTo(1.5, 10);
    expect(details!.breakdown.cc1hCost).toBeCloseTo(1.2, 10);
    expect(details!.breakdown.outputCost).toBeCloseTo(10, 10);
    expect(details!.breakdown.totalCost).toBeCloseTo(20.74, 10);
  });

  it('selects len tier and applies hour multiplier together (end-to-end billing)', async () => {
    mockPricingPayloadOnce([
      {
        model_name: 'grok-4.7',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr:
          'len <= 200000 ? tier("0_200k", p * 2 + cr * 0.5 + c * 6) : tier("200k_plus", p * 4 + cr * 1 + c * 12)',
      },
    ]);
    // Second call needs its own mock because mockResolvedValueOnce is single-use.
    mockPricingPayloadOnce([
      {
        model_name: 'grok-4.7',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr:
          'len <= 200000 ? tier("0_200k", p * 2 + cr * 0.5 + c * 6) : tier("200k_plus", p * 4 + cr * 1 + c * 12)',
      },
    ]);

    const offPeakUnder = await buildProxyBillingDetails({
      site: site(9038),
      account: { id: 9038 },
      modelName: 'grok-4.7',
      promptTokens: 100_000,
      completionTokens: 50_000,
      totalTokens: 180_000,
      cacheReadTokens: 10_000,
      // created_at is fixed by the mock; we control `now` via system time in the mock.
      // The mock billing_expr above does NOT include hour() multiplier, so cost is deterministic.
    });

    // len = 100k (under 200k) -> 0_200k tier: p*2 + cr*0.5 + c*6 = 2 + 0.5 + 6 = 8.5 per 1M
    // billable prompt = 100k - 10k = 90k -> 0.09 * 2 = 0.18
    // cache read = 10k -> 0.01 * 0.5 = 0.005
    // completion = 50k -> 0.05 * 6 = 0.3
    // total = 0.485
    expect(offPeakUnder!.pricing.pricingSource).toBe('expr');
    expect(offPeakUnder!.breakdown.inputPerMillion).toBeCloseTo(2, 10);
    expect(offPeakUnder!.breakdown.cacheReadPerMillion).toBeCloseTo(0.5, 10);
    expect(offPeakUnder!.breakdown.outputPerMillion).toBeCloseTo(6, 10);
    expect(offPeakUnder!.breakdown.inputCost).toBeCloseTo(0.18, 10);
    expect(offPeakUnder!.breakdown.cacheReadCost).toBeCloseTo(0.005, 10);
    expect(offPeakUnder!.breakdown.outputCost).toBeCloseTo(0.3, 10);
    expect(offPeakUnder!.breakdown.totalCost).toBeCloseTo(0.485, 10);

    const over = await buildProxyBillingDetails({
      site: site(9039),
      account: { id: 9039 },
      modelName: 'grok-4.7',
      promptTokens: 300_000,
      completionTokens: 100_000,
      totalTokens: 500_000,
      cacheReadTokens: 0,
    });

    // len = 300k (over 200k) -> 200k_plus tier: p*4 + cr*1 + c*12 = 4 + 12 = 16 per 1M
    // total = 0.3*4 + 0.1*12 = 1.2 + 1.2 = 2.4
    expect(over!.pricing.pricingSource).toBe('expr');
    expect(over!.breakdown.inputPerMillion).toBeCloseTo(4, 10);
    expect(over!.breakdown.outputPerMillion).toBeCloseTo(12, 10);
    expect(over!.breakdown.totalCost).toBeCloseTo(2.4, 10);
  });
});
