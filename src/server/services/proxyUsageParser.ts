export type ProxyUsageFieldKey =
  | 'promptTokens'
  | 'completionTokens'
  | 'totalTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'reasoningTokens';

export type ProxyUsagePresence = Record<ProxyUsageFieldKey, boolean>;

export interface ParsedProxyUsage {
  /**
   * 原始上游值，未做任何扣减（归一在 `resolveFinalUsage` 一次完成）。
   * 每个字段单独带 presence：键缺失 → presence=false、值 0；键在且值为 0 → presence=true、值 0。
   */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  /**
   * 1h-TTL cache-creation tokens, only when upstream reports them separately
   * (e.g. cache_creation.ephemeral_1h_input_tokens / claude_cache_creation_1_h_tokens).
   * 0/undefined when the 1h share cannot be distinguished from the 5m share — in which
   * case the expr cc1h variable stays 0 and the 1h cost folds into the standard cache-creation
   * figure (documented in the billing notes).
   */
  cacheCreationTokens1h?: number;
  promptTokensIncludeCache: boolean | null;
  presence: ProxyUsagePresence;
}

export const PROXY_USAGE_FIELD_KEYS: readonly ProxyUsageFieldKey[] = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
] as const;

/** @internal 供 normalize 模块导入，不构成外部调用面的 ABI 承诺。 */
export function createEmptyProxyUsage(): ParsedProxyUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    promptTokensIncludeCache: null,
    presence: {
      promptTokens: false,
      completionTokens: false,
      totalTokens: false,
      cacheReadTokens: false,
      cacheCreationTokens: false,
      reasoningTokens: false,
    },
  };
}

const USAGE_DIRECT_KEYS = [
  'prompt_tokens',
  'promptTokens',
  'prompt_token_count',
  'promptTokenCount',
  'input_tokens',
  'inputTokens',
  'input_token_count',
  'inputTokenCount',
  'completion_tokens',
  'completionTokens',
  'completion_token_count',
  'completionTokenCount',
  'candidates_token_count',
  'candidatesTokenCount',
  'output_tokens',
  'outputTokens',
  'output_token_count',
  'outputTokenCount',
  'total_tokens',
  'totalTokens',
  'total_token_count',
  'totalTokenCount',
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'prompt_cache_hit_tokens',
  'promptCacheHitTokens',
  'cached_tokens',
  'cachedTokens',
  'cache_read_tokens',
  'cacheReadTokens',
  'cache_creation_input_tokens',
  'cacheCreationInputTokens',
  'cache_creation_tokens',
  'cacheCreationTokens',
  'claude_cache_creation_5_m_tokens',
  'claudeCacheCreation5mTokens',
  'claude_cache_creation_1_h_tokens',
  'claudeCacheCreation1hTokens',
] as const;

const USAGE_DETAIL_KEYS = [
  'prompt_tokens_details',
  'promptTokensDetails',
  'input_tokens_details',
  'inputTokensDetails',
  'completion_tokens_details',
  'completionTokensDetails',
  'output_tokens_details',
  'outputTokensDetails',
  'cache_creation',
  'cacheCreation',
] as const;

function toNonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExplicitUsageValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 && Number.isFinite(Number(trimmed));
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasExplicitUsageValue(entry));
  }
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) => hasExplicitUsageValue(entry));
}

function sumNumericFields(record: Record<string, unknown> | undefined): number {
  if (!record || typeof record !== 'object') return 0;
  return Object.values(record).reduce<number>((sum, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return sum + value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0 && Number.isFinite(Number(trimmed))) return sum + Number(trimmed);
    }
    return sum;
  }, 0);
}

