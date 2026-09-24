---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: services
---

# 通知模板按事件定制：双审整改（迁移安全性 / 前端状态机 / 备份适配 / MySQL 列型）

## 一句话结论

第一轮「模板按事件类型定制」经 reviewer + oracle 双审判定需整改，本轮只整改不扩范围：
legacy 迁移废除「事务内全表 delete 再 insert」改为只补缺失 `__global__` 行的幂等写入；
前端未定制事件上输入先建独立覆盖（修掉静默写全局与空全局死锁）；备份纳入 `notification_templates` 表；
MySQL text 列不再因默认值降级成 `VARCHAR(191)`。

## 背景

双审指出四类阻塞问题与五类建议问题，逐条对应如下。核心风险是「升级即丢用户配置」：
旧迁移在事务里整表删除后插入 legacy 的 `__global__` 行，用户升级后自己定义的事件覆盖行会被静默抹掉；
备份导入旧版本文件时该路径会再次触发（legacy 键被写回），等于一次还原就能清空全部定制。

## 决策

1. **迁移只做「补齐缺失行」**：`ensureLegacyNotificationTemplatesMigrated()` 不再 delete 全表，
   只把 legacy JSON 拆出的 `__global__` 行按主键补差：SQLite/Postgres 用 `ON CONFLICT DO NOTHING`，
   MySQL 用 `INSERT .. ON DUPLICATE KEY UPDATE channel=channel` 的幂等写法。任何方言下并发/重复执行
   都只可能插入缺失行，不会 DELETE 或覆盖别人刚写入的行。legacy 键在迁移成功提交后删除，保持幂等。
   被放弃的方案：`onConflictDoUpdate` 覆盖已有 `__global__` 行——那会让旧备份内容覆盖用户升级后的新配置，
   同样属于丢数据。
2. **进程内迁移标记 + 导入入口重置**：启动迁移（或首次兜底）成功后置位，命中即跳过 settings 查询，
   每条通知不再多一次按主键的 settings 读；备份导入（`importPreferencesSection`）与恢复出厂
   （`clearAllBusinessData`）显式重置该标记，因此「导入旧备份后重迁移」仍然会发生，只是只补 `__global__`。
3. **扁平格式兼容只保留一处实现**：`normalizeNotificationTemplatesInput()` 统一「顶层是渠道键 → `__global__`」
   的归一化，`parseNotificationTemplatesInput`（严格）与 `saveNotificationTemplates`（宽松）都走它，
   不再各写一份。渠道名与事件类型名域不相交，扁平与双层不可能混淆。
4. **前端覆盖行判据从「内容非空」改成「行存在」**：`isCustomized = !!overrideTemplate`。
   写入一律落在当前事件类型上，未定制时先用全局内容播种一份独立覆盖（避免输入瞬间内容被清空）。
   被放弃的方案：引入独立的 dirty Set——payload 里的行本身就是最可靠的「用户显式创建过」标记，
   再维护一份 Set 只会出现两套真相。
5. **字段级回退**：`pickEventChannelTemplate` / `resolveNotificationTemplate` 按 title/body/parseMode
   逐字段回退（exact 缺的字段取 global），渲染层对仍然缺失的字段走渠道硬编码默认。
   整模板替换会让「只想改正文」的用户静默丢掉全局标题与解析模式。
6. **`sendNotification` 必填位前置**：`(title, message, eventType, level = 'info', options)`。
   原来 required 参数排在带默认值的 `level` 之后，调用点少传一个参数只会静默错位；
   同时移除 `loadNotificationTemplatesForEvent` 对非法 eventType 的静默降级，改为显式抛错。
7. **MySQL 列型**：`mapColumnType` 里 text 列只在「主键」时用 `VARCHAR(191)`（MySQL 主键/索引前缀需要），
   有默认值不再成为降级理由。模板正文上限 4000 字，`VARCHAR(191)` 会静默截断。
   产物用 `npm run schema:contract` 重新生成；注意必须以「上一个已发布契约」作为 previous，
   否则 upgrade 文件会退化成 `-- no schema changes detected`，真实升级路径丢失。
8. **备份适配**：preferences 段落新增 `notification_templates` 数组（全量行，含事件覆盖），
   导入语义 = 恢复备份中的行（同一事务内先删后插），旧版备份没有这一段时不碰本地表；
   `factoryResetService` 已有清表逻辑保持一致并重置迁移标记。

## 被放弃的方案（必填）

- **迁移用 `onConflictDoUpdate` 覆盖已有 `__global__` 行**：废弃，见决策 1。
- **前端维护独立 dirty Set 标记「已定制」**：废弃，见决策 4。
- **迁移检查保留「每次都查 settings」**：废弃。虽然最保守，但每条通知多一次 DB 读，
  且 legacy 键只可能由备份导入写回，入口重置标记已覆盖该场景。
- **`eventType` 收进 options 对象**：暂缓。前置成必填位改动更小、调用点更直观
  （TS 会在少传时直接报错，而 options 里的必填字段只能在运行时发现）。

## 影响与验证

- `npm run build` / `npm test` / `npm run typecheck` / `npm run repo:drift-check` 全部通过。
- `npm run test:schema:unit`、`npm run test:schema:parity`、`npm run test:schema:upgrade` 全部通过
  （MySQL / Postgres live 用例因无连接串按既有机制 skip）。
- 测试锁定：`notificationTemplates.test.ts`（迁移不再全表 delete——事件覆盖行跨迁移存活、
  只补缺失 `__global__`、未重置标记时不重迁移、字段级回退、非法 eventType 抛错、扁平格式解析）；
  `NotificationSettings.templates.test.tsx`（未定制事件直接输入落到该事件键、空全局下创建覆盖、
  变量 chip 归属事件）；`backupService.test.ts`（模板行导出/恢复、旧备份重迁移后事件行保留）；
  `schemaArtifactGenerator.test.ts`（text 列带默认值仍是 TEXT）；新增
  `settings.notification-templates.test.ts`（扁平 PUT 返回 200）。
