import React, { useEffect, useMemo, useState } from 'react';
import { api, type RuntimeSettingsPayload } from '../api.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';

type TemplateChannel = 'webhook' | 'bark' | 'serverchan' | 'telegram' | 'smtp';
type TemplateParseMode = '' | 'Markdown' | 'HTML';
/** '__global__' 为兜底模板：未单独定义的类型/渠道都回退到它。 */
type TemplateEventKey = '__global__' | 'token' | 'proxy' | 'site_notice' | 'checkin' | 'status' | 'daily_summary';

type NotificationTemplate = {
    title?: string;
    body?: string;
    parseMode?: TemplateParseMode;
};

type NotificationTemplatesByEvent = Partial<Record<TemplateEventKey, Partial<Record<TemplateChannel, NotificationTemplate>>>>;

const GLOBAL_EVENT_KEY: TemplateEventKey = '__global__';

const TEMPLATE_EVENT_TYPES: Array<{ value: TemplateEventKey; label: string; hint: string }> = [
    { value: '__global__', label: '全局', hint: '未单独定义模板的事件类型都会使用这一组模板' },
    { value: 'token', label: 'Token 失效', hint: '账号访问令牌失效' },
    { value: 'proxy', label: '代理告警', hint: '代理全部失败等路由级告警' },
    { value: 'site_notice', label: '站点公告', hint: '上游站点公告推送' },
    { value: 'checkin', label: '签到', hint: '签到失败 / Cloudflare 挑战' },
    { value: 'status', label: '系统状态', hint: '后台任务与更新中心提醒' },
    { value: 'daily_summary', label: '每日总结', hint: '每日统计汇总，支持专属变量' },
];

const TEMPLATE_CHANNELS: Array<{ value: TemplateChannel; label: string }> = [
    { value: 'telegram', label: 'Telegram' },
    { value: 'webhook', label: 'Webhook' },
    { value: 'bark', label: 'Bark' },
    { value: 'serverchan', label: 'Server酱' },
    { value: 'smtp', label: 'SMTP 邮件' },
];

const TEMPLATE_VARIABLES: Array<{ name: string; hint: string }> = [
    { name: 'title', hint: '告警标题' },
    { name: 'message', hint: '告警正文' },
    { name: 'level', hint: '级别 info/warning/error' },
    { name: 'count', hint: '风暴聚合累计次数' },
    { name: 'models', hint: '涉及模型列表' },
    { name: 'local_time', hint: '本地时间' },
    { name: 'utc_time', hint: 'UTC 时间' },
    { name: 'timezone', hint: '时区' },
    { name: 'app', hint: '应用名 metapi' },
];

/** daily_summary 专属变量（snake_case，与服务端 buildDailySummaryTemplateVars 对齐）。 */
const DAILY_SUMMARY_VARIABLES: Array<{ name: string; hint: string }> = [
    { name: 'local_day', hint: '统计日期' },
    { name: 'generated_at_local', hint: '生成时间（本地）' },
    { name: 'total_accounts', hint: '账号总数' },
    { name: 'active_accounts', hint: '活跃账号数' },
    { name: 'low_balance_accounts', hint: '低余额(<$1)账号数' },
    { name: 'checkin_total', hint: '签到总数' },
    { name: 'checkin_success', hint: '签到成功数' },
    { name: 'checkin_skipped', hint: '签到跳过数' },
    { name: 'checkin_failed', hint: '签到失败数' },
    { name: 'proxy_total', hint: '代理请求总数' },
    { name: 'proxy_success', hint: '代理成功数' },
    { name: 'proxy_failed', hint: '代理失败数' },
    { name: 'proxy_total_tokens', hint: '当日 Tokens' },
    { name: 'today_spend', hint: '当日支出（美元）' },
    { name: 'today_reward', hint: '当日奖励（美元）' },
    { name: 'today_net', hint: '当日净值（美元）' },
];

const PREVIEW_VARS: Record<string, string> = {
    title: '代理全部失败',
    message: '模型=grok-4.6, 原因=No available channels after retries',
    level: 'error',
    count: '6',
    models: 'grok-4.6 / grok-4.7 / glm-5.3-flash',
    local_time: '2026-09-22 10:30:00',
    utc_time: '2026-09-22T02:30:00.000Z',
    timezone: 'Asia/Shanghai',
    app: 'metapi',
};

/** daily_summary 预览用的专属变量示例值。 */
const PREVIEW_DAILY_SUMMARY_VARS: Record<string, string> = {
    local_day: '2026-09-22',
    generated_at_local: '2026-09-22 23:58:00',
    total_accounts: '12',
    active_accounts: '10',
    low_balance_accounts: '3',
    checkin_total: '10',
    checkin_success: '8',
    checkin_skipped: '1',
    checkin_failed: '1',
    proxy_total: '1024',
    proxy_success: '980',
    proxy_failed: '44',
    proxy_total_tokens: '12,345,678',
    today_spend: '3.141592',
    today_reward: '5.200000',
    today_net: '2.058408',
};