function collectUsageCandidates(payload: unknown): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  const visited = new Set<object>();
  const queue: unknown[] = [];

  const enqueue = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    queue.push(value);
  };

  enqueue(payload);
  enqueue((payload as any)?.usage);
  enqueue((payload as any)?.usageMetadata);
  enqueue((payload as any)?.usage_metadata);
  enqueue((payload as any)?.token_usage);
  enqueue((payload as any)?.tokenUsage);

  // Guard against unexpectedly deep/large payloads.
  let inspected = 0;
  const MAX_INSPECT = 200;

  while (queue.length > 0 && inspected < MAX_INSPECT) {
    const current = queue.shift();
    inspected += 1;

    if (Array.isArray(current)) {
      for (const item of current) enqueue(item);
      continue;
    }

    if (!isRecord(current)) continue;
    if (visited.has(current)) continue;
    visited.add(current);
    candidates.push(current);

    for (const value of Object.values(current)) {
      enqueue(value);
    }
  }

  return candidates;
}

/**
 * 按 hasOwn 逐键读取：任一别名键存在且值可解析为有限数 → present。
 * 多个别名同时存在时取最大值（与旧 firstPositiveInt 的「第一个正值」语义近似，且不丢显式 0）。
 */
interface UsageFieldValue {
  present: boolean;
  value: number;
}

function emptyField(): UsageFieldValue {
  return { present: false, value: 0 };
}

function readUsageField(record: Record<string, unknown>, keys: readonly string[]): UsageFieldValue {
  let present = false;
  let value = 0;
  for (const key of keys) {
    if (!hasOwn(record, key)) continue;
    const raw = record[key];
    if (raw === null || raw === undefined) continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    present = true;
    value = Math.max(value, Math.max(0, Math.round(n)));
  }
  return present ? { present: true, value } : emptyField();
}

function readNestedUsageField(
  record: Record<string, unknown>,
  parentKeys: readonly string[],
  childKeys: readonly string[],
): UsageFieldValue {
  let present = false;
  let value = 0;
  for (const parentKey of parentKeys) {
    const parent = record[parentKey];
    if (!isRecord(parent)) continue;
    for (const childKey of childKeys) {
      if (!hasOwn(parent, childKey)) continue;
      const raw = parent[childKey];
      if (raw === null || raw === undefined) continue;
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) continue;
      present = true;
      value = Math.max(value, Math.max(0, Math.round(n)));
    }
  }
  return present ? { present: true, value } : emptyField();
}

function sumAllNestedNumericFields(
  record: Record<string, unknown>,
  parentKeys: readonly string[],
): UsageFieldValue {
  let present = false;
  let value = 0;
  for (const parentKey of parentKeys) {
    const parent = record[parentKey];
    if (!isRecord(parent)) continue;
    const sum = sumNumericFields(parent);
    // Mark present if the detail object exists and has ANY keys (even if sum is 0).
    if (Object.keys(parent).length > 0) {
      present = true;
      value = Math.max(value, sum);
    }
  }
  return present ? { present: true, value } : emptyField();
}

/** Sum selected numeric child fields inside each named detail object (max across parents). */
function sumSelectedNestedNumericFields(
  record: Record<string, unknown>,
  parentKeys: readonly string[],
  childKeys: readonly string[],
): UsageFieldValue {
  let present = false;
  let value = 0;
  for (const parentKey of parentKeys) {
    const parent = record[parentKey];
    if (!isRecord(parent)) continue;
    let sum = 0;
    let anyChildKeyExists = false;
    for (const childKey of childKeys) {
      if (hasOwn(parent, childKey)) {
        anyChildKeyExists = true;
        const raw = parent[childKey];
        if (raw === null || raw === undefined) continue;
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) continue;
        sum += Math.max(0, Math.round(n));
      }
    }
    if (anyChildKeyExists) {
      present = true;
      value = Math.max(value, sum);
    }
  }
  return present ? { present: true, value } : emptyField();
}

function maxField(left: UsageFieldValue, right: UsageFieldValue): UsageFieldValue {
  if (!left.present && !right.present) return emptyField();
  return { present: true, value: Math.max(left.value, right.value) };
}

function sumFieldPair(left: UsageFieldValue, right: UsageFieldValue): UsageFieldValue {
  if (!left.present && !right.present) return emptyField();
  return { present: true, value: left.value + right.value };
}

