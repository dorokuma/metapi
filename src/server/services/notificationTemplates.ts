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
  /** 风暴聚合累计次数；仅聚合路径有值，未提供时渲染为空串而非 0。 */
  count?: number;
  /** 涉及模型列表；未提供时渲染为空串。 */
  models?: string[];
  localTime: string;
  timeZone: string;
  app?: string;
};

const CHANNELS: NotificationTemplateChannel[] = ['webhook', 'bark', 'serverchan', 'telegram', 'smtp'];
const PARSE_MODES: NotificationParseMode[] = ['', 'Markdown', 'HTML'];

export type NotificationTemplatesParseResult =
  | { success: true; data: NotificationTemplates }
  | { success: false; error: string };

/**
 * 路由层用的严格校验：拒绝非法结构而不是静默清空/截断。
 * 备份导入等内部路径仍可走宽松的 normalizeNotificationTemplates。
 */
export function parseNotificationTemplatesInput(raw: unknown): NotificationTemplatesParseResult {
  if (raw === undefined) return { success: true, data: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: 'Invalid notificationTemplates. Expected an object keyed by channel.' };
  }

  const record = raw as Record<string, unknown>;
  const next: NotificationTemplates = {};
  for (const key of Object.keys(record)) {
    if (!(CHANNELS as string[]).includes(key)) {
      return { success: false, error: `Invalid notificationTemplates channel: ${key}.` };
    }
    const channel = key as NotificationTemplateChannel;
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { success: false, error: `Invalid notificationTemplates.${key}. Expected an object.` };
    }

    const template = value as Record<string, unknown>;
    const normalized: NotificationTemplate = {};
    for (const field of ['title', 'body'] as const) {
      const rawField = template[field];
      if (rawField === undefined || rawField === null) continue;
      if (typeof rawField !== 'string') {
        return { success: false, error: `Invalid notificationTemplates.${key}.${field}. Expected a string.` };
      }
      const trimmed = rawField.trim();
      const limit = field === 'title' ? NOTIFICATION_TEMPLATE_MAX_TITLE_LENGTH : NOTIFICATION_TEMPLATE_MAX_BODY_LENGTH;
      if (trimmed.length > limit) {
        return { success: false, error: `Invalid notificationTemplates.${key}.${field}. Max length is ${limit}.` };
      }
      if (trimmed) normalized[field] = trimmed;
    }
    if (template.parseMode !== undefined && template.parseMode !== null) {
      if (typeof template.parseMode !== 'string' || !(PARSE_MODES as string[]).includes(template.parseMode)) {
        return { success: false, error: `Invalid notificationTemplates.${key}.parseMode. Expected '', Markdown or HTML.` };
      }
      if (template.parseMode) normalized.parseMode = template.parseMode as NotificationParseMode;
    }
    if (normalized.title || normalized.body || normalized.parseMode) {
      next[channel] = normalized;
    }
  }

  return { success: true, data: next };
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Markdown 特殊字符转义（用于变量值渲染时，按渠道规则） */
function escapeMarkdown(value: string): string {
  return value
    .split('\\').join('\\\\')
    .split('*').join('\\*')
    .split('_').join('\\_')
    .split('`').join('\\`')
    .split('[').join('\\[')
    .split(']').join('\\]');
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
  const record: Record<string, string> = {
    title: vars.title,
    message: vars.message,
    level: vars.level,
    // count/models 只在风暴聚合路径有值；未提供时渲染为空串，避免误导性的 "0"
    count: '',
    models: '',
    local_time: vars.localTime,
    utc_time: new Date().toISOString(),
    timezone: vars.timeZone,
    app: vars.app || 'metapi',
  };
  if (typeof vars.count === 'number' && Number.isFinite(vars.count)) {
    record.count = String(Math.max(0, Math.trunc(vars.count)));
  }
  if (Array.isArray(vars.models)) {
    record.models = vars.models.join(' / ');
  }
  return record;
}

/** 对变量值做 Markdown 转义，防止变量内容（如 model 名含链接语法）被 Markdown 解析 */
function buildEscapedTemplateVarRecord(vars: NotificationTemplateVars): Record<string, string> {
  const raw = buildTemplateVarRecord(vars);
  const escaped: Record<string, string> = { ...raw };
  // 只转义可变内容字段，不转义固定元数据
  for (const key of ['title', 'message', 'level', 'count', 'models', 'local_time', 'utc_time', 'timezone', 'app']) {
    if (Object.prototype.hasOwnProperty.call(escaped, key)) {
      escaped[key] = escapeMarkdown(escaped[key]);
    }
  }
  return escaped;
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
  escapeMarkdownValues = false,
): RenderedNotificationTemplate {
  const record = escapeMarkdownValues
    ? buildEscapedTemplateVarRecord(vars)
    : buildTemplateVarRecord(vars);
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

/** 供 notifyService 使用的便捷接口：变量值转义 */
export function renderEscapedNotificationTemplate(
  template: NotificationTemplate | undefined,
  vars: NotificationTemplateVars,
  fallback: { title: string; body: string },
): RenderedNotificationTemplate {
  return renderNotificationTemplate(template, vars, fallback, true);
}
