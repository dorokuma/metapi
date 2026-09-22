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

  it('retries telegram without parse_mode only when the error is a parse entity rejection', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      telegram: { body: '*{{title}}*\n{{message}}', parseMode: 'Markdown' },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;

    // 第一次 400 且描述含 parse entity，触发重试；第二次成功
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '含 _ 下划线 的消息', 'error');
    expect(result.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, secondInit] = fetchMock.mock.calls[1] as [string, any];
    expect(JSON.parse(secondInit.body).parse_mode).toBeUndefined();
  });

  it('does not retry telegram for non-parse-entity errors', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      telegram: { body: '*{{title}}*\n{{message}}', parseMode: 'Markdown' },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;

    // 429 限流：不应重试
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests' }) });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '消息', 'error');
    expect(result.succeeded).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('escapes Markdown special characters in variable values when parseMode is set', async () => {
    const { renderEscapedNotificationTemplate } = await import('./notificationTemplates.js');
    const rendered = renderEscapedNotificationTemplate(
      { title: '{{title}}', body: '{{message}} / {{models}}', parseMode: 'Markdown' },
      {
        title: '模型[vulnerable](https://evil.example)',
        message: '含 _ 下划线 和 * 星号',
        level: 'error',
        count: 1,
        models: ['claude-3.5', 'gpt-[evil](x)'],
        localTime: 'now',
        timeZone: 'UTC',
      },
      { title: 'fallback', body: 'fallback' },
    );
    // 链接语法不应被 Markdown 解析
    expect(rendered.title).toContain('\\[vulnerable]');
    expect(rendered.body).toContain('\\_ 下划线');
    expect(rendered.body).toContain('\\* 星号');
    expect(rendered.body).toContain('gpt-\\[evil](x)');
    // 模板骨架不动
    expect(rendered.usedTemplate).toBe(true);
  });

  it('escapes only _ * ` [ for legacy Markdown, not backslash or closing bracket', async () => {
    const { renderEscapedNotificationTemplate } = await import('./notificationTemplates.js');
    const rendered = renderEscapedNotificationTemplate(
      { title: '{{title}}', body: '{{message}}', parseMode: 'Markdown' },
      {
        title: 'path\\\\to\\\\file]',
        message: 'contains \\\\] and \\\\\\',
        level: 'info',
        localTime: 'now',
        timeZone: 'UTC',
      },
      { title: 'fallback', body: 'fallback' },
    );
    // 反斜杠和 ] 不被额外转义
    expect(rendered.title).toBe('path\\\\to\\\\file]');
    expect(rendered.body).toBe('contains \\\\] and \\\\\\');
  });

  it('escapes brackets to block link injection in legacy Markdown', async () => {
    const { renderEscapedNotificationTemplate } = await import('./notificationTemplates.js');
    const rendered = renderEscapedNotificationTemplate(
      { title: '{{title}}', body: '{{message}}', parseMode: 'Markdown' },
      {
        title: 'Click [here](https://evil.example)',
        message: 'Visit [evil](https://evil.example) now',
        level: 'info',
        localTime: 'now',
        timeZone: 'UTC',
      },
      { title: 'fallback', body: 'fallback' },
    );
    // [ 被转义，链接注入被挡住
    expect(rendered.title).toContain('\\[here]');
    expect(rendered.body).toContain('\\[evil]');
  });

  it('does not escape variable values when no parseMode is set', async () => {
    const { renderNotificationTemplate } = await import('./notificationTemplates.js');
    const rendered = renderNotificationTemplate(
      { title: '{{title}}', body: '{{message}}' },
      {
        title: '*italic*',
        message: '_underscore_',
        level: 'info',
        localTime: 'now',
        timeZone: 'UTC',
      },
      { title: 'f', body: 'f' },
    );
    // 无 parseMode 时，变量值原样保留
    expect(rendered.title).toBe('*italic*');
    expect(rendered.body).toBe('_underscore_');
  });

  it('escapes only & < > for HTML parseMode, not Markdown chars', async () => {
    const { renderEscapedNotificationTemplate } = await import('./notificationTemplates.js');
    const rendered = renderEscapedNotificationTemplate(
      { title: '{{title}}', body: '{{message}} | {{level}}', parseMode: 'HTML' },
      {
        title: '错误 & 异常 <script>',
        message: '模型<敏感> _下划线_ *星号*',
        level: 'error',
        count: 1,
        models: ['gpt-4'],
        localTime: 'now',
        timeZone: 'UTC',
      },
      { title: 'fallback', body: 'fallback' },
    );
    // HTML 渠道：仅 & < > 被转义
    expect(rendered.title).toBe('错误 &amp; 异常 &lt;script&gt;');
    expect(rendered.body).toContain('模型&lt;敏感&gt;');
    // Markdown 字符不转义
    expect(rendered.body).toContain('_下划线_');
    expect(rendered.body).toContain('*星号*');
    expect(rendered.parseMode).toBe('HTML');
    expect(rendered.usedTemplate).toBe(true);
  });

  it('truncates Bark body by encoded URL length with suffix counted in budget', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({ bark: { title: 'T', body: '{{message}}' } });

    const { config } = await import('../config.js');
    config.barkEnabled = true;
    config.barkUrl = 'https://api.day.app/example';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true });

    const { sendNotification } = await import('./notifyService.js');
    // Use a body long enough to exceed the encoded URL budget (7943 bytes)
    // so that truncation with '…' is guaranteed
    const longBody = 'y '.repeat(3000); // each space encodes to %20 (3x), total 9000 encoded chars
    await sendNotification('标题', longBody, 'info');

    const firstCall = fetchMock.mock.calls[0] as [string | Request, any] | undefined;
    expect(firstCall).toBeTruthy();
    const [callArg] = firstCall!;
    const url = typeof callArg === 'string' ? callArg : (callArg instanceof Request ? callArg.url : String(callArg));
    // URL 总长度不超过 8000
    expect(url.length).toBeLessThanOrEqual(8000);
    // 正文已被截断
    const bodyMatch = url.match(/\/T\/([^?]+)/);
    expect(bodyMatch).toBeTruthy();
    const decodedBody = decodeURIComponent(bodyMatch![1]);
    expect(decodedBody).toContain('…');
    // Budget constraint forces truncation of 3000-char body
    expect(decodedBody.length).toBeLessThan(longBody.length);
  });

  it('truncates Feishu custom webhook body by UTF-8 bytes with suffix', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    // 自定义 webhook 模板 + 超长 body
    await saveNotificationTemplates({
      webhook: { title: 'W:{{title}}', body: '{{message}}' },
    });

    const { config } = await import('../config.js');
    config.webhookEnabled = true;
    config.webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/test';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true });

    const { truncateUtf8Bytes, sendNotification } = await import('./notifyService.js');
    const longMessage = '中'.repeat(2000); // 6000 UTF-8 bytes
    await sendNotification('告警', longMessage, 'error');

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    const payload = JSON.parse(init.body);
    const content = payload.content.text;
    // FEISHU_MAX_BODY_BYTES = 3900，应被截断
    // 后缀 '\n…\n...(truncated)' 计入预算
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(3900);
    expect(content).toContain('…');
  });
});