function detectPromptTokensIncludeCache(record: Record<string, unknown>): boolean | null {
  const hasAnthropicCacheFields = [
    'cache_read_input_tokens',
    'cacheReadInputTokens',
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cache_creation',
    'cacheCreation',
    'claude_cache_creation_5_m_tokens',
    'claudeCacheCreation5mTokens',
    'claude_cache_creation_1_h_tokens',
    'claudeCacheCreation1hTokens',
  ].some((key) => key in record);
  if (hasAnthropicCacheFields) return false;

  const hasDetailCacheFields = [
    'prompt_tokens_details',
    'promptTokensDetails',
    'input_tokens_details',
    'inputTokensDetails',
    'prompt_cache_hit_tokens',
    'promptCacheHitTokens',
    'cached_tokens',
    'cachedTokens',
    // Gemini：promptTokenCount 含 cachedContentTokenCount。
    'cachedContentTokenCount',
    'cachedContentTokens',
    // 通用 OpenAI 风格的 cache 键：与 cached_tokens 同族，视为 prompt 含缓存；
    // 若这些键出现而 flag 留 null，归一会把已观测到的 cache 列写回 NULL，属于观测丢失。
    'cache_read_tokens',
    'cacheReadTokens',
    'cache_creation_tokens',
    'cacheCreationTokens',
  ].some((key) => key in record);
  if (hasDetailCacheFields) return true;

  return null;
}

function getCacheReadTokens(record: Record<string, unknown>): UsageFieldValue {
  return maxField(
    readUsageField(record, [
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'prompt_cache_hit_tokens',
      'promptCacheHitTokens',
      'cached_tokens',
      'cachedTokens',
      'cache_read_tokens',
      'cacheReadTokens',
      // Gemini API / Vertex usageMetadata：promptTokenCount 含 cachedContentTokenCount。
      'cachedContentTokenCount',
      'cachedContentTokens',
    ]),
    sumSelectedNestedNumericFields(record, [
      'prompt_tokens_details',
      'promptTokensDetails',
      'input_tokens_details',
      'inputTokensDetails',
    ], ['cached_tokens', 'cachedTokens', 'cache_read_input_tokens', 'cacheReadInputTokens']),
  );
}

function getCacheCreationTokens(record: Record<string, unknown>): UsageFieldValue {
  const direct = readUsageField(record, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cache_creation_tokens',
    'cacheCreationTokens',
  ]);
  const splitCandidates: UsageFieldValue[] = [
    sumFieldPair(
      readNestedUsageField(record, ['cache_creation'], ['ephemeral_5m_input_tokens', 'ephemeral5mInputTokens']),
      readNestedUsageField(record, ['cache_creation'], ['ephemeral_1h_input_tokens', 'ephemeral1hInputTokens']),
    ),
    sumFieldPair(
      readNestedUsageField(record, ['cacheCreation'], ['ephemeral5mInputTokens', 'ephemeral_5m_input_tokens']),
      readNestedUsageField(record, ['cacheCreation'], ['ephemeral1hInputTokens', 'ephemeral_1h_input_tokens']),
    ),
    sumFieldPair(
      readUsageField(record, ['claude_cache_creation_5_m_tokens', 'claudeCacheCreation5mTokens']),
      readUsageField(record, ['claude_cache_creation_1_h_tokens', 'claudeCacheCreation1hTokens']),
    ),
    sumSelectedNestedNumericFields(record, [
      'prompt_tokens_details',
      'promptTokensDetails',
      'input_tokens_details',
      'inputTokensDetails',
    ], ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_creation_tokens', 'cacheCreationTokens']),
  ];

  let result = direct;
  for (const candidate of splitCandidates) {
    result = maxField(result, candidate);
  }
  return result;
}

function getReasoningTokens(record: Record<string, unknown>): UsageFieldValue {
  return maxField(
    readUsageField(record, [
      'thoughtsTokenCount',
      'thoughts_token_count',
    ]),
    readNestedUsageField(record, [
      'completion_tokens_details',
      'completionTokensDetails',
      'output_tokens_details',
      'outputTokensDetails',
    ], [
      'reasoning_tokens',
      'reasoningTokens',
    ]),
  );
}

/**
 * 1h-TTL cache-creation tokens, only when upstream reports them as a distinct field.
 * Returns 0 when the 1h share is not separately reported (cannot be distinguished from
 * the 5m share), in which case cc1h stays 0 and the 1h cost folds into the standard
 * cache-creation figure.
 */
