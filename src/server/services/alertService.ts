import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import {
  evaluateAggregatedNotification,
  releaseAggregatedPushWindow,
} from './notificationAggregator.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

export async function reportTokenExpired(params: {
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  detail?: string;
}) {
  const accountLabel = params.username || `ID:${params.accountId}`;
  const siteLabel = params.siteName || 'unknown-site';
  const detailText = params.detail ? appendSessionTokenRebindHint(params.detail) : '';
  const detail = detailText ? ` (${detailText})` : '';
  const createdAt = formatUtcSqlDateTime(new Date());

  await db.insert(schema.events).values({
    type: 'token',
    title: 'Token 已失效',
    message: `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    level: 'error',
    relatedId: params.accountId,
    relatedType: 'account',
    createdAt,
  }).run();

  await db.update(schema.accounts).set({
    status: 'expired',
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, params.accountId)).run();

  setAccountRuntimeHealth(params.accountId, {
    state: 'unhealthy',
    reason: detailText ? `访问令牌失效：${detailText}` : '访问令牌失效',
    source: 'auth',
  });

  await sendNotification(
    'Token 已失效',
    `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    'error',
  );
}

export async function reportProxyAllFailed(params: { model: string; reason: string }) {
  // 同一类故障（代理全部失败）在故障期会跨模型、跨请求高频触发。落库与推送统一交给
  // 聚合器裁决：冷却窗口内只累计次数并原地更新同一条事件行，不再逐条插入、逐条推送。
  const decision = await evaluateAggregatedNotification({
    level: 'error',
    title: '代理全部失败',
    message: `模型=${params.model}, 原因=${params.reason}`,
    eventType: 'proxy',
    relatedType: 'route',
    model: params.model,
    reason: params.reason,
  });

  if (!decision.shouldPush) return;

  // 在发送前保存推送当时的 pushGeneration，防止挂起期间新推送把代际加一
  const { buildAggregatedSignature, getAggregatorEntry, releaseAggregatedPushWindow } = await import('./notificationAggregator.js');
  const signature = buildAggregatedSignature('error', '代理全部失败');
  const generation = getAggregatorEntry(signature)?.pushGeneration ?? 0;

  const result = await sendNotification(
    '代理全部失败',
    decision.message,
    'error',
    {
      bypassThrottle: true,
      storm: { count: decision.count, models: decision.models },
    },
  );

  // 渠道存在但全部发送失败（如 Telegram 拒收）时释放冷却窗口，
  // 避免一次失败把整个冷静期消耗掉。无渠道时不释放（没有重试意义）。
  if (result.attempted > 0 && result.succeeded === 0) {
    await releaseAggregatedPushWindow('error', '代理全部失败', generation);
  }
}
