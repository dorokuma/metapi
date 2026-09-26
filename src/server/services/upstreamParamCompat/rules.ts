/**
 * 「严格校验上游参数兼容层」规则：归一（宽松）、严格校验（PUT）与热路径解析。
 *
 * 规则双形态约定（全链路遵守）：
 * - 存储形态：settings 表 `upstream_param_compat_rules` 键下永远是原始 JSON 数组，
 *   元素形状 = `{ siteId, model, params }`（可选 `endpoints`），不含 matcher/正则等编译产物；
 *   PUT/GET 也按该形状收发。
 * - 内存形态：`config.upstreamParamCompatRules` 持有编译产物（每条规则带预编译 matcher），
 *   供热路径 `resolveUpstreamParamCompatParams` 直接使用；hydration / env 解析各编译一次，
 *   运行期不构造正则。
 *
 * 匹配语义：`siteId` 相等，且「下游请求模型」或「实际上游 modelName」命中（`model` 支持
 * 精确字符串或 `*` 通配，全串锚定、**大小写敏感**），且端点在规则端点列表内；多条命中取
 * params 并集。`endpoints` 省略时等价于 `['chat','responses']`，messages 必须显式写入才生效。
 *
 * 归一语义只此一种：**非法项 = 整条规则不剥离**（宽松路径整条丢弃；PUT 整条 400）。
 * `params` 只允许标识符，且拒绝结构键与原型污染键 —— 与自愈共用同一份拒绝表，安全优先。
 */

export type UpstreamParamCompatEndpoint = 'chat' | 'responses' | 'messages';

/** 存储/回显形态：settings 表、PUT 请求与 GET 响应共用的原始形状。 */
export type UpstreamParamCompatStoredRule = {
  siteId: number;
  model: string;
  params: string[];
  /** 省略 = `['chat','responses']`；messages 必须显式写入才生效。 */
  endpoints?: UpstreamParamCompatEndpoint[];
};

/** 内存/config 形态：原始形状 + 归一化期预编译的 matcher（禁止热路径 new RegExp）。 */
export type UpstreamParamCompatRule = UpstreamParamCompatStoredRule & {
  match: (model: string) => boolean;
};

export type UpstreamParamCompatParseResult =
  | { ok: true; rules: UpstreamParamCompatStoredRule[] }
  | { ok: false; message: string };

export const UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE = 32;
export const UPSTREAM_PARAM_COMPAT_MAX_RULES = 64;
export const UPSTREAM_PARAM_COMPAT_MAX_SELF_HEAL_PARAMS = 8;

export const UPSTREAM_PARAM_COMPAT_DEFAULT_ENDPOINTS: readonly UpstreamParamCompatEndpoint[] = [
  'chat',
  'responses',
];

export const UPSTREAM_PARAM_COMPAT_ALLOWED_ENDPOINTS: readonly UpstreamParamCompatEndpoint[] = [
  'chat',
  'responses',
  'messages',
];

/**
 * 结构键拒绝表：(a) 站点规则与 (b) 自愈共用同一份（有意收口，不是漏做）。
 * 请求路径上的自愈与站点规则都不能删生成所依赖的结构键。
 * 操作员若要剥离 `temperature` / `system` 一类键，请改用既有 payload 规则（filter）。
 */
export const UPSTREAM_PARAM_COMPAT_STRUCTURAL_KEYS: readonly string[] = [
  'model',
  'messages',
  'input',
  'stream',
  'tools',
  'tool_choice',
  'max_tokens',
  'temperature',
  'top_p',
  'n',
  'stop',
  'response_format',
  'instructions',
  'previous_response_id',
  'provider',
  'providerOptions',
  'system',
];

const STRUCTURAL_KEY_SET = new Set<string>(UPSTREAM_PARAM_COMPAT_STRUCTURAL_KEYS);
const RESERVED_PARAM_NAMES = new Set<string>(['__proto__', 'constructor', 'prototype']);
const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,64}$/;
const ALLOWED_ENDPOINT_SET = new Set<string>(UPSTREAM_PARAM_COMPAT_ALLOWED_ENDPOINTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 与 `normalizeUpstreamProviderPinRules` 同款归一：正整数（数字/数字字符串），非法返回 null。 */
export function normalizeUpstreamParamCompatSiteId(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const truncated = Math.trunc(value);
    return truncated > 0 ? truncated : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    const truncated = Math.trunc(numeric);
    return truncated > 0 ? truncated : null;
  }
  return null;
}