function getCacheCreationTokens1h(record: Record<string, unknown>): number {
  return Math.max(
    readNestedUsageField(record, ['cache_creation'], ['ephemeral_1h_input_tokens', 'ephemeral1hInputTokens']).value,
    readNestedUsageField(record, ['cacheCreation'], ['ephemeral1hInputTokens', 'ephemeral_1h_input_tokens']).value,
    readUsageField(record, ['claude_cache_creation_1_h_tokens', 'claudeCacheCreation1hTokens']).value,
  );
}

/**
 * 解析单条 usage 形状记录。presence 化后：
 * - 不再用 details 求和合成缺失的 prompt / completion；
 * - 不做 total 合成、不用 total 反推 prompt / completion、不做 `Math.max(total, p+c)` 抬高；
 * - Gemini：completion = candidatesTokenCount + thoughtsTokenCount（有 thoughts 才相加）、
 *   reasoning = thoughtsTokenCount、cache read 含 cachedContentTokenCount。
 */
function parseUsageRecord(record: Record<string, unknown>): ParsedProxyUsage {
  const usage = createEmptyProxyUsage();
  let promptTokens = readUsageField(record, [
    'prompt_tokens',
    'promptTokens',
    'prompt_token_count',
    'promptTokenCount',
    'input_tokens',
    'inputTokens',
    'input_token_count',
    'inputTokenCount',
  ]);
  const directCompletionTokens = readUsageField(record, [
    'completion_tokens',
    'completionTokens',
    'completion_token_count',
    'completionTokenCount',
    'candidates_token_count',
    'candidatesTokenCount',
    'output_tokens',
    'outputTokens',
    'output_token_count',
    'outputTokenCount',
  ]);
  const totalTokens = readUsageField(record, [
    'total_tokens',
    'totalTokens',
    'total_token_count',
    'totalTokenCount',
  ]);
  const candidatesTokens = readUsageField(record, ['candidates_token_count', 'candidatesTokenCount']);
  const thoughtsTokens = readUsageField(record, ['thoughtsTokenCount', 'thoughts_token_count']);
  const cacheReadTokens = getCacheReadTokens(record);
  const cacheCreationTokens = getCacheCreationTokens(record);
  const reasoningTokens = getReasoningTokens(record);
  const cacheCreationTokens1h = getCacheCreationTokens1h(record);
  const promptTokensIncludeCache = detectPromptTokensIncludeCache(record);

  let completionTokens = directCompletionTokens;
  if (thoughtsTokens.present) {
    if (candidatesTokens.present) {
      completionTokens = {
        present: true,
        value: candidatesTokens.value + thoughtsTokens.value,
      };
    } else if (!completionTokens.present) {
      completionTokens = { present: true, value: thoughtsTokens.value };
    }
  }

  // Gemini 的 thoughts 即 reasoning；本字段族通常不出现嵌套 reasoning 形状。
  const resolvedReasoningTokens = thoughtsTokens.present ? thoughtsTokens : reasoningTokens;

  usage.promptTokens = promptTokens.value;
  usage.presence.promptTokens = promptTokens.present;
  usage.completionTokens = completionTokens.value;
  usage.presence.completionTokens = completionTokens.present;
  usage.totalTokens = totalTokens.value;
  usage.presence.totalTokens = totalTokens.present;
  usage.cacheReadTokens = cacheReadTokens.value;
  usage.presence.cacheReadTokens = cacheReadTokens.present;
  usage.cacheCreationTokens = cacheCreationTokens.value;
  usage.presence.cacheCreationTokens = cacheCreationTokens.present;
  usage.reasoningTokens = resolvedReasoningTokens.value;
  usage.presence.reasoningTokens = resolvedReasoningTokens.present;
  if (cacheCreationTokens1h > 0) usage.cacheCreationTokens1h = cacheCreationTokens1h;
  usage.promptTokensIncludeCache = detectPromptTokensIncludeCache(record);

  return usage;
}

