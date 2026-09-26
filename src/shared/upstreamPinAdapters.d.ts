/**
 * 「上游钉选适配器」共享目录类型声明（实现见同名 .js，形态对齐 siteInitializationPresets 先例）。
 *
 * Phase 1 已实现：generic-dual / openrouter / vercel-ai-gateway / none。
 * Phase 2 增加 portkey / helicone（header 族，核实后）时同步扩充联合类型与目录。
 */

export type UpstreamPinAdapterId =
  | 'generic-dual'
  | 'openrouter'
  | 'vercel-ai-gateway'
  | 'none';

export type UpstreamPinAdapterMechanism = 'body' | 'header' | 'none';

/** 该网关能否**严格**表达对应模式；不足时注入侧能力协商跳过（不降级），UI 侧行内警告。 */
export type UpstreamPinAdapterCapabilities = {
  only: boolean;
  order: boolean;
};

export type UpstreamPinAdapterCatalogEntry = {
  id: UpstreamPinAdapterId;
  label: string;
  mechanism: UpstreamPinAdapterMechanism;
  capabilities: UpstreamPinAdapterCapabilities;
  notes: string;
};

export declare function listUpstreamPinAdapterCatalog(): UpstreamPinAdapterCatalogEntry[];
export declare function getUpstreamPinAdapterCatalogEntry(
  id: string | null | undefined,
): UpstreamPinAdapterCatalogEntry | null;
