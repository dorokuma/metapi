import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { migrateCurrentDatabase } from './databaseMigrationService.js';

/**
 * 三方言序列矩阵（切片 14 完成条件，live-gated）。
 *
 * 守护对象：`migrateCurrentDatabase` 迁移链「写入 ⇒ 序列同步 ⇒ 新建」在
 * sqlite / mysql / postgres × {空表, 仅哨兵 id=-1, 仅 id=0} 三情形下，
 * 随后新建站点必须得到 `id >= 1`（不产生 id=0 不可见站点）。
 *
 * 口径来源：
 * - /tmp/plan-token-stats-v19.md §12.8 第 8 条（setval 完成条件）与 §16.2 R2（三方言序列矩阵）。
 * - .agents/notes/20260927-token-usage-spec-recovered.md §10.3 / §11.7。
 *
 * 实现路径：真实运行 `migrateCurrentDatabase`（非 mock）。它从当前运行库快照源数据，
 * 写入目标库并触发 `syncPostgresSequences`（sites 分支 GREATEST 公式），随后直连目标库
 * 新建站点取回生成 id。源数据通过 `switchRuntimeDatabase('sqlite', <fresh file>)` 隔离构造。
 *
 * **禁止断言三方言首 id 都是 1**（U9）：
 * - postgres 空表/仅哨兵/仅 id=0 时 `setval(..., GREATEST(COALESCE(MAX(id) WHERE id>0,0),1), TRUE)`
 *   把序列钳到 last_value=1, is_called=true，下一 nextval = **2**；
 * - sqlite/mysql 空表首插 = **1**（sqlite AUTOINCREMENT 候选 max(rowid,seq)+1；mysql AUTO_INCREMENT 起 1）。
 * 故核心断言统一为 `id >= 1`，不钉死 `=== 1`。
 *
 * 门控：mysql 用 `DB_PARITY_MYSQL_URL`、postgres 用 `DB_PARITY_POSTGRES_URL`（缺则 it.skip，
 * 开关与 usageAggregationService.live.test.ts 一致）；sqlite 本地实跑、无门控。
 *
 * 归属 CI job：
 * - sqlite 部分：test-core（主测试 job，`npm test` = `vitest run --root .`，无门控随主 job 执行）。
 * - mysql 部分：schema-mysql job（ci.yml，env `DB_PARITY_MYSQL_URL` 定义于 job 层），
 *   由 `npm run test:live:site-sequences` 步骤执行。
 * - postgres 部分：schema-postgres job（ci.yml，env `DB_PARITY_POSTGRES_URL` 定义于 job 层），
 *   由 `npm run test:live:site-sequences` 步骤执行。
 *
 * 清理：每个用例的源/目标 sqlite 文件落在一次性 tmpdir，afterAll 统一删除；
 * mysql/postgres 目标用例结束后删除校验站点行；afterAll 切回 sqlite 并关净连接。不启 scheduler。
 */

type Scenario = 'empty' | 'sentinel-only' | 'id-zero-only';
type TargetDialect = 'sqlite' | 'mysql' | 'postgres';

const mysqlLive = process.env.DB_PARITY_MYSQL_URL ? it : it.skip;
const postgresLive = process.env.DB_PARITY_POSTGRES_URL ? it : it.skip;

