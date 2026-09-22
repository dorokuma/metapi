
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: services
---

# notificationAggregator 第六轮终审收尾硬化：静默重启写回缺口与三处测试假绿

notificationAggregator 第六轮终审收尾硬化：静默重启写回缺口与两处测试假绿

## 一句话结论

`loadPersistedState` 标 dirty 后不启动 flush 定时器，导致静默重启（无新告警）时写回永不发生、events 行停在 baseMessage；修复为标 dirty 处单点调用 `ensureFlushTimer()`，并补齐三个锁住真实行为的测试（H2 封板恢复重试、H3 写失败不发布、H4 代际采样时机）。

## 背景

第五轮（75c8078）修复了 pendingStorm 丢失与测试假绿后，第六轮双审放行可收口，按主代理要求补齐 4 条应修/建议（均不证伪当前实现）：

- H1（should fix）`notificationAggregator.ts:162`：load 标 dirty 后没有调用 `ensureFlushTimer()`。生产 blob 现无 `finalWritten` 即此路径——进程重启后若没有任何新告警触发评估，dirty 永远等不到 flush，events 行停在 baseMessage。
- H2（should fix）`restoreStorm` 的丢弃条件写反（`finalWritten` 取反）时测试仍绿：没有测试锁住"未封板的过期旧 storm 在重启后被恢复并重试封板"。
- H3（should fix）删掉 flush 封板失败中止块（`if (pendingSeal) continue;`）后测试仍绿："写失败不发布"只被间接断言，没在当轮 blob 上单独锁住。
- H4（consider/should fix）`alertService.ts:70`：代际采样挪到 `sendNotification` 之后现有测试仍绿——M3 单测只覆盖 release 层，没穿过 alertService 调用路径。

## 决策

1. **H1**：`loadPersistedState` 标 dirty 的分支内增加一次 `ensureFlushTimer()`（全文件仅此一处新增调用，无顺手重构）。不形成写放大循环：flush 成功后清 dirty，定时器为单例（内部判重），且不清 dirty 的条件仍是代数未变。未改丢弃条件、release 语义、发布路径。
2. **H2**：新增测试"restores an expired but unsealed old storm after restart and retries sealing it"：构造未封板且已过期 11 分钟的 storm blob，重启后断言旧 storm 行被原地封板写回、落库 storm 仍在且 `finalWritten=true`。`restoreStorm` 的 `finalWritten` 判断取反时该测试 FAIL（先红后绿）。
3. **H3**：新增测试"seal write failure keeps both the old storm and the pending storm in the same round"：封板写失败当轮直接读 settings blob，断言 `storm.eventId` 仍是旧行且 `finalWritten=false`、`pendingStorm` 同时在且不是旧行、旧行内容未被改写。删掉 `if (pendingSeal) continue;` 该测试 FAIL（先红后绿）。
4. **H4**：新增 `alertService.test.ts`：mock `notifyService.sendNotification` 挂起，穿过 `reportProxyAllFailed`，在发送挂起期间用 fake timers 推进冷静期并触发一次新推送（代际加一），再让发送以"全部渠道失败"返回，断言迟到 release 用的是发送前保存的旧代际、窗口未被改写；并补一次新代际 release 证明通路可用。采样挪到 send 之后该测试 FAIL（先红后绿）。

## 被放弃的方案（必填）

- **load 中标 dirty 后直接 `await flushAggregatedState()`**：废弃。会让 load 路径承担写放大与错误面，且首波并发告警都要等这次写回；改为启动既有单例定时器，语义与评估路径完全一致。
- **H2/H3/H4 用"删掉实现看测试是否红"之外的手段（如快照断言 `toBeDefined()`）**：废弃。这正是前几轮假绿的根因；一律改为对真实行为量（行内容、blob 字段、窗口时间戳）断言。
- **H4 在 notificationAggregator 单测里补**：废弃。主代理要求穿过 alertService 调用路径、覆盖与现有 M3 不同的层。

## 来源

- 双审（reviewer + oracle）第六轮终审结论，项 H1-H4。
- 先红后绿证据：H1 未修复时新测试 FAIL；H2 在 `restoreStorm` 反置 `finalWritten` 后 FAIL；H3 删掉封板失败中止块后 FAIL；H4 把代际采样挪到 send 之后 FAIL；四处修复后全部 PASS。
