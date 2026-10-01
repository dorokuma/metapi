import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SchemaContract } from './schemaContract.js';
import {
  alignMySqlTextDefaultsWithContract,
  introspectLiveSchema,
  materializeFreshSchema,
} from './schemaIntrospection.js';

const dbDir = dirname(fileURLToPath(import.meta.url));
const schemaContractPath = resolve(dbDir, 'generated/schemaContract.json');
const contract = JSON.parse(readFileSync(schemaContractPath, 'utf8')) as SchemaContract;

const skipLiveSchema = process.env.DB_PARITY_SKIP_LIVE_SCHEMA === 'true';
const sqliteParity = !skipLiveSchema && process.env.DB_PARITY_SQLITE !== 'false' ? it : it.skip;
const mysqlParity = process.env.DB_PARITY_MYSQL_URL ? it : it.skip;
const postgresParity = process.env.DB_PARITY_POSTGRES_URL ? it : it.skip;

// MySQL 方言 live 用例在真实容器上串行执行「清库 + bootstrap DDL + information_schema 内省」，
// 常态 1.2–2.3s、耗时全在串行往返回合上，对 runner I/O 与 MySQL 元数据延迟敏感，已在 CI 击穿
// vitest 默认 5000ms（见 .agents/notes/20261001-ci-mysql-live-schema-timeout.md）。
// 只放宽本用例预算；同族其余用例仍用 vitest 默认值。
const MYSQL_LIVE_SCHEMA_TIMEOUT_MS = 30_000;

describe('live schema parity', () => {
  sqliteParity('matches the contract for sqlite', async () => {
    const sqliteUrl = await materializeFreshSchema('sqlite');
    const live = await introspectLiveSchema({ dialect: 'sqlite', connectionString: sqliteUrl });
    expect(live).toEqual(contract);
  });

  mysqlParity(
    'matches the contract for mysql',
    async () => {
      const mysqlUrl = await materializeFreshSchema('mysql', {
        connectionString: process.env.DB_PARITY_MYSQL_URL!,
      });
      const live = await introspectLiveSchema({ dialect: 'mysql', connectionString: mysqlUrl });
      // MySQL/MariaDB 物理 TEXT 列不能携带 DEFAULT（errno 1101），DDL 按方言缺口省略；
      // 比对前从 contract 回填（见 alignMySqlTextDefaultsWithContract）。
      expect(alignMySqlTextDefaultsWithContract(live, contract)).toEqual(contract);
    },
    MYSQL_LIVE_SCHEMA_TIMEOUT_MS,
  );

  postgresParity('matches the contract for postgres', async () => {
    const postgresUrl = await materializeFreshSchema('postgres', {
      connectionString: process.env.DB_PARITY_POSTGRES_URL!,
    });
    const live = await introspectLiveSchema({ dialect: 'postgres', connectionString: postgresUrl });
    expect(live).toEqual(contract);
  });
});
