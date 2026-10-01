import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRepoDriftReport, runRepoDriftCheck } from './repo-drift-check.js';

function writeWorkspaceFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }
}

// The rule needle is hardcoded in the script, so read the live value out of the
// single-source definition file instead of duplicating the literal here: if the
// definition is renamed and the needle goes stale, the linkage test below fails.
function readTitleFromDefinitionFile(): string {
  const source = readFileSync(join(process.cwd(), 'src/server/shared/eventTitles.ts'), 'utf8');
  const match = source.match(/RETRY_EXHAUSTED_EVENT_TITLE\s*=\s*'([^']*)'/);
  if (!match) {
    throw new Error('could not extract RETRY_EXHAUSTED_EVENT_TITLE from src/server/shared/eventTitles.ts');
  }
  return match[1];
}

describe('repo drift check', () => {
  it('separates new violations from tracked debt', () => {
    const root = mkdtempSync(join(tmpdir(), 'metapi-repo-drift-'));
    writeWorkspaceFiles(root, {
      'src/server/transformers/openai/responses/routeCompatibility.ts': "import type { EndpointAttemptContext } from '../../../routes/proxy/endpointFlow.js';\n",
      'src/server/proxy-core/surfaces/chatSurface.ts': 'const payload = await upstream.text();\n',
      'src/server/proxy-core/surfaces/sharedSurface.ts': "import { dispatchRuntimeRequest } from '../../routes/proxy/runtimeExecutor.js';\n",
      'src/web/pages/Accounts.tsx': "import { TokensPanel } from './Tokens.js';\n",
      'src/web/pages/Tokens.tsx': 'export const TokensPanel = () => null;\n',
    });

    const report = runRepoDriftCheck({ root });

    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'proxy-surface-body-read',
        file: 'src/server/proxy-core/surfaces/chatSurface.ts',
      }),
      expect.objectContaining({
        ruleId: 'transformers-route-blind',
        file: 'src/server/transformers/openai/responses/routeCompatibility.ts',
      }),
    ]));
    expect(report.trackedDebt).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'proxy-core-routes-proxy-import',
        file: 'src/server/proxy-core/surfaces/sharedSurface.ts',
      }),
      expect.objectContaining({
        ruleId: 'web-page-to-page-import',
        file: 'src/web/pages/Accounts.tsx',
      }),
    ]));
  });

  it('flags inline copies of the reserved retry-title literal in non-test source', () => {
    const root = mkdtempSync(join(tmpdir(), 'metapi-repo-drift-title-'));
    writeWorkspaceFiles(root, {
      'src/server/example/inlineTitle.ts': "export const title = '代理重试耗尽';\n",
    });

    const report = runRepoDriftCheck({ root });

    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'event-title-single-source',
        file: 'src/server/example/inlineTitle.ts',
        line: 1,
      }),
    ]));
  });

  it('exempts the single-source definition file and test files', () => {
    const root = mkdtempSync(join(tmpdir(), 'metapi-repo-drift-title-exempt-'));
    writeWorkspaceFiles(root, {
      // `src/server/shared/eventTitles.ts` is the single legal origin of the literal.
      'src/server/shared/eventTitles.ts': "export const RETRY_EXHAUSTED_EVENT_TITLE = '代理重试耗尽';\n",
      // Test files are exempt from the rule (isNonTestSource), so fixtures may embed the literal.
      'src/server/example/inlineTitle.test.ts': "export const title = '代理重试耗尽';\n",
    });

    const report = runRepoDriftCheck({ root });

    expect(report.violations.filter((finding) => finding.ruleId === 'event-title-single-source')).toEqual([]);
  });

  it('keeps the rule needle in sync with the single-source definition file', () => {
    const title = readTitleFromDefinitionFile();
    const root = mkdtempSync(join(tmpdir(), 'metapi-repo-drift-title-linkage-'));
    writeWorkspaceFiles(root, {
      'src/server/example/linkedTitle.ts': `export const title = '${title}';\n`,
    });

    const report = runRepoDriftCheck({ root });

    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'event-title-single-source',
        file: 'src/server/example/linkedTitle.ts',
        line: 1,
      }),
    ]));
  });

  it('exempts whole-line comments, same-line block comments and trailing line comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'metapi-repo-drift-title-comments-'));
    writeWorkspaceFiles(root, {
      // Whole-line comment: documentation quotes the title (SQL discriminators, JSDoc).
      'src/server/example/wholeLineComment.ts': "// SELECT * FROM events WHERE title = '代理重试耗尽'\nexport const ok = 1;\n",
      // Same-line /* ... */ span.
      'src/server/example/inlineBlockComment.ts': 'export const ok = 1; /* 代理重试耗尽 */\n',
      // Trailing line comment after real code.
      'src/server/example/trailingLineComment.ts': "export const ok = 1; // 代理重试耗尽\n",
      // JSDoc continuation line: the `*`-prefixed start path of isCommentOnlyLine.
      'src/server/example/jsdocStarLine.ts': '/**\n * 代理重试耗尽\n */\nexport const ok = 1;\n',
    });

    const report = runRepoDriftCheck({ root });

    expect(report.violations.filter((finding) => finding.ruleId === 'event-title-single-source')).toEqual([]);
  });

  it('still flags a block-comment continuation line without a star prefix (documented false positive)', () => {
    // Accepted trade-off, not a bug: a per-line API cannot track block-comment
    // state, so a continuation line that does not start with `*` is treated as
    // code. The rule description states this loud false positive.
    const root = mkdtempSync(join(tmpdir(), 'metapi-repo-drift-title-block-cont-'));
    writeWorkspaceFiles(root, {
      'src/server/example/blockCommentContinuation.ts': '/*\n代理重试耗尽\n*/\nexport const ok = 1;\n',
    });

    const report = runRepoDriftCheck({ root });

    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'event-title-single-source',
        file: 'src/server/example/blockCommentContinuation.ts',
        line: 2,
      }),
    ]));
  });

  it('keeps the current repository within the first-wave ratchet', () => {
    const report = runRepoDriftCheck({ root: process.cwd() });
    expect(report.violations).toEqual([]);
    expect(report.trackedDebt).toEqual(expect.any(Array));
  });

  it('can render markdown reports for scheduled cleanup jobs', () => {
    const report = runRepoDriftCheck({ root: process.cwd() });
    const markdown = formatRepoDriftReport(report, 'markdown');

    expect(markdown).toContain('# Repo Drift Report');
    expect(markdown).toContain('## Violations');
    expect(markdown).toContain('## Tracked Debt');
  });
});
