/**
 * 「重试耗尽」运维标记的 `events` **独立 title**（判别器就用它直查）。
 *
 * 该标记**已从通知中心口径摘除**：服务端 `routes/api/events.ts` 的两个读接口
 * （`GET /api/events` 列表、`GET /api/events/count` 未读计数）按本 title 排除
 * ⇒ 不出现于通知面板列表，也不计入未读徽标/计数；**标记行仍照常落库、仍可
 * `SELECT * FROM events WHERE title = '代理重试耗尽'` 直查**。
 *
 * 与 `reportProxyAllFailed` 的「代理全部失败」互不干扰：聚合签名是 `level||title`
 * （`notificationAggregator.ts` 的 `buildAggregatedSignature`），新 title 自成一组；
 * 且本标记**直插 `events` 表**、不经 `evaluateAggregatedNotification`，故不推送、
 * 也不受聚合器的文本规范化与「保留集」影响。
 */
export const RETRY_EXHAUSTED_EVENT_TITLE = '代理重试耗尽';