export function isUpstreamParamCompatIdentifier(name: string): boolean {
  return PARAM_NAME_PATTERN.test(name);
}

/** 结构键（含原型污染键）判定：PUT 校验、宽松归一、热路径逐名再验共用。 */
export function isUpstreamParamCompatForbiddenParam(name: string): boolean {
  return STRUCTURAL_KEY_SET.has(name) || RESERVED_PARAM_NAMES.has(name);
}

/**
 * 热路径最后一道边界：标识符 + 拒绝表都通过才允许从出站体顶层删除。
 * 即使内存里的编译结果被绕过，也不能删结构键。
 */
export function isSafeStrippableUpstreamParam(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (!PARAM_NAME_PATTERN.test(name)) return false;
  if (STRUCTURAL_KEY_SET.has(name)) return false;
  if (RESERVED_PARAM_NAMES.has(name)) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化期预编译 matcher：无 `*` 走字符串精确比较（大小写敏感），有 `*` 编译一次全串锚定正则。 */
function compileModelMatcher(pattern: string): (model: string) => boolean {
  if (!pattern.includes('*')) {
    return (model: string) => model === pattern;
  }
  const compiled = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return (model: string) => compiled.test(model);
}

function coerceRuleArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeEndpointList(value: unknown): {
  ok: boolean;
  endpoints?: UpstreamParamCompatEndpoint[];
} {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false };
  const endpoints: UpstreamParamCompatEndpoint[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !ALLOWED_ENDPOINT_SET.has(item)) return { ok: false };
    const endpoint = item as UpstreamParamCompatEndpoint;
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  if (endpoints.length === 0) return { ok: false };
  return { ok: true, endpoints };
}

/**
 * 宽松归一（hydration / env 解析 / 导入）：接受原始形状（string 时先 JSON.parse）。
 * 一条规则里只要有一个非法 param（非标识符 / 命中拒绝表），或该条超过 32 个，**整条丢弃**；
 * 数组超过 64 条时丢弃第 65 条及之后。输出携带预编译 matcher 的编译形态。
 */
export function normalizeUpstreamParamCompatRules(value: unknown): UpstreamParamCompatRule[] {
  const rawItems = coerceRuleArray(value);
  const rules: UpstreamParamCompatRule[] = [];
  const limit = Math.min(rawItems.length, UPSTREAM_PARAM_COMPAT_MAX_RULES);

  for (let index = 0; index < limit; index += 1) {
    const item = rawItems[index];
    if (!isRecord(item)) continue;
    const siteId = normalizeUpstreamParamCompatSiteId(item.siteId);
    if (siteId === null) continue;
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    if (!model) continue;

    const rawParams = item.params;
    if (
      !Array.isArray(rawParams)
      || rawParams.length === 0
      || rawParams.length > UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE
    ) {
      continue;
    }

    const endpointsResult = normalizeEndpointList(item.endpoints);
    if (!endpointsResult.ok) continue;

    const params: string[] = [];
    let allParamsValid = true;
    for (const rawParam of rawParams) {
      if (typeof rawParam !== 'string') {
        allParamsValid = false;
        break;
      }
      const name = rawParam.trim();
      if (!isSafeStrippableUpstreamParam(name)) {
        allParamsValid = false;
        break;
      }
      if (!params.includes(name)) params.push(name);
    }
    if (!allParamsValid || params.length === 0) continue;

    const rule: UpstreamParamCompatRule = {
      siteId,
      model,
      params,
      match: compileModelMatcher(model),
    };
    if (endpointsResult.endpoints) rule.endpoints = endpointsResult.endpoints;
    rules.push(rule);
  }

  return rules;
}

/**
 * 严格校验（PUT）：string 输入先 JSON.parse（失败归为校验失败），再逐项严格校验。
 * 失败一律返回具体中文 message；成功输出原始形状（不含编译产物）。
 * 三键原子、不半应用：调用方在任何落库/写 config 之前先跑本函数。
 */
