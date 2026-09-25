---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: db
---

# 真库测试隔离缺陷：静态 import config + beforeAll 设 DATA_DIR 会写工作树 data/hub.db

## 一句话结论

测试里凡是会碰 sqlite 真库（`config.dataDir/hub.db`，走 `db/index.js` / `db/migrate.js`）的用例，
必须在**模块求值前**用 `vi.hoisted` 设置 `process.env.DATA_DIR`；在 `beforeAll` 里设已经太晚——
`config` 是静态 import，其 `dataDir` 在 import 时按当时的环境变量固化，测试随后会静默写工作树
`data/hub.db` 而不是临时目录，污染开发库且测试之间互相干扰。

## 背景

「Cline 上游探测」阶段 2 的真库集成测试（`src/server/routes/proxy/upstreamProviderDetect.test.ts`）
与 store 单测（`src/server/services/upstreamProviderDetect/store.test.ts`）第一版按常见写法组织：

```ts
import { config } from '../../config.js'; // 静态 import：dataDir 此刻已固化
...
beforeAll(() => {
  process.env.DATA_DIR = 'tmp/x'; // 太晚，config.dataDir 已经指向 data/
  await import('../../db/migrate.js');
});
```

结果第一次跑测试就把迁移/建表写进了工作树 `data/hub.db`（表现为 WAL 模式下的
`data/hub.db`、`data/hub.db-shm`、`data/hub.db-wal` 被创建/改时间），临时目录反而是空的。
危害不止是脏工作树：同一进程里多个真库测试共享同一个库，表被互相 delete/覆盖，
出现「单跑绿、全量跑红」的假失败。

补充核实（2026-09-25 返工）：`db/index.js` 的运行时路径有 vitest 隔离（`resolveVitestSqlitePath()`
在 `./data` + 无 `DB_URL` 时改写去 `tmpdir()/metapi-vitest-<worker>`），但 `db/migrate.js` 的
`resolveSqliteDbPath()` **没有这层隔离**，直接按 `config.dataDir` 解析。所以任何「静态 import config、
之后才动态 import `db/migrate.js`」的测试都会把迁移打到工作树 `data/hub.db`。
仓库现存实例（至少一处）：`src/server/routes/proxy/chat.siteApiEndpoint.test.ts`（静态 import config +
`beforeAll` 才设 `process.env.DATA_DIR`，随后动态 import `db/migrate.js`）；全量 `npm test`
期间可观察到 `data/hub.db` 的 mtime 被更新。该文件在本次返工范围外，未改动，待后续修复。

## 决策

1. 真库测试统一用 `vi.hoisted` 在**静态 import 被求值之前**设置 `DATA_DIR`，
   并把目录放在 `tmp/` 下、带上 `process.pid` 避免并发冲突：

   ```ts
   const { testDataDir } = vi.hoisted(() => {
     const dir = `tmp/upstream-provider-detect-test-${process.pid}`;
     process.env.DATA_DIR = dir;
     return { testDataDir: dir };
   });
   ```

   之后所有 DB 模块（`db/migrate.js`、`db/index.js`）都通过动态 `import()` 在 `beforeAll` 里加载，
   保证读取到的是测试目录。
2. `afterAll` 关闭 DB 连接、删除 `process.env.DATA_DIR`、`rmSync` 临时目录，
   不给下一次运行留残骸；生产/开发用的 `data/` 一律不读不写。
3. 新增的 parse/gate/collect 纯模块测试不碰 DB，不需要 `DATA_DIR`。
4. 备注：`db/migrate.js` 的 vitest 隔离缺口属于仓库级遗留（本次未改，不在修订单范围）；
   在它修复之前，任何碰迁移的测试都必须自己用 `vi.hoisted` 设 `DATA_DIR`。

## 被放弃的方案（必填）

- **在 `beforeAll` 里设 `DATA_DIR` 后再 import（原写法，已废弃）**：`config` 的静态求值早于
  `beforeAll`，`dataDir` 不会更新；只有把 config 也改成延迟读取环境变量才能救，但那会改动
  全局配置模块，风险远大于测试写法调整。
- **每个测试自己 `new Database(':memory:')` 绕开 config**：真库测试的价值就在走完整迁移 +
  `db/index.js` 的运行时路径；换成内存库会漏掉迁移/方言投影问题，属于降低覆盖换干净，不取。
- **给测试加 `DB_URL=:memory:`**：`db/index.js` 的 sqlite 代理路径与文件库行为存在差异
  （本次要验证的真实迁移链路就基于文件库），仍不取。

## 来源

- `src/server/routes/proxy/upstreamProviderDetect.test.ts`、`src/server/services/upstreamProviderDetect/store.test.ts`
  的 `vi.hoisted` 隔离写法；
- 「Cline 上游探测」返工任务踩坑记录（2026-09-25）。
