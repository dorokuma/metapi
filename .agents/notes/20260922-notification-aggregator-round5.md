# 聚合器第五轮双审返工：pendingStorm 丢失与测试假绿


status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: services
---

# 标题

notificationAggregator 第五轮双审返工：pendingStorm 丢失与测试假绿

## 一句话结论

`pendingStorm` 在两条路径上会被静默丢弃（封板写失败后重建、进程重启不落库），修复为"续写原对象 + persist/load 带上 pendingStorm 与 finalWritten"；三个原本恒真的测试改为真行为测试并补齐先红证据。

## 背景

第四轮（ca1ab00）引入 pendingStorm 机制，目标是"先封板旧风暴、成功后才发布新风暴"。双审（reviewer+oracle）发现三处 major：

- M1：`evaluateAggregatedNotification` 的 `stormExpired` 分支无条件新建 pendingStorm。封板写失败后下一次 evaluate 因旧 storm 已 inactive，就把上一份 pendingStorm（连同已插入 events 行的 eventId 与 count）丢掉，再 insert 一条新行 → 孤儿行、count 回 1、中间行永远停在 baseMessage。
- M2：pendingStorm 不落库。新 events 行在发布前已插入，进程崩溃/重启时超过 10 分钟的旧 storm 被 load 丢弃、封板不重试，整段新风暴丢失。注释所称"最多丢 5 秒"不成立。
- M3/M4：封板与代际两个行为测试是假绿的（只断言 `lastPushAtMs>0` / `toBeDefined()`，删掉被测逻辑仍 PASS）。
- M5：NotificationSettings chip `onMouseDown preventDefault` 无断言。

## 决策

1. **M1**：`stormExpired` 分支加 `&& !entry.pendingStorm` 守卫。已有 pendingStorm 就续写原对象，禁止新建、禁止再 insert；发布权只属于 flush。
2. **M2**：
   - `PersistedEntry` 增加 `pendingStorm?: PersistedStorm | null` 字段（settings 表 JSON blob，**无需 schema 迁移**）。
   - `PersistedStorm` 由 `Omit<StormEntry,'finalWritten'>` 改为完整 `StormEntry`，`finalWritten` 落库，重启后才能区分"已封板可丢弃"与"未封板需重试"。
   - 新增 `restoreStorm()`：pendingStorm 一律恢复；旧 storm 仅在"已封板且已过期"时丢弃，未封板的过期 storm 也恢复并允许重试封板。
   - load 时若存在 pendingStorm 或未封板 storm，标记 dirty，让重启后即使没有新告警也能在下一周期完成写回。
3. **M3**：`release` 测试改为记录 release 前后 `lastPushAtMs` 并断言相等；覆盖"发送前保存的代际不改窗口、发送后新代际会改窗口"，并用 fake timers 精确控制冷静期。
4. **M4**：封板测试改用 fake timers 让旧 storm 在内存中过期（不再依赖 load 过期丢弃来构造），真正进入封板写失败分支；断言旧 eventId 保留、计数不丢、行数守恒。
5. **M5**：`NotificationSettings.templates.test.tsx` 新增断言——`isBodyFocused` 时 chip `onMouseDown` 调用 `preventDefault`，失焦时不调用。

## 被放弃的方案（必填）

- **给 pendingStorm 单独加一张表 / 加 migration**：废弃。该状态本来就是 settings 表的 JSON blob，扩字段即可，无需 schema 迁移，也避免触碰数据库契约。
- **封板失败后把 pendingStorm 里的 eventId 置 0 重插**：废弃。会再次插入孤儿行，正是 M1 要修的病症。
- **load 时把所有过期 storm 一律丢弃**：废弃。这是 M2 的根因——未封板的 storm 被丢会让整段新风暴丢失；改为按 `finalWritten` 判别。
- **测试继续用 `Date.now() - 11min` 改 DB 再 reset 构造过期**：废弃。load 会把过期 storm 丢掉，封板分支根本进不去，正是 M4 假绿的原因。

## 来源

- 双审（reviewer + oracle）第五轮返工结论，项 M1-M5。
- 先红后绿证据：在 ca1ab00 基线上对 notificationAggregator.ts / NotificationSettings.tsx 分别回滚改动后，新测试 FAIL；修复后 PASS。
