import baselineContract from './generated/fixtures/2026-03-14-baseline.schemaContract.json' with { type: 'json' };
import currentContract from './generated/schemaContract.json' with { type: 'json' };
import { alignMySqlTextDefaultsWithContract, applyContractFixtureThenUpgrade, introspectLiveSchema } from './schemaIntrospection.js';
import { describe, expect, it } from 'vitest';

const skipLiveSchema = process.env.DB_PARITY_SKIP_LIVE_SCHEMA === 'true';
const sqliteUpgrade = !skipLiveSchema && process.env.DB_PARITY_SQLITE !== 'false' ? it : it.skip;
const mysqlUpgrade = process.env.DB_PARITY_MYSQL_URL ? it : it.skip;
const postgresUpgrade = process.env.DB_PARITY_POSTGRES_URL ? it : it.skip;

// MySQL 方言 live 用例在真实容器上串行执行「清库 + 基线 DDL + 升级 DDL + information_schema 内省」，
// 常态 1.2–2.3s、耗时全在串行往返回合上，对 runner I/O 与 MySQL 元数据延迟敏感，已在 CI 击穿
// vitest 默认 5000ms（见 .agents/notes/20261001-ci-mysql-live-schema-timeout.md）。
// 只放宽本用例预算；同族其余用例仍用 vitest 默认值。
const MYSQL_LIVE_SCHEMA_TIMEOUT_MS = 30_000;

describe('schema upgrade parity', () => {
  sqliteUpgrade('upgrades sqlite to the current contract', async () => {
    const sqliteUrl = await applyContractFixtureThenUpgrade('sqlite', baselineContract, currentContract);
    const live = await introspectLiveSchema({ dialect: 'sqlite', connectionString: sqliteUrl });
    expect(live).toEqual(currentContract);
  });

  mysqlUpgrade(
    'upgrades mysql to the current contract',
    async () => {
      const mysqlUrl = await applyContractFixtureThenUpgrade('mysql', baselineContract, currentContract, {
        connectionString: process.env.DB_PARITY_MYSQL_URL!,
      });
      const live = await introspectLiveSchema({ dialect: 'mysql', connectionString: mysqlUrl });
      // MySQL/MariaDB 物理 TEXT 列不能携带 DEFAULT（errno 1101）：比对前从 contract 回填
      // 该类列的默认值（见 alignMySqlTextDefaultsWithContract），其余字段照常校验。
      expect(alignMySqlTextDefaultsWithContract(live, currentContract)).toEqual(currentContract);
    },
    MYSQL_LIVE_SCHEMA_TIMEOUT_MS,
  );

  postgresUpgrade('upgrades postgres to the current contract', async () => {
    const postgresUrl = await applyContractFixtureThenUpgrade('postgres', baselineContract, currentContract, {
      connectionString: process.env.DB_PARITY_POSTGRES_URL!,
    });
    const live = await introspectLiveSchema({ dialect: 'postgres', connectionString: postgresUrl });
    expect(live).toEqual(currentContract);
  });
});
