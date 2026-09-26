import {
  getUpstreamPinAdapterCatalogEntry,
  type UpstreamPinAdapterCatalogEntry,
} from '../../../shared/upstreamPinAdapters.js';

/** 未配置映射站点的默认适配器 id（与服务端 registry 默认一致）。 */
export const DEFAULT_UPSTREAM_PIN_ADAPTER_ID = 'generic-dual';

export type UpstreamPinAdapterHint = {
  /** 行内展示的适配器 label（未知 id 时为「未知适配器「x」」）。 */
  label: string;
  /** 行内警告文案；null = 无警告。纯前端判定、不参与校验，服务端为最终裁决。 */
  warning: string | null;
};

export type UpstreamPinAdapterResolution = {
  adapter: UpstreamPinAdapterCatalogEntry | null;
  unknownAdapterId: string | null;
};

/**
 * 按站点映射解析规则行适配器（S2/O5，纯前端）：
 * 未配置映射 → 默认双姿势；命中已注册 id → 该目录项；未注册 id → unknownAdapterId（服务端热路径零注入）。
 */
export function resolveUpstreamPinAdapterForSite(input: {
  adapterMap: Record<string, string>;
  siteId: number;
}): UpstreamPinAdapterResolution {
  const rawId = input.siteId > 0 ? input.adapterMap[String(input.siteId)] : undefined;
  if (!rawId) {
    return {
      adapter: getUpstreamPinAdapterCatalogEntry(DEFAULT_UPSTREAM_PIN_ADAPTER_ID),
      unknownAdapterId: null,
    };
  }
  const adapter = getUpstreamPinAdapterCatalogEntry(rawId);
  return adapter ? { adapter, unknownAdapterId: null } : { adapter: null, unknownAdapterId: rawId };
}

/**
 * 规则行适配器提示文案（S2 按 mode 查能力 + O1 诚实 fail-open 文案 + O5 none 无机制提示）：
 * - 能力不足：「该规则将被跳过（该请求不会受本规则约束）」——跳过 = 该请求失去供应商约束，文案不得粉饰；
 * - none：「该网关无请求体钉选机制，规则不会注入」；
 * - 未注册 id：未知适配器提示（当前版本不会注入）。
 */
export function resolveUpstreamPinRuleAdapterHint(input: {
  adapter: UpstreamPinAdapterCatalogEntry | null;
  unknownAdapterId: string | null;
  mode: 'only' | 'order';
}): UpstreamPinAdapterHint {
  if (input.unknownAdapterId) {
    return {
      label: `未知适配器「${input.unknownAdapterId}」`,
      warning: '未知适配器不会被识别，该规则将被跳过（该请求不会受本规则约束）。',
    };
  }

  const adapter = input.adapter;
  if (!adapter) {
    return { label: '通用双姿势（默认）', warning: null };
  }

  if (adapter.id === 'none') {
    return {
      label: adapter.label,
      warning: '该网关无请求体钉选机制，规则不会注入。',
    };
  }

  const capabilityOk = input.mode === 'only'
    ? adapter.capabilities.only
    : adapter.capabilities.order;
  if (!capabilityOk) {
    return {
      label: adapter.label,
      warning: `该站点网关无法严格表达 ${input.mode}，该规则将被跳过（该请求不会受本规则约束）。`,
    };
  }

  return { label: adapter.label, warning: null };
}
