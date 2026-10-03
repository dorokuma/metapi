import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';

import About from './About.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getUpdateCenterStatus: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('About update center', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getUpdateCenterStatus.mockResolvedValue({
      currentVersion: '1.2.3',
      githubRelease: {
        normalizedVersion: '1.3.0',
        displayVersion: '1.3.0',
        url: 'https://github.com/cita-777/metapi/releases/tag/v1.3.0',
      },
      dockerHubTag: {
        normalizedVersion: 'latest',
        displayVersion: 'latest @ sha256:efb2ee655386',
      },
      helper: {
        imageTag: 'latest',
        imageDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows current version, newer release summaries, and a highlighted update reminder', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <About />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('v1.2.3');
      expect(text).toContain('GitHub 稳定版');
      expect(text).toContain('1.3.0');
      expect(text).toContain('Docker Hub');
      expect(text).toContain('latest @ sha256:efb2ee655386');
      expect(text).toContain('发现新版本');
      expect(text).toContain('前往更新中心');

      const highlightedReminder = root.root.find((node) => (
        typeof node.props.className === 'string'
        && node.props.className.includes('stat-value-glow')
        && collectText(node).includes('发现新版本')
      ));
      expect(collectText(highlightedReminder)).toContain('发现新版本');
    } finally {
      root?.unmount();
    }
  });

  it('shows a neutral placeholder instead of a fabricated version when the status payload omits currentVersion', async () => {
    apiMock.getUpdateCenterStatus.mockResolvedValue({
      githubRelease: {
        normalizedVersion: '1.4.0',
        displayVersion: '1.4.0',
      },
      dockerHubTag: null,
      helper: null,
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <About />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      // 当前版本未知：不得拿编造版本冒充当前版本，也不得由此得出“发现新版本”的假提示
      expect(text).not.toContain('v1.3.0');
      expect(text).not.toContain('发现新版本');
      const versionLine = root.root.find((node) => node.props['data-testid'] === 'about-current-version');
      expect(collectText(versionLine)).toBe('—');
    } finally {
      root?.unmount();
    }
  });

  it('shows a neutral placeholder and keeps the unknown-state reminder when the status lookup fails', async () => {
    apiMock.getUpdateCenterStatus.mockRejectedValue(new Error('status unavailable'));

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <About />
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).not.toContain('v1.3.0');
      expect(text).toContain('无法检查更新');
      const versionLine = root.root.find((node) => node.props['data-testid'] === 'about-current-version');
      expect(collectText(versionLine)).toBe('—');
    } finally {
      root?.unmount();
    }
  });
});
