---
status: active
superseded_by: ""
supersedes: ""
模块: "scripts, db, services"
---

# 20260928 CI 门禁修复决策观察

## 一句话结论

本次修复在 CI 门禁、MySQL 长文本列默认值与 live 测试方言兼容三个层面做了收缩与降级，相关决策已记录；后续跟进缺口需人工排期。

## 背景

分支 `fix/ci-gate-repair` 修复了 CI 中 schema 门禁与测试方言兼容性问题，并调整了 audit 报告路径，使 CI 能在无 DockerHub secrets 时通过。

## 决策

1. **npm audit push 路径由硬失败降级为报告**。当 GitHub Actions 缺少 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 时，流程不再阻塞发布，而是在工作流末尾输出 audit summary 供人工跟进。缺口：高危漏洞 summary 的查看者、处理时限尚未定责。
2. **MYSQL_LONG_TEXT_COLUMNS 不变量**。schemaArtifactGenerator 在生成 MySQL bootstrap 时，对新增长文本列显式省略 `DEFAULT`，以避免 MySQL 驱动报错。后续所有写入点若新增长文本列，必须显式赋值，否则可能触发门禁失败。目前暂无测试守护该不变量。
3. **usageAggregationService.live.test 去 `.returning()`**。MySQL 驱动不支持 `INSERT ... RETURNING`，因此 live 测试改用隐式自增主键后的查询断言；该改动属于 `schema-mysql` 门禁步骤必需。

## 被放弃的方案（必填）

- 维持 audit push 硬失败，等待 secrets 配置完成后再通过 CI。弃用原因：阻塞发布周期，且 secrets 配置涉及外部协作。
- 为 `MYSQL_LONG_TEXT_COLUMNS` 立即补充全局测试。弃用原因：改动面较大，先以文档化不变量方式收敛，后续排期补测。
- 在 `usageAggregationService.live.test` 中改用 SQLite 兼容方言保留 `.returning()`。弃用原因：与 MySQL 门禁目标冲突。

## 来源

- 分支 `fix/ci-gate-repair` 双审通过。
- `.github/workflows/ci.yml` 中 audit push 步骤降级。
- `schemaArtifactGenerator.ts` 与 `schemaArtifactGenerator.test.ts` 关于长文本列默认值的修复。
- `usageAggregationService.live.test.ts` 与 `databaseMigrationService.sequences.live.test.ts` 方言兼容调整。
