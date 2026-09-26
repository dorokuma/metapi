/**
 * `generic-dual`：默认适配器，= 既有 inject.ts 的双姿势实现。
 *
 * S1（硬约束）：**不搬移** inject 逻辑——`applyBody` 直接引用 `injectUpstreamProviderPin` 原函数，
 * inject.ts 零 diff、inject.test.ts 零改动，「搬移漂移」风险归零。
 * 回滚杠杆 = 三层急停 + 适配器/接线文件整段 revert（inject.ts 始终是原实现）。
 */
import { injectUpstreamProviderPin } from '../inject.js';

export const applyGenericDualBody = injectUpstreamProviderPin;
