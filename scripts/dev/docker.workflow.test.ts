import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('docker workflows', () => {
  it('publishes armv7 docker images in ci and release workflows', () => {
    const ciWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(ciWorkflow).toContain('arch: armv7');
    expect(ciWorkflow).toContain('platform: linux/arm/v7');
    expect(ciWorkflow).toContain('"${tag}-armv7"');

    expect(releaseWorkflow).toContain('arch: armv7');
    expect(releaseWorkflow).toContain('platform: linux/arm/v7');
    expect(releaseWorkflow).toContain('"${tag}-armv7"');
  });

  it('derives Docker Hub image names from the configured username secret', () => {
    const ciWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(ciWorkflow).toContain('DOCKERHUB_IMAGE: ${{ secrets.DOCKERHUB_USERNAME }}/metapi');
    expect(ciWorkflow).not.toContain('images: 1467078763/metapi');

    expect(releaseWorkflow).toContain('DOCKERHUB_IMAGE: ${{ secrets.DOCKERHUB_USERNAME }}/metapi');
    expect(releaseWorkflow).not.toContain('1467078763/metapi');
  });

  it('uses an armv7-capable node base image in the Dockerfile', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'docker/Dockerfile'), 'utf8');

    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS builder');
    expect(dockerfile).toContain('FROM node:22-bookworm-slim');
  });

  it('avoids buildkit-only frontend syntax so managed docker builders can parse it reliably', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'docker/Dockerfile'), 'utf8');

    expect(dockerfile).not.toContain('# syntax=docker/dockerfile:');
    expect(dockerfile).not.toContain('RUN --mount=type=cache');
  });

  it('keeps server docker builds isolated from desktop packaging dependencies', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'docker/Dockerfile'), 'utf8');

    expect(dockerfile).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(dockerfile).toContain('npm rebuild esbuild sharp better-sqlite3 --no-audit --no-fund');
    expect(dockerfile).not.toContain('npm ci --no-audit --no-fund');
    expect(dockerfile).toContain('RUN npm run build:web && npm run build:server');
    expect(dockerfile).toContain('npm prune --omit=dev --no-audit --no-fund');
  });

  it('validates manual GHCR tags before using them in publish commands', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/publish-ghcr.yml'), 'utf8');

    expect(workflow).toContain('validate_tag:');
    expect(workflow).toContain('INPUT_TAG: ${{ inputs.tag }}');
    expect(workflow).toContain('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$');
    expect(workflow).toContain('tag: ${{ steps.validate.outputs.tag }}');
    expect(workflow).toContain('type=raw,value=${{ needs.validate_tag.outputs.tag }}');
    expect(workflow).toContain('tag="${GHCR_IMAGE}:${IMAGE_TAG}"');
    expect(workflow).not.toContain('tag="${GHCR_IMAGE}:${{ inputs.tag }}"');
  });

  it('bounds the compose switch-note history the deploy script writes', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-painless.sh'), 'utf8');

    // 切换注释块只保留最近 KEEP_ENTRIES 条（本次 + 上一条），不再只追加不清理。
    expect(script).toContain('KEEP_ENTRIES = 2');
    expect(script).toContain('entry_head = re.compile(');
    expect(script).toContain('entry_rollback = re.compile(');
    expect(script).toContain('if heads and len(heads) > keep_count:');
    expect(script).toContain('if not is_note_line(line)');
    // 本次这条的文案/位置与旧行为一致（镜像、prev、compose 备份路径、恢复指引）。
    expect(script).toContain('# %s switched to %s; prev %s');
    expect(script).toContain('# rollback: 恢复 %s 或把 image 改回 %s 后 docker compose up -d');
    expect(script).toContain('kept + [note, "    image: %s\\n" % image]');
    // 旧的无界写法（只追加、从不清理）不得回归。
    expect(script).not.toContain('out += [note, "    image: %s\\n" % image]');
    expect(script).not.toContain('out, done = [], False');
  });

  it('covers the compose rewrite window with the rollback path', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-painless.sh'), 'utf8');

    // 切换前的备份、python 改写、改后 `compose config -q` 三道动作的相对次序：
    const backupIdx = script.indexOf('cp -f "$COMPOSE_FILE" "$COMPOSE_BAK"');
    const rewriteIdx = script.indexOf('python3 - "$COMPOSE_FILE"');
    const configCheckIdx = script.indexOf('compose config -q || die "改后 compose 校验失败"');
    // `SWITCHED=1` 必须在备份之后、改写之前 ⇒ 改写窗口内的任何退出（含 `config -q` 失败与信号）
    // 都归 trap 的 rollback 管（恢复 `.pre-*` 备份），不会把改写后的 compose 留在盘上。
    const switchedIdx = backupIdx < 0 ? -1 : script.indexOf('SWITCHED=1', backupIdx);
    expect(backupIdx).toBeGreaterThan(-1);
    expect(switchedIdx).toBeGreaterThan(backupIdx);
    expect(switchedIdx).toBeLessThan(rewriteIdx);
    expect(switchedIdx).toBeLessThan(configCheckIdx);
    // 旧的置位位置（`compose up -d` 之前）不得回归：整脚本只有一处 `SWITCHED=1`。
    expect(script.split('\n').filter((line) => line.trim() === 'SWITCHED=1')).toHaveLength(1);
  });
});