function renderPreview(
    template: NotificationTemplate | undefined,
    channel: TemplateChannel,
    vars: Record<string, string>,
): { title: string; body: string } {
    const render = (input: string) => input.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) => (
        Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match
    ));
    const level = vars.level || 'error';
    // 与 notifyService 的 subject 规则保持一致：无自定义标题时 SMTP 带官方前缀
    const fallbackTitle = channel === 'smtp'
        ? `[metapi][${level.toUpperCase()}] ${vars.title}`
        : vars.title;
    if (!template || (!template.title && !template.body)) {
        return channel === 'smtp'
            ? { title: fallbackTitle, body: `${vars.message}\n\nLevel: ${level}\nLocal Time: ${vars.local_time}` }
            : { title: fallbackTitle, body: `[metapi][${level.toUpperCase()}] ${vars.title}\n\n${vars.message}\n\nLevel: ${level}\nLocal Time: ${vars.local_time}` };
    }
    return {
        title: template.title ? render(template.title) : fallbackTitle,
        body: template.body ? render(template.body) : `${vars.message}\n\nLevel: ${level}`,
    };
}

type RuntimeSettings = {
    webhookUrl: string;
    barkUrl: string;
    webhookEnabled: boolean;
    barkEnabled: boolean;
    serverChanEnabled: boolean;
    telegramEnabled: boolean;
    telegramApiBaseUrl: string;
    telegramChatId: string;
    telegramUseSystemProxy: boolean;
    telegramMessageThreadId: string;
    smtpEnabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    smtpPassMasked?: string;
    smtpFrom: string;
    smtpTo: string;
    serverChanKeyMasked?: string;
    telegramBotTokenMasked?: string;
    notifyCooldownSec: number;
    notificationTemplates: NotificationTemplatesByEvent;
};

function isTemplateEmpty(template: NotificationTemplate | undefined): boolean {
    return !template || (!template.title && !template.body && !template.parseMode);
}

function TemplatePreview({
    channel,
    template,
    vars,
}: {
    channel: TemplateChannel;
    template: NotificationTemplate | undefined;
    vars: Record<string, string>;
}) {
    const preview = useMemo(() => renderPreview(template, channel, vars), [template, channel, vars]);
    return (
        <div
            data-testid="template-preview"
            style={{
                padding: 14,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-light)',
                background: 'var(--color-bg)',
                fontSize: 13,
                lineHeight: 1.8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)',
                maxHeight: 260,
                overflow: 'auto',
            }}
        >
            <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>{preview.title}</div>
            <div>{preview.body}</div>
        </div>
    );
}

