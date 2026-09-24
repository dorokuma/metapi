import { eq, inArray, sql } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../db/index.js';

/**
 * 推送模板自定义（事件类型 × 渠道）。
 *
 * 各渠道的默认 payload 是硬编码的（企业微信 markdown 不可用、Bark 只有纯文本 URL 等）。
 * 这里允许按「事件类型 × 渠道」覆盖"标题 + 正文"，留空的渠道继续走默认渲染，行为零变化。
 *
 * 变量使用 `{{name}}` 占位符，不走模板引擎，避免注入与求值风险；
 * 未识别的占位符原样保留（预览里会标红提示）。
 *
 * 解析顺序：`(eventType, channel)` 精确匹配 → `(__global__, channel)` 兜底行 →
 * notifyService 里该渠道的硬编码默认渲染。
 */

export type NotificationTemplateChannel = 'webhook' | 'bark' | 'serverchan' | 'telegram' | 'smtp';
export type NotificationParseMode = '' | 'Markdown' | 'HTML';

export type NotificationTemplate = {
  title?: string;
  body?: string;
  parseMode?: NotificationParseMode;
};

export type NotificationTemplates = Partial<Record<NotificationTemplateChannel, NotificationTemplate>>;

/** 兜底事件类型：未单独定义模板的事件类型（含历史数据）都回退到这一组模板。 */
export const NOTIFICATION_EVENT_GLOBAL = '__global__';

export const NOTIFICATION_EVENT_TYPES = [
  'token',
  'proxy',
  'site_notice',
  'checkin',
  'status',
  'daily_summary',
] as const;

export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number];
export type NotificationEventKey = NotificationEventType | typeof NOTIFICATION_EVENT_GLOBAL;

export type NotificationTemplatesByEvent = Partial<Record<NotificationEventKey, NotificationTemplates>>;

/** 迁移前模板存放在 settings 的 JSON 里；迁移成功后该键会被删除。 */
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
  /** 事件类型专属变量（snake_case），如 daily_summary 的当日花费。 */
  extra?: Record<string, string>;
};

const CHANNELS: NotificationTemplateChannel[] = ['webhook', 'bark', 'serverchan', 'telegram', 'smtp'];
const PARSE_MODES: NotificationParseMode[] = ['', 'Markdown', 'HTML'];
const EVENT_KEYS = [NOTIFICATION_EVENT_GLOBAL, ...NOTIFICATION_EVENT_TYPES] as const;

export function isNotificationEventKey(value: unknown): value is NotificationEventKey {
  return typeof value === 'string' && (EVENT_KEYS as readonly string[]).includes(value);
}

export function isNotificationTemplateChannel(value: unknown): value is NotificationTemplateChannel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/** 各事件类型可用的模板变量；具体事件的专属变量由调用方补充。 */
export function buildNotificationTemplateVariablesByEvent(
  extraByEvent?: Partial<Record<NotificationEventType, readonly string[]>>,
): Record<NotificationEventKey, string[]> {
  const result = {} as Record<NotificationEventKey, string[]>;
  for (const eventKey of EVENT_KEYS) {
    const extra = eventKey === NOTIFICATION_EVENT_GLOBAL ? [] : (extraByEvent?.[eventKey] ?? []);
    result[eventKey] = [...new Set([...NOTIFICATION_TEMPLATE_VARIABLES, ...extra])];
  }
  return result;
}

export type NotificationTemplatesParseResult =
  | { success: true; data: NotificationTemplatesByEvent }
  | { success: false; error: string };

/**
 * 路由层用的严格校验：双层（事件类型 × 渠道）拒绝非法结构，而不是静默清空/截断。
 * 备份导入等内部路径仍可走宽松的 normalizeNotificationTemplatesByEvent。
 *
 * 历史扁平格式（顶层直接是渠道键）在这里识别并归一化成 `__global__` 层，
 * 因此 PUT /api/settings/runtime 收到老客户端/老备份导出的扁平 payload 也返回 200。
 * 扁平与双层不可能混淆：渠道名永远不在事件类型域内，反之亦然。
 */
