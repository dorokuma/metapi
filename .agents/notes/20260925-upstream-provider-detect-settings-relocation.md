---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: web
---

# 上游探测设置归位与去品牌化：设置入口迁到系统设置页 + 参与站点改站点多选

## 一句话结论

「上游探测」四项配置（总开关 / 采样率 / 保留天数 / 参与站点）从 /logs 调试设置弹层
迁到系统设置页独立分区（`/settings?section=upstream-detect`，侧边栏「设置」）；
参与站点从手填 host 后缀改为**站点 id 多选**（settings 键 `upstream_provider_detect_site_ids`），
单一配置源、默认空 = 不采集、保存后热生效；旧键 `upstream_provider_detect_platforms`
代码全清 + 启动时删除残留行；用户可见文案去 Cline 品牌化（Cline 仅作示例）。

## 背景

- 首版把四项配置塞进 /logs 的「调试设置」弹层：入口藏在调试追踪语义里，和「代理调试」
  的记录内容混在一起；用户评审要求归位到系统设置页。
- 参与站点原来是 host 后缀匹配（`api.cline.bot` 命中 `cline.bot`）：站点换域名即门禁失效，
  同一 host 上的多个站点无法逐个控制，且「后缀」不是站点实体的稳定标识。
- 用户可见文案把功能写成 Cline 专属（「上游探测（Cline 网关）」），需要改成通用口径，
  因为返回 `provider_metadata.gateway.routing` 的网关不止 Cline 一家。

## 决策

1. **设置归属**：新增系统设置页分区「上游探测」，插入在「路由策略」卡片之后、全局品牌屏蔽
   之前（代理相关分区群的收尾处，紧邻「代理失败判定 / 路由策略」）；卡片带
   `data-settings-card="upstream-detect"` 与 `id="settings-section-upstream-detect"`，
   保存走该页既有 `PUT /api/settings/runtime` 流程。
2. **门禁机制**：只按站点 id 判定——`shouldCollectUpstreamProviderObservation({ requestId, siteId })`
   检查 `config.upstreamProviderDetectSiteIds` 集合命中，再做采样；代理面已有
   `selected.site.id`，不需要任何额外查询。空集合 = 不采集（默认）。
3. **单一配置源**：settings 键 `upstream_provider_detect_site_ids`（JSON 数字数组；
   PUT 同时接受数字字符串并归一化去重）；环境变量改为 `UPSTREAM_PROVIDER_DETECT_SITE_IDS`
   （逗号分隔 id，发布环节写等价值）；hydration 只认新键。
4. **旧键清理**：`upstream_provider_detect_platforms` 不再被读取/写入；启动时
   `dropLegacyUpstreamProviderDetectPlatformsSetting()` 删除残留行（失败不阻塞，幂等）。
5. **/logs 侧**：调试设置弹层移除四项（含 state / type / payload 触点）；「上游分布」面板
   头部加「配置」入口 → `navigate('/settings?section=upstream-detect')`，设置页按
   `?section=` 锚点 `scrollIntoView` 定位。ProxyLogs 的筛选 URL 同步 effect 增加
   `location.pathname === '/logs'` 守卫，避免离开页面时用本页筛选覆盖目标页 query。
6. **去品牌化**：分区标题/面板入口/输入提示全部通用口径；描述固定为「解析上游网关返回的
   路由元数据（provider_metadata.gateway.routing），记录每笔请求实际命中的上游提供方；
   适用于返回该结构的网关（例如 Cline）。」；「未选站点 = 不采集」提示保留。
7. **测试隔离**：新增真库测试（settings 路由、旧键清理）统一 `vi.hoisted` 先把 `DATA_DIR`
   指向 `tmp/` 独立目录，绝不写工作树 `data/`。

## 被放弃的方案（必填）

- **由所选站点推导 host 后缀、复用原后缀门禁**：站点 URL 变化后后缀漂移（配置与实际
  站点不再一致），且「站点 id → 后缀」的派生结果等于第二份配置；同一 host 多站点也无法
  区分。放弃。
- **新旧键双读一段时间（兼容期）**：违背「单一配置源、不要双配置并存」的评审结论，
  会让「参与站点」出现两套真相。放弃。
- **保留 host 后缀匹配作为 OR 条件**：任何带后缀的旧配置都会绕过站点勾选，默认不采集
  语义就被破坏了。放弃。
- **把配置放进独立设置页 / 新弹层**：设置页已有 runtime settings 分区模式与保存流程，
  再开页面只会增加入口碎片化。放弃。

## 来源

- 任务说明：用户评审返工 `[MARK-WORKER-UPSTREAM-DETECT-UX-REWORK]`（仓库 10bc02d 之上）。
- 相关实现：`src/server/services/upstreamProviderDetect/{siteIds,gate,legacySettings}.ts`、
  `src/server/routes/api/settings.ts`、`src/server/runtimeSettingsHydration.ts`、
  `src/web/pages/{Settings,ProxyLogs}.tsx`。
- 相关测试：`settings.upstream-detect.test.tsx`、`ProxyLogs.upstream-observations(.mobile).test.tsx`、
  `gate/collect/legacySettings` 单测、`routes/proxy/upstreamProviderDetect.test.ts`。
