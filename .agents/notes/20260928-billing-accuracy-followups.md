---
status: active
superseded_by: ""
supersedes: ""
模块: services
---

# fix/billing-accuracy 遗留项

## 一句话结论

本轮返工完成 todayIncome 写入端刚性美元契约、legacy 读取端兼容、余额异常治理与计费可审计化；以下 5 项遗留待后续迭代处理。

## 背景

reviewer r2 判定 proxyBilling group 透传、legacy 启发式残余风险、快照元数据丢失、异常漏报、审计增强为遗留项，本次不做。

## 决策

1. proxyBilling group 透传：维持 `group` 字段业务侧待定义状态，后续接入 `tokenGroup/routeGroup/site` 配置后再打通。
2. 读取端 legacy 启发式：保留现状，新快照已打标 `normalized` 免疫；存量无标记且 >=1e5 旧快照仍有误归一残余风险，待后续数据迁移或标记补录消除。
3. 快照二次读写：`incomePlatform` 元数据可能在多次 `mergeAccountExtraConfig` 中被覆盖丢失，待后续写入层原子化或 schema 迁移补齐。
4. extraConfig 为空账户：异常计数可能漏报，待后续初始化逻辑补全。
5. 审计增强：`incomeUnitSource/incomePlatform` 写入 `dailySummary/accountsOverview` 为候选增强，待后续审计需求明确。

## 被放弃的方案（必填）

- 本次直接硬改 group 透传：风险高，group 来源未明，可能引入错误计价。

## 来源

- reviewer r2 返工判定（2026-09-28）