describe('databaseMigrationService sequence matrix (slice 14)', () => {
  let originalDbUrl: string;
  let originalDbSsl: boolean;
  let workDir = '';
  let pathCounter = 0;

  beforeAll(async () => {
    originalDbUrl = config.dbType === 'sqlite' ? '' : config.dbUrl;
    originalDbSsl = config.dbSsl;
    workDir = mkdtempSync(join(tmpdir(), 'metapi-seq-matrix-'));
  });

  afterAll(async () => {
    const { switchRuntimeDatabase, closeDbConnections } = await import('../db/index.js');
    await switchRuntimeDatabase('sqlite', originalDbUrl, originalDbSsl);
    await closeDbConnections();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  function nextPath(name: string): string {
    pathCounter += 1;
    return join(workDir, `${name}-${pathCounter}`);
  }

  /** 把运行库切到一个全新 sqlite 源文件，并按场景写入源数据（空表 / 仅哨兵 / 仅 id=0）。 */
  async function setupSource(scenario: Scenario): Promise<void> {
    const { switchRuntimeDatabase, db, schema } = await import('../db/index.js');
    const sourcePath = nextPath(`src-${scenario}`);
    await switchRuntimeDatabase('sqlite', sourcePath);
    // 既有缺陷规避：drizzle 迁移 journal 缺 0005（proxy_logs.billing_details），
    // 导致 switchRuntimeDatabase 建的源库缺该列，而 toBackupSnapshot 按当前 schema 查询会引用它。
    // 手动补列以匹配当前 schema（幂等：已存在则忽略 duplicate column）。
    const { default: Database } = await import('better-sqlite3');
    const sqlite = new Database(sourcePath);
    try {
      sqlite.exec('ALTER TABLE proxy_logs ADD COLUMN billing_details text');
    } catch (error) {
      if (!String((error as { message?: unknown })?.message ?? '').includes('duplicate column')) {
        throw error;
      }
    } finally {
      sqlite.close();
    }
    if (scenario === 'sentinel-only') {
      // F12 哨兵：显式 id=-1。
      await db
        .insert(schema.sites)
        .values({ id: -1, name: 'sentinel', url: 'null', platform: 'reserved-unattributed' })
        .run();
    } else if (scenario === 'id-zero-only') {
      // F2b 历史脏数据：显式 id=0。
      await db
        .insert(schema.sites)
        .values({ id: 0, name: 'dirty-zero', url: 'https://dirty-zero.example', platform: 'custom' })
        .run();
    }
  }

  /** 直连目标库新建一个站点（走默认 id），返回生成的 id。 */
  async function insertNewSiteOnTarget(dialect: TargetDialect, targetUrl: string): Promise<number> {
    if (dialect === 'sqlite') {
      const { default: Database } = await import('better-sqlite3');
      const sqlite = new Database(targetUrl);
      try {
        const result = sqlite
          .prepare('INSERT INTO sites (name, url, platform) VALUES (?, ?, ?)')
          .run('verify-site', 'https://verify.example', 'custom');
        return Number(result.lastInsertRowid);
      } finally {
        sqlite.close();
      }
    }

    if (dialect === 'mysql') {
      const mysql = await import('mysql2/promise');
      const connection = await mysql.createConnection({ uri: targetUrl });
      try {
        const [result] = await connection.query(
          'INSERT INTO sites (name, url, platform) VALUES (?, ?, ?)',
          ['verify-site', 'https://verify.example', 'custom'],
        );
        return Number((result as { insertId?: number }).insertId);
      } finally {
        await connection.end();
      }
    }

    const pg = await import('pg');
    const client = new pg.Client({ connectionString: targetUrl });
    await client.connect();
    try {
      const result = await client.query(
        'INSERT INTO sites (name, url, platform) VALUES ($1, $2, $3) RETURNING id',
        ['verify-site', 'https://verify.example', 'custom'],
      );
      return Number((result.rows[0] as { id: number }).id);
    } finally {
      await client.end();
    }
  }

  /** 删除目标库上的校验站点行（仅 mysql/postgres；sqlite 目标走整文件删除）。 */
  async function deleteSiteOnTarget(dialect: TargetDialect, targetUrl: string, siteId: number): Promise<void> {
    if (dialect === 'mysql') {
      const mysql = await import('mysql2/promise');
      const connection = await mysql.createConnection({ uri: targetUrl });
      try {
        await connection.execute('DELETE FROM sites WHERE id = ?', [siteId]);
      } finally {
        await connection.end();
      }
      return;
    }

    if (dialect === 'postgres') {
      const pg = await import('pg');
      const client = new pg.Client({ connectionString: targetUrl });
      await client.connect();
      try {
        await client.query('DELETE FROM sites WHERE id = $1', [siteId]);
      } finally {
        await client.end();
      }
    }
  }

  /** 迁移（setval）后、新建前，断言 postgres sites 序列已同步：last_value>=1 且 is_called=true。 */
  async function verifyPostgresSequenceSynced(targetUrl: string): Promise<void> {
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: targetUrl });
    await client.connect();
    try {
      const result = await client.query('SELECT last_value, is_called FROM sites_id_seq');
      const row = result.rows[0] as { last_value: number; is_called: boolean };
      expect(row.last_value).toBeGreaterThanOrEqual(1);
      expect(row.is_called).toBe(true);
    } finally {
      await client.end();
    }
  }

  /**
   * 跑一条「写入 ⇒ 序列同步 ⇒ 新建」真实链：
   * 构造源 → migrateCurrentDatabase（触发 setval）→ [pg 校验序列] → 新建站点 → 断言 id>=1 → 清理校验行。
   */
  async function runSequenceMatrixCase(dialect: TargetDialect, targetUrl: string, scenario: Scenario): Promise<void> {
    await setupSource(scenario);
    await migrateCurrentDatabase({ dialect, connectionString: targetUrl, overwrite: true });

    if (dialect === 'postgres') {
      await verifyPostgresSequenceSynced(targetUrl);
    }

    const newSiteId = await insertNewSiteOnTarget(dialect, targetUrl);
    // 核心断言：随后新建站点 id >= 1（不产生 id=0 不可见站）。
    // 故意不断言 === 1：pg setval(1, TRUE) 后 nextval=2；sqlite/mysql 空表首插=1。
    expect(newSiteId).toBeGreaterThanOrEqual(1);

    if (dialect !== 'sqlite') {
      await deleteSiteOnTarget(dialect, targetUrl, newSiteId);
    }
  }

  // ---- sqlite：本地实跑（ungated），补「空表 / 仅 id=0 / 迁移后」链路 ----
  it('sqlite empty table: post-migration new site id >= 1', async () => {
    await runSequenceMatrixCase('sqlite', nextPath('target-sqlite-empty'), 'empty');
  });

  it('sqlite sentinel-only: post-migration new site id >= 1', async () => {
    await runSequenceMatrixCase('sqlite', nextPath('target-sqlite-sentinel'), 'sentinel-only');
  });

  it('sqlite id=0-only: post-migration new site id >= 1, no id=0 new site', async () => {
    await runSequenceMatrixCase('sqlite', nextPath('target-sqlite-zero'), 'id-zero-only');
  });

  // ---- mysql：live-gated（DB_PARITY_MYSQL_URL）----
  mysqlLive('mysql empty table: post-migration new site id >= 1', async () => {
    await runSequenceMatrixCase('mysql', process.env.DB_PARITY_MYSQL_URL!, 'empty');
  });

  mysqlLive('mysql sentinel-only: post-migration new site id >= 1', async () => {
    await runSequenceMatrixCase('mysql', process.env.DB_PARITY_MYSQL_URL!, 'sentinel-only');
  });

  mysqlLive('mysql id=0-only: post-migration new site id >= 1, no id=0 new site', async () => {
    await runSequenceMatrixCase('mysql', process.env.DB_PARITY_MYSQL_URL!, 'id-zero-only');
  });

  // ---- postgres：live-gated（DB_PARITY_POSTGRES_URL）----
  postgresLive('postgres empty table: post-migration new site id >= 1, sequence synced', async () => {
    await runSequenceMatrixCase('postgres', process.env.DB_PARITY_POSTGRES_URL!, 'empty');
  });

  postgresLive('postgres sentinel-only: post-migration new site id >= 1, sequence synced', async () => {
    await runSequenceMatrixCase('postgres', process.env.DB_PARITY_POSTGRES_URL!, 'sentinel-only');
  });

  postgresLive('postgres id=0-only: post-migration new site id >= 1, no id=0 new site, sequence synced', async () => {
    await runSequenceMatrixCase('postgres', process.env.DB_PARITY_POSTGRES_URL!, 'id-zero-only');
  });
});
