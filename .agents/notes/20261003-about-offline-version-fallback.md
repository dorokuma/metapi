---
status: active
superseded_by: ""
supersedes: ""
模块: "web"
---

# About 页缺版本时的「编造版本号兜底」修复（挂起分支）

## 一句话结论

About 页的 `const VERSION = '1.3.0'` 不是「陈旧常量」而是可达的真 bug：兜底值恒非空，当
`/api/update-center/status` 未返回 `currentVersion` 时它会被当成当前版本渲染、并作为
`buildUpdateReminder` 的输入参与比对，从而凭空得出「有更新」结论；修复后该页面只显示服务端
给出的版本，拿不到就用语言无关的中性占位 `—`，任何路径都不再把编造值喂给提醒计算。

## 动作项（下次发版前必做）

> **下次发版启动时，先合并 `fix/about-offline-version-fallback`（在跑 `scripts/deploy-painless.sh`
> 之前完成 ff-only 合入 main），再按「发版与无痛上线」流程执行。**
>
> 该分支按用户要求挂起，不随其它改动生效；本记录是它的唯一入口提示，勿依赖会话记忆。

## 背景

- 日期：2026-10-03；分支基点 `main` = `d55b18e5`。
- 改动前 `src/web/pages/About.tsx` 顶部有 `const VERSION = '1.3.0';`，三处使用：
  初始 state `` useState(`v${VERSION}`) ``、初始化 `buildUpdateReminder({ currentVersion: VERSION, ... })`、
  以及 `` const resolvedCurrentVersion = String(status.currentVersion || VERSION) ``。
- 仓库当时的 `package.json` 版本是 `1.4.19`，`1.3.0` 早已与运行实例无关——但**价值判断的关键不是
  「值过时」，而是这条兜底在缺失态必然生效**。
- 可达性（为什么是真 bug，而非陈旧常量）：
  1. 兜底 `currentVersion` 恒非空 → `buildUpdateReminder` 拿到的「当前版本」永远是一个数字版本；
  2. `resolveUpdateReminderCandidate` 的版本判定是 `compareStableVersions(currentVersion, candidate) === -1`，
     只要 currentVersion 是合法语义版本就会真的参与比较，缺版本时本应走到「无法比较」的 `null` 分支；
  3. 于是当上游只给出候选版本、没给出 `currentVersion` 时，页面会拿 `1.3.0` 当基准，把任何高于 1.3.0 的
     候选判成「比当前更新」。红态实测（仅新测试、实现未改）渲染出 `v1.3.0`，并同时给出假的
     「发现新版本 · GitHub 稳定版 1.4.0 已可部署。」——对一个可能正在跑 1.4.19 的实例，这是明确的错误提示，
     且完全由编造值产生。

## 决策

1. **删除兜底常量**，不再在任何路径上使用编造版本号：`VERSION` 从 `About.tsx` 移除。
2. **缺失态用与语言无关的中性占位**：`UNKNOWN_VERSION_PLACEHOLDER = '—'`；初始 state 改为 `''`，
   请求成功时 `setCurrentVersion(resolvedCurrentVersion ? `v${resolvedCurrentVersion}` : '')`（避免出现孤立的 `v`）。
3. **API 正常路径行为逐字不变**：`String(status.currentVersion || '')` 未加额外归一化，非空返回时仍渲染
   `v<currentVersion>`，传给 `buildUpdateReminder` 的输入与改动前完全相同（含 helper 与候选对象原样透传）。
4. **缺失态不再喂假版本**：`loadStatus` 成功但与 `currentVersion` 缺失时传空串；`buildUpdateReminder` 因
   `compareStableVersions` 归一化失败返回 `null`，既不产生假的「有更新」，也不会崩溃（`null === -1` 为假，
   无候选来源时提前返回「无法检查更新」）。
5. **渲染行加 `data-testid="about-current-version"`**，供新用例精确定位该行（本仓库 29 个页面文件在用该惯例）。
6. **不引入构建期注入**：版本真相已在服务端（`/api/update-center/status` 由运行实例给出）。前端用
   `define` 注入 `package.json` 版本会引入**第二份真相来源**——打包产物版本 ≠ 实际运行镜像版本，
   缺失态下会拿一个可能不匹配实例的版本参与比对，与本次修复目标相反；且需同时改 `vite.config.ts`
   与 `vitest.config.ts` 两处 `define`，为纯展示兜底扩大构建面与测试面，不划算。
