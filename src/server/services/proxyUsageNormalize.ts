import {
  createEmptyProxyUsage,
  hasProxyUsageObservation,
  PROXY_USAGE_FIELD_KEYS,
  type ParsedProxyUsage,
  type ProxyUsageFieldKey,
} from './proxyUsageParser.js';

/**
 * 用法解析链第 4 步（§1.3）唯一归一入口。
 *
 * 不变量：
 * - 减过 ⇒ `promptTokensIncludeCache === false`；
 * - 未减且确认 prompt 含缓存 ⇒ flag 保持上游 evidence（Anthropic 形状为 false）；
 * - 无证据 ⇒ flag = NULL、cache 列 = NULL、prompt 不减。
 *
 * 归一后的列里不会再出现 flag=true 的新行：true 只存在于历史未迁移行，读侧按「未归一」防御。
 */

export type ProxyUsageSource = 'upstream' | 'self-log' | 'unknown';

export interface SelfLogUsageInput {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  promptTokensIncludeCache?: boolean | null;
}

export interface ProxyUsageNormalizeInput {
  /**
   * 上游 parse 产物（未减值、带 presence）。也接受不带 presence 的 Partial 数值对象：
   * 缺 presence 时按「值 > 0 视为观测到」推断，保证旧调用面可用。
   */
  upstream?: Partial<Record<ProxyUsageFieldKey, number | null | undefined>> & {
    promptTokensIncludeCache?: boolean | null;
    presence?: Partial<Record<ProxyUsageFieldKey, boolean>>;
  } | null;
  /** self-log 命中且上游缺观测时的补缺值（D6：三字段都缺才用 self-log）。 */
  selfLog?: SelfLogUsageInput | null;
  /** images/search：全字段 presence=true + 显式真 0（非 NULL、非 unknown）。 */
  zeros?: boolean;
}

export interface ResolvedUsageColumns {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  reasoningTokens: number | null;
  promptTokensIncludeCache: boolean | null;
}

export interface ResolvedBillingUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokensIncludeCache: boolean | null;
}

export interface ResolveFinalUsageResult {
  /** 唯一写入物：写入点把这一组数写进 proxy_logs 五列 + 既有三列。 */
  columns: ResolvedUsageColumns;
  /** 计费输入：与列值同一组数（NULL 分量按 0 交给计费）。 */
  billing: ResolvedBillingUsage;
  /** usage_source 列值；images/search 的显式 zeros 不产生 unknown（写 NULL）。 */
  usageSource: ProxyUsageSource | null;
}

function toNonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

/**
 * 将调用方传入的 upstream（可能带 presence，也可能不带）规范化为带 presence 的
 * ParsedProxyUsage。presence 缺失时按「值 > 0 视为观测到」推断，保证旧调用面可用。
 */
function normalizeUpstreamUsage(
  upstream: ProxyUsageNormalizeInput['upstream'],
): ParsedProxyUsage {
  const normalized = createEmptyProxyUsage();
  if (!upstream) return normalized;
  const explicitPresence = upstream.presence && typeof upstream.presence === 'object'
    ? upstream.presence
    : null;

  for (const key of PROXY_USAGE_FIELD_KEYS) {
    const raw = upstream[key];
    if (raw === null || raw === undefined) continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    const value = Math.max(0, Math.round(n));
    const present = explicitPresence ? explicitPresence[key] === true : value > 0;
    if (!present) continue;
    normalized[key] = value;
    normalized.presence[key] = true;
  }

  normalized.promptTokensIncludeCache = upstream.promptTokensIncludeCache ?? null;
  return normalized;
}

/**
 * 上游观测存在性判据（与 resolveFinalUsage 四分支裁决同一口径）：
 * 显式 presence 优先；缺 presence 时按「值 > 0 视为观测到」推断（旧调用面兼容）。
 * 写入点用它决定是否进 self-log 回查：显式全 0（presence=true）视为上游在场，
 * 不得按「上游缺失」处理。
 */
export function hasUpstreamUsageObservation(upstream: ProxyUsageNormalizeInput['upstream']): boolean {
  return hasProxyUsageObservation(normalizeUpstreamUsage(upstream));
}

/**
 * 将 selfLog 输入规范化为带 presence 的 ParsedProxyUsage。
 * 有值的字段全部标记为 presence=true。
 */
function toSelfLogUsage(selfLog: SelfLogUsageInput): ParsedProxyUsage {
  const usage = createEmptyProxyUsage();
  usage.promptTokens = toNonNegativeInt(selfLog.promptTokens);
  usage.presence.promptTokens = true;
  usage.completionTokens = toNonNegativeInt(selfLog.completionTokens);
  usage.presence.completionTokens = true;
  usage.totalTokens = toNonNegativeInt(selfLog.totalTokens);
  usage.presence.totalTokens = true;
  if (selfLog.cacheReadTokens !== null && selfLog.cacheReadTokens !== undefined) {
    usage.cacheReadTokens = toNonNegativeInt(selfLog.cacheReadTokens);
    usage.presence.cacheReadTokens = true;
  }
  if (selfLog.cacheCreationTokens !== null && selfLog.cacheCreationTokens !== undefined) {
    usage.cacheCreationTokens = toNonNegativeInt(selfLog.cacheCreationTokens);
    usage.presence.cacheCreationTokens = true;
  }
  usage.promptTokensIncludeCache = selfLog.promptTokensIncludeCache ?? null;
  return usage;
}

