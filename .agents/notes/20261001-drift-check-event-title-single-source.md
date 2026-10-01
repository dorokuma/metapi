---
status: active
superseded_by: ""
supersedes: ""
模块: scripts, docs
---

# drift-check `event-title-single-source` 规则收尾：needle 联动测试与逐行注释启发式

## 一句话结论

`scripts/dev/repo-drift-check.ts` 的 `event-title-single-source` 规则（禁止在 `src/` 非测试源码里内联 `'代理重试耗尽'`）本轮收尾固化三处取舍：needle 与单一定义源的联动**靠测试期正则抽取**而非导出内部常量；注释豁免是**逐行启发式**（整行注释、同行 `/* */`、行尾 `//`），非 `*` 续行的块注释会**响亮误报**；运行时拼接类构造**不检测**（登记为已知假阴性面）。

## 背景

- 规则：`scripts/dev/repo-drift-check.ts`（needle 由 `String.fromCharCode(...)` 还原，不写字面量）；唯一合法源 = `src/server/shared/eventTitles.ts:14` 的 `RETRY_EXHAUSTED_EVENT_TITLE`。
- 扫描面：`fileFilter` 要求 `src/` 前缀 + 非测试源码（`isNonTestSource`）+ 非定义文件；`walkFiles` 是目录遍历（untracked 文件同样被扫）。规则文件自身在 `scripts/`，**不可能自扫**。
- 风险点：needle 是硬编码码点，与定义文件无代码联动 ⇒ title 一改名，守卫便静默失效（仍守着旧串），棘轮测试照样全绿。

## 决策

1. **联动测试不导出内部常量**（`scripts/dev/repo-drift-check.test.ts`）：`readTitleFromDefinitionFile()` 用正则 `/RETRY_EXHAUSTED_EVENT_TITLE\s*=\s*'([^']*)'/` 从真实定义文件取值，再把该值写进夹具内联字面量，断言规则必报 violation。title 改名（needle 陈旧）时该用例直接红。
2. **注释豁免只做逐行启发式**：`isCommentOnlyLine` + `stripInlineBlockComments` + 新增 `stripTrailingLineComment`（从第一个 `//` 截断）。不解析字符串字面量 ⇒ `'https://…'` 这类 URL 会被 `//` 提前截断，属已接受的假阴性面。
3. **非 `*` 续行的块注释按「会报」固化用例**：逐行 API 无状态、无法识别块注释状态，保留该响亮假阳性，并在规则 description 与 `docs/engineering/harness-engineering.md` 写明。
4. **文档补范围与豁免**：该 bullet 补「仅 `src/` 非测试源码；豁免定义文件、测试文件与注释；扩展名以 `.ts/.tsx/.js/.jsx` 为准」。
5. **订正不成立的自述理由**：码点还原的真实收益只是 `rg <title> scripts/dev/` 无噪声，并非「防止规则扫到自己」——规则在 `scripts/`，本就不会被 `src/` 前缀的 fileFilter 扫到。

## 遗留与跟进（只登记，不在本片修）

1. **联动测试抽真值的正则未锚定代码行**：`scripts/dev/repo-drift-check.test.ts` 的 `readTitleFromDefinitionFile()` 用 `/RETRY_EXHAUSTED_EVENT_TITLE\s*=\s*'([^']*)'/` 取第一个匹配。若将来 `src/server/shared/eventTitles.ts` 的 JSDoc 里出现 `RETRY_EXHAUSTED_EVENT_TITLE = '…'` 形式的示例、且排在真实 export 之前，会抽到错值，夹具与 needle 一起偏移而用例仍绿。锚定到真实 export 行可解，本片未动。
2. **豁免面比文档更窄**：`docs/engineering/harness-engineering.md` 写「test files 豁免」，代码实际只认 `.test.ts`/`.test.tsx`/`.test.js`/`.test.jsx` 四个后缀（`isNonTestSource`）。将来若换测试命名规范（如 `*.spec.ts`），测试夹具会被当成源码而响亮误报；文档措辞与实现的这条落差是后续漂移源。
3. **`scripts/` 无静态类型门槛（仓库级空白）**：`tsconfig.server.json`/`tsconfig.web.json`/`tsconfig.web.test.json`/`tsconfig.desktop.json` 四个项目 config（其 base `tsconfig.json` 亦然）的 `include` 都只含 `src/`，`scripts/` 下 **14 个非测试脚本**（7 个 `.ts` + 7 个 `.mjs`，见 `find scripts -type f \( -name '*.ts' -o -name '*.mjs' \) ! -name '*.test.*'`）不在任何 `tsc` 项目内，`npm test`（`vitest run --root .`，只收测试文件）与 `npm run typecheck` 都覆盖不到。⇒ 本片对该规则的实现改动仅由一道**定向** `tsc --noEmit … scripts/dev/…` 临时兜住；给 `scripts/` 建 tsconfig 是候选后续任务。
4. **规则已知误报/漏报面索引**：已知假阴性（运行时拼接、模板插值、`\u` 转义、`String.fromCharCode`，及字符串内含未闭合 `/*`）与已知假阳性（非 `*` 续行的块注释）已写入规则 `description`，此处仅索引，不重复。

## 被放弃的方案（必填）

- **导出规则内部常量给测试用**（更直觉）：会让规则模块为测试暴露实现细节，并把 needle 变成「第二个可被 import 的来源」，削弱定义文件作为唯一真相的地位；改用测试期从定义文件抽取真值。
- **引入块注释状态机 / 完整词法扫描**：消除非 `*` 续行误报的收益与「跨行状态 + 字符串/模板字面量处理」的成本不匹配——本规则是防呆门禁，不是编译器。
- **扩展检测运行时构造**（字符串拼接、模板插值、`\u` 转义、`String.fromCharCode`、字符串内含 `/* */`）：静态文本匹配天然做不到，强行做会引入更多假阳性；改为在 description 登记已知局限，不修。

## 来源

- 分支 `chore/drift-check-event-title-single-source`（基于 main `cdbcf3aa`），reviewer + oracle 两方结论并集收尾。
- 联动性证据（/tmp 一次性副本，已清理）：改 `src/server/shared/eventTitles.ts` 的 title ⇒ 该用例 FAIL（8 用例中 1 failed / 7 passed）；还原 ⇒ PASS（8/8）。
- 终态验证：`npm run typecheck` 四段全绿；`npx vitest run --root . scripts/dev/repo-drift-check.test.ts` = 8/8；`npm run repo:drift-check` = 0 违规 / 5 条既有 tracked debt；反向对照（真实 `src/` 非测试源码内联字面量）= 1 违规，删除后回 0。
- 关联：`.agents/notes/20261001-retry-exhausted-proxy-log-and-stream-cap.md`（title 常量迁家与通知中心口径摘除）。
