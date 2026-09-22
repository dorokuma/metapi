import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
}));
const fetchMock = vi.fn();

vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: unknown[]) => (createTransportMock as any)(...args) },
  createTransport: (...args: unknown[]) => (createTransportMock as any)(...args),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  withExplicitProxyRequestInit: (_proxyUrl: unknown, options?: Record<string, unknown>) => options ?? {},
}));

describe('notification templates', () => {
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-notif-templates-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
  });

  beforeEach(async () => {
    vi.resetModules();
    sendMailMock.mockReset();
    fetchMock.mockReset();
    const { config } = await import('../config.js');
    config.notifyCooldownSec = 0;
    config.smtpEnabled = true;
    config.smtpHost = 'smtp.example.com';
    config.smtpPort = 587;
    config.smtpFrom = 'from@example.com';
    config.smtpTo = 'to@example.com';
    config.webhookEnabled = false;
    config.barkEnabled = false;
    config.serverChanEnabled = false;
    config.telegramEnabled = false;
    const dbModule = await import('../db/index.js');
    await dbModule.db.delete(dbModule.schema.settings).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('normalizes templates and rejects unknown channels gracefully', async () => {
    const { saveNotificationTemplates, loadNotificationTemplates, normalizeNotificationTemplates } = await import('./notificationTemplates.js');

    const saved = await saveNotificationTemplates({
      telegram: { title: '[TG] {{title}}', body: '*{{level}}* {{message}}\n累计 {{count}} 次', parseMode: 'Markdown' },
      unknownChannel: { title: 'ignored' },
      webhook: { body: 42 },
    });
    expect(saved).toEqual({
      telegram: { title: '[TG] {{title}}', body: '*{{level}}* {{message}}\n累计 {{count}} 次', parseMode: 'Markdown' },
    });

    const loaded = await loadNotificationTemplates();
    expect(loaded.telegram?.parseMode).toBe('Markdown');
    expect(normalizeNotificationTemplates(null)).toEqual({});
    expect(normalizeNotificationTemplates({ telegram: { parseMode: 'Sideways' } })).toEqual({});
  });

  it('renders variables and keeps unknown placeholders visible', async () => {
    const { renderNotificationTemplate } = await import('./notificationTemplates.js');
    const rendered = renderNotificationTemplate(
      { title: 'A {{title}}', body: '{{message}} | {{models}} | {{count}} | {{local_time}} | {{nope}}' },
      {
        title: '代理全部失败',
        message: 'boom',
        level: 'error',
        count: 6,
        models: ['grok-4.6', 'grok-4.7'],
        localTime: '2026-09-22 10:00:00',
        timeZone: 'Asia/Shanghai',
      },
      { title: 'fallback-title', body: 'fallback-body' },
    );
    expect(rendered.title).toBe('A 代理全部失败');
    expect(rendered.body).toContain('boom | grok-4.6 / grok-4.7 | 6 | 2026-09-22 10:00:00');
    expect(rendered.body).toContain('{{nope}}');
    expect(rendered.usedTemplate).toBe(true);
  });

  it('falls back to default rendering when the channel has no template', async () => {
    const { renderNotificationTemplate } = await import('./notificationTemplates.js');
    const rendered = renderNotificationTemplate(
      undefined,
      { title: 't', message: 'm', level: 'info', localTime: 'x', timeZone: 'y' },
      { title: 'default-title', body: 'default-body' },
    );
    expect(rendered).toMatchObject({ title: 'default-title', body: 'default-body', usedTemplate: false });
  });

  it('applies the telegram template body with the storm count and merges the title into the text', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      telegram: {
        title: 'TG {{level}}',
        body: '*{{title}}*\n{{message}}\n累计 {{count}} 次，涉及：{{models}}',
        parseMode: 'Markdown',
      },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '模型=grok-4.6', 'error', {
      storm: { count: 6, models: ['grok-4.6', 'grok-4.7'] },
    });
    expect(result.succeeded).toBe(1);

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    const payload = JSON.parse(init.body);
    expect(payload.parse_mode).toBe('Markdown');
    // 标题模板不再被丢弃：拼在正文前方
    expect(payload.text).toContain('TG error');
    expect(payload.text).toContain('累计 6 次，涉及：grok-4.6 / grok-4.7');
  });

  it('renders count and models as empty strings for non-storm alerts', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      telegram: { body: '{{title}}｜累计 {{count}} 次｜{{models}}' },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('Token 已失效', '账号 a 失效', 'error');

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body).text).toBe('Token 已失效｜累计  次｜');
  });

  it('retries telegram without parse_mode when the markup is rejected', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      telegram: { body: '*{{title}}*\n{{message}}', parseMode: 'Markdown' },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;

    // 第一次带 parse_mode 被拒，第二次去掉 parse_mode 成功
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '含 _ 下划线 的消息', 'error');
    expect(result.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, secondInit] = fetchMock.mock.calls[1] as [string, any];
    expect(JSON.parse(secondInit.body).parse_mode).toBeUndefined();
  });

  it('drops the official wrapper for wecom when a template is set', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({ webhook: { body: '自定义：{{title}} - {{message}}' } });

    const { config } = await import('../config.js');
    config.webhookEnabled = true;
    config.webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '模型=x', 'error');
    expect(result.succeeded).toBe(1);

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    const payload = JSON.parse(init.body);
    expect(payload.text.content).toBe('自定义：代理全部失败 - 模型=x');
    expect(payload.text.content).not.toContain('[metapi]');
  });

  it('keeps the default telegram payload shape when no template is set', async () => {
    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('标题', '正文', 'warning');

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    const payload = JSON.parse(init.body);
    expect(payload.parse_mode).toBeUndefined();
    expect(payload.text).toContain('[metapi][WARNING] 标题');
  });

  it('applies the smtp subject override and leaves the default prefix when using the raw title', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({ smtp: { title: '[自定义] {{title}}' } });
    sendMailMock.mockResolvedValue(undefined);

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '正文', 'error');
    expect(result.succeeded).toBe(1);

    const mail = sendMailMock.mock.calls[0][0] as any;
    expect(mail.subject).toBe('[自定义] 代理全部失败');
  });

  it('applies the webhook template to the json payload', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({ webhook: { body: 'W:{{title}}::{{message}}::{{level}}' } });

    const { config } = await import('../config.js');
    config.webhookEnabled = true;
    config.webhookUrl = 'https://example.com/hook';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '模型=x', 'error');
    expect(result.succeeded).toBe(1);

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body).message).toBe('W:代理全部失败::模型=x::error');
  });

  it('validates template payloads strictly instead of silently clearing them', async () => {
    const { parseNotificationTemplatesInput } = await import('./notificationTemplates.js');

    expect(parseNotificationTemplatesInput(undefined)).toEqual({ success: true, data: {} });
    expect(parseNotificationTemplatesInput({ telegram: { body: 'ok' } })).toEqual({
      success: true,
      data: { telegram: { body: 'ok' } },
    });

    // 非对象：以前会被静默收成 {}（等于清空），现在必须报错
    expect(parseNotificationTemplatesInput('nope').success).toBe(false);
    expect(parseNotificationTemplatesInput(null).success).toBe(false);
    expect(parseNotificationTemplatesInput([]).success).toBe(false);
    expect(parseNotificationTemplatesInput({ unknownChannel: {} }).success).toBe(false);
    expect(parseNotificationTemplatesInput({ telegram: { body: 42 } }).success).toBe(false);
    expect(parseNotificationTemplatesInput({ telegram: { parseMode: 'Sideways' } }).success).toBe(false);
    expect(parseNotificationTemplatesInput({ telegram: { body: 'x'.repeat(5000) } }).success).toBe(false);
  });

  it('truncates oversized template bodies to the documented limit', async () => {
    const { normalizeNotificationTemplates, NOTIFICATION_TEMPLATE_MAX_BODY_LENGTH } = await import('./notificationTemplates.js');
    const normalized = normalizeNotificationTemplates({ bark: { body: 'x'.repeat(10_000) } });
    expect(normalized.bark?.body?.length).toBe(NOTIFICATION_TEMPLATE_MAX_BODY_LENGTH);
  });
});
