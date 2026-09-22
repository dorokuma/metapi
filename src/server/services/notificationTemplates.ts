import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';

/**
 * 推送模板自定义。
 *
 * 各渠道的默认 payload 是硬编码的（企业微信 markdown 不可用、Bark 只有纯文本 URL 等）。
 * 这里允许按渠道覆盖"标题 + 正文"，留空的渠道继续走默认渲染，行为零变化。
 *
 * 变量使用 `{{name}}` 占位符，不走模板引擎，避免注入与求值风险；
 * 未识别的占位符原样保留（预览里会标红提示）。
 */

export type NotificationTemplateChannel = 'webhook' | 'bark' | 'serverchan' | 'telegram' | 'smtp';
export type NotificationParseMode = '' | 'Markdown' | 'HTML';

export type NotificationTemplate = {
  title?: string;
  body?: string;
  parseMode?: NotificationParseMode;
};

export type NotificationTemplates = Partial<Record<NotificationTemplateChannel, NotificationTemplate>>;

export const NOTIFICATION_TEMPLATES_SETTING_KEY = 'notification_templates_v1';
export const NOTIFICATION_TEMPLATE_MAX_BODY_LENGTH = 4000;
export const NOTIFICATION_TEMPLATE_MAX_TITLE_LENGTH = 300;

export const NOTIFICATION_TEMPLATE_VARIABLES = [
  'title',
  'message',
  'level',
  'count',
  'models',
  'local_time',
  'utc_time',
  'timezone',
  'app',
] as const;

export type NotificationTemplateVars = {
  title: string;
  message: string;
  level: string;
  count?: number;
  models?: string[];
  localTime: string;
  timeZone: string;
  app?: string;
};

const CHANNELS: NotificationTemplateChannel[] = ['webhook', 'bark', 'serverchan', 'telegram', 'smtp'];
const PARSE_MODES: NotificationParseMode[] = ['', 'Markdown', 'HTML'];

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeParseMode(value: unknown): NotificationParseMode {
  const normalized = asTrimmedString(value);
  return (PARSE_MODES as string[]).includes(normalized) ? (normalized as NotificationParseMode) : '';
}

function normalizeTemplate(raw: unknown): NotificationTemplate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const template: NotificationTemplate = {};
  const title = asTrimmedString(record.title);
  const body = asTrimmedString(record.body);
  if (title) template.title = title.slice(0, NOTIFICATION_TEMPLATE_MAX_TITLE_LENGTH);
  if (body) template.body = body.slice(0, NOTIFICATION_TEMPLATE_MAX_BODY_LENGTH);
  const parseMode = normalizeParseMode(record.parseMode);
  if (parseMode) template.parseMode = parseMode;
  return template;
}

export function normalizeNotificationTemplates(raw: unknown): NotificationTemplates {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const next: NotificationTemplates = {};
  for (const channel of CHANNELS) {
    const template = normalizeTemplate(record[channel]);
    if (template.title || template.body || template.parseMode) {
      next[channel] = template;
    }
  }
  return next;
}

export async function loadNotificationTemplates(): Promise<NotificationTemplates> {
  try {
    const row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, NOTIFICATION_TEMPLATES_SETTING_KEY))
      .get();
    if (!row?.value) return {};
    return normalizeNotificationTemplates(JSON.parse(row.value));
  } catch {
    return {};
  }
}

export async function saveNotificationTemplates(raw: unknown): Promise<NotificationTemplates> {
  const normalized = normalizeNotificationTemplates(raw);
  await upsertSetting(NOTIFICATION_TEMPLATES_SETTING_KEY, normalized);
  return normalized;
}

export function buildTemplateVarRecord(vars: NotificationTemplateVars): Record<string, string> {
  return {
    title: vars.title,
    message: vars.message,
    level: vars.level,
    count: String(vars.count ?? 0),
    models: (vars.models || []).join(' / '),
    local_time: vars.localTime,
    utc_time: new Date().toISOString(),
    timezone: vars.timeZone,
    app: vars.app || 'metapi',
  };
}

export type RenderedNotificationTemplate = {
  title: string;
  body: string;
  parseMode: NotificationParseMode;
  usedTemplate: boolean;
};

/**
 * 渲染模板。未识别的 `{{xxx}}` 原样保留，调用方（预览 UI）可据此提示用户。
 */
export function renderNotificationTemplate(
  template: NotificationTemplate | undefined,
  vars: NotificationTemplateVars,
  fallback: { title: string; body: string },
): RenderedNotificationTemplate {
  const record = buildTemplateVarRecord(vars);
  const render = (input: string): string => input.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) => (
    Object.prototype.hasOwnProperty.call(record, name) ? record[name] : match
  ));

  const hasTemplate = !!(template && (template.title || template.body));
  if (!hasTemplate) {
    return {
      title: fallback.title,
      body: fallback.body,
      parseMode: '',
      usedTemplate: false,
    };
  }

  return {
    title: template.title ? render(template.title) : fallback.title,
    body: template.body ? render(template.body) : fallback.body,
    parseMode: template.parseMode || '',
    usedTemplate: true,
  };
}

export function findUnknownTemplatePlaceholders(template: NotificationTemplate | undefined): string[] {
  const known = new Set<string>(NOTIFICATION_TEMPLATE_VARIABLES);
  const found = new Set<string>();
  for (const raw of [template?.title || '', template?.body || '']) {
    for (const match of raw.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
      if (!known.has(match[1])) found.add(match[1]);
    }
  }
  return [...found];
}
