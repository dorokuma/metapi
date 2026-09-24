import { fetch } from 'undici';
import { config } from '../config.js';
import { withExplicitProxyRequestInit } from './siteProxy.js';
import nodemailer, { type Transporter } from 'nodemailer';
import {
  createNotificationSignature,
  evaluateNotificationThrottle,
  pruneNotificationThrottleState,
  type NotificationThrottleState,
} from './notificationThrottle.js';
import {
  isNotificationEventKey,
  loadNotificationTemplatesForEvent,
  pickEventChannelTemplate,
  renderNotificationTemplate,
  renderEscapedNotificationTemplate,
  type NotificationEventKey,
  type NotificationTemplateVars,
  type NotificationTemplateChannel,
  type RenderedNotificationTemplate,
} from './notificationTemplates.js';
import { formatLocalDateTime, getResolvedTimeZone } from './localTimeService.js';

const BARK_MAX_BODY_LENGTH = 3500;
const TELEGRAM_MAX_TEXT_LENGTH = 3900;
const WECHAT_MAX_BODY_BYTES = 1900;
const FEISHU_MAX_BODY_BYTES = 3900;

/** UTF-8 字节截断：超长时逐字符回退，确保不破坏多字节字符 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let truncated = text.slice(0, maxBytes);
  while (truncated.length > 0 && Buffer.byteLength(truncated, 'utf8') > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

type NotificationChannel = 'webhook' | 'bark' | 'serverchan' | 'telegram' | 'smtp';

export type SendNotificationOptions = {
  bypassThrottle?: boolean;
  requireChannel?: boolean;
  throwOnFailure?: boolean;
  /** 风暴聚合上下文：供 {{count}} / {{models}} 变量渲染。 */
  storm?: { count?: number; models?: string[] };
  /** 事件类型专属变量（snake_case），如 daily_summary 的当日花费。 */
  extraVars?: Record<string, string>;
};

export type NotificationDispatchResult = {
  throttled: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  failedChannels: NotificationChannel[];
};

let cachedSmtpFingerprint = '';
let cachedTransporter: Transporter | null = null;
const notificationThrottleState = new Map<string, NotificationThrottleState>();

function getSmtpFingerprint() {
  return [
    config.smtpHost,
    config.smtpPort,
    config.smtpSecure ? '1' : '0',
    config.smtpUser,
    config.smtpPass,
    config.smtpFrom,
    config.smtpTo,
  ].join('|');
}

function getSmtpTransporter() {
  const fingerprint = getSmtpFingerprint();
  if (cachedTransporter && cachedSmtpFingerprint === fingerprint) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser
      ? {
        user: config.smtpUser,
        pass: config.smtpPass,
      }
      : undefined,
  });
  cachedSmtpFingerprint = fingerprint;
  return cachedTransporter;
}

function buildTimeFootnote(now: Date): string {
  const timeZone = getResolvedTimeZone();
  return [
    `Local Time: ${formatLocalDateTime(now)} (${timeZone})`,
    `UTC Time: ${now.toISOString()}`,
  ].join('\n');
}

function buildTelegramText(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxTextLength = 3900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\nLevel: ${level}\n${timeFootnote}`;
  if (raw.length <= maxTextLength) return raw;
  return `${raw.slice(0, maxTextLength)}\n\n...(truncated)`;
}

function isWeComBotWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'qyapi.weixin.qq.com' && parsed.pathname.includes('/cgi-bin/webhook/send');
  } catch {
    return false;
  }
}

function buildWeComText(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxLength = 1900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\n...(truncated)`;
}

function buildWeComTextUtf8(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxBytes = WECHAT_MAX_BODY_BYTES;
  const suffix = '\n…\n...(truncated)';
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw;
  const truncated = truncateUtf8Bytes(raw, Math.max(0, maxBytes - suffixBytes));
  return `${truncated}${suffix}`;
}

function isFeishuBotWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'open.feishu.cn' || parsed.hostname === 'open.larksuite.com')
      && parsed.pathname.includes('/open-apis/bot/v2/hook/')
    );
  } catch {
    return false;
  }
}

