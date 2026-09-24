/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getRuntimeSettings: vi.fn(),
    updateRuntimeSettings: vi.fn(async () => ({})),
    testNotification: vi.fn(async () => ({ message: 'ok' })),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

import NotificationSettings from './NotificationSettings.js';
import { ToastProvider } from '../components/Toast.js';

function collectText(node: any): string {
  const children = node?.children || [];
  return children.map((child: any) => (typeof child === 'string' ? child : collectText(child))).join('');
}

function findButtonByTestId(root: ReactTestRenderer, testId: string) {
  return root.root.findAll((node) => (
    node.type === 'button' && node.props['data-testid'] === testId
  ))[0];
}

function findInputByTestId(root: ReactTestRenderer, testId: string) {
  return root.root.findAll((node) => (
    (node.type === 'input' || node.type === 'textarea') && node.props['data-testid'] === testId
  ))[0];
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findFiber(node: any, predicate: (fiber: any) => boolean): any {
  if (predicate(node)) return node;
  if (node.child) {
    const found = findFiber(node.child, predicate);
    if (found) return found;
  }
  if (node.sibling) {
    const found = findFiber(node.sibling, predicate);
    if (found) return found;
  }
  return null;
}

function setComponentRef(root: ReactTestRenderer, targetType: any, refValue: any): any {
  const rootFiber = (root.root as any)._fiber;
  if (!rootFiber) return null;
  const fiber = findFiber(rootFiber, (f: any) => f.type === targetType);
  if (!fiber) return null;
  let state = fiber.memoizedState;
  while (state) {
    if (state.memoizedState && typeof state.memoizedState === 'object' && 'current' in state.memoizedState) {
      state.memoizedState.current = refValue;
      return state.memoizedState;
    }
    state = state.next;
  }
  return null;
}

describe('NotificationSettings templates', () => {
  beforeEach(() => {
    apiMock.getRuntimeSettings.mockReset();
    apiMock.updateRuntimeSettings.mockReset();
    apiMock.updateRuntimeSettings.mockResolvedValue({});
    apiMock.getRuntimeSettings.mockResolvedValue({
      webhookEnabled: false,
      barkEnabled: false,
      serverChanEnabled: false,
      telegramEnabled: true,
      smtpEnabled: false,
      notifyCooldownSec: 300,
      notificationTemplates: {
        __global__: {
          telegram: { title: '[TG] {{title}}', body: '*{{level}}* {{message}}\n累计 {{count}} 次', parseMode: 'Markdown' },
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function renderPage() {
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <ToastProvider>
          <MemoryRouter initialEntries={['/settings/notifications']}>
            <Routes>
              <Route path="/settings/notifications" element={<NotificationSettings />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      );
    });
    await flush();
    return root;
  }

  it('opens on the telegram tab and renders the live preview from saved templates', async () => {
    const root = await renderPage();
    try {
      const title = findInputByTestId(root, 'template-title-input');
      expect(title.props.value).toBe('[TG] {{title}}');

      const preview = root.root.findAll((node) => node.props['data-testid'] === 'template-preview')[0];
      const text = collectText(preview);
      expect(text).toContain('[TG] 代理全部失败');
      expect(text).toContain('*error* 模型=grok-4.6, 原因=No available channels after retries');
      expect(text).toContain('累计 6 次');
    } finally {
      root?.unmount();
    }
  });

  it('inserts a variable chip into the body and reflects it in the preview', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {},
    });
    const root = await renderPage();
    try {
      const body = findInputByTestId(root, 'template-body-input');
      await act(async () => {
        body.props.onChange({ target: { value: '第一条：' } });
      });
      const modelsChip = root.root.findAll((node) => (
        node.type === 'button' && node.props.title === '涉及模型列表'
      ))[0];
      await act(async () => {
        modelsChip.props.onClick();
      });

      const updated = findInputByTestId(root, 'template-body-input');
      expect(updated.props.value).toBe('第一条：{{models}}');
      const preview = root.root.findAll((node) => node.props['data-testid'] === 'template-preview')[0];
      expect(collectText(preview)).toContain('grok-4.6 / grok-4.7 / glm-5.3-flash');
    } finally {
      root?.unmount();
    }
  });

  it('switches the telegram parse mode', async () => {
    const root = await renderPage();
    try {
      const html = findButtonByTestId(root, 'template-parse-mode-HTML');
      await act(async () => {
        html.props.onClick();
      });
      const active = findButtonByTestId(root, 'template-parse-mode-HTML');
      expect(active.props.style.border).toContain('var(--color-primary)');
    } finally {
      root?.unmount();
    }
  });

  it('saves templates together with the notification settings', async () => {
    const root = await renderPage();
    try {
      const body = findInputByTestId(root, 'template-body-input');
      await act(async () => {
        body.props.onChange({ target: { value: '新正文 {{message}}' } });
      });
      const save = root.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('保存通知设置')
      ))[0];
      await act(async () => {
        await save.props.onClick();
      });

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledTimes(1);
      const calls = apiMock.updateRuntimeSettings.mock.calls as unknown as Array<[Record<string, any>]>;
      const payload = calls[0][0];
      expect(payload.notificationTemplates.__global__.telegram.body).toBe('新正文 {{message}}');
    } finally {
      root?.unmount();
    }
  });

  it('edits the global template when an event type has no override of its own', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {
        __global__: { telegram: { body: 'GLOBAL {{title}}' } },
        token: { bark: { body: 'TOKEN-BARK' } },
      },
    });
    const root = await renderPage();
    try {
      // token × telegram 未单独定义 → 展示全局模板
      const eventTab = findButtonByTestId(root, 'template-event-tab-token');
      await act(async () => {
        eventTab.props.onClick();
      });
      const inheritButton = findButtonByTestId(root, 'template-inherit-global');
      expect(inheritButton).toBeTruthy();
      expect(findInputByTestId(root, 'template-body-input').props.value).toBe('GLOBAL {{title}}');

      // 一键继承全局：生成独立覆盖
      await act(async () => {
        inheritButton.props.onClick();
      });
      expect(findButtonByTestId(root, 'template-inherit-global')).toBeUndefined();
      expect(findButtonByTestId(root, 'template-clear-override')).toBeTruthy();
      expect(findInputByTestId(root, 'template-body-input').props.value).toBe('GLOBAL {{title}}');

      // 覆盖后的编辑只写当前事件类型
      const body = findInputByTestId(root, 'template-body-input');
      await act(async () => {
        body.props.onChange({ target: { value: 'TOKEN-OWN {{title}}' } });
      });
      const save = root.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('保存通知设置')
      ))[0];
      await act(async () => {
        await save.props.onClick();
      });
      const calls = apiMock.updateRuntimeSettings.mock.calls as unknown as Array<[Record<string, any>]>;
      const payload = calls[0][0];
      expect(payload.notificationTemplates.token.telegram.body).toBe('TOKEN-OWN {{title}}');
      expect(payload.notificationTemplates.__global__.telegram.body).toBe('GLOBAL {{title}}');
    } finally {
      root?.unmount();
    }
  });

  it('creates an override on the event when typing into an uncustomized event', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {
        __global__: { telegram: { body: 'GLOBAL {{title}}' } },
        token: { bark: { body: 'TOKEN-BARK' } },
      },
    });
    const root = await renderPage();
    try {
      // token × telegram 未单独定义，直接输入必须落到 token 行，而不是静默写回 __global__
      await act(async () => {
        findButtonByTestId(root, 'template-event-tab-token').props.onClick();
      });
      const body = findInputByTestId(root, 'template-body-input');
      await act(async () => {
        body.props.onChange({ target: { value: 'TOKEN-OWN {{title}}' } });
      });
      // 一旦输入即视为已单独定义
      expect(findButtonByTestId(root, 'template-clear-override')).toBeTruthy();
      const save = root.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('保存通知设置')
      ))[0];
      await act(async () => {
        await save.props.onClick();
      });
      const calls = apiMock.updateRuntimeSettings.mock.calls as unknown as Array<[Record<string, any>]>;
      const payload = calls[0][0];
      expect(payload.notificationTemplates.token.telegram.body).toBe('TOKEN-OWN {{title}}');
      expect(payload.notificationTemplates.__global__.telegram.body).toBe('GLOBAL {{title}}');
    } finally {
      root?.unmount();
    }
  });

  it('creates an override even when the global template is empty', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {},
    });
    const root = await renderPage();
    try {
      await act(async () => {
        findButtonByTestId(root, 'template-event-tab-checkin').props.onClick();
      });
      // 全局为空：先一键继承（得到空覆盖行），再输入
      const inheritButton = findButtonByTestId(root, 'template-inherit-global');
      expect(inheritButton).toBeTruthy();
      await act(async () => {
        inheritButton.props.onClick();
      });
      // 空覆盖行也必须被识别为「已单独定义」，否则后续输入会写回全局
      expect(findButtonByTestId(root, 'template-inherit-global')).toBeUndefined();
      expect(findButtonByTestId(root, 'template-clear-override')).toBeTruthy();

      const body = findInputByTestId(root, 'template-body-input');
      await act(async () => {
        body.props.onChange({ target: { value: 'CHECKIN {{message}}' } });
      });
      const save = root.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('保存通知设置')
      ))[0];
      await act(async () => {
        await save.props.onClick();
      });
      const calls = apiMock.updateRuntimeSettings.mock.calls as unknown as Array<[Record<string, any>]>;
      const payload = calls[0][0];
      expect(payload.notificationTemplates.checkin.telegram.body).toBe('CHECKIN {{message}}');
      // 全局模板没有被隐式创建出来
      expect(payload.notificationTemplates.__global__?.telegram).toBeUndefined();
    } finally {
      root?.unmount();
    }
  });

  it('attributes an inserted variable chip to the active event instead of __global__', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {
        __global__: { telegram: { body: 'GLOBAL {{title}}' } },
      },
    });
    const root = await renderPage();
    try {
      await act(async () => {
        findButtonByTestId(root, 'template-event-tab-token').props.onClick();
      });
      const levelChip = root.root.findAll((node) => (
        node.type === 'button' && node.props.title === '级别 info/warning/error'
      ))[0];
      await act(async () => {
        levelChip.props.onClick();
      });
      // chip 插入到当前事件的正文里（继承来的全局内容之后追加）
      expect(findInputByTestId(root, 'template-body-input').props.value).toBe('GLOBAL {{title}}{{level}}');
      const save = root.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('保存通知设置')
      ))[0];
      await act(async () => {
        await save.props.onClick();
      });
      const calls = apiMock.updateRuntimeSettings.mock.calls as unknown as Array<[Record<string, any>]>;
      const payload = calls[0][0];
      expect(payload.notificationTemplates.token.telegram.body).toBe('GLOBAL {{title}}{{level}}');
      expect(payload.notificationTemplates.__global__.telegram.body).toBe('GLOBAL {{title}}');
    } finally {
      root?.unmount();
    }
  });

  it('clearing an override restores inheritance of the global template', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {
        __global__: { telegram: { body: 'GLOBAL {{title}}' } },
        token: { telegram: { body: 'TOKEN-OWN {{title}}' } },
      },
    });
    const root = await renderPage();
    try {
      await act(async () => {
        findButtonByTestId(root, 'template-event-tab-token').props.onClick();
      });
      expect(findInputByTestId(root, 'template-body-input').props.value).toBe('TOKEN-OWN {{title}}');

      await act(async () => {
        findButtonByTestId(root, 'template-clear-override').props.onClick();
      });
      // 恢复继承后重新展示全局模板，且保存结果里不再有 token.telegram
      expect(findInputByTestId(root, 'template-body-input').props.value).toBe('GLOBAL {{title}}');
      const save = root.root.findAll((node) => (
        node.type === 'button' && collectText(node).includes('保存通知设置')
      ))[0];
      await act(async () => {
        await save.props.onClick();
      });
      const calls = apiMock.updateRuntimeSettings.mock.calls as unknown as Array<[Record<string, any>]>;
      const payload = calls[0][0];
      expect(payload.notificationTemplates.token?.telegram).toBeUndefined();
      expect(payload.notificationTemplates.__global__.telegram.body).toBe('GLOBAL {{title}}');
    } finally {
      root?.unmount();
    }
  });

  it('offers the daily_summary specific variables when that event type is active', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {},
    });
    const root = await renderPage();
    try {
      await act(async () => {
        findButtonByTestId(root, 'template-event-tab-daily_summary').props.onClick();
      });
      const spendChip = root.root.findAll((node) => (
        node.type === 'button' && node.props.title === '当日支出（美元）'
      ))[0];
      expect(spendChip).toBeTruthy();
      await act(async () => {
        spendChip.props.onClick();
      });
      const body = findInputByTestId(root, 'template-body-input');
      expect(body.props.value).toBe('{{today_spend}}');
      // 专属变量在预览里用示例值渲染
      const preview = root.root.findAll((node) => node.props['data-testid'] === 'template-preview')[0];
      expect(collectText(preview)).toContain('3.141592');
    } finally {
      root?.unmount();
    }
  });

  it('keeps the default preview when the channel has no template', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {},
    });
    const root = await renderPage();
    try {
      const preview = root.root.findAll((node) => node.props['data-testid'] === 'template-preview')[0];
      const text = collectText(preview);
      expect(text).toContain('代理全部失败');
      expect(text).toContain('模型=grok-4.6');
      expect(text).not.toContain('{{');
    } finally {
      root?.unmount();
    }
  });

  it('restores caret after inserting a variable chip when unfocused', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {},
    });
    // 模拟未聚焦：document.activeElement 不是 textarea
    let origActiveElement: any;
    let hadActiveElement = false;
    if (typeof document !== 'undefined') {
      origActiveElement = document.activeElement;
      hadActiveElement = true;
      Object.defineProperty(document, 'activeElement', {
        configurable: true,
        get() { return null; },
      });
    }

    const root = await renderPage();
    try {
      const body = findInputByTestId(root, 'template-body-input');
      await act(async () => {
        body.props.onChange({ target: { value: 'prefix' } });
      });

      const countChip = root.root.findAll((node) => (
        node.type === 'button' && node.props.title === '风暴聚合累计次数'
      ))[0];
      await act(async () => {
        countChip.props.onClick();
      });

      const updated = findInputByTestId(root, 'template-body-input');
      // 未聚焦时追加到末尾（不插入到开头）
      expect(updated.props.value).toBe('prefix{{count}}');
    } finally {
      root?.unmount();
      if (hadActiveElement && typeof document !== 'undefined') {
        Object.defineProperty(document, 'activeElement', {
          configurable: true,
          get() { return origActiveElement; },
        });
      }
    }
  });

  it('inserts a variable chip at the caret position when textarea is focused', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {},
    });

    const mockTextarea = {
      selectionStart: 5,
      selectionEnd: 5,
      focus: () => {},
      setSelectionRange: () => {},
    };

    const root = await renderPage();
    try {
      const body = findInputByTestId(root, 'template-body-input');
      await act(async () => {
        body.props.onChange({ target: { value: 'hello world' } });
      });
      // 模拟 textarea 聚焦
      await act(async () => {
        body.props.onFocus?.();
      });

      setComponentRef(root, NotificationSettings, mockTextarea);

      const countChip = root.root.findAll((node) => (
        node.type === 'button' && node.props.title === '风暴聚合累计次数'
      ))[0];

      await act(async () => {
        countChip.props.onClick();
      });

      const updated = findInputByTestId(root, 'template-body-input');
      // 聚焦时 chip 插入到光标位置
      expect(updated.props.value).toBe('hello{{count}} world');
    } finally {
      root?.unmount();
    }
  });

  it('keeps the body focused while clicking a variable chip (preventDefault when focused)', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      telegramEnabled: true,
      notifyCooldownSec: 300,
      notificationTemplates: {},
    });

    const root = await renderPage();
    try {
      const body = findInputByTestId(root, 'template-body-input');
      await act(async () => {
        body.props.onChange({ target: { value: 'hello world' } });
      });
      // 聚焦文本框：chip onMouseDown 必须 preventDefault，防止按钮抢走 textarea 焦点
      await act(async () => {
        body.props.onFocus?.();
      });

      const countChip = root.root.findAll((node) => (
        node.type === 'button' && node.props.title === '风暴聚合累计次数'
      ))[0];

      const preventDefault = vi.fn();
      await act(async () => {
        countChip.props.onMouseDown({ preventDefault });
      });
      // 正文已聚焦：阻止 mousedown 默认行为以保住焦点（不能是删掉也绿的摆设断言）
      expect(preventDefault).toHaveBeenCalled();

      await act(async () => {
        countChip.props.onClick();
      });
      const updated = findInputByTestId(root, 'template-body-input');
      // chip 插入行为本身不回归（拦截默认行为不能影响写入）
      expect(updated.props.value).toContain('{{count}}');

      // 未聚焦时不得阻止默认行为
      await act(async () => {
        body.props.onBlur?.();
      });
      const preventDefaultUnfocused = vi.fn();
      await act(async () => {
        countChip.props.onMouseDown({ preventDefault: preventDefaultUnfocused });
      });
      expect(preventDefaultUnfocused).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