export function parseNotificationTemplatesInput(raw: unknown): NotificationTemplatesParseResult {
  if (raw === undefined) return { success: true, data: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: 'Invalid notificationTemplates. Expected an object keyed by event type.' };
  }

  const flatInput = raw as Record<string, unknown>;
  // 历史扁平格式上提：channel → template 整体按 __global__ 解析，渠道内字段仍按严格规则校验
  const record = isLegacyFlatShape(flatInput)
    ? { [NOTIFICATION_EVENT_GLOBAL]: flatInput } as Record<string, unknown>
    : flatInput;
  const next: NotificationTemplatesByEvent = {};
  for (const eventKey of Object.keys(record)) {
    if (!isNotificationEventKey(eventKey)) {
      return { success: false, error: `Invalid notificationTemplates event type: ${eventKey}.` };
    }
    const perEvent = record[eventKey];
    if (perEvent === undefined || perEvent === null) continue;
    if (typeof perEvent !== 'object' || Array.isArray(perEvent)) {
      return { success: false, error: `Invalid notificationTemplates.${eventKey}. Expected an object keyed by channel.` };
    }

    const channels = perEvent as Record<string, unknown>;
    const normalizedChannels: NotificationTemplates = {};
    for (const channel of Object.keys(channels)) {
      if (!isNotificationTemplateChannel(channel)) {
        return { success: false, error: `Invalid notificationTemplates.${eventKey} channel: ${channel}.` };
      }
      const value = channels[channel];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { success: false, error: `Invalid notificationTemplates.${eventKey}.${channel}. Expected an object.` };
      }

      const template = value as Record<string, unknown>;
      const normalized: NotificationTemplate = {};
      for (const field of ['title', 'body'] as const) {
        const rawField = template[field];
        if (rawField === undefined || rawField === null) continue;
        if (typeof rawField !== 'string') {
          return { success: false, error: `Invalid notificationTemplates.${eventKey}.${channel}.${field}. Expected a string.` };
        }
        const trimmed = rawField.trim();
        const limit = field === 'title' ? NOTIFICATION_TEMPLATE_MAX_TITLE_LENGTH : NOTIFICATION_TEMPLATE_MAX_BODY_LENGTH;
        if (trimmed.length > limit) {
          return { success: false, error: `Invalid notificationTemplates.${eventKey}.${channel}.${field}. Max length is ${limit}.` };
        }
        if (trimmed) normalized[field] = trimmed;
      }
      if (template.parseMode !== undefined && template.parseMode !== null) {
        if (typeof template.parseMode !== 'string' || !(PARSE_MODES as string[]).includes(template.parseMode)) {
          return { success: false, error: `Invalid notificationTemplates.${eventKey}.${channel}.parseMode. Expected '', Markdown or HTML.` };
        }
        if (template.parseMode) normalized.parseMode = template.parseMode as NotificationParseMode;
      }
      if (normalized.title || normalized.body || normalized.parseMode) {
        normalizedChannels[channel] = normalized;
      }
    }

    if (Object.keys(normalizedChannels).length > 0) {
      next[eventKey] = normalizedChannels;
    }
  }

  return { success: true, data: next };
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Markdown 特殊字符转义（用于变量值渲染时，按渠道规则）；legacy 只转义 _ * ` [ 四个字符 */
function escapeMarkdown(value: string): string {
  return value
    .split('*').join('\\*')
    .split('_').join('\\_')
    .split('`').join('\\`')
    .split('[').join('\\[');
}

/** HTML 特殊字符转义：仅转义 & < > */
function escapeHtml(value: string): string {
  return value
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;');
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

function normalizeChannelTemplates(raw: unknown): NotificationTemplates {
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

export function normalizeNotificationTemplatesByEvent(raw: unknown): NotificationTemplatesByEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const next: NotificationTemplatesByEvent = {};
  for (const eventKey of EVENT_KEYS) {
    const templates = normalizeChannelTemplates(record[eventKey]);
    if (Object.keys(templates).length > 0) {
      next[eventKey] = templates;
    }
  }
  return next;
}

function toTemplateRow(
  eventType: NotificationEventKey,
  channel: NotificationTemplateChannel,
  template: NotificationTemplate,
) {
  return {
    eventType,
    channel,
    title: template.title ?? '',
    body: template.body ?? '',
    parseMode: template.parseMode ?? '',
  };
}

/** 兼容旧扁平结构（channel → template），用于导入历史备份。 */
function isLegacyFlatShape(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.keys(raw as Record<string, unknown>).some((key) => isNotificationTemplateChannel(key));
}

/**
 * 扁平格式兼容的唯一实现点：顶层是渠道键时按 `__global__` 归一化，其余按事件类型归一化。
 * 严格校验（parseNotificationTemplatesInput）与宽松写入（saveNotificationTemplates）共用它，
 * 避免同一份兼容逻辑出现两份漂移的实现。
 */
export function normalizeNotificationTemplatesInput(raw: unknown): NotificationTemplatesByEvent {
  return isLegacyFlatShape(raw)
    ? { [NOTIFICATION_EVENT_GLOBAL]: normalizeChannelTemplates(raw) }
    : normalizeNotificationTemplatesByEvent(raw);
}

/** 读取全部模板（按事件类型分组），供设置页与备份导出使用。 */
export async function loadNotificationTemplates(): Promise<NotificationTemplatesByEvent> {
  await ensureLegacyNotificationTemplatesMigrated();
  try {
    const rows = await db.select().from(schema.notificationTemplates).all();
    const next: NotificationTemplatesByEvent = {};
    for (const row of rows) {
      if (!isNotificationEventKey(row.eventType)) continue;
      if (!isNotificationTemplateChannel(row.channel)) continue;
      const template = normalizeTemplate({ title: row.title, body: row.body, parseMode: row.parseMode });
      if (!template.title && !template.body && !template.parseMode) continue;
      const bucket = next[row.eventType] ?? {};
      bucket[row.channel] = template;
      next[row.eventType] = bucket;
    }
    return next;
  } catch {
    return {};
  }
}

/**
 * 按 (eventType, channel) 查询：一次取出「精确匹配 + __global__ 兜底」两组，
 * 回退顺序由调用方保留（精确 → 全局 → 默认渲染）。
 */
export type ResolvedNotificationTemplates = {
  eventType: NotificationEventKey;
  exact: NotificationTemplates;
  global: NotificationTemplates;
};

/**
 * 按 (eventType, channel) 查询：一次取出「精确匹配 + __global__ 兜底」两组，
 * 回退顺序由调用方保留（精确 → 全局 → 默认渲染）。
 *
 * `eventType` 必填且必须是合法事件键：非法值显式报错，不再静默降级成 `__global__`
 * （静默降级会让写错事件类型的调用点悄悄解析到全局行上，问题无法被测试发现）。
 */
export async function loadNotificationTemplatesForEvent(
  eventType: NotificationEventKey,
): Promise<ResolvedNotificationTemplates> {
  if (!isNotificationEventKey(eventType)) {
    throw new Error(`loadNotificationTemplatesForEvent: invalid eventType "${String(eventType)}".`);
  }
  const lookupKeys = eventType === NOTIFICATION_EVENT_GLOBAL
    ? [NOTIFICATION_EVENT_GLOBAL]
    : [eventType, NOTIFICATION_EVENT_GLOBAL];

  const result: ResolvedNotificationTemplates = {
    eventType,
    exact: {},
    global: {},
  };

  await ensureLegacyNotificationTemplatesMigrated();

  try {
    const rows = await db.select().from(schema.notificationTemplates)
      .where(inArray(schema.notificationTemplates.eventType, lookupKeys))
      .all();
    for (const row of rows) {
      if (!isNotificationTemplateChannel(row.channel)) continue;
      const template = normalizeTemplate({ title: row.title, body: row.body, parseMode: row.parseMode });
      if (!template.title && !template.body && !template.parseMode) continue;
      if (row.eventType === NOTIFICATION_EVENT_GLOBAL) {
        result.global[row.channel] = template;
      } else {
        result.exact[row.channel] = template;
      }
    }
  } catch {
    // 表不存在或查询失败时保持空模板，调用方回退到硬编码默认渲染。
  }

  return result;
}

/**
 * 精确匹配优先，其次 __global__ 兜底行。
 *
 * 字段级回退：exact 只定义了 body 时，title / parseMode 仍从 __global__ 继承；
 * 两级都没有的字段留给渲染层走渠道硬编码默认值。不做整模板替换，
 * 否则「只想改正文」会静默丢掉全局的标题与解析模式。
 */
export function pickEventChannelTemplate(
  resolved: ResolvedNotificationTemplates,
  channel: NotificationTemplateChannel,
): NotificationTemplate | undefined {
  const exact = resolved.exact[channel];
  const global = resolved.global[channel];
  if (!exact) return global;
  if (!global) return exact;

  const merged: NotificationTemplate = {};
  const title = exact.title ?? global.title;
  const body = exact.body ?? global.body;
  const parseMode = exact.parseMode ?? global.parseMode;
  if (title) merged.title = title;
  if (body) merged.body = body;
  if (parseMode) merged.parseMode = parseMode;
  return merged;
}

export function resolveNotificationTemplate(
  templates: NotificationTemplatesByEvent,
  eventType: NotificationEventKey | string | undefined | null,
  channel: NotificationTemplateChannel,
): NotificationTemplate | undefined {
  const exact = isNotificationEventKey(eventType) && eventType !== NOTIFICATION_EVENT_GLOBAL
    ? templates[eventType]?.[channel]
    : undefined;
  const global = templates[NOTIFICATION_EVENT_GLOBAL]?.[channel];
  if (!exact) return global;
  if (!global) return exact;

  const merged: NotificationTemplate = {};
  const title = exact.title ?? global.title;
  const body = exact.body ?? global.body;
  const parseMode = exact.parseMode ?? global.parseMode;
  if (title) merged.title = title;
  if (body) merged.body = body;
  if (parseMode) merged.parseMode = parseMode;
  return merged;
}

export async function saveNotificationTemplates(raw: unknown): Promise<NotificationTemplatesByEvent> {
  // 历史扁平结构（channel → template）按 __global__ 写入，老用户数据不丢（与 parse 共用同一处实现）
  const normalized = normalizeNotificationTemplatesInput(raw);

  await db.transaction(async (tx) => {
    await tx.delete(schema.notificationTemplates).run();
    const rows: ReturnType<typeof toTemplateRow>[] = [];
    for (const eventKey of EVENT_KEYS) {
      const perEvent = normalized[eventKey];
      if (!perEvent) continue;
      for (const channel of CHANNELS) {
        const template = perEvent[channel];
        if (!template) continue;
        rows.push(toTemplateRow(eventKey, channel, template));
      }
    }
    if (rows.length > 0) {
      await tx.insert(schema.notificationTemplates).values(rows).run();
    }
  });

  return normalized;
}

type NotificationTemplateRow = ReturnType<typeof toTemplateRow>;

/**
 * legacy 迁移的进程内标记：启动期迁移（或首次兜底）成功后置位，
 * 命中后热路径（每条通知一次）不再查询 settings。
 * 备份导入可能把旧版本导出的 legacy 键又写回来，所以导入入口
 * （backupService / factoryResetService）需要调 resetLegacyNotificationTemplateMigrationFlag()
 * 重新打开这次检查，之后再次迁移仍保持幂等。
 */
let legacyNotificationTemplatesMigrated = false;

export function resetLegacyNotificationTemplateMigrationFlag(): void {
  legacyNotificationTemplatesMigrated = false;
}

/**
 * 把 `settings.notification_templates_v1` 的旧 JSON 拆成 `(__global__, channel)` 行。
 *
 * 只做「补齐缺失的 __global__ 行」的条件写入：不删除任何已有行，也不覆盖已有行
 * （尤其不能碰用户自己定义的事件覆盖行）。成功后删除 legacy setting；
 * 幂等由 legacy 键先删 + 插入冲突忽略 + 进程内标记三重保证。
 *
 * 多实例/并发安全：SQLite 由单写锁串行化；MySQL 用 `INSERT .. ON DUPLICATE KEY UPDATE`
 * 的幂等写法，SQLite / Postgres 用 `ON CONFLICT DO NOTHING`，任何方言重复执行
 * 都只可能插入缺失行，不会 DELETE/覆盖别人刚写入的行。
 */
export async function ensureLegacyNotificationTemplatesMigrated(): Promise<number> {
  if (legacyNotificationTemplatesMigrated) return 0;

  let legacyRaw = '';
  try {
    const row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, NOTIFICATION_TEMPLATES_SETTING_KEY))
      .get();
    legacyRaw = typeof row?.value === 'string' ? row.value : '';
  } catch {
    return 0;
  }

  // 没有 legacy 键说明已迁移过（或本来就没有旧数据）：置位标记，热路径不再查 settings
  if (!legacyRaw) {
    legacyNotificationTemplatesMigrated = true;
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(legacyRaw);
  } catch {
    parsed = null;
  }

  const globalTemplates = normalizeChannelTemplates(parsed);
  const rows: NotificationTemplateRow[] = CHANNELS
    .map((channel) => (globalTemplates[channel] ? toTemplateRow(NOTIFICATION_EVENT_GLOBAL, channel, globalTemplates[channel]!) : null))
    .filter((row): row is NotificationTemplateRow => row !== null);

  if (rows.length > 0) {
    await insertMissingGlobalTemplateRows(rows);
  }

  try {
    await db.delete(schema.settings).where(eq(schema.settings.key, NOTIFICATION_TEMPLATES_SETTING_KEY)).run();
  } catch {
    // 删除失败不阻塞：下次导入/兜底会继续尝试，且写入只补缺失行不会重复
  }

  legacyNotificationTemplatesMigrated = true;

  return rows.length;
}

/** 只插入缺失的 `__global__` 行；不删除、不覆盖任何已有行。 */
async function insertMissingGlobalTemplateRows(rows: NotificationTemplateRow[]): Promise<void> {
  await db.transaction(async (tx) => {
    if (runtimeDbDialect === 'mysql') {
      // MySQL 没有 ON CONFLICT DO NOTHING，用「主键冲突时把自己赋给自己」的幂等写法
      await (tx.insert(schema.notificationTemplates).values(rows) as any)
        .onDuplicateKeyUpdate({
          set: { channel: sql`${schema.notificationTemplates.channel}` },
        })
        .run();
      return;
    }

    await (tx.insert(schema.notificationTemplates).values(rows) as any)
      .onConflictDoNothing()
      .run();
  });
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
  // 事件类型专属变量（snake_case）后置覆盖，允许同名字段被事件值覆盖
  if (vars.extra && typeof vars.extra === 'object') {
    for (const [key, value] of Object.entries(vars.extra)) {
      if (typeof value !== 'string') continue;
      if (!/^[a-z0-9_]+$/.test(key)) continue;
      record[key] = value;
    }
  }
  return record;
}

/** 对变量值做转义，防止变量内容被 Markdown/HTML 解析 */
function buildEscapedTemplateVarRecord(
  vars: NotificationTemplateVars,
  parseMode: NotificationParseMode,
): Record<string, string> {
  const raw = buildTemplateVarRecord(vars);
  const escaped: Record<string, string> = { ...raw };
  const escapeFn = parseMode === 'HTML' ? escapeHtml : escapeMarkdown;
  // 所有可变内容（含事件类型专属变量）都按渠道规则转义
  for (const key of Object.keys(escaped)) {
    escaped[key] = escapeFn(escaped[key]);
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
  const parseMode = template?.parseMode || '';
  const record = escapeMarkdownValues
    ? buildEscapedTemplateVarRecord(vars, parseMode)
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

export function findUnknownTemplatePlaceholders(
  template: NotificationTemplate | undefined,
  knownVariables: readonly string[] = NOTIFICATION_TEMPLATE_VARIABLES,
): string[] {
  const known = new Set<string>(knownVariables);
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
