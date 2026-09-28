import { mergeAccountExtraConfig } from './accountExtraConfig.js';
import { formatLocalDate } from './localTimeService.js';

type TodayIncomeSnapshot = {
  day: string;
  baseline?: number;
  latest: number;
  updatedAt?: string;
  /** 归一后来源：quota=上游 quota 单位需换算, dollar=上游已是美元, normalized=已归一 */
  incomeUnitSource?: 'quota' | 'dollar' | 'normalized';
  /** 写入时使用的平台，用于读取时归一（仅 incomeUnitSource=quota 时生效） */
  incomePlatform?: string;
};

type EstimateRewardInput = {
  day: string;
  successCount: number;
  parsedRewardCount: number;
  rewardSum: number;
  extraConfig?: string | Record<string, unknown> | null;
  platform?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(value: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

function resolveQuotaConversionFactor(platform?: string | null): number {
  const normalized = typeof platform === 'string' ? platform.toLowerCase() : '';
  return normalized === 'veloera' ? 1_000_000 : 500_000;
}

function normalizeTodayIncome(platform: string | null | undefined, value: number): number {
  const factor = resolveQuotaConversionFactor(platform);
  // 读取端 legacy 无标记快照专用；写入端已是刚性美元契约，不再调用此函数。
  if (!looksLikeQuotaUnits(value)) return value;
  return Number.isFinite(factor) && factor > 0 ? Math.round((value / factor) * 1_000_000) / 1_000_000 : value;
}

function looksLikeQuotaUnits(value: number): boolean {
  // 旧快照无 incomeUnitSource 时，按量级 heuristic 回退：
  // 美元量级通常 < 1e4，quota 量级通常 >= 1e5。
  return value >= 100_000;
}

function normalizeSnapshot(raw: unknown, platform?: string | null): TodayIncomeSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const day = typeof record.day === 'string' ? record.day.trim() : '';
  if (!day) return null;

  const latest = toNonNegativeNumber(record.latest);
  if (latest == null) return null;

  const baseline = toNonNegativeNumber(record.baseline);
  const incomeUnitSource = typeof record.incomeUnitSource === 'string'
    ? record.incomeUnitSource
    : undefined;
  const incomePlatform = typeof record.incomePlatform === 'string'
    ? record.incomePlatform
    : platform;

  // 旧快照无 incomeUnitSource，按量级 heuristic 判断是否需归一
  let normalizedLatest = latest;
  let normalizedBaseline = baseline ?? latest;
  if (incomeUnitSource === 'quota' || (!incomeUnitSource && looksLikeQuotaUnits(latest))) {
    normalizedLatest = normalizeTodayIncome(incomePlatform, latest);
    normalizedBaseline = normalizeTodayIncome(incomePlatform, baseline ?? latest);
  } else if (incomeUnitSource === 'normalized') {
    // 新格式：写入端已归一，读取端绝不重算。
    normalizedLatest = latest;
    normalizedBaseline = baseline ?? latest;
  } else if (incomeUnitSource === 'dollar') {
    // 旧格式：写入端认为已是美元，读取端信任该标记。
    normalizedLatest = latest;
    normalizedBaseline = baseline ?? latest;
  }

  return {
    day,
    baseline: normalizedBaseline,
    latest: normalizedLatest,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt.trim() : undefined,
    incomeUnitSource: (incomeUnitSource ?? (looksLikeQuotaUnits(latest) ? 'quota' : 'dollar')) as TodayIncomeSnapshot['incomeUnitSource'],
    incomePlatform: incomePlatform ?? undefined,
  };
}

function extractTodayIncomeSnapshot(extraConfig?: string | Record<string, unknown> | null, platform?: string | null): TodayIncomeSnapshot | null {
  const parsed = parseObject(extraConfig);
  return normalizeSnapshot(parsed.todayIncomeSnapshot, platform);
}

export function getTodayIncomeDelta(
  extraConfig: string | Record<string, unknown> | null | undefined,
  day: string,
  platform?: string | null,
): number {
  if (!day) return 0;
  const snapshot = extractTodayIncomeSnapshot(extraConfig, platform);
  if (!snapshot || snapshot.day !== day) return 0;

  const baseline = typeof snapshot.baseline === 'number' ? snapshot.baseline : snapshot.latest;
  const delta = snapshot.latest - baseline;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return delta;
}

export function getTodayIncomeValue(
  extraConfig: string | Record<string, unknown> | null | undefined,
  day: string,
  platform?: string | null,
): number {
  if (!day) return 0;
  const snapshot = extractTodayIncomeSnapshot(extraConfig, platform);
  if (!snapshot || snapshot.day !== day) return 0;
  return snapshot.latest;
}

export function updateTodayIncomeSnapshot(
  extraConfig: string | Record<string, unknown> | null | undefined,
  todayIncome: number,
  now = new Date(),
  platform?: string | null,
): string | null {
  const income = toNonNegativeNumber(todayIncome);
  if (income == null) {
    if (typeof extraConfig === 'string') return extraConfig || null;
    if (extraConfig == null) return null;
    return JSON.stringify(parseObject(extraConfig));
  }

  // 写入端刚性契约：adapter 已归一为美元，直接入库并标记 normalized。
  // 不在此处做启发式换算，避免 300 raw quota 被误当 300 美元。
  const incomeUnitSource: TodayIncomeSnapshot['incomeUnitSource'] = 'normalized';

  const day = formatLocalDate(now);
  const existing = extractTodayIncomeSnapshot(extraConfig, platform);
  let baseline = income;
  let latest = income;

  if (existing && existing.day === day) {
    baseline = typeof existing.baseline === 'number' ? existing.baseline : existing.latest;
    if (income < baseline) baseline = income;
    latest = income;
  }

  return mergeAccountExtraConfig(extraConfig, {
    todayIncomeSnapshot: {
      day,
      baseline,
      latest,
      updatedAt: now.toISOString(),
      incomeUnitSource,
      incomePlatform: platform || undefined,
    },
  });
}

export function estimateRewardWithTodayIncomeFallback(input: EstimateRewardInput): number {
  const rewardSum = Number.isFinite(input.rewardSum) && input.rewardSum > 0 ? input.rewardSum : 0;
  if (!Number.isFinite(input.successCount) || input.successCount <= 0) return rewardSum;

  // 成功解析的签到奖励为主；income 快照仅在完全无解析时兜底。
  const hasParsedReward = input.parsedRewardCount > 0;
  if (hasParsedReward) return rewardSum;

  const incomeValue = getTodayIncomeValue(input.extraConfig, input.day, input.platform);
  return incomeValue;
}
