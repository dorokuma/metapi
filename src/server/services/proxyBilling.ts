import {
  buildProxyBillingDetails,
  estimateProxyCost,
  type ProxyBillingDetails,
  type ProxyBillingPricingOverride,
} from './modelPricingService.js';
import type { SelfLogBillingMeta } from './proxyUsageFallbackService.js';

interface ProxyBillingUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokensIncludeCache: boolean | null;
  selfLogBillingMeta: SelfLogBillingMeta | null;
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
}

interface ResolvedProxyUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
  selfLogBillingMeta: SelfLogBillingMeta | null;
}

interface ResolveProxyLogBillingInput {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
  modelName: string;
  resolvedUsage: ProxyBillingUsageSummary;
  resolvedUsageColumns: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    promptTokensIncludeCache: boolean | null;
  };
}

function toPricingOverride(meta: SelfLogBillingMeta | null): ProxyBillingPricingOverride | null {
  if (!meta) return null;
  return {
    modelRatio: meta.modelRatio,
    completionRatio: meta.completionRatio,
    cacheRatio: meta.cacheRatio,
    cacheCreationRatio: meta.cacheCreationRatio,
    groupRatio: meta.groupRatio,
  };
}

export async function resolveProxyLogBilling(
  input: ResolveProxyLogBillingInput,
): Promise<{ estimatedCost: number; billingDetails: ProxyBillingDetails | null }> {
  const selfLogMeta = input.resolvedUsage.selfLogBillingMeta;
  const billingPricingOverride = toPricingOverride(selfLogMeta);
  // 归一后只消费 columns（resolveFinalUsage 已统一处理 flag/cache 语义）。
  const columns = input.resolvedUsageColumns;
  const cacheReadTokens = columns.cacheReadTokens ?? 0;
  const cacheCreationTokens = columns.cacheCreationTokens ?? 0;
  const promptTokensIncludeCache = columns.promptTokensIncludeCache;

  const billingInput = {
    site: input.site,
    account: input.account,
    modelName: input.modelName,
    promptTokens: columns.promptTokens ?? 0,
    completionTokens: columns.completionTokens ?? 0,
    totalTokens: columns.totalTokens ?? 0,
    cacheReadTokens,
    cacheCreationTokens,
    promptTokensIncludeCache,
    billingPricingOverride,
  };

  let estimatedCost = await estimateProxyCost(billingInput);
  const billingDetails = await buildProxyBillingDetails(billingInput);

  if (
    input.resolvedUsage.estimatedCostFromQuota > 0
    && (input.resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)
  ) {
    estimatedCost = input.resolvedUsage.estimatedCostFromQuota;
  }

  return {
    estimatedCost,
    billingDetails,
  };
}
