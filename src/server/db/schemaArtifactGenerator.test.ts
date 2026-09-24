import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateDialectArtifacts, generateUpgradeSql, type GeneratedDialectArtifacts } from './schemaArtifactGenerator.js';
import type { SchemaContract, SchemaContractColumn } from './schemaContract.js';

const dbDir = dirname(fileURLToPath(import.meta.url));
const schemaContractPath = resolve(dbDir, 'generated/schemaContract.json');

function readSchemaContract(): SchemaContract {
  return JSON.parse(readFileSync(schemaContractPath, 'utf8')) as SchemaContract;
}

function makeColumn(overrides: Partial<SchemaContractColumn> = {}): SchemaContractColumn {
  return {
    logicalType: 'text',
    notNull: false,
    defaultValue: null,
    primaryKey: false,
    ...overrides,
  };
}

describe('schema artifact generator', () => {
  it('generates bootstrap sql for mysql and postgres from the contract', () => {
    const artifacts = generateDialectArtifacts(readSchemaContract());

    expect(artifacts.mysqlBootstrap).toContain('CREATE TABLE IF NOT EXISTS `sites`');
    expect(artifacts.mysqlBootstrap).toContain('CREATE TABLE IF NOT EXISTS `site_disabled_models`');
    expect(artifacts.postgresBootstrap).toContain('CREATE TABLE IF NOT EXISTS "account_tokens"');
    expect(artifacts.mysqlBootstrap).toContain('`snapshot_key` TEXT NOT NULL');
    expect(artifacts.postgresBootstrap).toContain('"snapshot_key" TEXT NOT NULL');
    expect(artifacts.postgresBootstrap).toContain('"token_group"');
  });

  it('generates additive upgrade sql for newly added tables, columns, indexes, and uniques', () => {
    const previousContract: SchemaContract = {
      tables: {
        sites: {
          columns: {
            id: makeColumn({ logicalType: 'integer', notNull: true, primaryKey: true }),
          },
        },
      },
      indexes: [],
      uniques: [],
      foreignKeys: [],
    };
    const currentContract: SchemaContract = {
      tables: {
        sites: {
          columns: {
            id: makeColumn({ logicalType: 'integer', notNull: true, primaryKey: true }),
            status: makeColumn({ notNull: true, defaultValue: "'active'" }),
          },
        },
        accounts: {
          columns: {
            id: makeColumn({ logicalType: 'integer', notNull: true, primaryKey: true }),
            site_id: makeColumn({ logicalType: 'integer', notNull: true }),
            email: makeColumn({ notNull: true }),
          },
        },
      },
      indexes: [
        { name: 'sites_status_idx', table: 'sites', columns: ['status'], unique: false },
      ],
      uniques: [
        { name: 'accounts_site_email_unique', table: 'accounts', columns: ['site_id', 'email'] },
      ],
      foreignKeys: [
        {
          table: 'accounts',
          columns: ['site_id'],
          referencedTable: 'sites',
          referencedColumns: ['id'],
          onDelete: 'cascade',
        },
      ],
    };

    const artifacts: GeneratedDialectArtifacts = generateDialectArtifacts(currentContract, previousContract);

    expect(artifacts.mysqlUpgrade).toContain('CREATE TABLE IF NOT EXISTS `accounts`');
    expect(artifacts.mysqlUpgrade).toContain('ALTER TABLE `sites` ADD COLUMN `status`');
    expect(artifacts.mysqlUpgrade).toContain('CREATE INDEX `sites_status_idx` ON `sites`');
    expect(artifacts.mysqlUpgrade).toContain('CREATE UNIQUE INDEX `accounts_site_email_unique` ON `accounts`');
    expect(artifacts.postgresUpgrade).toContain('CREATE TABLE IF NOT EXISTS "accounts"');
    expect(artifacts.postgresUpgrade).toContain('ALTER TABLE "sites" ADD COLUMN "status"');
    expect(artifacts.postgresUpgrade).toContain('CREATE INDEX "sites_status_idx" ON "sites"');
    expect(artifacts.postgresUpgrade).toContain('CREATE UNIQUE INDEX "accounts_site_email_unique" ON "accounts"');
  });

  it('orders dependent tables safely and emits executable datetime defaults for external dialects', () => {
    const artifacts = generateDialectArtifacts(readSchemaContract());

    expect(
      artifacts.mysqlBootstrap.indexOf('CREATE TABLE IF NOT EXISTS `accounts`'),
    ).toBeLessThan(
      artifacts.mysqlBootstrap.indexOf('CREATE TABLE IF NOT EXISTS `account_tokens`'),
    );
    expect(
      artifacts.postgresBootstrap.indexOf('CREATE TABLE IF NOT EXISTS "accounts"'),
    ).toBeLessThan(
      artifacts.postgresBootstrap.indexOf('CREATE TABLE IF NOT EXISTS "account_tokens"'),
    );
    expect(artifacts.mysqlBootstrap).toContain("`created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))");
    expect(artifacts.postgresBootstrap).toContain(`"created_at" TEXT DEFAULT to_char(timezone('UTC', CURRENT_TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS')`);
  });

  it('uses varchar for mysql text primary keys so bootstrap ddl stays executable', () => {
    const artifacts = generateDialectArtifacts(readSchemaContract());

    expect(artifacts.mysqlBootstrap).toContain('CREATE TABLE IF NOT EXISTS `settings` (`key` VARCHAR(191) NOT NULL PRIMARY KEY, `value` TEXT)');
    expect(artifacts.mysqlBootstrap).not.toContain('CREATE TABLE IF NOT EXISTS `settings` (`key` TEXT NOT NULL PRIMARY KEY, `value` TEXT)');
  });

  it('does not add mysql text prefixes to non-text index columns', () => {
    const artifacts = generateDialectArtifacts(readSchemaContract());

    expect(artifacts.mysqlBootstrap).toContain('CREATE INDEX `checkin_logs_account_created_at_idx` ON `checkin_logs` (`account_id`, `created_at`)');
    expect(artifacts.mysqlBootstrap).toContain('CREATE INDEX `events_read_created_at_idx` ON `events` (`read`, `created_at`)');
    expect(artifacts.mysqlBootstrap).not.toContain('`created_at`(191)');
    expect(artifacts.mysqlBootstrap).not.toContain('`read`(191)');
  });

  it('allows mysql upgrade generation to force prefix lengths for live text-backed columns', () => {
    const previousContract: SchemaContract = {
      tables: {
        proxy_logs: {
          columns: {
            downstream_api_key_id: makeColumn({ logicalType: 'integer' }),
            created_at: makeColumn({ logicalType: 'datetime', defaultValue: "datetime('now')" }),
          },
        },
      },
      indexes: [],
      uniques: [],
      foreignKeys: [],
    };
    const currentContract: SchemaContract = {
      ...previousContract,
      indexes: [
        {
          name: 'proxy_logs_downstream_api_key_created_at_idx',
          table: 'proxy_logs',
          columns: ['downstream_api_key_id', 'created_at'],
          unique: false,
        },
      ],
    };

    const mysqlUpgrade = generateUpgradeSql('mysql', currentContract, previousContract, {
      mysqlIndexPrefixRequirements: {
        proxy_logs: {
          created_at: true,
        },
      },
    });

    expect(mysqlUpgrade).toContain(
      'CREATE INDEX `proxy_logs_downstream_api_key_created_at_idx` ON `proxy_logs` (`downstream_api_key_id`, `created_at`(191))',
    );
  });

  it('emits a single table-level primary key clause for composite primary keys', () => {
    const contract: SchemaContract = {
      tables: {
        notification_templates: {
          columns: {
            event_type: makeColumn({ notNull: true, primaryKey: true }),
            channel: makeColumn({ notNull: true, primaryKey: true }),
            body: makeColumn({ notNull: true, defaultValue: "''" }),
          },
        },
        settings: {
          columns: {
            key: makeColumn({ notNull: true, primaryKey: true }),
            value: makeColumn(),
          },
        },
      },
      indexes: [],
      uniques: [],
      foreignKeys: [],
    };

    const artifacts = generateDialectArtifacts(contract);

    expect(artifacts.mysqlBootstrap).toContain(
      'CREATE TABLE IF NOT EXISTS `notification_templates` (`event_type` VARCHAR(191) NOT NULL, `channel` VARCHAR(191) NOT NULL, `body` TEXT NOT NULL DEFAULT \'\', PRIMARY KEY (`event_type`, `channel`))',
    );
    expect(artifacts.postgresBootstrap).toContain(
      'CREATE TABLE IF NOT EXISTS "notification_templates" ("event_type" TEXT NOT NULL, "channel" TEXT NOT NULL, "body" TEXT NOT NULL DEFAULT \'\', PRIMARY KEY ("event_type", "channel"))',
    );
    // 复合主键不能逐列内联，否则会生成 "more than one primary key" 的非法 SQL
    expect(artifacts.mysqlBootstrap).not.toContain('`event_type` VARCHAR(191) NOT NULL PRIMARY KEY');
    // 单列主键保持内联不变
    expect(artifacts.mysqlBootstrap).toContain('CREATE TABLE IF NOT EXISTS `settings` (`key` VARCHAR(191) NOT NULL PRIMARY KEY, `value` TEXT)');
  });

  it('keeps long-text marked notification template columns as TEXT in mysql', () => {
    const artifacts = generateDialectArtifacts(readSchemaContract());

    // 模板正文上限 4000 字：notification_templates.title/body/parse_mode 有显式长文本
    // 标记，绝不能因为 DEFAULT '' 被映射成 VARCHAR(191) 而截断
    expect(artifacts.mysqlBootstrap).toContain('`title` TEXT NOT NULL DEFAULT \'\'');
    expect(artifacts.mysqlBootstrap).toContain('`body` TEXT NOT NULL DEFAULT \'\'');
    expect(artifacts.mysqlBootstrap).toContain('`parse_mode` TEXT NOT NULL DEFAULT \'\'');
    expect(artifacts.mysqlBootstrap).not.toContain('`body` VARCHAR(191)');
    expect(artifacts.mysqlBootstrap).not.toContain('`title` VARCHAR(191)');
    // postgres 侧 text 列本来就是 TEXT，不受标记影响
    expect(artifacts.postgresBootstrap).toContain('"body" TEXT NOT NULL DEFAULT \'\'');
    // 文本列若有长度上限依据（如 datetime 的 VARCHAR(191)）保持原样
    expect(artifacts.mysqlBootstrap).toContain("`created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))");
  });

  it('maps non-primary-key text columns with defaults to varchar(191) without a long-text marker', () => {
    const contract: SchemaContract = {
      tables: {
        sites: {
          columns: {
            // 既有表的枚举类文本列（无长文本标记）：带默认值仍是 VARCHAR(191)
            status: makeColumn({ notNull: true, defaultValue: "'active'" }),
            post_refresh_probe_model: makeColumn({ defaultValue: "''" }),
            // 无默认值、非主键的文本列仍是 TEXT
            url: makeColumn({ notNull: true }),
          },
        },
        notification_templates: {
          columns: {
            // 同类列一旦带长文本标记就必须保持 TEXT
            body: makeColumn({ notNull: true, defaultValue: "''" }),
          },
        },
      },
      indexes: [],
      uniques: [],
      foreignKeys: [],
    };

    const artifacts = generateDialectArtifacts(contract);

    expect(artifacts.mysqlBootstrap).toContain('`status` VARCHAR(191) NOT NULL DEFAULT \'active\'');
    expect(artifacts.mysqlBootstrap).toContain('`post_refresh_probe_model` VARCHAR(191) DEFAULT \'\'');
    expect(artifacts.mysqlBootstrap).toContain('`url` TEXT NOT NULL');
    expect(artifacts.mysqlBootstrap).toContain('`body` TEXT NOT NULL DEFAULT \'\'');
  });

  it('keeps existing tables mysql bootstrap column types byte-compatible (varchar(191) with defaults)', () => {
    const artifacts = generateDialectArtifacts(readSchemaContract());

    // 既有带默认值的 text 列必须保持 VARCHAR(191)，不得被长文本改动波及
    expect(artifacts.mysqlBootstrap).toContain("`status` VARCHAR(191) NOT NULL DEFAULT 'active'");
    expect(artifacts.mysqlBootstrap).toContain("`status` VARCHAR(191) DEFAULT 'active'");
    expect(artifacts.mysqlBootstrap).toContain("`source` VARCHAR(191) DEFAULT 'manual'");
    expect(artifacts.mysqlBootstrap).toContain("`value_status` VARCHAR(191) NOT NULL DEFAULT 'ready'");
    expect(artifacts.mysqlBootstrap).toContain("`level` VARCHAR(191) NOT NULL DEFAULT 'info'");
    expect(artifacts.mysqlBootstrap).toContain("`routing_strategy` VARCHAR(191) DEFAULT 'weighted'");
    expect(artifacts.mysqlBootstrap).toContain("`route_mode` VARCHAR(191) DEFAULT 'pattern'");
    expect(artifacts.mysqlBootstrap).toContain("`strategy` VARCHAR(191) NOT NULL DEFAULT 'round_robin'");
    expect(artifacts.mysqlBootstrap).toContain("`time_zone` VARCHAR(191) NOT NULL DEFAULT 'Local'");
    expect(artifacts.mysqlBootstrap).toContain("`post_refresh_probe_scope` VARCHAR(191) DEFAULT 'single'");
  });

  it('rejects destructive diffs when generating additive upgrades', () => {
    const current = readSchemaContract();
    const previous = structuredClone(current);

    delete current.tables.sites.columns.status;

    expect(() => generateDialectArtifacts(current, previous)).toThrow(/non-additive schema diff/i);
  });
});