7. **验证**（cwd `/root/workspace/metapi`）：`npm run typecheck`（exit 0，四段）、
   `npx vitest run src/web/pages/About.update-center.test.tsx`（3 passed，含新增 2 条：API 缺 `currentVersion`、
   API 失败；先红后绿，红态即上文实测）、`npm run build:web`（exit 0）、`npm run repo:drift-check`
   （Violations: 0）、`git diff --check`（干净）。
8. **本分支为何挂起**：用户要求该修复留到下一个发版才随发版生效。提交只落在
   `fix/about-offline-version-fallback` 上，不并入 main、不推送 main、不发版。

### 复审口径（主代理已定）

- 若届时需 rebase 才能 `--ff-only`：先做 **diff 同一性核对**（`git range-diff`，或对比两版 patch），
  结果须与本次受审 diff **逐字相同**，并在新基点重跑门槛（`npm run typecheck`、
  `npx vitest run src/web/pages/About.update-center.test.tsx`、`npm run build:web`）。
- 逐字相同 → reviewer 增量确认即可，不必重复全量双审。
- 一旦 rebase 过程中出现任何非平凡冲突解决（内容有改动）→ 走完整双审。

## 被放弃的方案（必填）

- **构建期注入版本（`define` / `import` `package.json`）**：弃用原因见决策第 6 条——引入第二份真相来源，
  且需动 vite/vitest 两处构建面。
- **保留兜底但改为读 `package.json` 版本**：弃用原因：前端打包版本不等于运行中镜像/服务端版本，
  缺失态下仍会把一个可能与实例不符的版本拿去比对，错因换汤不换药。
- **用中文文案占位（如「版本未知」/复用本页既有的「暂无数据」）**：弃用原因：`translateText` 对词典中
  没有的中文词条在 en 模式会落到 `'Untranslated'`（`src/web/i18n.tsx`），而补 `i18n.supplement.ts` 词条
  超出本次「只动 About.tsx 与其既有测试」的文件边界；版本号本身与语言无关，破折号占位不需要词条。
- **本次直接改 helper，让「当前版本未知」不落「已是最新」**：弃用原因：`buildUpdateReminder` 被
  `src/web/pages/settings/UpdateCenterSection.tsx` 共用，语义调整需评估 Settings 更新中心的影响，
  属另一范围；本次仅登记为关联项（见下），不在该分支实施。
- **把修复并入 main 直接生效**：弃用原因：与用户「留到下一个发版」的要求冲突。

## 关联登记（低优先级，本次不做）

- `buildUpdateReminder` 增加「当前版本未知」分支：当前版本缺失但有候选版本时，目前会落到 `已是最新`
  （「当前运行版本与已发现的部署目标没有明显差异。」），语义上更像「无法比对」。改动前该卡片的取值被
  1.3.0 兜底掩盖，本次修复后这一段才显现出来。
- 注意：该 helper 由 `Settings/UpdateCenterSection` 共用，任何语义调整都需评估其影响，并连带更新
  `src/web/pages/helpers/updateCenterPresentation.test.ts` 与 `src/shared/updateCenterReminder.test.ts` 的既有断言。

## 来源

- 本次会话（worker `[MARK-WK-ABOUTVER-1791041]`，cwd `/root/workspace/metapi`）。
- 代码：`src/web/pages/About.tsx`、`src/web/pages/About.update-center.test.tsx`、
  `src/web/pages/helpers/updateCenterPresentation.ts`、`src/server/shared/updateCenterReminder.ts`。
- 红态证据：仅保留新测试、实现回退到改动前，`npx vitest run src/web/pages/About.update-center.test.tsx`
  报 2 failed，失败文本含 `…Metapiv1.3.0…` 与 `更新提醒发现新版本…GitHub 稳定版 1.4.0 已可部署。`
- 双审：reviewer 逐项核对并在 `/tmp` 独立复现红态；oracle 放行，均 0 致命 0 应修。
