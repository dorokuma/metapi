---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: db
---

# 测试隔离专项 backlog：全仓 DATA_DIR 缺陷测试普查（项目彻底清爽）

## 一句话结论

「Cline 上游探测」特性线收口后，启动一次**全仓测试隔离专项**：普查所有会碰真库
（`config.dataDir/hub.db`）却在静态 import 之后才设 `DATA_DIR` 的测试文件，统一改成
「模块求值前设置临时目录」的写法，最后删掉存量工作树 `data/hub.db` 残骸并留痕。
在此之前，任何新增真库测试都必须自带 `vi.hoisted` 隔离（本特性线已按此执行）。

## 背景

- 机制缺陷与最小复现见 `20260925-sqlite-test-isolation-data-dir.md`：`db/migrate.js` 的
  `resolveSqliteDbPath()` 没有 vitest 隔离，静态 import `config` 的测试在 `beforeAll` 里设
  `DATA_DIR` 已经太晚，迁移会打到工作树 `data/hub.db`。
- 已知现存实例至少一处：`src/server/routes/proxy/chat.siteApiEndpoint.test.ts`；全量
  `npm test` 期间可观察到 `data/hub.db` 的 mtime 被更新。
- 任务方给出的普查规模：**约 109 / 466 个测试文件待逐个人工确认**（其余为纯模块/组件测试，
  不碰真库）。该数字是「嫌疑面」不是「缺陷数」，需要逐个看 import 顺序 + 是否动态
  import `db/migrate.js` / `db/index.js`。
- 危害不止脏工作树：同一 worker 进程里多个真库测试共享同一个库，表被互相 delete/覆盖，
  会出现「单跑绿、全量跑红」的假失败（假红/假绿都降低门禁可信度）。

## 决策

1. **触发时机**：本特性线（阶段 3+4）收口、全量门禁绿之后，作为独立专项开工；不夹在
   功能 PR 里做，避免 100+ 文件的机械 diff 掩盖功能改动。
2. **普查口径**（按优先级）：
   1. 静态 `import { config }` / 静态 `import` 任何会在模块求值期解析 `config.dataDir`
      的模块，且后续动 `db/migrate.js` 的测试；
   2. `beforeAll` 里才 `process.env.DATA_DIR = ...` 的测试；
   3. `afterAll` 不清理临时目录、也不 `closeDbConnections()` 的测试（残骸/句柄泄漏）。
3. **修法候选（按推荐顺序）**：
   - **vitest setup 统一临时 DATA_DIR**（首选）：新增全局 setup 文件，在**每个测试文件
     模块求值前**把 `DATA_DIR` 指到 `tmpdir()/metapi-vitest-<worker>-<pid>`，并注册全局
     teardown 清理。一次到位，测试文件零改动，但需要验证对「显式设置 DATA_DIR 的测试」
     的覆盖顺序（setup 先于测试文件 import 生效）。
   - **vi.hoisted 逐个修**（兜底）：沿用本特性线的写法，`vi.hoisted` 里设置目录 +
     `afterAll` 删目录；适合 setup 方案覆盖不到的边角（如自带 env 断言的测试）。
   - 两者都要保留「测试之间不共享同一 sqlite 文件」这一硬约束，按 worker/pid 分目录。
4. **收尾**：专项合并后删除工作树存量 `data/hub.db`（含 `-wal`/`-shm`）并确认 `git status`
   干净；`data/` 本就在提交禁列，不留任何文件。
5. **门禁证据**：专项完成时给出「普查文件数 / 修复文件数 / 全量 `npm test` 期间
   `data/hub.db` 不再被创建或改 mtime」三项证据，并回写本笔记状态。
6. **过渡期约束**（立即生效）：本特性线及后续新增真库测试一律自带 `vi.hoisted` 隔离，
   禁止再引入「静态 import config + beforeAll 设 DATA_DIR」写法。

## 被放弃的方案（必填）

- **让 `db/migrate.js` 抄 `db/index.js` 的 `resolveVitestSqlitePath()`**：方向对，但那是
  运行时路径判定（`NODE_ENV==='test'` / vitest 环境探测），改动生产迁移入口的风险大于
  测试侧写法统一；可作为 setup 方案的备选，不在本专项默认范围内。
- **只修已知的一两处**：全量跑红的假失败只是概率问题，逐个抓漏是无穷工作；必须用
  setup/普查一次收口，否则专项会反复复活。
- **给所有测试加 `DB_URL=:memory:`**：与 `20260925-sqlite-test-isolation-data-dir.md`
  中否决理由相同——内存库与文件库的代理/迁移行为有差异，属降覆盖换干净，不取。

## 来源

- `.agents/notes/20260925-sqlite-test-isolation-data-dir.md`（机制与最小复现）
- 「Cline 上游探测」阶段 3+4 收口清单第 6 项（2026-09-25，任务方给出 109/466 嫌疑面）
- 本特性线真库测试的 `vi.hoisted` 隔离范式：
  `src/server/services/upstreamProviderDetect/store.test.ts`、
  `src/server/routes/api/upstreamObservations.test.ts`
