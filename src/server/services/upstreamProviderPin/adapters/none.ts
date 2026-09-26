/**
 * `none`：无请求体钉选机制者（Cloudflare AI Gateway、单一厂商直连等）的显式 no-op。
 *
 * 与热路径「未注册 id」的零注入兜底共用同一实现：无 applyBody / applyHeaders，
 * pin 命中也零注入（能力协商同样会因能力全 false 而跳过）。
 */
import type { UpstreamPinAdapter } from './types.js';

/** 零注入实现：不提供任何 apply* 钩子（冻结，防误改扩展出「假通用」行为）。 */
export const NO_INJECTION_ADAPTER_IMPLEMENTATION: Pick<
  UpstreamPinAdapter,
  'applyBody' | 'applyHeaders'
> = Object.freeze({});