function buildFeishuText(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxLength = 3900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\n...(truncated)`;
}

function buildFeishuTextUtf8(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  timeFootnote: string,
): string {
  const maxBytes = FEISHU_MAX_BODY_BYTES;
  const suffix = '\n…\n...(truncated)';
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw;
  const truncated = truncateUtf8Bytes(raw, Math.max(0, maxBytes - suffixBytes));
  return `${truncated}${suffix}`;
}

/**
 * 发送通知。
 *
 * `eventType` 为必填参数且没有静默默认值（排在 `level` 之前：必填位前置，
 * 调用点不能靠默认值把事件类型漏掉），调用方必须显式声明这条通知属于哪类事件，
 * 模板解析才能走「精确匹配 → __global__ 兜底 → 渠道默认渲染」的顺序。
 * 非法事件类型显式抛错，避免悄悄落到全局模板上。
 */
export async function sendNotification(
  title: string,
  message: string,
  eventType: NotificationEventKey,
  level: 'info' | 'warning' | 'error' = 'info',
  options: SendNotificationOptions = {},
): Promise<NotificationDispatchResult> {
  if (!isNotificationEventKey(eventType)) {
    throw new Error(`sendNotification: invalid eventType "${String(eventType)}".`);
  }
  const now = new Date();
  const timeFootnote = buildTimeFootnote(now);
  const { bypassThrottle = false, requireChannel = false, throwOnFailure = false, storm, extraVars } = options;
  const cooldownMs = Math.max(0, Math.trunc(config.notifyCooldownSec)) * 1000;
  let resolvedMessage = message;
  if (!bypassThrottle && cooldownMs > 0) {
    const nowMs = Date.now();
    pruneNotificationThrottleState(notificationThrottleState, nowMs, Math.max(cooldownMs * 6, 600_000));
    const signature = createNotificationSignature(title, message, level);
    const decision = evaluateNotificationThrottle(notificationThrottleState, signature, nowMs, cooldownMs);
    if (!decision.shouldSend) {
      return {
        throttled: true,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failedChannels: [],
      };
    }
    if (decision.mergedCount > 0) {
      resolvedMessage = `${message}\n\n[通知合并] 冷静期内已合并 ${decision.mergedCount} 条重复告警`;
    }
  }

  // 自定义模板：按 eventType 取精确匹配，缺省时回退 __global__，再缺省沿用默认渲染
  const resolvedTemplates = await loadNotificationTemplatesForEvent(eventType);
  const templateVars: NotificationTemplateVars = {
    title,
    message: resolvedMessage,
    level,
    localTime: formatLocalDateTime(now),
    timeZone: getResolvedTimeZone(),
  };
  if (extraVars) templateVars.extra = extraVars;
  if (typeof storm?.count === 'number') templateVars.count = storm.count;
  if (Array.isArray(storm?.models)) templateVars.models = storm.models;
  const renderChannel = (
    channel: NotificationTemplateChannel,
    fallback: { title: string; body: string },
  ): RenderedNotificationTemplate => {
    const chTemplate = pickEventChannelTemplate(resolvedTemplates, channel);
    const parseMode = chTemplate?.parseMode ?? '';
    if (parseMode === 'HTML') {
      // HTML 渠道：仅转义 & < >
      return renderEscapedNotificationTemplate(chTemplate, templateVars, fallback);
    }
    if (parseMode === 'Markdown') {
      // Markdown 渠道：转义 _ * ` [ ]
      return renderEscapedNotificationTemplate(chTemplate, templateVars, fallback);
    }
    return renderNotificationTemplate(chTemplate, templateVars, fallback);
  };

  const tasks: Array<{ channel: NotificationChannel; run: () => Promise<unknown> }> = [];

  if (config.webhookEnabled && config.webhookUrl) {
    const webhookTemplate = pickEventChannelTemplate(resolvedTemplates, 'webhook');
    const webhookRendered = renderChannel('webhook', { title, body: resolvedMessage });
    const isWeComWebhook = isWeComBotWebhook(config.webhookUrl);
    const isFeishuWebhook = isFeishuBotWebhook(config.webhookUrl);
    // 自定义模板时不套官方 [metapi][LEVEL] 头与时间脚注，内容完全由模板决定
    const makeWeComFeishuBody = (customContent: string | null): string => {
      if (!customContent) return customContent as unknown as string;
      const suffix = '\n…\n...(truncated)';
      if (isWeComWebhook) {
        const maxBytes = WECHAT_MAX_BODY_BYTES;
        const suffixBytes = Buffer.byteLength(suffix, 'utf8');
        if (Buffer.byteLength(customContent, 'utf8') > maxBytes) {
          return `${truncateUtf8Bytes(customContent, Math.max(0, maxBytes - suffixBytes))}${suffix}`;
        }
        return customContent;
      }
      if (isFeishuWebhook) {
        const maxBytes = FEISHU_MAX_BODY_BYTES;
        const suffixBytes = Buffer.byteLength(suffix, 'utf8');
        if (Buffer.byteLength(customContent, 'utf8') > maxBytes) {
          return `${truncateUtf8Bytes(customContent, Math.max(0, maxBytes - suffixBytes))}${suffix}`;
        }
        return customContent;
      }
      return customContent;
    };
    const weComFeishuContent = webhookRendered.usedTemplate
      ? makeWeComFeishuBody([
        webhookTemplate?.title ? webhookRendered.title : '',
        webhookRendered.body,
      ].filter(Boolean).join('\n'))
      : null;
    tasks.push(
      {
        channel: 'webhook',
        run: async () => {
          let body: string;
          if (isWeComWebhook) {
            const customText = weComFeishuContent ?? buildWeComTextUtf8(title, resolvedMessage, level, timeFootnote);
            body = JSON.stringify({
              msgtype: 'text',
              text: {
                content: customText,
              },
            });
          } else if (isFeishuWebhook) {
            const customText = weComFeishuContent ?? buildFeishuTextUtf8(title, resolvedMessage, level, timeFootnote);
            body = JSON.stringify({
              msg_type: 'text',
              content: {
                text: customText,
              },
            });
          } else {
            body = JSON.stringify({
              title: webhookRendered.title,
              message: webhookRendered.body,
              level,
              timestamp: now.toISOString(),
              localTime: formatLocalDateTime(now),
              timeZone: getResolvedTimeZone(),
            });
          }
          const response = await fetch(config.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          if (!response.ok) {
            throw new Error(`Webhook 响应状态 ${response.status}`);
          }
          if (isWeComWebhook) {
            let payload: { errcode?: number; errmsg?: string } | null = null;
            try {
              payload = await response.json() as { errcode?: number; errmsg?: string };
            } catch {
              throw new Error('企业微信 Webhook 返回了无效 JSON');
            }
            if (typeof payload?.errcode === 'number' && payload.errcode !== 0) {
              throw new Error(`企业微信 Webhook 返回错误 ${payload.errcode}: ${payload.errmsg || 'unknown error'}`);
            }
          }
          if (isFeishuWebhook) {
            let payload: { code?: number; msg?: string } | null = null;
            try {
              payload = await response.json() as { code?: number; msg?: string };
            } catch {
              throw new Error('飞书 Webhook 返回了无效 JSON');
            }
            if (typeof payload?.code === 'number' && payload.code !== 0) {
              throw new Error(`飞书 Webhook 返回错误 ${payload.code}: ${payload.msg || 'unknown error'}`);
            }
          }
        },
      },
    );
  }

  if (config.barkEnabled && config.barkUrl) {
    const barkRendered = renderChannel('bark', { title, body: resolvedMessage });
    const barkBase = config.barkUrl.replace(/\/+$/, '');
    // Bark 把正文放进 URL：超长正文会导致请求失败，按 encode 后 URL 总长度截断
    const prefix = `${barkBase}/${encodeURIComponent(barkRendered.title)}/`;
    const suffix = `?group=AllApiHub&level=${encodeURIComponent(level)}`;
    const budget = Math.max(1, 8000 - prefix.length - suffix.length);
    const encoded = encodeURIComponent(barkRendered.body);
    const truncateEncoded = (enc: string, maxBytes: number): string => {
      // We have maxBytes for the percent-encoded body. Back-decide raw char budget:
      // iteratively reduce raw text until encodeURIComponent fits in maxBytes.
      let raw = barkRendered.body;
      while (encodeURIComponent(raw + '…').length > maxBytes && raw.length > 0) {
        raw = raw.slice(0, -1);
      }
      return raw ? `${raw}…` : '…';
    };
    const barkBody = encoded.length > budget
      ? truncateEncoded(encoded, budget)
      : barkRendered.body;
    const url = `${prefix}${encodeURIComponent(barkBody)}${suffix}`;
    tasks.push({
      channel: 'bark',
      run: async () => {
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
          throw new Error(`Bark 响应状态 ${response.status}`);
        }
      },
    });
  }

  if (config.serverChanEnabled && config.serverChanKey) {
    const serverChanRendered = renderChannel('serverchan', { title, body: resolvedMessage });
    const form = new URLSearchParams({
      title: serverChanRendered.title,
      desp: `${serverChanRendered.body}\n\nLevel: ${level}\n${timeFootnote}`,
    });
    tasks.push(
      {
        channel: 'serverchan',
        run: async () => {
          const response = await fetch(`https://sctapi.ftqq.com/${config.serverChanKey}.send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
          });
          if (!response.ok) {
            throw new Error(`Server酱响应状态 ${response.status}`);
          }
        },
      },
    );
  }

  if (config.telegramEnabled && config.telegramBotToken && config.telegramChatId) {
    const telegramTemplate = pickEventChannelTemplate(resolvedTemplates, 'telegram');
    const telegramRendered = renderChannel('telegram', {
      title,
      body: buildTelegramText(title, resolvedMessage, level, timeFootnote),
    });
    const telegramText = telegramRendered.usedTemplate
      ? [
        telegramTemplate?.title ? telegramRendered.title : '',
        telegramRendered.body,
      ].filter(Boolean).join('\n')
      : buildTelegramText(title, resolvedMessage, level, timeFootnote);
    const telegramApiBaseUrl = String(config.telegramApiBaseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
    const telegramApiUrl = `${telegramApiBaseUrl}/bot${config.telegramBotToken}/sendMessage`;
    const telegramMessageThreadId = Number.parseInt(String(config.telegramMessageThreadId || '').trim(), 10);
    const telegramParseMode = telegramRendered.parseMode;
    const sendTelegram = async (withParseMode: boolean): Promise<void> => {
      let response;
      try {
        response = await fetch(telegramApiUrl, withExplicitProxyRequestInit(
          config.telegramUseSystemProxy ? config.systemProxyUrl : null,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: config.telegramChatId,
              ...(Number.isFinite(telegramMessageThreadId) && telegramMessageThreadId > 0
                ? { message_thread_id: telegramMessageThreadId }
                : {}),
              text: telegramText.length > TELEGRAM_MAX_TEXT_LENGTH
                ? `${telegramText.slice(0, TELEGRAM_MAX_TEXT_LENGTH)}\n\n...(truncated)`
                : telegramText,
              disable_web_page_preview: true,
              ...(withParseMode && telegramParseMode ? { parse_mode: telegramParseMode } : {}),
            }),
          },
        ));
      } catch (networkError) {
        throw new Error(`Telegram 网络错误: ${networkError instanceof Error ? networkError.message : String(networkError)}`);
      }
      if (!response.ok) {
        let description = `HTTP ${response.status}`;
        try {
          const errPayload = await response.json() as { description?: string };
          if (errPayload?.description) description = errPayload.description;
        } catch {}
        throw Object.assign(new Error(`Telegram 响应状态 ${response.status}: ${description}`), { status: response.status, description });
      }
      let payload: { ok?: boolean; description?: string } | null = null;
      try {
        payload = await response.json() as { ok?: boolean; description?: string };
      } catch {}
      if (payload?.ok === false) {
        const desc = payload.description || 'Telegram 返回失败';
        throw Object.assign(new Error(desc), { status: 400, description: desc });
      }
    };
    tasks.push({
      channel: 'telegram',
      run: async () => {
        try {
          await sendTelegram(true);
        } catch (error) {
          // 仅 400 且错误为 parse entity 相关时才去掉 parse_mode 重发一次；
          // 429/超时等其他错误直接上报，避免重复告警并加重限流
          const status = typeof (error as any)?.status === 'number' ? (error as any).status : null;
          const message = typeof (error as any)?.message === 'string' ? (error as any).message.toLowerCase() : '';
          const is400ParseEntity = status === 400
            && (/parse.*entity|can't parse entities|message is too long|message text is empty/.test(message)
              || message.includes('Bad Request: can\'t parse entities')
              || message.includes('parse entity'));
          if (!telegramParseMode || !is400ParseEntity) throw error;
          await sendTelegram(false);
        }
      },
    });
  }

  if (
    config.smtpEnabled &&
    config.smtpHost &&
    config.smtpPort > 0 &&
    config.smtpFrom &&
    config.smtpTo
  ) {
    const smtpTemplate = pickEventChannelTemplate(resolvedTemplates, 'smtp');
    const smtpRendered = renderChannel('smtp', { title, body: resolvedMessage });
    const transporter = getSmtpTransporter();
    tasks.push(
      {
        channel: 'smtp',
        run: () => transporter.sendMail({
          from: config.smtpFrom,
          to: config.smtpTo,
          subject: smtpTemplate?.title
            ? smtpRendered.title
            : `[metapi][${level.toUpperCase()}] ${title}`,
          text: `${smtpRendered.body}\n\nLevel: ${level}\n${timeFootnote}`,
        }),
      },
    );
  }

  if (tasks.length === 0) {
    if (requireChannel || throwOnFailure) {
      throw new Error('未启用任何通知渠道，请先开启并保存至少一种通知方式');
    }
    return {
      throttled: false,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      failedChannels: [],
    };
  }

  const results = await Promise.all(tasks.map(async (task) => {
    try {
      await task.run();
      return { channel: task.channel, ok: true as const, error: '' };
    } catch (error: any) {
      return {
        channel: task.channel,
        ok: false as const,
        error: error?.message || String(error) || 'unknown error',
      };
    }
  }));

  const failedResults = results.filter((item) => !item.ok);
  const succeeded = results.length - failedResults.length;
  const failedChannels = failedResults.map((item) => item.channel);

  if (throwOnFailure && succeeded === 0 && failedResults.length > 0) {
    throw new Error(`通知发送失败：${failedResults[0].error}`);
  }

  return {
    throttled: false,
    attempted: results.length,
    succeeded,
    failed: failedResults.length,
    failedChannels,
  };
}
