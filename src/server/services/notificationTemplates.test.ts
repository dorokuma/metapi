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
    await dbModule.db.delete(dbModule.schema.notificationTemplates).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('normalizes per-event templates and rejects unknown event types or channels gracefully', async () => {
    const {
      saveNotificationTemplates,
      loadNotificationTemplates,
      normalizeNotificationTemplatesByEvent,
    } = await import('./notificationTemplates.js');

    const saved = await saveNotificationTemplates({
      __global__: { telegram: { title: '[全局] {{title}}', parseMode: 'Markdown' } },
      proxy: { telegram: { body: '*{{level}}* {{message}}\n累计 {{count}} 次' } },
      unknownEvent: { telegram: { title: 'ignored' } },
      token: { unknownChannel: { body: 'ignored' } },
    });
    expect(saved).toEqual({
      __global__: { telegram: { title: '[全局] {{title}}', parseMode: 'Markdown' } },
      proxy: { telegram: { body: '*{{level}}* {{message}}\n累计 {{count}} 次' } },
    });

    const loaded = await loadNotificationTemplates();
    expect(loaded.__global__?.telegram?.parseMode).toBe('Markdown');
    expect(loaded.proxy?.telegram?.body).toContain('累计 {{count}} 次');
    expect(normalizeNotificationTemplatesByEvent(null)).toEqual({});
    expect(normalizeNotificationTemplatesByEvent({ proxy: { telegram: { parseMode: 'Sideways' } } })).toEqual({});
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
      proxy: {
        telegram: {
          title: 'TG {{level}}',
          body: '*{{title}}*\n{{message}}\n累计 {{count}} 次，涉及：{{models}}',
          parseMode: 'Markdown',
        },
      },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '模型=grok-4.6', 'proxy', 'error', {
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

  it('routes each event type to its own template', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      proxy: { telegram: { body: 'PROXY {{title}}' } },
      token: { telegram: { body: 'TOKEN {{title}}' } },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('代理全部失败', '模型=x', 'proxy', 'error');
    await sendNotification('Token 已失效', '账号 a', 'token', 'error');
    await sendNotification('签到失败', '账号 b', 'checkin', 'error');

    expect(JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body).text).toContain('PROXY 代理全部失败');
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, any])[1].body).text).toContain('TOKEN Token 已失效');
    // 未单独定义的事件类型回退到 __global__，仍无模板时走默认渲染
    const third = JSON.parse((fetchMock.mock.calls[2] as [string, any])[1].body).text;
    expect(third).toContain('[metapi][ERROR] 签到失败');
  });

  it('falls back to the __global__ row before the hardcoded default rendering', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      __global__: { telegram: { body: 'GLOBAL {{title}}' } },
      token: { bark: { body: 'TOKEN-BARK {{title}}' } },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    // token 只定义了 bark：telegram 精确匹配缺失 → 回退 __global__
    await sendNotification('Token 已失效', '账号 a', 'token', 'error');
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body).text).toContain('GLOBAL Token 已失效');

    // 完全没有任何模板的渠道 → 硬编码默认渲染
    fetchMock.mockClear();
    await saveNotificationTemplates({ token: { bark: { body: 'TOKEN-BARK {{title}}' } } });
    await sendNotification('Token 已失效', '账号 a', 'token', 'error');
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body).text).toContain('[metapi][ERROR] Token 已失效');
  });

  it('renders count and models as empty strings for non-storm alerts', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      proxy: { telegram: { body: '{{title}}｜累计 {{count}} 次｜{{models}}' } },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('Token 已失效', '账号 a 失效', 'proxy', 'error');

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body).text).toBe('Token 已失效｜累计  次｜');
  });

  it('renders daily_summary specific template variables passed by the caller', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      daily_summary: { telegram: { body: '支出 ${{today_spend}} | 奖励 ${{today_reward}} | 净值 ${{today_net}}' } },
    });

    const { sendNotification } = await import('./notifyService.js');
    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await sendNotification('每日总结 2026-09-22', '正文', 'daily_summary', 'info', {
      bypassThrottle: true,
      extraVars: { today_spend: '3.141592', today_reward: '5.200000', today_net: '2.058408' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body).text).toBe('支出 $3.141592 | 奖励 $5.200000 | 净值 $2.058408');
  });

  it('retries telegram without parse_mode only when the error is a parse entity rejection', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      proxy: { telegram: { body: '*{{title}}*\n{{message}}', parseMode: 'Markdown' } },
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
    const result = await sendNotification('代理全部失败', '含 _ 下划线 的消息', 'proxy', 'error');
    expect(result.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, secondInit] = fetchMock.mock.calls[1] as [string, any];
    expect(JSON.parse(secondInit.body).parse_mode).toBeUndefined();
  });

  it('does not retry telegram for non-parse-entity errors', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      proxy: { telegram: { body: '*{{title}}*\n{{message}}', parseMode: 'Markdown' } },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;

    // 429 限流：不应重试
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests' }) });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '消息', 'proxy', 'error');
    expect(result.succeeded).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops the official wrapper for wecom when a template is set', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({ __global__: { webhook: { body: '自定义：{{title}} - {{message}}' } } });

    const { config } = await import('../config.js');
    config.webhookEnabled = true;
    config.webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '模型=x', 'proxy', 'error');
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
    await sendNotification('标题', '正文', 'status', 'warning');

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    const payload = JSON.parse(init.body);
    expect(payload.parse_mode).toBeUndefined();
    expect(payload.text).toContain('[metapi][WARNING] 标题');
  });

  it('applies the smtp subject override and leaves the default prefix when using the raw title', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({ __global__: { smtp: { title: '[自定义] {{title}}' } } });
    sendMailMock.mockResolvedValue(undefined);

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '正文', 'proxy', 'error');
    expect(result.succeeded).toBe(1);

    const mail = sendMailMock.mock.calls[0][0] as any;
    expect(mail.subject).toBe('[自定义] 代理全部失败');
  });

  it('applies the webhook template to the json payload', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({ __global__: { webhook: { body: 'W:{{title}}::{{message}}::{{level}}' } } });

    const { config } = await import('../config.js');
    config.webhookEnabled = true;
    config.webhookUrl = 'https://example.com/hook';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true });

    const { sendNotification } = await import('./notifyService.js');
    const result = await sendNotification('代理全部失败', '模型=x', 'proxy', 'error');
    expect(result.succeeded).toBe(1);

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(init.body).message).toBe('W:代理全部失败::模型=x::error');
  });

  it('validates template payloads strictly at both layers instead of silently clearing them', async () => {
    const { parseNotificationTemplatesInput } = await import('./notificationTemplates.js');

    expect(parseNotificationTemplatesInput(undefined)).toEqual({ success: true, data: {} });
    expect(parseNotificationTemplatesInput({ __global__: { telegram: { body: 'ok' } } })).toEqual({
      success: true,
      data: { __global__: { telegram: { body: 'ok' } } },
    });

    // 非对象：以前会被静默收成 {}（等于清空），现在必须报错
    expect(parseNotificationTemplatesInput('nope').success).toBe(false);
    expect(parseNotificationTemplatesInput(null).success).toBe(false);
    expect(parseNotificationTemplatesInput([]).success).toBe(false);
    // 第一层：非法事件类型
    expect(parseNotificationTemplatesInput({ daily: {} }).success).toBe(false);
    // 第二层：合法事件类型下的非法渠道
    expect(parseNotificationTemplatesInput({ proxy: { unknownChannel: {} } }).success).toBe(false);
    expect(parseNotificationTemplatesInput({ proxy: { telegram: { body: 42 } } }).success).toBe(false);
    expect(parseNotificationTemplatesInput({ proxy: { telegram: { parseMode: 'Sideways' } } }).success).toBe(false);
    expect(parseNotificationTemplatesInput({ proxy: { telegram: { body: 'x'.repeat(5000) } } }).success).toBe(false);
    expect(parseNotificationTemplatesInput({ proxy: 'nope' }).success).toBe(false);
  });

  it('accepts the legacy flat payload by normalizing it into the __global__ layer', async () => {
    const { parseNotificationTemplatesInput } = await import('./notificationTemplates.js');

    // 历史扁平格式（顶层直接是渠道键）不再 400，归一化成 __global__ 层
    expect(parseNotificationTemplatesInput({ webhook: { body: 'flat {{title}}' } })).toEqual({
      success: true,
      data: { __global__: { webhook: { body: 'flat {{title}}' } } },
    });
    // 扁平格式下的渠道字段仍按严格规则校验
    expect(parseNotificationTemplatesInput({ telegram: { parseMode: 'Sideways' } }).success).toBe(false);
    expect(parseNotificationTemplatesInput({ unknownChannel: { body: 'x' } }).success).toBe(false);
  });

  it('truncates oversized template bodies to the documented limit', async () => {
    const { normalizeNotificationTemplatesByEvent, NOTIFICATION_TEMPLATE_MAX_BODY_LENGTH } = await import('./notificationTemplates.js');
    const normalized = normalizeNotificationTemplatesByEvent({ __global__: { bark: { body: 'x'.repeat(10_000) } } });
    expect(normalized.__global__?.bark?.body?.length).toBe(NOTIFICATION_TEMPLATE_MAX_BODY_LENGTH);
  });

  it('migrates the legacy settings JSON into __global__ rows and drops the legacy key', async () => {
    const { upsertSetting } = await import('../db/upsertSetting.js');
    const { eq } = await import('drizzle-orm');
    const { db, schema } = await import('../db/index.js');
    const { loadNotificationTemplates, NOTIFICATION_TEMPLATES_SETTING_KEY } = await import('./notificationTemplates.js');

    await upsertSetting(NOTIFICATION_TEMPLATES_SETTING_KEY, {
      telegram: { title: '[TG] {{title}}', parseMode: 'Markdown' },
      bark: { body: 'B {{message}}' },
      unknownChannel: { body: 'ignored' },
    });

    const loaded = await loadNotificationTemplates();
    expect(loaded.__global__?.telegram).toEqual({ title: '[TG] {{title}}', parseMode: 'Markdown' });
    expect(loaded.__global__?.bark).toEqual({ body: 'B {{message}}' });
    expect(loaded.__global__?.webhook).toBeUndefined();
    // 其他事件类型仍为回退到 __global__ 的空态
    expect(loaded.proxy).toBeUndefined();

    const legacyRow = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, NOTIFICATION_TEMPLATES_SETTING_KEY))
      .get();
    expect(legacyRow).toBeUndefined();

    // 幂等：再次加载不会重复写入或报错
    await expect(loadNotificationTemplates()).resolves.toEqual(loaded);
  });

  it('re-migrates when a legacy backup re-introduces the settings key after import', async () => {
    const { upsertSetting } = await import('../db/upsertSetting.js');
    const { eq } = await import('drizzle-orm');
    const { db, schema } = await import('../db/index.js');
    const {
      loadNotificationTemplates,
      saveNotificationTemplates,
      resetLegacyNotificationTemplateMigrationFlag,
      NOTIFICATION_TEMPLATES_SETTING_KEY,
    } = await import('./notificationTemplates.js');

    // 第一次迁移
    await upsertSetting(NOTIFICATION_TEMPLATES_SETTING_KEY, { telegram: { body: 'OLD {{title}}' } });
    expect((await loadNotificationTemplates()).__global__?.telegram?.body).toBe('OLD {{title}}');

    // 升级后用户又改了模板
    await saveNotificationTemplates({ __global__: { telegram: { body: 'NEW {{title}}' } } });

    // 导入旧版本备份把 legacy 键又写回来：必须再次迁移，但只补缺失的 __global__ 行——
    // 已有的全局行不被旧备份内容覆盖，更不能整表删除（那会连带删掉事件覆盖行）。
    await upsertSetting(NOTIFICATION_TEMPLATES_SETTING_KEY, {
      telegram: { body: 'BACKUP {{title}}' },
      bark: { body: 'BACKUP-BARK {{title}}' },
    });
    resetLegacyNotificationTemplateMigrationFlag();
    const migrated = await loadNotificationTemplates();
    expect(migrated.__global__?.telegram?.body).toBe('NEW {{title}}');
    expect(migrated.__global__?.bark?.body).toBe('BACKUP-BARK {{title}}');

    // legacy 键在迁移成功后删除，保持幂等
    const legacyRow = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, NOTIFICATION_TEMPLATES_SETTING_KEY))
      .get();
    expect(legacyRow).toBeUndefined();

    // 没有备份导入入口重置标记时，热路径不再重查 settings、也不会重新迁移
    await upsertSetting(NOTIFICATION_TEMPLATES_SETTING_KEY, { telegram: { body: 'SECOND-BACKUP {{title}}' } });
    expect((await loadNotificationTemplates()).__global__?.telegram?.body).toBe('NEW {{title}}');
  });

  it('never deletes event override rows when the legacy migration re-runs', async () => {
    const { upsertSetting } = await import('../db/upsertSetting.js');
    const {
      loadNotificationTemplates,
      saveNotificationTemplates,
      resetLegacyNotificationTemplateMigrationFlag,
      NOTIFICATION_TEMPLATES_SETTING_KEY,
    } = await import('./notificationTemplates.js');

    await saveNotificationTemplates({
      __global__: { webhook: { body: 'GLOBAL-HOOK' } },
      token: { telegram: { body: 'TOKEN-TG' } },
      proxy: { bark: { body: 'PROXY-BARK' } },
    });

    await upsertSetting(NOTIFICATION_TEMPLATES_SETTING_KEY, { telegram: { body: 'LEGACY-TG {{title}}' } });
    resetLegacyNotificationTemplateMigrationFlag();

    const loaded = await loadNotificationTemplates();
    // 事件覆盖行必须原样保留（禁止迁移事务里的全表 delete）
    expect(loaded.token?.telegram?.body).toBe('TOKEN-TG');
    expect(loaded.proxy?.bark?.body).toBe('PROXY-BARK');
    expect(loaded.__global__?.webhook?.body).toBe('GLOBAL-HOOK');
    // 缺失的 __global__ 渠道被补齐
    expect(loaded.__global__?.telegram?.body).toBe('LEGACY-TG {{title}}');
  });

  it('falls back field by field between the event row and the __global__ row', async () => {
    const {
      saveNotificationTemplates,
      loadNotificationTemplatesForEvent,
      pickEventChannelTemplate,
    } = await import('./notificationTemplates.js');

    await saveNotificationTemplates({
      __global__: { telegram: { title: 'G-TITLE {{title}}', body: 'G-BODY', parseMode: 'Markdown' } },
      proxy: { telegram: { body: 'PROXY-BODY' } },
    });

    const resolved = await loadNotificationTemplatesForEvent('proxy');
    // 事件行只有 body：title / parseMode 逐字段继承全局行
    expect(pickEventChannelTemplate(resolved, 'telegram')).toEqual({
      title: 'G-TITLE {{title}}',
      body: 'PROXY-BODY',
      parseMode: 'Markdown',
    });
    // 全局也缺失的渠道保持在两级都为 undefined
    expect(pickEventChannelTemplate(resolved, 'bark')).toBeUndefined();
  });

  it('inherits the global title and parseMode when the event row only defines a body', async () => {
    const { saveNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      __global__: { telegram: { title: '[全局] {{title}}', body: 'G-BODY', parseMode: 'Markdown' } },
      proxy: { telegram: { body: 'PROXY {{title}}' } },
    });

    const { config } = await import('../config.js');
    config.telegramEnabled = true;
    config.telegramBotToken = 'tg-token';
    config.telegramChatId = 'chat-1';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const { sendNotification } = await import('./notifyService.js');
    await sendNotification('代理全部失败', '模型=x', 'proxy', 'error');

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    const payload = JSON.parse(init.body);
    expect(payload.parse_mode).toBe('Markdown');
    expect(payload.text).toContain('[全局] 代理全部失败');
    expect(payload.text).toContain('PROXY 代理全部失败');
  });

  it('rejects invalid event types instead of silently reading the __global__ row', async () => {
    const { loadNotificationTemplatesForEvent } = await import('./notificationTemplates.js');
    await expect(loadNotificationTemplatesForEvent('daily' as any)).rejects.toThrow(/invalid eventType/);

    const { sendNotification } = await import('./notifyService.js');
    await expect(sendNotification('标题', '正文', 'nope' as any, 'info')).rejects.toThrow(/invalid eventType/);
  });

  it('resolves templates from an in-memory map with the same fallback order', async () => {
    const { resolveNotificationTemplate, buildNotificationTemplateVariablesByEvent } = await import('./notificationTemplates.js');
    const templates = {
      __global__: { telegram: { body: 'global-tg' }, bark: { body: 'global-bark' } },
      token: { telegram: { body: 'token-tg' } },
    };
    expect(resolveNotificationTemplate(templates, 'token', 'telegram')?.body).toBe('token-tg');
    expect(resolveNotificationTemplate(templates, 'token', 'bark')?.body).toBe('global-bark');
    expect(resolveNotificationTemplate(templates, 'checkin', 'telegram')?.body).toBe('global-tg');
    expect(resolveNotificationTemplate(templates, undefined, 'smtp')).toBeUndefined();
    expect(resolveNotificationTemplate(templates, 'not-an-event', 'telegram')?.body).toBe('global-tg');

    const variablesByEvent = buildNotificationTemplateVariablesByEvent({
      daily_summary: ['local_day', 'today_spend'],
    });
    expect(variablesByEvent.token).toContain('title');
    expect(variablesByEvent.token).not.toContain('today_spend');
    expect(variablesByEvent.daily_summary).toEqual(expect.arrayContaining(['title', 'local_day', 'today_spend']));
    expect(variablesByEvent.__global__).not.toContain('local_day');
  });

  it('writes legacy flat payloads as the __global__ event so backups never lose templates', async () => {
    const { saveNotificationTemplates, loadNotificationTemplates } = await import('./notificationTemplates.js');
    const saved = await saveNotificationTemplates({ webhook: { body: 'flat {{title}}' } });
    expect(saved).toEqual({ __global__: { webhook: { body: 'flat {{title}}' } } });
    await expect(loadNotificationTemplates()).resolves.toEqual(saved);
  });

  it('keeps overrides isolated per event and channel when saving', async () => {
    const { saveNotificationTemplates, loadNotificationTemplates } = await import('./notificationTemplates.js');
    await saveNotificationTemplates({
      __global__: { telegram: { body: 'global' }, webhook: { body: 'global-hook' } },
      token: { telegram: { body: 'token-tg' } },
    });
    const loaded = await loadNotificationTemplates();
    expect(loaded.__global__?.telegram?.body).toBe('global');
    expect(loaded.token?.telegram?.body).toBe('token-tg');
    expect(loaded.token?.webhook).toBeUndefined();

    // 清除某个事件类型下所有渠道的覆盖后该事件类型整体消失
    await saveNotificationTemplates({ __global__: { telegram: { body: 'global' }, webhook: { body: 'global-hook' } } });
    const afterClear = await loadNotificationTemplates();
    expect(afterClear.token).toBeUndefined();
    expect(Object.keys(afterClear)).toEqual(['__global__']);
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
    await saveNotificationTemplates({ __global__: { bark: { title: 'T', body: '{{message}}' } } });

    const { config } = await import('../config.js');
    config.barkEnabled = true;
    config.barkUrl = 'https://api.day.app/example';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true });

    const { sendNotification } = await import('./notifyService.js');
    // Use a body long enough to exceed the encoded URL budget (7943 bytes)
    // so that truncation with '…' is guaranteed
    const longBody = 'y '.repeat(3000); // each space encodes to %20 (3x), total 9000 encoded chars
    await sendNotification('标题', longBody, 'checkin', 'info');

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
      __global__: { webhook: { title: 'W:{{title}}', body: '{{message}}' } },
    });

    const { config } = await import('../config.js');
    config.webhookEnabled = true;
    config.webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/test';
    config.smtpEnabled = false;
    fetchMock.mockResolvedValue({ ok: true });

    const { truncateUtf8Bytes, sendNotification } = await import('./notifyService.js');
    const longMessage = '中'.repeat(2000); // 6000 UTF-8 bytes
    await sendNotification('告警', longMessage, 'proxy', 'error');

    const [, init] = fetchMock.mock.calls[0] as [string, any];
    const payload = JSON.parse(init.body);
    const content = payload.content.text;
    // FEISHU_MAX_BODY_BYTES = 3900，应被截断
    // 后缀 '\n…\n...(truncated)' 计入预算
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(3900);
    expect(content).toContain('…');
  });
});
