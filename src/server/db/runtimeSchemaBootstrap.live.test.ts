import baselineContract from './generated/fixtures/2026-03-14-baseline.schemaContract.json' with { type: 'json' };
import currentContract from './generated/schemaContract.json' with { type: 'json' };
import mysql from 'mysql2/promise';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { generateBootstrapSql } from './schemaArtifactGenerator.js';
import { alignMySqlTextDefaultsWithContract, __schemaIntrospectionTestUtils, introspectLiveSchema } from './schemaIntrospection.js';
import { bootstrapRuntimeDatabaseSchema } from './runtimeSchemaBootstrap.js';

const mysqlRuntime = process.env.DB_PARITY_MYSQL_URL ? it : it.skip;
const postgresRuntime = process.env.DB_PARITY_POSTGRES_URL ? it : it.skip;

// MySQL 方言 live 用例在真实容器上串行执行「清库 + 基线 DDL + runtime bootstrap + information_schema 内省」，
// 常态 1.2–2.3s、耗时全在串行往返回合上，对 runner I/O 与 MySQL 元数据延迟敏感：本用例与同族
// parity / upgrade 用例都曾在 CI 被 vitest 默认 5000ms 预算击穿（本用例 2026-09-28 run 36387260031，
// 5009ms → Test timed out in 5000ms；明细见 .agents/notes/20261001-ci-mysql-live-schema-timeout.md）。
// 只放宽本用例预算；同族其余用例仍用 vitest 默认值。
const MYSQL_LIVE_SCHEMA_TIMEOUT_MS = 30_000;

async function resetMySqlSchema(connectionString: string): Promise<void> {
  const connection = await mysql.createConnection({ uri: connectionString });
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    const [rows] = await connection.query(`
      SELECT table_name AS table_name
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_type = 'BASE TABLE'
    `);
    for (const row of rows as Array<Record<string, unknown>>) {
      const tableName = String(row.table_name || '');
      if (!tableName) continue;
      await connection.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await connection.end();
  }
}

async function applyMySqlStatements(connectionString: string, statements: string[]): Promise<void> {
  const connection = await mysql.createConnection({ uri: connectionString });
  try {
    for (const statement of statements) {
      await connection.query(statement);
    }
  } finally {
    await connection.end();
  }
}

async function resetPostgresSchema(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = current_schema()
      ORDER BY tablename ASC
    `);
    for (const row of result.rows as Array<{ tablename: string }>) {
      await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

async function applyPostgresStatements(connectionString: string, statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
}

describe('runtime schema bootstrap live upgrade path', () => {
  mysqlRuntime(
    'upgrades mysql runtime schemas from an older live contract',
    async () => {
      const connectionString = process.env.DB_PARITY_MYSQL_URL!;
      const baselineStatements = __schemaIntrospectionTestUtils.splitSqlStatements(
        generateBootstrapSql('mysql', baselineContract),
      );

      await resetMySqlSchema(connectionString);
      await applyMySqlStatements(connectionString, baselineStatements);

      await bootstrapRuntimeDatabaseSchema({
        dialect: 'mysql',
        connectionString,
      });

      const live = await introspectLiveSchema({ dialect: 'mysql', connectionString });
      // MySQL/MariaDB 物理 TEXT 列不能携带 DEFAULT（errno 1101）：比对前从 contract 回填
      // 该类列的默认值（见 alignMySqlTextDefaultsWithContract），其余字段照常校验。
      expect(alignMySqlTextDefaultsWithContract(live, currentContract)).toEqual(currentContract);
    },
    MYSQL_LIVE_SCHEMA_TIMEOUT_MS,
  );

  postgresRuntime('upgrades postgres runtime schemas from an older live contract', async () => {
    const connectionString = process.env.DB_PARITY_POSTGRES_URL!;
    const baselineStatements = __schemaIntrospectionTestUtils.splitSqlStatements(
      generateBootstrapSql('postgres', baselineContract),
    );

    await resetPostgresSchema(connectionString);
    await applyPostgresStatements(connectionString, baselineStatements);

    await bootstrapRuntimeDatabaseSchema({
      dialect: 'postgres',
      connectionString,
    });

    const live = await introspectLiveSchema({ dialect: 'postgres', connectionString });
    expect(live).toEqual(currentContract);
  });
});
