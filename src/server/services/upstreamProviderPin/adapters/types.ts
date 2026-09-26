/**
 * 「上游钉选适配器」接口定义。
 *
 * 适配器全部为纯函数、无状态，符合 services 层约束（不引 routes / Fastify / OAuth）：
 * - `applyBody` / `applyHeaders` **不得 mutate 入参**，必须返回浅拷贝；调用点**必须使用返回值**
 *   （`ensureStreamAcceptHeader` :251/:256、`ensureResponsesAcceptHeader` :291 存在「原样返回入参」
 *   的分支，若实现侧就地改写会把改动泄漏到非注入路径）。
 * - header 族适配器只允许**新增**自有键名（如 `x-portkey-*` / `Helicone-*`），
 *   不得触碰鉴权头与 BLOCKED_PASSTHROUGH_HEADERS。
 * - 能力协商在调用点（upstreamProviderPin/apply.ts）按 mode 查 `capabilities`：
 *   不足即整条跳过（body 与 header 都不写），绝不把 only 降级为 order。
 */

import type {
  UpstreamPinAdapterCapabilities,
  UpstreamPinAdapterId,
  UpstreamPinAdapterMechanism,
} from '../../../../shared/upstreamPinAdapters.js';
import type { UpstreamProviderPinTarget } from '../rules.js';

export type {
  UpstreamPinAdapterCapabilities,
  UpstreamPinAdapterId,
  UpstreamPinAdapterMechanism,
};

export type UpstreamPinAdapter = {
  id: UpstreamPinAdapterId;
  /** UI 显示名（来自共享目录）。 */
  label: string;
  mechanism: UpstreamPinAdapterMechanism;
  capabilities: UpstreamPinAdapterCapabilities;
  /** UI 能力提示文案（来自共享目录）。 */
  notes: string;
  /** body 族：返回浅拷贝。 */
  applyBody?: (
    body: Record<string, unknown>,
    pin: UpstreamProviderPinTarget,
  ) => Record<string, unknown>;
  /** header 族（opt-in）：返回浅拷贝。 */
  applyHeaders?: (
    headers: Record<string, string>,
    pin: UpstreamProviderPinTarget,
  ) => Record<string, string>;
};