export function parseUpstreamParamCompatRules(value: unknown): UpstreamParamCompatParseResult {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      raw = [];
    } else {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return { ok: false, message: '上游参数兼容规则不是合法的 JSON' };
      }
    }
  }

  if (!Array.isArray(raw)) {
    return { ok: false, message: '上游参数兼容规则必须是数组' };
  }
  if (raw.length > UPSTREAM_PARAM_COMPAT_MAX_RULES) {
    return { ok: false, message: `上游参数兼容规则超过 ${UPSTREAM_PARAM_COMPAT_MAX_RULES} 条` };
  }

  const rules: UpstreamParamCompatStoredRule[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item: unknown = raw[index];
    const position = `第 ${index + 1} 条规则`;
    if (!isRecord(item)) {
      return { ok: false, message: `${position}必须是对象` };
    }

    const siteId = normalizeUpstreamParamCompatSiteId(item.siteId);
    if (siteId === null) {
      return { ok: false, message: `${position}的 siteId 必须是正整数` };
    }

    if (typeof item.model !== 'string') {
      return { ok: false, message: `${position}的 model 必须是字符串` };
    }
    const model = item.model.trim();
    if (!model) {
      return { ok: false, message: `${position}的 model 不能为空` };
    }

    if (!Array.isArray(item.params)) {
      return { ok: false, message: `${position}的 params 必须是字符串数组` };
    }
    if (item.params.length === 0) {
      return { ok: false, message: `${position}的 params 不能为空` };
    }
    if (item.params.length > UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE) {
      return {
        ok: false,
        message: `${position}的 params 超过 ${UPSTREAM_PARAM_COMPAT_MAX_PARAMS_PER_RULE} 个`,
      };
    }

    const params: string[] = [];
    for (const rawParam of item.params) {
      if (typeof rawParam !== 'string') {
        return { ok: false, message: `${position}的 params 只能包含字符串` };
      }
      const name = rawParam.trim();
      if (!isUpstreamParamCompatIdentifier(name)) {
        return { ok: false, message: `${position}的 params 含非法参数名：${name || '(空)'}` };
      }
      if (isUpstreamParamCompatForbiddenParam(name)) {
        return { ok: false, message: `${position}的 params 含禁止剥离的结构键：${name}` };
      }
      if (!params.includes(name)) params.push(name);
    }

    const endpointsResult = normalizeEndpointList(item.endpoints);
    if (!endpointsResult.ok) {
      return {
        ok: false,
        message: `${position}的 endpoints 只能是 chat / responses / messages 的非空子集`,
      };
    }

    const rule: UpstreamParamCompatStoredRule = { siteId, model, params };
    if (endpointsResult.endpoints) rule.endpoints = endpointsResult.endpoints;
    rules.push(rule);
  }

  return { ok: true, rules };
}

/** 把内存/config 形态（或任意超集形状）还原为存储/回显的原始形状（去掉 matcher）。 */
export function toUpstreamParamCompatStoredRules(
  rules: readonly UpstreamParamCompatStoredRule[],
): UpstreamParamCompatStoredRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule) => {
    const stored: UpstreamParamCompatStoredRule = {
      siteId: rule.siteId,
      model: rule.model,
      params: [...rule.params],
    };
    if (Array.isArray(rule.endpoints)) stored.endpoints = [...rule.endpoints];
    return stored;
  });
}

/**
 * 热路径命中解析：返回全部命中规则的 params 并集（大小写敏感、按规则顺序去重）。
 * 未命中返回空数组。总开关门禁在 `stripUnsupportedUpstreamParams`（(a) 只看总开关）。
 */
export function resolveUpstreamParamCompatParams(input: {
  rules: readonly UpstreamParamCompatRule[];
  siteId: number | null | undefined;
  requestedModel: string;
  actualModel?: string;
  endpoint: UpstreamParamCompatEndpoint;
}): string[] {
  const rules = input.rules;
  if (!Array.isArray(rules) || rules.length === 0) return [];

  const siteId = normalizeUpstreamParamCompatSiteId(input.siteId);
  if (siteId === null) return [];

  const modelCandidates = [
    typeof input.requestedModel === 'string' ? input.requestedModel.trim() : '',
    typeof input.actualModel === 'string' ? input.actualModel.trim() : '',
  ].filter((value) => value.length > 0);
  if (modelCandidates.length === 0) return [];

  const union: string[] = [];
  for (const rule of rules) {
    if (!rule || rule.siteId !== siteId) continue;
    const endpoints = rule.endpoints ?? UPSTREAM_PARAM_COMPAT_DEFAULT_ENDPOINTS;
    if (!Array.isArray(endpoints) || !endpoints.includes(input.endpoint)) continue;
    if (typeof rule.match !== 'function') continue;
    if (!modelCandidates.some((model) => rule.match(model))) continue;
    for (const name of rule.params) {
      if (!union.includes(name)) union.push(name);
    }
  }

  return union;
}