export default function NotificationSettings() {
    const templateBodyRef = React.useRef<HTMLTextAreaElement | null>(null);
    const [isBodyFocused, setIsBodyFocused] = useState(false);
    const [runtime, setRuntime] = useState<RuntimeSettings>({
        webhookUrl: '',
        barkUrl: '',
        webhookEnabled: true,
        barkEnabled: true,
        serverChanEnabled: false,
        telegramEnabled: false,
        telegramApiBaseUrl: 'https://api.telegram.org',
        telegramChatId: '',
        telegramUseSystemProxy: false,
        telegramMessageThreadId: '',
        smtpEnabled: false,
        smtpHost: '',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: '',
        smtpFrom: '',
        smtpTo: '',
        notifyCooldownSec: 300,
        notificationTemplates: {},
    });

    const [activeTemplateEvent, setActiveTemplateEvent] = useState<TemplateEventKey>(GLOBAL_EVENT_KEY);
    const [activeTemplateChannel, setActiveTemplateChannel] = useState<TemplateChannel>('telegram');

    const [serverChanKey, setServerChanKey] = useState('');
    const [telegramBotToken, setTelegramBotToken] = useState('');
    const [smtpPass, setSmtpPass] = useState('');
    const [loading, setLoading] = useState(true);
    const [savingNotify, setSavingNotify] = useState(false);
    const [testingNotify, setTestingNotify] = useState(false);
    const toast = useToast();

    const inputStyle: React.CSSProperties = {
        width: '100%',
        padding: '10px 14px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        outline: 'none',
        background: 'var(--color-bg)',
        color: 'var(--color-text-primary)',
        transition: 'border-color 0.2s',
    };

    const loadSettings = async () => {
        setLoading(true);
        try {
            const runtimeInfo = await api.getRuntimeSettings();
            const rawTemplates = (runtimeInfo.notificationTemplates || {}) as NotificationTemplatesByEvent;
            // 兼容旧版扁平结构（channel → template）：整体按 __global__ 读入。
            const templates: NotificationTemplatesByEvent = TEMPLATE_EVENT_TYPES.some((item) => item.value in rawTemplates)
                ? rawTemplates
                : { [GLOBAL_EVENT_KEY]: rawTemplates as NotificationTemplatesByEvent[typeof GLOBAL_EVENT_KEY] };
            setRuntime({
                webhookUrl: runtimeInfo.webhookUrl || '',
                barkUrl: runtimeInfo.barkUrl || '',
                webhookEnabled: runtimeInfo.webhookEnabled ?? true,
                barkEnabled: runtimeInfo.barkEnabled ?? true,
                serverChanEnabled: !!runtimeInfo.serverChanEnabled,
                telegramEnabled: !!runtimeInfo.telegramEnabled,
                telegramApiBaseUrl: runtimeInfo.telegramApiBaseUrl || 'https://api.telegram.org',
                telegramChatId: runtimeInfo.telegramChatId || '',
                telegramUseSystemProxy: !!runtimeInfo.telegramUseSystemProxy,
                telegramMessageThreadId: runtimeInfo.telegramMessageThreadId || '',
                smtpEnabled: !!runtimeInfo.smtpEnabled,
                smtpHost: runtimeInfo.smtpHost || '',
                smtpPort: Number(runtimeInfo.smtpPort) || 587,
                smtpSecure: !!runtimeInfo.smtpSecure,
                smtpUser: runtimeInfo.smtpUser || '',
                smtpPassMasked: runtimeInfo.smtpPassMasked || '',
                smtpFrom: runtimeInfo.smtpFrom || '',
                smtpTo: runtimeInfo.smtpTo || '',
                serverChanKeyMasked: runtimeInfo.serverChanKeyMasked || '',
                telegramBotTokenMasked: runtimeInfo.telegramBotTokenMasked || '',
                notifyCooldownSec: Number.isFinite(Number(runtimeInfo.notifyCooldownSec))
                    ? Math.max(0, Math.trunc(Number(runtimeInfo.notifyCooldownSec)))
                    : 300,
                notificationTemplates: templates,
            });
        } catch (err: any) {
            toast.error(err?.message || '加载通知设置失败');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSettings();
    }, []);

    const saveNotify = async () => {
        setSavingNotify(true);
        try {
            const payload: RuntimeSettingsPayload = {
                webhookUrl: runtime.webhookUrl,
                barkUrl: runtime.barkUrl,
                webhookEnabled: runtime.webhookEnabled,
                barkEnabled: runtime.barkEnabled,
                serverChanEnabled: runtime.serverChanEnabled,
                telegramEnabled: runtime.telegramEnabled,
                telegramApiBaseUrl: runtime.telegramApiBaseUrl,
                telegramChatId: runtime.telegramChatId,
                telegramUseSystemProxy: runtime.telegramUseSystemProxy,
                telegramMessageThreadId: runtime.telegramMessageThreadId,
                smtpEnabled: runtime.smtpEnabled,
                smtpHost: runtime.smtpHost,
                smtpPort: runtime.smtpPort,
                smtpSecure: runtime.smtpSecure,
                smtpUser: runtime.smtpUser,
                smtpFrom: runtime.smtpFrom,
                smtpTo: runtime.smtpTo,
                notifyCooldownSec: Math.max(0, Math.trunc(Number(runtime.notifyCooldownSec) || 0)),
                notificationTemplates: runtime.notificationTemplates,
            };
            if (serverChanKey.trim()) payload.serverChanKey = serverChanKey.trim();
            if (telegramBotToken.trim()) payload.telegramBotToken = telegramBotToken.trim();
            if (smtpPass.trim()) payload.smtpPass = smtpPass.trim();

            const res = await api.updateRuntimeSettings(payload);
            setRuntime((prev) => ({
                ...prev,
                serverChanKeyMasked: res.serverChanKeyMasked || prev.serverChanKeyMasked,
                telegramBotTokenMasked: res.telegramBotTokenMasked || prev.telegramBotTokenMasked,
                smtpPassMasked: res.smtpPassMasked || prev.smtpPassMasked,
                // 保存后收敛：空覆盖行等价于继承，服务端会丢弃，本地状态同步
                notificationTemplates: dropEmptyOverrideRows(prev.notificationTemplates),
            }));
            setServerChanKey('');
            setTelegramBotToken('');
            setSmtpPass('');
            toast.success('通知设置已保存');
        } catch (err: any) {
            toast.error(err?.message || '保存失败');
        } finally {
            setSavingNotify(false);
        }
    };

    const testNotify = async () => {
        setTestingNotify(true);
        try {
            const res = await api.testNotification();
            toast.success(res?.message || '测试通知已发送');
        } catch (err: any) {
            toast.error(err?.message || '触发测试通知失败');
        } finally {
            setTestingNotify(false);
        }
    };

    const activeEventTemplates = runtime.notificationTemplates[activeTemplateEvent] || {};
    const globalTemplates = runtime.notificationTemplates[GLOBAL_EVENT_KEY] || {};
    const overrideTemplate = activeEventTemplates[activeTemplateChannel];
    const globalTemplate = globalTemplates[activeTemplateChannel];
    /**
     * 「该事件存在覆盖行」的显式判据：payload 里有这个 (事件, 渠道) 单元格就算已单独定义。
     * 不再凭模板内容判空——全局模板为空时「一键继承全局」只会得到一行空覆盖，
     * 旧逻辑据此判定「未定制」并把后续输入静默写回全局，用户永远建不出独立覆盖。
     */
    const isCustomized = !!overrideTemplate;
    const effectiveTemplate = isCustomized ? overrideTemplate : globalTemplate;
    /** 事件类型是否已有任一有内容的覆盖（事件 Tab 提示点） */
    const eventHasOwnTemplate = (event: TemplateEventKey): boolean => (
        Object.values(runtime.notificationTemplates[event] || {}).some((template) => !isTemplateEmpty(template))
    );
    /** 渠道是否已有覆盖行（含空行：空行也是用户显式创建的覆盖） */
    const channelHasOverride = (event: TemplateEventKey, channel: TemplateChannel): boolean => (
        !!runtime.notificationTemplates[event]?.[channel]
    );
    /** 非全局事件下的空覆盖行等价于继承全局，服务端会丢弃；保存后本地状态同步收敛。 */
    const dropEmptyOverrideRows = (templates: NotificationTemplatesByEvent): NotificationTemplatesByEvent => {
        const next: NotificationTemplatesByEvent = {};
        for (const [event, channels] of Object.entries(templates)) {
            if (event === GLOBAL_EVENT_KEY) {
                next[event] = channels;
                continue;
            }
            const kept: Partial<Record<TemplateChannel, NotificationTemplate>> = {};
            for (const [channel, template] of Object.entries(channels || {}) as Array<[TemplateChannel, NotificationTemplate]>) {
                if (!isTemplateEmpty(template)) kept[channel] = template;
            }
            if (Object.keys(kept).length > 0) next[event as TemplateEventKey] = kept;
        }
        return next;
    };

    /**
     * 写入当前事件类型的模板单元格。
     * 未单独定义时先在该事件上创建一份独立覆盖（沿用当前全局内容，避免输入瞬间内容被清空），
     * 绝不静默写回 __global__。
     */
    const writeTemplate = (channel: TemplateChannel, patch: Partial<NotificationTemplate>) => {
        setRuntime((prev) => {
            const event = activeTemplateEvent;
            const eventTemplates = { ...(prev.notificationTemplates[event] || {}) };
            const current: NotificationTemplate = eventTemplates[channel]
                || { ...(prev.notificationTemplates[GLOBAL_EVENT_KEY]?.[channel] || {}) };
            const next: NotificationTemplate = { ...current, ...patch };
            for (const key of ['title', 'body'] as const) {
                if (!next[key]) delete next[key];
            }
            if (!next.parseMode) delete next.parseMode;
            // __global__ 上清空即删除该行；非全局事件保留（可能为空的）覆盖行作为显式标记
            if (event === GLOBAL_EVENT_KEY && !next.title && !next.body && !next.parseMode) {
                delete eventTemplates[channel];
            } else {
                eventTemplates[channel] = next;
            }
            const templates = { ...prev.notificationTemplates };
            if (Object.keys(eventTemplates).length === 0) {
                delete templates[event];
            } else {
                templates[event] = eventTemplates;
            }
            return { ...prev, notificationTemplates: templates };
        });
    };

    const inheritGlobal = () => {
        setRuntime((prev) => {
            const source = prev.notificationTemplates[GLOBAL_EVENT_KEY]?.[activeTemplateChannel] || {};
            const templates = { ...prev.notificationTemplates };
            templates[activeTemplateEvent] = {
                ...(templates[activeTemplateEvent] || {}),
                [activeTemplateChannel]: { ...source },
            };
            return { ...prev, notificationTemplates: templates };
        });
    };

    const clearOverride = () => {
        setRuntime((prev) => {
            const eventTemplates = { ...(prev.notificationTemplates[activeTemplateEvent] || {}) };
            delete eventTemplates[activeTemplateChannel];
            const templates = { ...prev.notificationTemplates };
            if (Object.keys(eventTemplates).length === 0) {
                delete templates[activeTemplateEvent];
            } else {
                templates[activeTemplateEvent] = eventTemplates;
            }
            return { ...prev, notificationTemplates: templates };
        });
    };

    const variableOptions = useMemo(() => {
        if (activeTemplateEvent === 'daily_summary') {
            return [...TEMPLATE_VARIABLES, ...DAILY_SUMMARY_VARIABLES];
        }
        return TEMPLATE_VARIABLES;
    }, [activeTemplateEvent]);

    const previewVars = useMemo(() => (
        activeTemplateEvent === 'daily_summary'
            ? { ...PREVIEW_VARS, ...PREVIEW_DAILY_SUMMARY_VARS }
            : PREVIEW_VARS
    ), [activeTemplateEvent]);

    const activeEventMeta = TEMPLATE_EVENT_TYPES.find((item) => item.value === activeTemplateEvent);

    if (loading) {
        return (
            <div className="animate-fade-in">
                <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
                <div className="skeleton" style={{ width: '100%', height: 320, borderRadius: 'var(--radius-sm)' }} />
            </div>
        );
    }

    return (
        <div className="animate-fade-in" style={{ paddingBottom: 40 }}>
            {/* 头部标题与操作 */}
            <div className="page-header">
                <h2 className="page-title">{tr('通知设置')}</h2>
                <div className="page-actions">
                    <button onClick={testNotify} disabled={testingNotify} className="btn btn-success">
                        {testingNotify ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 发送中...</> : '发送测试通知'}
                    </button>
                    <button onClick={saveNotify} disabled={savingNotify} className="btn btn-primary">
                        {savingNotify ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存通知设置'}
                    </button>
                </div>
            </div>

            <div style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 20 }}>

                <div className="card animate-slide-up stagger-1" style={{ padding: 20 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>告警去噪与冷静期</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                        相同告警在冷静期内不会重复推送；冷静期结束后会自动合并重复条数。
                    </div>
                    <div style={{ maxWidth: 260 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                            冷静期（秒）
                        </div>
                        <input
                            type="number"
                            min={0}
                            value={runtime.notifyCooldownSec}
                            onChange={(e) => setRuntime((prev) => ({
                                ...prev,
                                notifyCooldownSec: Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                            }))}
                            style={inputStyle}
                        />
                    </div>
                </div>

                {/* 卡片：推送模板（事件类型 × 渠道） */}
                <div className="card animate-slide-up stagger-2" style={{ padding: 24 }} data-testid="notification-template-card">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-primary-light)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>推送模板</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>按事件类型分别定制各渠道收到的消息格式；未定制的渠道回退到全局模板；保存通知设置后生效</div>
                            </div>
                        </div>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ border: '1px solid var(--color-border)', fontSize: 12 }}
                            onClick={() => {
                                if (!window.confirm('确定清空所有事件类型的自定义模板并恢复默认样式吗？')) return;
                                setRuntime((prev) => ({ ...prev, notificationTemplates: {} }));
                            }}
                        >
                            全部恢复默认
                        </button>
                    </div>

                    {/* 事件类型选择 */}
                    <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>事件类型</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                        {TEMPLATE_EVENT_TYPES.map((eventType) => {
                            const active = eventType.value === activeTemplateEvent;
                            const customized = eventHasOwnTemplate(eventType.value);
                            return (
                                <button
                                    key={eventType.value}
                                    type="button"
                                    data-testid={`template-event-tab-${eventType.value}`}
                                    title={eventType.hint}
                                    onClick={() => setActiveTemplateEvent(eventType.value)}
                                    style={{
                                        padding: '6px 14px',
                                        borderRadius: 'var(--radius-sm)',
                                        fontSize: 13,
                                        cursor: 'pointer',
                                        border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                                        background: active ? 'var(--color-primary-light)' : 'var(--color-bg)',
                                        color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                                        fontWeight: active ? 600 : 400,
                                    }}
                                >
                                    {eventType.label}
                                    {customized && <span style={{ marginLeft: 6, color: 'var(--color-primary)' }}>·</span>}
                                </button>
                            );
                        })}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 16 }}>
                        {activeEventMeta?.hint}
                    </div>

                    {/* 渠道 Tab */}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                        {TEMPLATE_CHANNELS.map((channel) => {
                            const active = channel.value === activeTemplateChannel;
                            const customized = channelHasOverride(activeTemplateEvent, channel.value);
                            return (
                                <button
                                    key={channel.value}
                                    type="button"
                                    data-testid={`template-tab-${channel.value}`}
                                    onClick={() => setActiveTemplateChannel(channel.value)}
                                    style={{
                                        padding: '6px 14px',
                                        borderRadius: 'var(--radius-sm)',
                                        fontSize: 13,
                                        cursor: 'pointer',
                                        border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                                        background: active ? 'var(--color-primary-light)' : 'var(--color-bg)',
                                        color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                                        fontWeight: active ? 600 : 400,
                                    }}
                                >
                                    {channel.label}
                                    {customized && <span style={{ marginLeft: 6, color: 'var(--color-primary)' }}>·</span>}
                                </button>
                            );
                        })}
                    </div>

                    {/* 继承状态 */}
                    {activeTemplateEvent !== GLOBAL_EVENT_KEY && (
                        <div
                            data-testid="template-inherit-state"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                                flexWrap: 'wrap',
                                padding: '10px 14px',
                                marginBottom: 16,
                                borderRadius: 'var(--radius-sm)',
                                border: '1px dashed var(--color-border)',
                                background: 'var(--color-bg)',
                                fontSize: 12,
                                color: 'var(--color-text-secondary)',
                            }}
                        >
                            <span>
                                {isCustomized
                                    ? `当前「${activeEventMeta?.label} × ${TEMPLATE_CHANNELS.find((item) => item.value === activeTemplateChannel)?.label}」已单独定义模板。`
                                    : '当前未单独定义，正在展示并编辑全局模板；点击右侧按钮可一键继承全局后再单独调整。'}
                            </span>
                            {isCustomized ? (
                                <button
                                    type="button"
                                    data-testid="template-clear-override"
                                    className="btn btn-ghost"
                                    style={{ border: '1px solid var(--color-border)', fontSize: 12 }}
                                    onClick={clearOverride}
                                >
                                    恢复继承全局
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    data-testid="template-inherit-global"
                                    className="btn btn-ghost"
                                    style={{ border: '1px solid var(--color-primary)', color: 'var(--color-primary)', fontSize: 12 }}
                                    onClick={inheritGlobal}
                                >
                                    一键继承全局
                                </button>
                            )}
                        </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px 20px' }}>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>标题模板</div>
                            <input
                                data-testid="template-title-input"
                                value={effectiveTemplate?.title || ''}
                                onChange={(e) => writeTemplate(activeTemplateChannel, { title: e.target.value })}
                                placeholder="留空使用默认标题"
                                style={inputStyle}
                            />
                        </div>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)' }}>正文模板</span>
                                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>点击变量插入到光标处</span>
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                {variableOptions.map((variable) => (
                                    <button
                                        key={variable.name}
                                        type="button"
                                        title={variable.hint}
                                        onMouseDown={(e) => {
                                            if (isBodyFocused) {
                                                e.preventDefault();
                                            }
                                        }}
                                        onClick={() => {
                                            const token = `{{${variable.name}}}`;
                                            const textarea = templateBodyRef.current;
                                            const currentBody = effectiveTemplate?.body || '';
                                            let nextBody = `${currentBody}${token}`;
                                            let caret = currentBody.length;
                                            if (isBodyFocused && textarea) {
                                                const start = Number.isFinite(textarea.selectionStart)
                                                    ? Number(textarea.selectionStart)
                                                    : currentBody.length;
                                                const end = Number.isFinite(textarea.selectionEnd)
                                                    ? Number(textarea.selectionEnd)
                                                    : start;
                                                nextBody = `${currentBody.slice(0, start)}${token}${currentBody.slice(end)}`;
                                                caret = start + token.length;
                                            }
                                            writeTemplate(activeTemplateChannel, { body: nextBody });
                                            if (typeof requestAnimationFrame === 'function') {
                                                requestAnimationFrame(() => {
                                                    if (!textarea) return;
                                                    textarea.focus();
                                                    textarea.setSelectionRange(caret, caret);
                                                });
                                            }
                                        }}
                                        style={{
                                            padding: '3px 10px',
                                            fontSize: 12,
                                            fontFamily: 'var(--font-mono)',
                                            borderRadius: 999,
                                            border: '1px solid var(--color-border)',
                                            background: 'var(--color-bg)',
                                            color: 'var(--color-text-secondary)',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {`{{${variable.name}}}`}
                                    </button>
                                ))}
                            </div>
                            <textarea
                                ref={templateBodyRef}
                                data-testid="template-body-input"
                                value={effectiveTemplate?.body || ''}
                                onChange={(e) => writeTemplate(activeTemplateChannel, { body: e.target.value })}
                                onFocus={() => setIsBodyFocused(true)}
                                onBlur={() => setIsBodyFocused(false)}
                                placeholder="留空使用默认正文，例如：\n*{{title}}*\n{{message}}\n累计 {{count}} 次"
                                rows={6}
                                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-mono)', lineHeight: 1.7 }}
                            />
                        </div>

                        {activeTemplateChannel === 'telegram' && (
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>解析模式</div>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    {([
                                        { value: '', label: '纯文本' },
                                        { value: 'Markdown', label: 'Markdown' },
                                        { value: 'HTML', label: 'HTML' },
                                    ] as Array<{ value: TemplateParseMode; label: string }>).map((mode) => (
                                        <button
                                            key={mode.value || 'plain'}
                                            type="button"
                                            data-testid={`template-parse-mode-${mode.value || 'plain'}`}
                                            onClick={() => writeTemplate('telegram', { parseMode: mode.value })}
                                            style={{
                                                padding: '5px 14px',
                                                fontSize: 12,
                                                borderRadius: 'var(--radius-sm)',
                                                cursor: 'pointer',
                                                border: `1px solid ${(effectiveTemplate?.parseMode || '') === mode.value ? 'var(--color-primary)' : 'var(--color-border)'}`,
                                                background: (effectiveTemplate?.parseMode || '') === mode.value ? 'var(--color-primary-light)' : 'var(--color-bg)',
                                                color: (effectiveTemplate?.parseMode || '') === mode.value ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                                            }}
                                        >
                                            {mode.label}
                                        </button>
                                    ))}
                                </div>
                                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
                                    选择 Markdown / HTML 时，Telegram 会按对应语法渲染；注意特殊字符需按该模式转义，否则 Telegram 会拒收整条消息。
                                </div>
                            </div>
                        )}

                        {/* 实时预览 */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                                实时预览（示例数据）{activeTemplateEvent !== GLOBAL_EVENT_KEY && !isCustomized ? ' · 当前展示全局模板效果' : ''}
                            </div>
                            <TemplatePreview
                                channel={activeTemplateChannel}
                                template={effectiveTemplate}
                                vars={previewVars}
                            />
                        </div>
                    </div>
                </div>

                {/* 卡片：Webhook & Bark */}
                <div className="card animate-slide-up stagger-2" style={{ padding: 24, border: (runtime.webhookEnabled || runtime.barkEnabled) ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-primary-light)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 005.656-5.656l-1.1 1.1" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>Webhook & Bark</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>通过 HTTP URL 推送消息通知（自动识别企业微信、飞书格式）</div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: 16 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                                <span style={{ fontSize: 13, fontWeight: 500, color: runtime.webhookEnabled ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>启用 Webhook</span>
                                <input
                                    type="checkbox"
                                    style={{ width: 16, height: 16, cursor: 'pointer' }}
                                    checked={runtime.webhookEnabled}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, webhookEnabled: e.target.checked }))}
                                />
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                                <span style={{ fontSize: 13, fontWeight: 500, color: runtime.barkEnabled ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>启用 Bark</span>
                                <input
                                    type="checkbox"
                                    style={{ width: 16, height: 16, cursor: 'pointer' }}
                                    checked={runtime.barkEnabled}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, barkEnabled: e.target.checked }))}
                                />
                            </label>
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div style={{ opacity: runtime.webhookEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Webhook URL</div>
                            <input
                                value={runtime.webhookUrl}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, webhookUrl: e.target.value }))}
                                placeholder="https://your-webhook-url (可选)"
                                style={inputStyle}
                                disabled={!runtime.webhookEnabled}
                            />
                        </div>
                        <div style={{ opacity: runtime.barkEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Bark URL</div>
                            <input
                                value={runtime.barkUrl}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, barkUrl: e.target.value }))}
                                placeholder="https://api.day.app/your_key (可选)"
                                style={inputStyle}
                                disabled={!runtime.barkEnabled}
                            />
                        </div>
                    </div>
                </div>

                {/* 卡片：Server酱 */}
                <div className="card animate-slide-up stagger-3" style={{ padding: 24, border: runtime.serverChanEnabled ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-warning-soft)', color: 'var(--color-warning)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>Server酱 (SendKey)</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>微信推送消息支持</div>
                            </div>
                        </div>

                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <span style={{ fontSize: 13, fontWeight: 500, color: runtime.serverChanEnabled ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>启用 Server酱</span>
                            <input
                                type="checkbox"
                                style={{ width: 16, height: 16, cursor: 'pointer' }}
                                checked={runtime.serverChanEnabled}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, serverChanEnabled: e.target.checked }))}
                            />
                        </label>
                    </div>

                    <div style={{ opacity: runtime.serverChanEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)', marginBottom: 10 }}>
                            当前配置: {runtime.serverChanKeyMasked || '未设置'}
                        </code>
                        <input
                            type="password"
                            value={serverChanKey}
                            onChange={(e) => setServerChanKey(e.target.value)}
                            placeholder="输入新的 Server酱 Key（留空则不改）"
                            style={inputStyle}
                            disabled={!runtime.serverChanEnabled}
                        />
                    </div>
                </div>

                {/* 卡片：Telegram */}
                <div className="card animate-slide-up stagger-4" style={{ padding: 24, border: runtime.telegramEnabled ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-primary-light)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 11l18-8-6 18-3-7-9-3z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>Telegram Bot</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>通过 Telegram 机器人推送消息通知</div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: 16 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                                <span style={{ fontSize: 13, fontWeight: 500, color: runtime.telegramUseSystemProxy ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>使用系统代理</span>
                                <input
                                    type="checkbox"
                                    style={{ width: 16, height: 16, cursor: 'pointer' }}
                                    checked={runtime.telegramUseSystemProxy}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, telegramUseSystemProxy: e.target.checked }))}
                                />
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                                <span style={{ fontSize: 13, fontWeight: 500, color: runtime.telegramEnabled ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>启用 Telegram</span>
                                <input
                                    type="checkbox"
                                    style={{ width: 16, height: 16, cursor: 'pointer' }}
                                    checked={runtime.telegramEnabled}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, telegramEnabled: e.target.checked }))}
                                />
                            </label>
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px 20px', opacity: runtime.telegramEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram API Base URL</div>
                            <input
                                value={runtime.telegramApiBaseUrl}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, telegramApiBaseUrl: e.target.value }))}
                                placeholder="例如: https://your-proxy.example.com"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
                                留空或使用默认值时直连官方 Telegram API；如需国内反代，可填写反代前缀。
                            </div>
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram Chat ID</div>
                            <input
                                value={runtime.telegramChatId}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, telegramChatId: e.target.value }))}
                                placeholder="例如: -1001234567890 或 @your_channel"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram Topic ID</div>
                            <input
                                value={runtime.telegramMessageThreadId}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, telegramMessageThreadId: e.target.value }))}
                                placeholder="例如: 77"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                                Telegram Bot Token
                                {runtime.telegramBotTokenMasked && <span style={{ color: 'var(--color-primary)', marginLeft: 8, fontSize: 12 }}>(当前已设置)</span>}
                            </div>
                            <input
                                type="password"
                                value={telegramBotToken}
                                onChange={(e) => setTelegramBotToken(e.target.value)}
                                placeholder="输入新的 Bot Token（留空则不改）"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                        </div>
                    </div>
                </div>

                {/* 卡片：SMTP 邮件设置 */}
                <div className="card animate-slide-up stagger-4" style={{ padding: 24, border: runtime.smtpEnabled ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-primary-light)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>邮件服务 (SMTP)</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>通过电子邮件推送提醒</div>
                            </div>
                        </div>

                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <span style={{ fontSize: 13, fontWeight: 500, color: runtime.smtpEnabled ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>启用 SMTP</span>
                            <input
                                type="checkbox"
                                style={{ width: 16, height: 16, cursor: 'pointer' }}
                                checked={runtime.smtpEnabled}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpEnabled: e.target.checked }))}
                            />
                        </label>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px 20px', opacity: runtime.smtpEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>SMTP 服务器</div>
                            <input
                                value={runtime.smtpHost}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpHost: e.target.value }))}
                                placeholder="例如: smtp.qq.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>端口</div>
                                <input
                                    type="number"
                                    min={1}
                                    value={runtime.smtpPort}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, smtpPort: Number(e.target.value) || 0 }))}
                                    style={inputStyle}
                                    disabled={!runtime.smtpEnabled}
                                />
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)', paddingBottom: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={runtime.smtpSecure}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, smtpSecure: e.target.checked }))}
                                    disabled={!runtime.smtpEnabled}
                                />
                                启用 TLS/SSL
                            </label>
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>账号用户</div>
                            <input
                                value={runtime.smtpUser}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpUser: e.target.value }))}
                                placeholder="SMTP 用户名"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                                账号密码
                                {runtime.smtpPassMasked && <span style={{ color: 'var(--color-primary)', marginLeft: 8, fontSize: 12 }}>(当前已设置)</span>}
                            </div>
                            <input
                                type="password"
                                value={smtpPass}
                                onChange={(e) => setSmtpPass(e.target.value)}
                                placeholder="输入以更改密码..."
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>发件人地址</div>
                            <input
                                value={runtime.smtpFrom}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpFrom: e.target.value }))}
                                placeholder="例如: admin@example.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>接收地址</div>
                            <input
                                value={runtime.smtpTo}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpTo: e.target.value }))}
                                placeholder="例如: target@example.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