function buildResult(
  columns: ResolvedUsageColumns,
  usageSource: ProxyUsageSource | null,
): ResolveFinalUsageResult {
  return {
    columns,
    billing: {
      promptTokens: columns.promptTokens ?? 0,
      completionTokens: columns.completionTokens ?? 0,
      totalTokens: columns.totalTokens ?? 0,
      cacheReadTokens: columns.cacheReadTokens ?? 0,
      cacheCreationTokens: columns.cacheCreationTokens ?? 0,
      promptTokensIncludeCache: columns.promptTokensIncludeCache,
    },
    usageSource,
  };
}

function emptyColumns(): ResolvedUsageColumns {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    reasoningTokens: null,
    promptTokensIncludeCache: null,
  };
}

function zerosColumns(): ResolvedUsageColumns {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    promptTokensIncludeCache: null,
  };
}

/**
 * 归一单条带 presence 的 usage。
 *
 * 规则：
 * 1. flag===true：prompt = max(0, rawPrompt - cacheRead - cacheCreation)，写出 flag=false；
 * 2. flag===false：prompt 不动；
 * 3. flag===null：cache 列写 NULL（不是 0），prompt 不减；
 * 4. 单字段无 presence → 该列 NULL；
 * 5. 上游给了 total（presence=true）：保留上游值，钳制到 total >= uncached+cache+completion；
 *    上游没给 total：按各分量合成一次。
 */
function normalizeUsageFields(
  source: ParsedProxyUsage,
  usageSource: ProxyUsageSource,
): ResolveFinalUsageResult {
  const promptPresent = source.presence.promptTokens;
  const completionPresent = source.presence.completionTokens;
  const cacheReadPresent = source.presence.cacheReadTokens;
  const cacheCreationPresent = source.presence.cacheCreationTokens;
  const reasoningPresent = source.presence.reasoningTokens;
  const totalPresent = source.presence.totalTokens;

  const rawPrompt = promptPresent ? source.promptTokens : null;
  const completion = completionPresent ? source.completionTokens : null;
  const reasoning = reasoningPresent ? source.reasoningTokens : null;

  // 归一后 flag 只可能是 false 或 null（true 仅历史未迁移行）。
  let flag = source.promptTokensIncludeCache;
  if (flag === true) flag = false;
  else if (flag === false) flag = false;
  else flag = null;

  // 1.3a：无形状证据（flag=null）时 cache 列写 NULL 而不是 0，prompt 不减。
  const cacheRead = flag === null ? null : (cacheReadPresent ? source.cacheReadTokens : null);
  const cacheCreation = flag === null ? null : (cacheCreationPresent ? source.cacheCreationTokens : null);

  // flag=true（上游 prompt 含缓存）时减一次；减完写 flag=false。下限 0。
  const prompt = rawPrompt !== null && source.promptTokensIncludeCache === true
    ? Math.max(0, rawPrompt - (cacheRead ?? 0) - (cacheCreation ?? 0))
    : rawPrompt;

  const totalParts = (
    (prompt ?? 0)
    + (cacheRead ?? 0)
    + (cacheCreation ?? 0)
    + (completion ?? 0)
  );

  let total: number | null = null;
  if (totalPresent) {
    // 上游给了 total：保留上游值，只做 total>=parts 钳制（presence=true 才抬高）。
    total = Math.max(source.totalTokens, totalParts);
  } else if (promptPresent || completionPresent || cacheReadPresent || cacheCreationPresent || reasoningPresent) {
    // 上游没给 total：按 uncached + cacheRead + cacheCreation + completion 合成一次；
    // reasoning 已含在 completion 内，不另加。
    total = totalParts;
  }

  return buildResult({
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: reasoning,
    promptTokensIncludeCache: flag,
  }, usageSource);
}

export function resolveFinalUsage(input: ProxyUsageNormalizeInput): ResolveFinalUsageResult {
  if (input.zeros === true) {
    // images/search：显式真 0，不是 NULL；usageSource 不因此变 unknown（写 NULL）。
    return buildResult(zerosColumns(), null);
  }

  const upstream = normalizeUpstreamUsage(input.upstream);
  if (hasProxyUsageObservation(upstream)) {
    return normalizeUsageFields(upstream, 'upstream');
  }

  if (input.selfLog) {
    // D6：upstream 完全缺观测时才用 self-log 的 token/cache/flag 做合成，随后同一次归一。
    return normalizeUsageFields(toSelfLogUsage(input.selfLog), 'self-log');
  }

  return buildResult(emptyColumns(), 'unknown');
}
