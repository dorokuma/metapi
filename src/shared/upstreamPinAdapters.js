/**
 * 「上游钉选适配器」目录：服务端 adapters/registry 与 Web 设置页共读的元数据单一来源。
 *
 * 只登记**已实现**的适配器（Phase 1 = 下列四家）：id / label / mechanism / capabilities / notes。
 * - 服务端：registry 以本目录为 id、label、能力元数据来源并挂接 applyBody / applyHeaders 实现；
 *   运行期「合法适配器 id 集合」以 registry 键集为准（PUT 校验与热路径 resolve 共用）。
 * - Web 端（Settings.tsx）：适配器下拉与行内能力提示同读本目录，禁止 import server。
 * - capabilities 表达「该网关能否严格表达该模式」：注入前做能力协商，不足即跳过注入
 *   （不降级、不静默反转语义）；UI 行内警告按同一能力表判定。
 *
 * 形态对齐 siteInitializationPresets 先例：纯 js + 同名 .d.ts，导出冻结数据副本。
 */

const UPSTREAM_PIN_ADAPTER_CATALOG = Object.freeze([
  Object.freeze({
    id: 'generic-dual',
    label: '通用双姿势（默认）',
    mechanism: 'body',
    capabilities: Object.freeze({ only: true, order: true }),
    notes: '同时写入嵌套 providerOptions.gateway 与顶层 provider 两种姿势；未识别网关的最大兼容姿势，也是未配置站点时的默认行为。',
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    mechanism: 'body',
    capabilities: Object.freeze({ only: true, order: true }),
    notes: '原生契约：only = provider.only 白名单（与账号级允许列表取交集，交集为空返回 404）；order = provider.order 顺序优先，allow_fallbacks 默认 true（本适配器不改写该键）；provider 名为 slug（支持 Base Slug Matching），非法名上游 400；provider.ignore 命中的提供方会被剔除；providerOptions.gateway 被其忽略，本适配器不写。',
  }),
  Object.freeze({
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    mechanism: 'body',
    capabilities: Object.freeze({ only: true, order: true }),
    notes: '契约位 = 嵌套 providerOptions.gateway.{only|order}：only 命中不回退、order 优先尝试；本适配器不写顶层 provider（契约外字段，避免未知字段透传）。',
  }),
  Object.freeze({
    id: 'none',
    label: '不注入（无钉选机制）',
    mechanism: 'none',
    capabilities: Object.freeze({ only: false, order: false }),
    notes: '该网关无请求体钉选机制（路由在 URL 前缀/控制台配置），规则不会注入；请勿为该类站点配置规则。',
  }),
]);

function cloneCatalogEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    capabilities: { ...entry.capabilities },
  };
}

/** 返回已实现适配器目录（副本，调用方不可改内部数据）。 */
export function listUpstreamPinAdapterCatalog() {
  return UPSTREAM_PIN_ADAPTER_CATALOG.map((entry) => cloneCatalogEntry(entry));
}

/** 按 id 取目录项；未注册/空 id 返回 null。 */
export function getUpstreamPinAdapterCatalogEntry(id) {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!normalizedId) return null;
  return cloneCatalogEntry(
    UPSTREAM_PIN_ADAPTER_CATALOG.find((entry) => entry.id === normalizedId) || null,
  );
}
