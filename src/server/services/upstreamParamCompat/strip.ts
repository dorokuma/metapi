/**
 * (a) 站点级参数剥离：在最终出站体上按站点（可含模型、端点）删掉指定顶层键，零额外往返。
 *
 * 挂点与顺序（`upstreamRequestBuilder.ts`）：协议整形 → payload 规则 → **站点剥离** → 钉选。
 * 只有打在最终出站体上才不会漏掉 responses 透传（走 responsesOriginalBody），
 * 也不会被 payload override 把刚删的键加回来。
 *
 * 门禁：(a) 只看总开关 `config.upstreamParamCompatEnabled`；不传 siteId 的调用点自然不剥。
 *
 * 返回语义：未命中 / 无可删键 → 返回**原引用**（逐字节不变）；命中 → 浅拷贝后删顶层键。
 * 热路径逐名再过一次标识符 + 拒绝表（`isSafeStrippableUpstreamParam`），只删顶层、大小写敏感。
 */

import { config } from '../../config.js';
import {
  isSafeStrippableUpstreamParam,
  resolveUpstreamParamCompatParams,
  type UpstreamParamCompatEndpoint,
} from './rules.js';

export function stripUnsupportedUpstreamParams<T extends Record<string, unknown>>(
  body: T,
  input: {
    siteId: number | null | undefined;
    requestedModel: string;
    actualModel?: string;
    endpoint: UpstreamParamCompatEndpoint;
  },
): T {
  // 双保险：总开关关 = 不剥离（关开不删规则）。
  if (config.upstreamParamCompatEnabled !== true) return body;

  const rules = config.upstreamParamCompatRules;
  if (!Array.isArray(rules) || rules.length === 0) return body;

  const names = resolveUpstreamParamCompatParams({
    rules,
    siteId: input.siteId,
    requestedModel: input.requestedModel,
    actualModel: input.actualModel,
    endpoint: input.endpoint,
  }).filter(isSafeStrippableUpstreamParam);
  if (names.length === 0) return body;

  // 只删顶层且确实存在的键；一个都删不掉时保持原引用（零改动路径逐字节不变）。
  const present = names.filter((name) => Object.prototype.hasOwnProperty.call(body, name));
  if (present.length === 0) return body;

  const next = { ...body } as T;
  for (const name of present) {
    delete next[name];
  }
  return next;
}