function scoreProxyUsage(usage: ParsedProxyUsage): number {
  let score = 0;
  if (usage.presence.totalTokens && usage.totalTokens > 0) {
    score += usage.totalTokens * 10_000;
  }
  score += (
    usage.promptTokens
    + usage.completionTokens
    + usage.cacheReadTokens
    + usage.cacheCreationTokens
    + usage.reasoningTokens
  );
  for (const key of PROXY_USAGE_FIELD_KEYS) {
    if (usage.presence[key]) score += 1;
  }
  if (usage.promptTokensIncludeCache !== null) score += 1;
  return score;
}

export function parseProxyUsage(payload: unknown): ParsedProxyUsage {
  if (!payload || typeof payload !== 'object') return createEmptyProxyUsage();
  const candidates = collectUsageCandidates(payload);

  let best = createEmptyProxyUsage();
  let bestScore = -1;

  for (const candidate of candidates) {
    const parsed = parseUsageRecord(candidate);
    const score = scoreProxyUsage(parsed);
    if (score > bestScore) {
      best = parsed;
      bestScore = score;
    }
  }

  return best;
}

export function hasProxyUsagePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const candidates = collectUsageCandidates(payload);
  return candidates.some((candidate) => (
    USAGE_DIRECT_KEYS.some((key) => hasOwn(candidate, key) && hasExplicitUsageValue(candidate[key]))
    || USAGE_DETAIL_KEYS.some((key) => hasOwn(candidate, key) && hasExplicitUsageValue(candidate[key]))
  ));
}

export function hasProxyUsageObservation(usage: ParsedProxyUsage): boolean {
  return PROXY_USAGE_FIELD_KEYS.some((key) => usage.presence[key]);
}

function sanitizeUsage(usage: ParsedProxyUsage): ParsedProxyUsage {
  const sanitized = createEmptyProxyUsage();
  for (const key of PROXY_USAGE_FIELD_KEYS) {
    const present = usage.presence?.[key] === true;
    sanitized[key] = present ? toNonNegativeInt(usage[key]) : 0;
    sanitized.presence[key] = present;
  }
  sanitized.promptTokensIncludeCache = usage.promptTokensIncludeCache ?? null;
  return sanitized;
}

/**
 * 逐帧合并（日志通道语义）：逐字段取 max + presence OR。
 *
 * 不变量：
 * - 输入永远是 parse 出来的原始未减值（归一在 `resolveFinalUsage` 一次完成），
 *   因此这里绝不会出现「已减帧与未减帧取 max」；
 * - 修复旧实现 `incomingScore > baseScore` 时整体替换 incoming、丢掉 base 已有 cache/flag 字段的问题；
 * - total presence = 任一侧 OR，不用 0/NULL 混判；本函数不做 total 合成。
 */
export function mergeProxyUsage(base: ParsedProxyUsage, incoming: ParsedProxyUsage): ParsedProxyUsage {
  const sanitizedBase = sanitizeUsage(base);
  const sanitizedIncoming = sanitizeUsage(incoming);
  const merged = createEmptyProxyUsage();

  for (const key of PROXY_USAGE_FIELD_KEYS) {
    const basePresent = sanitizedBase.presence[key];
    const incomingPresent = sanitizedIncoming.presence[key];
    merged[key] = Math.max(
      basePresent ? sanitizedBase[key] : 0,
      incomingPresent ? sanitizedIncoming[key] : 0,
    );
    merged.presence[key] = basePresent || incomingPresent;
  }

  merged.promptTokensIncludeCache = (
    sanitizedIncoming.promptTokensIncludeCache
    ?? sanitizedBase.promptTokensIncludeCache
  );
  const mergedCc1h = Math.max(
    base.cacheCreationTokens1h ?? 0,
    incoming.cacheCreationTokens1h ?? 0,
  );
  if (mergedCc1h > 0) merged.cacheCreationTokens1h = mergedCc1h;

  return merged;
}

export function pullSseDataEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const events: string[] = [];
  let rest = normalized;

  while (true) {
    const boundary = rest.indexOf('\n\n');
    if (boundary < 0) break;
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);

    if (!block.trim()) continue;

    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length <= 0) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    events.push(payload);
  }

  return { events, rest };
}
