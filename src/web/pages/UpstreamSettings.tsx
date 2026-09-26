import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type RuntimeSettingsPayload, type UpstreamProviderDistributionItem, type UpstreamProviderPinRule, type UpstreamParamCompatRule, type UpstreamParamCompatEndpoint } from '../api.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { useAnimatedVisibility } from '../components/useAnimatedVisibility.js';
import ModernSelect from '../components/ModernSelect.js';
import ResponsiveFormGrid from '../components/ResponsiveFormGrid.js';
import ModelAvailabilityProbeConfirmModal from './settings/ModelAvailabilityProbeConfirmModal.js';
import {
  createCodexDefaultHighReasoningVisualPreset,
  createVisualPayloadRule,
  isVisualPayloadRuleBlank,
  payloadRulesToVisualRules,
  type PayloadRuleAction,
  type VisualPayloadRule,
  type VisualPayloadRuleValueMode,
  visualRulesToPayloadRules,
} from './settings/payloadRulesVisual.js';
import { PAYLOAD_RULE_PROTOCOL_OPTIONS } from './settings/payloadRuleProtocolOptions.js';
import {
  resolveUpstreamPinAdapterForSite,
  resolveUpstreamPinRuleAdapterHint,
} from './helpers/upstreamPinAdapterHints.js';
import { listUpstreamPinAdapterCatalog } from '../../shared/upstreamPinAdapters.js';
import type { UpstreamPinAdapterCatalogEntry } from '../../shared/upstreamPinAdapters.js';

const UPSTREAM_DETECT_SECTION_ID = 'upstream-detect';
const UPSTREAM_PIN_SECTION_ID = 'upstream-pin';
const MODEL_AVAILABILITY_PROBE_CONFIRM_TEXT = '我确认我使用的中转站全部允许批量测活，如因开启此功能被中转站封号，自行负责。';

const PAYLOAD_RULES_EDITOR_SECTIONS = [
  {
    key: 'default',
    title: 'default',
    description: '字段缺失时才注入，适合补默认参数。',
    placeholder: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": {
      "reasoning.effort": "high"
    }
  }
]`,
  },
  {
    key: 'default-raw',
    title: 'default-raw',
    description: '字段缺失时注入原始 JSON，适合 schema、复杂对象等值。',
    placeholder: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": {
      "response_format": "{\\"type\\":\\"json_schema\\"}"
    }
  }
]`,
  },
  {
    key: 'override',
    title: 'override',
    description: '无论原请求是否已有该字段，都强制覆盖。',
    placeholder: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": {
      "text.verbosity": "low"
    }
  }
]`,
  },
  {
    key: 'override-raw',
    title: 'override-raw',
    description: '无论原请求是否已有该字段，都强制覆盖为原始 JSON。',
    placeholder: `[
  {
    "models": [{ "name": "gemini-*", "protocol": "gemini" }],
    "params": {
      "generationConfig.responseJsonSchema": "{\\"type\\":\\"object\\"}"
    }
  }
]`,
  },
  {
    key: 'filter',
    title: 'filter',
    description: '删除匹配请求中的字段。',
    placeholder: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": ["safety_identifier"]
  }
]`,
  },
] as const satisfies ReadonlyArray<{
  key: PayloadRuleAction;
  title: string;
  description: string;
  placeholder: string;
}>;

const PAYLOAD_RULE_ACTION_OPTIONS: Array<{ value: PayloadRuleAction; label: string }> = [
  { value: 'default', label: '默认注入' },
  { value: 'default-raw', label: '默认注入 JSON' },
  { value: 'override', label: '强制覆盖' },
  { value: 'override-raw', label: '强制覆盖 JSON' },
  { value: 'filter', label: '删除字段' },
];

const PAYLOAD_RULE_VALUE_MODE_OPTIONS: Array<{ value: VisualPayloadRuleValueMode; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'json', label: 'JSON' },
];

type SettingsSiteOption = {
  id: number;
  name: string;
  url?: string;
};

type PayloadRulesEditorSectionKey = PayloadRuleAction;
type PayloadRulesEditorDrafts = Record<PayloadRulesEditorSectionKey, string>;

type RuntimeSettings = {
  proxyEmptyContentFailEnabled: boolean;
  proxyErrorKeywords: string[];
  codexUpstreamWebsocketEnabled: boolean;
  responsesCompactFallbackToResponsesEnabled: boolean;
  proxySessionChannelConcurrencyLimit: number;
  proxySessionChannelQueueWaitMs: number;
  modelAvailabilityProbeEnabled: boolean;
  upstreamProviderDetectEnabled: boolean;
  upstreamProviderDetectSampleRate: number;
  upstreamProviderDetectRetentionDays: number;
  upstreamProviderDetectSiteIds: number[];
  upstreamProviderPinEnabled: boolean;
  upstreamProviderPinRules: UpstreamProviderPinRule[];
  upstreamProviderPinAdapterMap: Record<string, string>;
  upstreamParamCompatEnabled: boolean;
  upstreamParamCompatSelfHealEnabled: boolean;
  upstreamParamCompatRules: UpstreamParamCompatRule[];
};

function normalizeUpstreamDetectSampleRate(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
}

function normalizeUpstreamDetectRetentionDays(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 14;
  return Math.max(0, Math.trunc(numeric));
}

function normalizeUpstreamDetectSiteIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const result: number[] = [];
  for (const item of value) {
    const numeric = Math.trunc(Number(item));
    if (!Number.isInteger(numeric) || numeric <= 0 || seen.has(numeric)) continue;
    seen.add(numeric);
    result.push(numeric);
  }
  return result;
}

function normalizeUpstreamPinProviders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeUpstreamPinRulesFromSettings(value: unknown): UpstreamProviderPinRule[] {
  if (!Array.isArray(value)) return [];
  const result: UpstreamProviderPinRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const siteId = Math.trunc(Number(record.siteId));
    if (!Number.isInteger(siteId) || siteId <= 0) continue;
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model) continue;
    const providers = normalizeUpstreamPinProviders(record.providers);
    if (providers.length === 0) continue;
    const mode = record.mode === 'only' || record.mode === 'order' ? record.mode : null;
    if (!mode) continue;
    result.push({ siteId, model, providers, mode });
  }
  return result;
}

function normalizeUpstreamPinAdapterMapFromSettings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = rawKey.trim();
    if (!trimmedKey) continue;
    const numeric = Number(trimmedKey);
    if (!Number.isInteger(numeric) || numeric <= 0) continue;
    if (typeof rawValue !== 'string') continue;
    const adapterId = rawValue.trim();
    if (!adapterId) continue;
    result[String(numeric)] = adapterId;
  }
  return result;
}

function normalizeSettingsSiteOptions(value: unknown): SettingsSiteOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const result: SettingsSiteOption[] = [];
  for (const item of value as Array<Record<string, unknown>>) {
    const id = Math.trunc(Number(item?.id));
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: typeof item?.name === 'string' && item.name.trim().length > 0 ? item.name : `#${id}`,
      url: typeof item?.url === 'string' ? item.url : undefined,
    });
  }
  return result;
}

function createEmptyPayloadRuleDrafts(): PayloadRulesEditorDrafts {
  return {
    default: '',
    'default-raw': '',
    override: '',
    'override-raw': '',
    filter: '',
  };
}

function formatPayloadRuleSectionForEditor(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value) && value.length <= 0) return '';
  return JSON.stringify(value, null, 2);
}

function normalizePayloadRulesForEditor(value: unknown): PayloadRulesEditorDrafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptyPayloadRuleDrafts();
  }

  const record = value as Record<string, unknown>;
  return {
    default: formatPayloadRuleSectionForEditor(record.default),
    'default-raw': formatPayloadRuleSectionForEditor(record.defaultRaw ?? record['default-raw']),
    override: formatPayloadRuleSectionForEditor(record.override),
    'override-raw': formatPayloadRuleSectionForEditor(record.overrideRaw ?? record['override-raw']),
    filter: formatPayloadRuleSectionForEditor(record.filter),
  };
}

function parsePayloadRulesFromDrafts(
  drafts: PayloadRulesEditorDrafts,
): { success: true; value: Record<string, unknown> } | { success: false; message: string } {
  const next: Record<string, unknown> = {};

  for (const section of PAYLOAD_RULES_EDITOR_SECTIONS) {
    const raw = drafts[section.key].trim();
    if (!raw) continue;
    try {
      next[section.key] = JSON.parse(raw);
    } catch (error: any) {
      return {
        success: false,
        message: `Payload 规则 ${section.title} 不是合法 JSON：${error?.message || '解析失败'}`,
      };
    }
  }

  return {
    success: true,
    value: next,
  };
}

function parseProxyErrorKeywords(raw: string): string[] {
  return raw
    .split(/\r?\n|,/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const DEFAULT_UPSTREAM_PARAM_COMPAT_ENDPOINTS: UpstreamParamCompatEndpoint[] = ['chat', 'responses'];

// 来源：src/server/services/upstreamParamCompat/rules.ts UPSTREAM_PARAM_COMPAT_STRUCTURAL_KEYS
const UPSTREAM_PARAM_COMPAT_STRUCTURAL_KEYS = [
  'model',
  'messages',
  'input',
  'stream',
  'tools',
  'tool_choice',
  'max_tokens',
  'temperature',
  'top_p',
  'n',
  'stop',
  'response_format',
  'instructions',
  'previous_response_id',
  'provider',
  'providerOptions',
  'system',
] as const;
const UPSTREAM_PARAM_COMPAT_RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const UPSTREAM_PARAM_COMPAT_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,64}$/;

export default function UpstreamSettings() {
  const isMobile = useIsMobile();
  const [runtime, setRuntime] = useState<RuntimeSettings>({
    proxyEmptyContentFailEnabled: false,
    proxyErrorKeywords: [],
    codexUpstreamWebsocketEnabled: false,
    responsesCompactFallbackToResponsesEnabled: false,
    proxySessionChannelConcurrencyLimit: 2,
    proxySessionChannelQueueWaitMs: 1500,
    modelAvailabilityProbeEnabled: false,
    upstreamProviderDetectEnabled: false,
    upstreamProviderDetectSampleRate: 1,
    upstreamProviderDetectRetentionDays: 14,
    upstreamProviderDetectSiteIds: [],
    upstreamProviderPinEnabled: false,
    upstreamProviderPinRules: [],
    upstreamProviderPinAdapterMap: {},
    upstreamParamCompatEnabled: false,
    upstreamParamCompatSelfHealEnabled: false,
    upstreamParamCompatRules: [],
  });
  const [proxyErrorKeywordsText, setProxyErrorKeywordsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingProxyFailureRules, setSavingProxyFailureRules] = useState(false);
  const [payloadVisualRules, setPayloadVisualRules] = useState<VisualPayloadRule[]>([]);
  const [payloadRuleDrafts, setPayloadRuleDrafts] = useState<PayloadRulesEditorDrafts>(createEmptyPayloadRuleDrafts());
  const [payloadAdvancedDirty, setPayloadAdvancedDirty] = useState(false);
  const [savingPayloadRules, setSavingPayloadRules] = useState(false);
  const [showPayloadRulesEditor, setShowPayloadRulesEditor] = useState(false);
  const [savingProxyTransport, setSavingProxyTransport] = useState(false);
  const [savingModelAvailabilityProbe, setSavingModelAvailabilityProbe] = useState(false);
  const [modelAvailabilityProbeConfirmOpen, setModelAvailabilityProbeConfirmOpen] = useState(false);
  const modelAvailabilityProbeConfirmPresence = useAnimatedVisibility(modelAvailabilityProbeConfirmOpen, 220);
  const [modelAvailabilityProbeConfirmationInput, setModelAvailabilityProbeConfirmationInput] = useState('');
  const [savedModelAvailabilityProbeEnabled, setSavedModelAvailabilityProbeEnabled] = useState(false);
  const [savingUpstreamDetect, setSavingUpstreamDetect] = useState(false);
  const [upstreamDetectSites, setUpstreamDetectSites] = useState<SettingsSiteOption[] | null>(null);
  const [upstreamDetectSitesFailed, setUpstreamDetectSitesFailed] = useState(false);
  const [savingUpstreamPin, setSavingUpstreamPin] = useState(false);
  const [pinProviderDrafts, setPinProviderDrafts] = useState<Record<number, string>>({});
  const [pinObservation, setPinObservation] = useState<Record<number, {
    loading: boolean;
    items?: UpstreamProviderDistributionItem[];
    error?: string;
  }>>({});
  const [savingUpstreamParamCompat, setSavingUpstreamParamCompat] = useState(false);
  const [paramCompatParamDrafts, setParamCompatParamDrafts] = useState<Record<number, string>>({});
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

  const settingsModernCardStyle: React.CSSProperties = {
    padding: isMobile ? 20 : 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  };

  const settingsModernDangerCardStyle: React.CSSProperties = {
    ...settingsModernCardStyle,
    borderColor: 'color-mix(in srgb, var(--color-danger) 22%, var(--color-border))',
    background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-danger-soft) 18%, var(--color-bg-card)) 0%, var(--color-bg-card) 100%)',
  };

  const settingsModernHeaderStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    flexWrap: 'wrap',
  };

  const settingsModernTitleBlockStyle: React.CSSProperties = {
    display: 'grid',
    gap: 6,
    minWidth: 0,
  };

  const settingsModernTitleStyle: React.CSSProperties = {
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.35,
    color: 'var(--color-text-primary)',
  };

  const settingsModernDescriptionStyle: React.CSSProperties = {
    fontSize: 12,
    lineHeight: 1.75,
    color: 'var(--color-text-muted)',
  };

  const settingsModernPillRowStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  };

  const settingsModernCalloutStyle: React.CSSProperties = {
    display: 'grid',
    gap: 6,
    padding: '14px 16px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-light)',
    background: 'color-mix(in srgb, var(--color-bg) 82%, var(--color-bg-card))',
  };

  const settingsModernToggleStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: isMobile ? 12 : 16,
    padding: '14px 16px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-light)',
    background: 'color-mix(in srgb, var(--color-bg) 78%, var(--color-bg-card))',
    cursor: 'pointer',
  };

  const settingsModernToggleCopyStyle: React.CSSProperties = {
    display: 'grid',
    gap: 6,
    minWidth: 0,
  };

  const settingsModernFieldCardStyle: React.CSSProperties = {
    display: 'grid',
    gap: 10,
    padding: '14px 16px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-light)',
    background: 'color-mix(in srgb, var(--color-bg) 82%, var(--color-bg-card))',
  };

  const settingsModernFieldLabelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
  };

  const settingsModernFieldHintStyle: React.CSSProperties = {
    fontSize: 12,
    lineHeight: 1.7,
    color: 'var(--color-text-muted)',
    marginTop: -2,
  };

  const settingsModernActionsStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  };

  const getSettingsPillStyle = (tone: 'neutral' | 'primary' | 'danger' | 'warning'): React.CSSProperties => {
    const toneStyles: Record<string, React.CSSProperties> = {
      neutral: {
        borderColor: 'color-mix(in srgb, var(--color-text-muted) 12%, var(--color-border-light))',
        background: 'color-mix(in srgb, var(--color-text-muted) 8%, var(--color-bg-card))',
        color: 'var(--color-text-secondary)',
      },
      primary: {
        borderColor: 'color-mix(in srgb, var(--color-primary) 20%, var(--color-border-light))',
        background: 'color-mix(in srgb, var(--color-primary-light) 64%, var(--color-bg-card))',
        color: 'var(--color-primary)',
      },
      warning: {
        borderColor: 'color-mix(in srgb, var(--color-warning) 20%, var(--color-border-light))',
        background: 'color-mix(in srgb, var(--color-warning-soft) 68%, var(--color-bg-card))',
        color: 'var(--color-warning)',
      },
      danger: {
        borderColor: 'color-mix(in srgb, var(--color-danger) 20%, var(--color-border-light))',
        background: 'color-mix(in srgb, var(--color-danger-soft) 66%, var(--color-bg-card))',
        color: 'var(--color-danger)',
      },
    };

    return {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '5px 10px',
      borderRadius: 999,
      border: '1px solid var(--color-border-light)',
      fontSize: 12,
      fontWeight: 600,
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
      ...toneStyles[tone],
    };
  };

  const proxyTransportModeLabel = runtime.codexUpstreamWebsocketEnabled ? '上游 WebSocket 已启用' : 'HTTP 优先';
  const proxyTransportQueueLabel = `会话池 ${runtime.proxySessionChannelConcurrencyLimit} 并发 / ${runtime.proxySessionChannelQueueWaitMs}ms`;
  const modelAvailabilityProbeDirty = runtime.modelAvailabilityProbeEnabled !== savedModelAvailabilityProbeEnabled;
  const modelAvailabilityProbeStatusTone: 'neutral' | 'primary' | 'danger' | 'warning' = modelAvailabilityProbeDirty
    ? 'warning'
    : savedModelAvailabilityProbeEnabled
      ? 'danger'
      : 'neutral';
  const modelAvailabilityProbeStatusLabel = modelAvailabilityProbeDirty
    ? '待保存'
    : savedModelAvailabilityProbeEnabled
      ? '已启用'
      : '已关闭';

  const syncPayloadRuleDraftsFromObject = (value: unknown) => {
    setPayloadRuleDrafts(normalizePayloadRulesForEditor(value));
    setPayloadAdvancedDirty(false);
  };

  const syncPayloadVisualRulesFromObject = (value: unknown) => {
    setPayloadVisualRules(payloadRulesToVisualRules(value));
  };

  const applyVisualPayloadRules = (
    nextRulesOrUpdater: VisualPayloadRule[] | ((current: VisualPayloadRule[]) => VisualPayloadRule[]),
  ) => {
    setPayloadVisualRules((currentRules) => {
      const nextRules = typeof nextRulesOrUpdater === 'function'
        ? nextRulesOrUpdater(currentRules)
        : nextRulesOrUpdater;
      const serialized = visualRulesToPayloadRules(nextRules);
      if (serialized.success) {
        syncPayloadRuleDraftsFromObject(serialized.value);
      }
      return nextRules;
    });
  };

  const loadSettings = async () => {
    setLoading(true);
    try {
      const runtimeInfo = await api.getRuntimeSettings();
      setRuntime({
        proxyEmptyContentFailEnabled: !!runtimeInfo.proxyEmptyContentFailEnabled,
        proxyErrorKeywords: Array.isArray(runtimeInfo.proxyErrorKeywords)
          ? runtimeInfo.proxyErrorKeywords.filter((item: unknown) => typeof item === 'string')
          : [],
        codexUpstreamWebsocketEnabled: !!runtimeInfo.codexUpstreamWebsocketEnabled,
        responsesCompactFallbackToResponsesEnabled: !!runtimeInfo.responsesCompactFallbackToResponsesEnabled,
        proxySessionChannelConcurrencyLimit: Number(runtimeInfo.proxySessionChannelConcurrencyLimit) >= 0
          ? Math.trunc(Number(runtimeInfo.proxySessionChannelConcurrencyLimit))
          : 2,
        proxySessionChannelQueueWaitMs: Number(runtimeInfo.proxySessionChannelQueueWaitMs) >= 0
          ? Math.trunc(Number(runtimeInfo.proxySessionChannelQueueWaitMs))
          : 1500,
        modelAvailabilityProbeEnabled: !!runtimeInfo.modelAvailabilityProbeEnabled,
        upstreamProviderDetectEnabled: !!runtimeInfo.upstreamProviderDetectEnabled,
        upstreamProviderDetectSampleRate: normalizeUpstreamDetectSampleRate(runtimeInfo.upstreamProviderDetectSampleRate),
        upstreamProviderDetectRetentionDays: normalizeUpstreamDetectRetentionDays(runtimeInfo.upstreamProviderDetectRetentionDays),
        upstreamProviderDetectSiteIds: normalizeUpstreamDetectSiteIds(runtimeInfo.upstreamProviderDetectSiteIds),
        upstreamProviderPinEnabled: !!runtimeInfo.upstreamProviderPinEnabled,
        upstreamProviderPinRules: normalizeUpstreamPinRulesFromSettings(runtimeInfo.upstreamProviderPinRules),
        upstreamProviderPinAdapterMap: normalizeUpstreamPinAdapterMapFromSettings(runtimeInfo.upstreamProviderPinAdapterMap),
        upstreamParamCompatEnabled: !!runtimeInfo.upstreamParamCompatEnabled,
        upstreamParamCompatSelfHealEnabled: !!runtimeInfo.upstreamParamCompatSelfHealEnabled,
        upstreamParamCompatRules: Array.isArray(runtimeInfo.upstreamParamCompatRules)
          ? (runtimeInfo.upstreamParamCompatRules as unknown[]).reduce((result: UpstreamParamCompatRule[], item) => {
              if (!item || typeof item !== 'object') return result;
              const record = item as Record<string, unknown>;
              const rawSiteId = record.siteId;
              if (rawSiteId == null) {
                const model = typeof record.model === 'string' ? record.model.trim() : '';
                const params = Array.isArray(record.params)
                  ? (record.params as unknown[]).filter((p: unknown) => typeof p === 'string' && p.trim()) as string[]
                  : [];
                result.push({
                  siteId: null as UpstreamParamCompatRule['siteId'],
                  model,
                  params,
                });
                return result;
              }
              const siteId = Math.trunc(Number(rawSiteId));
              if (!Number.isInteger(siteId) || siteId <= 0) return result;
              const model = typeof record.model === 'string' ? record.model.trim() : '';
              if (!model) return result;
              const endpoints = Array.isArray(record.endpoints)
                ? (record.endpoints as unknown[]).filter(
                    (ep: unknown) => ep === 'chat' || ep === 'responses' || ep === 'messages',
                  ) as UpstreamParamCompatEndpoint[]
                : [];
              const params = Array.isArray(record.params)
                ? record.params.filter((p: unknown) => typeof p === 'string' && p.trim())
                : [];
              result.push({
                siteId,
                model,
                params,
                ...(endpoints.length > 0 ? { endpoints } : {}),
              });
              return result;
            }, [])
          : [],
      });
      setProxyErrorKeywordsText(
        Array.isArray(runtimeInfo.proxyErrorKeywords)
          ? runtimeInfo.proxyErrorKeywords.filter((item: unknown) => typeof item === 'string').join('\n')
          : '',
      );
      setSavedModelAvailabilityProbeEnabled(!!runtimeInfo.modelAvailabilityProbeEnabled);
      syncPayloadRuleDraftsFromObject(runtimeInfo.payloadRules);
      syncPayloadVisualRulesFromObject(runtimeInfo.payloadRules);
    } catch (err: any) {
      toast.error(err?.message || '加载上游设置失败');
    } finally {
      setLoading(false);
    }
    Promise.resolve()
      .then(() => api.getSites())
      .then((rows: unknown) => {
        setUpstreamDetectSites(normalizeSettingsSiteOptions(rows));
        setUpstreamDetectSitesFailed(false);
      })
      .catch(() => {
        setUpstreamDetectSitesFailed(true);
      });
  };

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Load settings on mount
  useLayoutEffect(() => {
    loadSettings();
  }, []);

  // Deep-link: scroll to section after loading is false
  useLayoutEffect(() => {
    const section = searchParams.get('section');
    if (!section) return;
    if (loading) return;

    const target = document.getElementById(`settings-section-${section}`);
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [loading, searchParams]);

  const saveProxyFailureRules = async () => {
    setSavingProxyFailureRules(true);
    try {
      const keywords = parseProxyErrorKeywords(proxyErrorKeywordsText);
      const res = await api.updateRuntimeSettings({
        proxyErrorKeywords: keywords,
        proxyEmptyContentFailEnabled: runtime.proxyEmptyContentFailEnabled,
      });
      const nextKeywords = Array.isArray(res?.proxyErrorKeywords)
        ? res.proxyErrorKeywords
        : keywords;
      setRuntime((prev) => ({
        ...prev,
        proxyErrorKeywords: nextKeywords,
        proxyEmptyContentFailEnabled: typeof res?.proxyEmptyContentFailEnabled === 'boolean'
          ? res.proxyEmptyContentFailEnabled
          : prev.proxyEmptyContentFailEnabled,
      }));
      setProxyErrorKeywordsText(nextKeywords.join('\n'));
      toast.success('代理失败规则已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存失败');
    } finally {
      setSavingProxyFailureRules(false);
    }
  };

  const savePayloadRules = async () => {
    const nextPayloadRules = payloadAdvancedDirty
      ? parsePayloadRulesFromDrafts(payloadRuleDrafts)
      : visualRulesToPayloadRules(payloadVisualRules);
    if (!nextPayloadRules.success) {
      toast.error(nextPayloadRules.message);
      return;
    }

    setSavingPayloadRules(true);
    try {
      const res = await api.updateRuntimeSettings({
        payloadRules: nextPayloadRules.value,
      });
      syncPayloadRuleDraftsFromObject(res?.payloadRules);
      syncPayloadVisualRulesFromObject(res?.payloadRules);
      toast.success('Payload 规则已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存 Payload 规则失败');
    } finally {
      setSavingPayloadRules(false);
    }
  };

  const applyCodexDefaultHighReasoningPreset = () => {
    applyVisualPayloadRules((currentRules) => [
      ...currentRules.filter((rule) => !isVisualPayloadRuleBlank(rule)),
      ...createCodexDefaultHighReasoningVisualPreset(),
    ]);
    setShowPayloadRulesEditor(true);
    toast.success('已填入 Codex 默认高推理预设');
  };

  const addPayloadVisualRule = () => {
    applyVisualPayloadRules((currentRules) => [
      ...currentRules,
      createVisualPayloadRule(),
    ]);
  };

  const updatePayloadVisualRule = (ruleId: string, patch: Partial<VisualPayloadRule>) => {
    applyVisualPayloadRules((currentRules) => currentRules.map((rule) => {
      if (rule.id !== ruleId) return rule;
      const nextAction = (patch.action ?? rule.action) as PayloadRuleAction;
      const nextValueMode = patch.valueMode ?? (
        nextAction === 'default-raw' || nextAction === 'override-raw'
          ? 'json'
          : rule.valueMode
      );
      return {
        ...rule,
        ...patch,
        action: nextAction,
        valueMode: nextAction === 'filter' ? 'text' : nextValueMode,
        value: nextAction === 'filter' ? '' : (patch.value ?? rule.value),
      };
    }));
  };

  const removePayloadVisualRule = (ruleId: string) => {
    applyVisualPayloadRules((currentRules) => currentRules.filter((rule) => rule.id !== ruleId));
  };

  const syncVisualRulesFromAdvancedJson = () => {
    const parsedPayloadRules = parsePayloadRulesFromDrafts(payloadRuleDrafts);
    if (!parsedPayloadRules.success) {
      toast.error(parsedPayloadRules.message);
      return;
    }
    syncPayloadVisualRulesFromObject(parsedPayloadRules.value);
    setPayloadAdvancedDirty(false);
    toast.success('已将高级 JSON 同步到可视化规则');
  };

  const saveProxyTransportSettings = async () => {
    setSavingProxyTransport(true);
    try {
      const res = await api.updateRuntimeSettings({
        codexUpstreamWebsocketEnabled: runtime.codexUpstreamWebsocketEnabled,
        responsesCompactFallbackToResponsesEnabled: runtime.responsesCompactFallbackToResponsesEnabled,
        proxySessionChannelConcurrencyLimit: runtime.proxySessionChannelConcurrencyLimit,
        proxySessionChannelQueueWaitMs: runtime.proxySessionChannelQueueWaitMs,
      });
      setRuntime((prev) => ({
        ...prev,
        codexUpstreamWebsocketEnabled: typeof res?.codexUpstreamWebsocketEnabled === 'boolean'
          ? res.codexUpstreamWebsocketEnabled
          : prev.codexUpstreamWebsocketEnabled,
        responsesCompactFallbackToResponsesEnabled: typeof res?.responsesCompactFallbackToResponsesEnabled === 'boolean'
          ? res.responsesCompactFallbackToResponsesEnabled
          : prev.responsesCompactFallbackToResponsesEnabled,
        proxySessionChannelConcurrencyLimit: Number(res?.proxySessionChannelConcurrencyLimit) >= 0
          ? Math.trunc(Number(res.proxySessionChannelConcurrencyLimit))
          : prev.proxySessionChannelConcurrencyLimit,
        proxySessionChannelQueueWaitMs: Number(res?.proxySessionChannelQueueWaitMs) >= 0
          ? Math.trunc(Number(res.proxySessionChannelQueueWaitMs))
          : prev.proxySessionChannelQueueWaitMs,
      }));
      toast.success('传输与会话并发设置已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存失败');
    } finally {
      setSavingProxyTransport(false);
    }
  };

  const persistModelAvailabilityProbeSetting = async (enabled: boolean) => {
    setSavingModelAvailabilityProbe(true);
    try {
      const res = await api.updateRuntimeSettings({
        modelAvailabilityProbeEnabled: enabled,
      });
      const nextEnabled = typeof res?.modelAvailabilityProbeEnabled === 'boolean'
        ? res.modelAvailabilityProbeEnabled
        : enabled;
      setRuntime((prev) => ({
        ...prev,
        modelAvailabilityProbeEnabled: nextEnabled,
      }));
      setSavedModelAvailabilityProbeEnabled(nextEnabled);
      setModelAvailabilityProbeConfirmOpen(false);
      setModelAvailabilityProbeConfirmationInput('');
      toast.success(nextEnabled ? '批量测活已开启' : '批量测活已关闭');
    } catch (err: any) {
      toast.error(err?.message || '保存失败');
    } finally {
      setSavingModelAvailabilityProbe(false);
    }
  };

  const saveModelAvailabilityProbeSettings = async () => {
    if (runtime.modelAvailabilityProbeEnabled === savedModelAvailabilityProbeEnabled) {
      toast.info('批量测活设置未变化');
      return;
    }
    if (runtime.modelAvailabilityProbeEnabled) {
      setModelAvailabilityProbeConfirmOpen(true);
      return;
    }
    await persistModelAvailabilityProbeSetting(false);
  };

  const closeModelAvailabilityProbeConfirmModal = () => {
    if (savingModelAvailabilityProbe) return;
    setModelAvailabilityProbeConfirmOpen(false);
  };

  const handleConfirmModelAvailabilityProbe = async () => {
    if (modelAvailabilityProbeConfirmationInput.trim() !== MODEL_AVAILABILITY_PROBE_CONFIRM_TEXT) return;
    await persistModelAvailabilityProbeSetting(true);
  };

  const saveUpstreamDetect = async () => {
    setSavingUpstreamDetect(true);
    try {
      const submittedSiteIds = normalizeUpstreamDetectSiteIds(runtime.upstreamProviderDetectSiteIds);
      const res = await api.updateRuntimeSettings({
        upstreamProviderDetectEnabled: runtime.upstreamProviderDetectEnabled,
        upstreamProviderDetectSampleRate: normalizeUpstreamDetectSampleRate(runtime.upstreamProviderDetectSampleRate),
        upstreamProviderDetectRetentionDays: normalizeUpstreamDetectRetentionDays(runtime.upstreamProviderDetectRetentionDays),
        upstreamProviderDetectSiteIds: submittedSiteIds,
      });
      setRuntime((prev) => ({
        ...prev,
        upstreamProviderDetectEnabled: res?.upstreamProviderDetectEnabled === undefined
          ? prev.upstreamProviderDetectEnabled
          : !!res.upstreamProviderDetectEnabled,
        upstreamProviderDetectSampleRate: res?.upstreamProviderDetectSampleRate === undefined
          ? prev.upstreamProviderDetectSampleRate
          : normalizeUpstreamDetectSampleRate(res.upstreamProviderDetectSampleRate),
        upstreamProviderDetectRetentionDays: res?.upstreamProviderDetectRetentionDays === undefined
          ? prev.upstreamProviderDetectRetentionDays
          : normalizeUpstreamDetectRetentionDays(res.upstreamProviderDetectRetentionDays),
        upstreamProviderDetectSiteIds: res?.upstreamProviderDetectSiteIds === undefined
          ? submittedSiteIds
          : normalizeUpstreamDetectSiteIds(res.upstreamProviderDetectSiteIds),
      }));
      toast.success('上游探测设置已保存，已热生效');
    } catch (err: any) {
      toast.error(err?.message || '保存上游探测设置失败');
    } finally {
      setSavingUpstreamDetect(false);
    }
  };

  const toggleUpstreamDetectSite = (siteId: number, checked: boolean) => {
    setRuntime((prev) => {
      const currentSiteIds = prev.upstreamProviderDetectSiteIds;
      const nextSiteIds = checked
        ? (currentSiteIds.includes(siteId) ? currentSiteIds : [...currentSiteIds, siteId])
        : currentSiteIds.filter((id) => id !== siteId);
      return { ...prev, upstreamProviderDetectSiteIds: nextSiteIds };
    });
  };

  const selectAllUpstreamDetectSites = () => {
    setRuntime((prev) => ({
      ...prev,
      upstreamProviderDetectSiteIds: normalizeUpstreamDetectSiteIds([
        ...prev.upstreamProviderDetectSiteIds,
        ...(upstreamDetectSites || []).map((site) => site.id),
      ]),
    }));
  };

  const clearUpstreamDetectSites = () => {
    setRuntime((prev) => ({ ...prev, upstreamProviderDetectSiteIds: [] }));
  };

  const upstreamDetectStatusLabel = runtime.upstreamProviderDetectEnabled ? '已开启' : '未开启';
  const upstreamDetectSiteCountLabel = runtime.upstreamProviderDetectSiteIds.length > 0
    ? `${runtime.upstreamProviderDetectSiteIds.length} 个参与站点`
    : '未选参与站点';

  const upstreamPinStatusLabel = runtime.upstreamProviderPinEnabled ? '已开启' : '未开启';
  const upstreamPinRuleCountLabel = runtime.upstreamProviderPinRules.length > 0
    ? `${runtime.upstreamProviderPinRules.length} 条规则`
    : '未配置规则';
  const duplicatedPinRuleIndexes = new Set<number>();
  runtime.upstreamProviderPinRules.forEach((rule, index) => {
    const key = `${rule.siteId}\u0000${rule.model.trim()}`;
    if (!rule.siteId || !rule.model.trim()) return;
    const duplicated = runtime.upstreamProviderPinRules.some((other, otherIndex) => (
      otherIndex !== index && `${other.siteId}\u0000${other.model.trim()}` === key
    ));
    if (duplicated) duplicatedPinRuleIndexes.add(index);
  });

  const upstreamPinAdapterCatalog = useMemo(() => listUpstreamPinAdapterCatalog(), []);
  const upstreamPinAdapterById = useMemo(
    () => new Map<string, UpstreamPinAdapterCatalogEntry>(
      upstreamPinAdapterCatalog.map((entry) => [entry.id, entry]),
    ),
    [upstreamPinAdapterCatalog],
  );
  const upstreamPinAdapterRows = useMemo(
    () => Object.entries(runtime.upstreamProviderPinAdapterMap)
      .map(([siteId, adapterId]) => ({ siteId, adapterId })),
    [runtime.upstreamProviderPinAdapterMap],
  );

  const updatePinAdapterRowSite = (currentSiteId: string, nextSiteId: string) => {
    setRuntime((prev) => {
      const nextMap = { ...prev.upstreamProviderPinAdapterMap };
      const adapterId = nextMap[currentSiteId] ?? 'generic-dual';
      delete nextMap[currentSiteId];
      const normalizedSiteId = nextSiteId.trim();
      if (normalizedSiteId) nextMap[normalizedSiteId] = adapterId;
      return { ...prev, upstreamProviderPinAdapterMap: nextMap };
    });
  };

  const updatePinAdapterRowAdapter = (siteId: string, adapterId: string) => {
    setRuntime((prev) => ({
      ...prev,
      upstreamProviderPinAdapterMap: {
        ...prev.upstreamProviderPinAdapterMap,
        [siteId]: adapterId,
      },
    }));
  };

  const addPinAdapterRow = () => {
    setRuntime((prev) => {
      if ('' in prev.upstreamProviderPinAdapterMap) return prev;
      return {
        ...prev,
        upstreamProviderPinAdapterMap: {
          ...prev.upstreamProviderPinAdapterMap,
          '': upstreamPinAdapterCatalog[0]?.id ?? 'generic-dual',
        },
      };
    });
  };

  const removePinAdapterRow = (siteId: string) => {
    setRuntime((prev) => {
      const nextMap = { ...prev.upstreamProviderPinAdapterMap };
      delete nextMap[siteId];
      return { ...prev, upstreamProviderPinAdapterMap: nextMap };
    });
  };

  const updatePinRule = (
    index: number,
    updater: (rule: UpstreamProviderPinRule) => UpstreamProviderPinRule,
  ) => {
    setRuntime((prev) => ({
      ...prev,
      upstreamProviderPinRules: prev.upstreamProviderPinRules.map((rule, ruleIndex) => (
        ruleIndex === index ? updater(rule) : rule
      )),
    }));
  };

  const addUpstreamPinRule = () => {
    setPinObservation({});
    setPinProviderDrafts({});
    setRuntime((prev) => ({
      ...prev,
      upstreamProviderPinRules: [
        ...prev.upstreamProviderPinRules,
        { siteId: 0, model: '', providers: [], mode: 'only' },
      ],
    }));
  };

  const removeUpstreamPinRule = (index: number) => {
    setPinObservation({});
    setPinProviderDrafts({});
    setRuntime((prev) => ({
      ...prev,
      upstreamProviderPinRules: prev.upstreamProviderPinRules.filter((_rule, ruleIndex) => ruleIndex !== index),
    }));
  };

  const moveUpstreamPinRule = (index: number, direction: -1 | 1) => {
    setPinObservation({});
    setPinProviderDrafts({});
    setRuntime((prev) => {
      const rules = prev.upstreamProviderPinRules;
      const target = index + direction;
      if (target < 0 || target >= rules.length) return prev;
      const next = [...rules];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return { ...prev, upstreamProviderPinRules: next };
    });
  };

  const commitPinProviders = (index: number, raw: string) => {
    const parts = raw.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
    if (parts.length === 0) return;
    updatePinRule(index, (rule) => ({
      ...rule,
      providers: normalizeUpstreamPinProviders([...rule.providers, ...parts]),
    }));
  };

  const handlePinProviderInputChange = (index: number, value: string) => {
    if (!/[,，]/.test(value)) {
      setPinProviderDrafts((prev) => ({ ...prev, [index]: value }));
      return;
    }
    const parts = value.split(/[,，]/);
    const trailing = parts.pop() ?? '';
    const committed = parts.join(',');
    if (committed.trim()) commitPinProviders(index, committed);
    setPinProviderDrafts((prev) => ({ ...prev, [index]: trailing.trimStart() }));
  };

  const removePinProvider = (index: number, provider: string) => {
    updatePinRule(index, (rule) => ({
      ...rule,
      providers: rule.providers.filter((item) => item !== provider),
    }));
  };

  const togglePinObservation = async (index: number, rule: UpstreamProviderPinRule) => {
    const current = pinObservation[index];
    if (current) {
      setPinObservation((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      return;
    }
    if (!runtime.upstreamProviderDetectEnabled) {
      setPinObservation((prev) => ({
        ...prev,
        [index]: { loading: false, error: '暂无观测数据（需开启上游探测且有命中流量）' },
      }));
      return;
    }
    if (!rule.siteId || !rule.model.trim()) {
      setPinObservation((prev) => ({
        ...prev,
        [index]: { loading: false, error: '需要先填写站点与模型才能查询' },
      }));
      return;
    }
    setPinObservation((prev) => ({ ...prev, [index]: { loading: true } }));
    try {
      const items = await api.getUpstreamObservationDistribution({
        siteId: rule.siteId,
        model: rule.model.trim(),
      });
      setPinObservation((prev) => ({ ...prev, [index]: { loading: false, items } }));
    } catch (err: any) {
      setPinObservation((prev) => ({
        ...prev,
        [index]: { loading: false, error: err?.message || '加载观测数据失败' },
      }));
    }
  };

  const fillPinProvidersFromObservation = async (index: number, rule: UpstreamProviderPinRule) => {
    if (!rule.siteId) {
      toast.error('请先选择站点');
      return;
    }
    try {
      const res = await api.getUpstreamObservationFallbacks({ siteId: rule.siteId });
      const candidates = normalizeUpstreamPinProviders(
        (Array.isArray(res?.items) ? res.items : [])
          .flatMap((group) => (Array.isArray(group?.fallbacks) ? group.fallbacks : [])),
      );
      if (candidates.length === 0) {
        toast.error('暂无观测数据可填充（需开启上游探测且有命中流量）');
        return;
      }
      updatePinRule(index, (current) => ({
        ...current,
        providers: normalizeUpstreamPinProviders([...current.providers, ...candidates]),
      }));
    } catch (err: any) {
      toast.error(err?.message || '读取观测数据失败');
    }
  };

  const saveUpstreamPin = async () => {
    setSavingUpstreamPin(true);
    try {
      const submittedRules: UpstreamProviderPinRule[] = runtime.upstreamProviderPinRules.map((rule) => ({
        siteId: rule.siteId,
        model: rule.model.trim(),
        providers: normalizeUpstreamPinProviders(rule.providers),
        mode: rule.mode,
      }));
      const res = await api.updateRuntimeSettings({
        upstreamProviderPinEnabled: runtime.upstreamProviderPinEnabled,
        upstreamProviderPinRules: submittedRules,
        upstreamProviderPinAdapterMap: { ...runtime.upstreamProviderPinAdapterMap },
      });
      setRuntime((prev) => ({
        ...prev,
        upstreamProviderPinEnabled: res?.upstreamProviderPinEnabled === undefined
          ? prev.upstreamProviderPinEnabled
          : !!res.upstreamProviderPinEnabled,
        upstreamProviderPinRules: res?.upstreamProviderPinRules === undefined
          ? submittedRules
          : normalizeUpstreamPinRulesFromSettings(res.upstreamProviderPinRules),
        upstreamProviderPinAdapterMap: res?.upstreamProviderPinAdapterMap === undefined
          ? prev.upstreamProviderPinAdapterMap
          : normalizeUpstreamPinAdapterMapFromSettings(res.upstreamProviderPinAdapterMap),
      }));
      setPinProviderDrafts({});
      toast.success('上游钉选设置已保存，已热生效');
    } catch (err: any) {
      toast.error(err?.message || '保存上游钉选设置失败');
    } finally {
      setSavingUpstreamPin(false);
    }
  };

  const addUpstreamParamCompatRule = () => {
    setRuntime((prev) => {
      if (prev.upstreamParamCompatRules.length >= 64) return prev;
      return {
        ...prev,
        upstreamParamCompatRules: [
          ...prev.upstreamParamCompatRules,
          { siteId: 0, model: '', params: [], endpoints: [] },
        ],
      };
    });
  };

  const removeUpstreamParamCompatRule = (index: number) => {
    setParamCompatParamDrafts((prev) => {
      const nextDrafts: Record<number, string> = {};
      let targetIndex = 0;
      for (let i = 0; i < runtime.upstreamParamCompatRules.length; i++) {
        if (i === index) continue;
        if (prev[i] !== undefined) {
          nextDrafts[targetIndex] = prev[i];
        }
        targetIndex++;
      }
      return nextDrafts;
    });
    setRuntime((prev) => ({
      ...prev,
      upstreamParamCompatRules: prev.upstreamParamCompatRules.filter((_rule, ruleIndex) => ruleIndex !== index),
    }));
  };

  const updateUpstreamParamCompatRule = (
    index: number,
    updater: (rule: UpstreamParamCompatRule) => UpstreamParamCompatRule,
  ) => {
    setRuntime((prev) => ({
      ...prev,
      upstreamParamCompatRules: prev.upstreamParamCompatRules.map((rule, ruleIndex) => (
        ruleIndex === index ? updater(rule) : rule
      )),
    }));
  };

  const saveUpstreamParamCompat = async () => {
    const emptyRule = runtime.upstreamParamCompatRules.find(
      (rule) => !rule.siteId || rule.siteId <= 0 || !rule.model.trim(),
    );
    if (emptyRule) {
      toast.error('请先填写站点和模型后再保存，空规则会导致请求失败');
      return;
    }

    const emptyParamRule = runtime.upstreamParamCompatRules.find((rule, ruleIndex) => {
      const draft = paramCompatParamDrafts[ruleIndex];
      const params = draft !== undefined
        ? draft.split(',').map((p) => p.trim()).filter(Boolean)
        : rule.params;
      return params.length === 0;
    });
    if (emptyParamRule) {
      const ruleIndex = runtime.upstreamParamCompatRules.indexOf(emptyParamRule);
      toast.error(`规则 #${ruleIndex + 1} 请填写要剥除的参数名`);
      return;
    }

    const invalidParamRule = runtime.upstreamParamCompatRules.find((rule, ruleIndex) => {
      const draft = paramCompatParamDrafts[ruleIndex];
      const params = draft !== undefined
        ? draft.split(',').map((p) => p.trim()).filter(Boolean)
        : rule.params;
      return params.some((param) => {
        if (!UPSTREAM_PARAM_COMPAT_IDENTIFIER_PATTERN.test(param)) {
          return true;
        }
        if (
          UPSTREAM_PARAM_COMPAT_STRUCTURAL_KEYS.includes(param as any)
          || UPSTREAM_PARAM_COMPAT_RESERVED_NAMES.has(param)
        ) {
          return true;
        }
        return false;
      });
    });
    if (invalidParamRule) {
      const ruleIndex = runtime.upstreamParamCompatRules.indexOf(invalidParamRule);
      const draft = paramCompatParamDrafts[ruleIndex];
      const params = draft !== undefined
        ? draft.split(',').map((p) => p.trim()).filter(Boolean)
        : invalidParamRule.params;
      const bad = params.find((param) => {
        if (!UPSTREAM_PARAM_COMPAT_IDENTIFIER_PATTERN.test(param)) return true;
        if (
          UPSTREAM_PARAM_COMPAT_STRUCTURAL_KEYS.includes(param as any)
          || UPSTREAM_PARAM_COMPAT_RESERVED_NAMES.has(param)
        ) return true;
        return false;
      });
      const reason = !UPSTREAM_PARAM_COMPAT_IDENTIFIER_PATTERN.test(bad!)
        ? '格式不合法（须为合法标识符）'
        : '属于结构键/保留名，禁止剥离';
      toast.error(
        `规则 #${ruleIndex + 1} 的参数「${bad}」${reason}，请修改`,
      );
      return;
    }

    setSavingUpstreamParamCompat(true);
    try {
      const submittedRules = runtime.upstreamParamCompatRules.map((rule, ruleIndex) => {
        const rawDraft = paramCompatParamDrafts[ruleIndex];
        const params = rawDraft !== undefined
          ? rawDraft.split(',').map((p) => p.trim()).filter(Boolean)
          : rule.params.filter((p) => p.trim());
        return {
          siteId: rule.siteId,
          model: rule.model.trim(),
          params,
          ...(rule.endpoints && rule.endpoints.length > 0 ? { endpoints: rule.endpoints } : {}),
        };
      });
      const res = await api.updateRuntimeSettings({
        upstreamParamCompatEnabled: runtime.upstreamParamCompatEnabled,
        upstreamParamCompatSelfHealEnabled: runtime.upstreamParamCompatSelfHealEnabled,
        upstreamParamCompatRules: submittedRules,
      });
      setRuntime((prev) => ({
        ...prev,
        upstreamParamCompatEnabled: typeof res?.upstreamParamCompatEnabled === 'boolean'
          ? res.upstreamParamCompatEnabled
          : prev.upstreamParamCompatEnabled,
        upstreamParamCompatSelfHealEnabled: typeof res?.upstreamParamCompatSelfHealEnabled === 'boolean'
          ? res.upstreamParamCompatSelfHealEnabled
          : prev.upstreamParamCompatSelfHealEnabled,
        upstreamParamCompatRules: res?.upstreamParamCompatRules === undefined
          ? submittedRules
          : Array.isArray(res.upstreamParamCompatRules)
            ? res.upstreamParamCompatRules.filter((item: unknown) => {
                if (!item || typeof item !== 'object') return false;
                const record = item as Record<string, unknown>;
                const siteId = Math.trunc(Number(record.siteId));
                if (!Number.isInteger(siteId) || siteId <= 0) return false;
                const model = typeof record.model === 'string' ? record.model.trim() : '';
                if (!model) return false;
                return true;
              }).map((item: Record<string, unknown>) => ({
                siteId: Math.trunc(Number(item.siteId)),
                model: String(item.model).trim(),
                params: Array.isArray(item.params)
                  ? item.params.filter((p: unknown) => typeof p === 'string' && p.trim())
                  : [],
                ...(Array.isArray(item.endpoints) && item.endpoints.length > 0 ? { endpoints: item.endpoints as UpstreamParamCompatEndpoint[] } : {}),
              }))
            : submittedRules,
      }));
      setParamCompatParamDrafts({});
      toast.success('上游参数兼容层设置已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存上游参数兼容层设置失败');
    } finally {
      setSavingUpstreamParamCompat(false);
    }
  };

  const configuredPayloadRuleCount = useMemo(
    () => payloadVisualRules.filter((rule) => !isVisualPayloadRuleBlank(rule)).length,
    [payloadVisualRules],
  );

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
      <div className="page-header">
        <h2 className="page-title">上游设置</h2>
      </div>

      <div style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* 代理失败判定 */}
        <div className="card animate-slide-up stagger-4" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>代理失败判定</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            命中任一关键词或空内容时判定失败，可触发重试。
          </div>
          <textarea
            value={proxyErrorKeywordsText}
            onChange={(e) => setProxyErrorKeywordsText(e.target.value)}
            placeholder="一行一个关键词，或逗号分隔"
            style={{
              ...inputStyle,
              fontFamily: 'var(--font-mono)',
              minHeight: 96,
              resize: 'vertical',
              marginBottom: 12,
            }}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={runtime.proxyEmptyContentFailEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, proxyEmptyContentFailEnabled: e.target.checked }))}
            />
            空内容（completion=0，即使 prompt 有词元也算）判定失败
          </label>
          <div>
            <button onClick={saveProxyFailureRules} disabled={savingProxyFailureRules} className="btn btn-primary">
              {savingProxyFailureRules ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存失败规则'}
            </button>
          </div>
        </div>

        {/* Payload 规则 */}
        <div className="card animate-slide-up stagger-4" style={settingsModernCardStyle} data-settings-card="payload-rules">
          <div style={settingsModernHeaderStyle}>
            <div style={settingsModernTitleBlockStyle}>
              <div style={settingsModernTitleStyle}>Payload 规则</div>
              <div style={settingsModernDescriptionStyle}>
                对匹配模型的上游请求做默认注入、强制覆盖或字段过滤。规则结构参考 CPA 的 payload 配置，常见场景可直接注入
                {' '}
                <code style={{ fontFamily: 'var(--font-mono)' }}>reasoning.effort</code>
                {' '}
                之类的参数。
              </div>
            </div>
            <div style={settingsModernPillRowStyle}>
              <span style={getSettingsPillStyle(configuredPayloadRuleCount > 0 ? 'primary' : 'neutral')}>
                {configuredPayloadRuleCount > 0 ? `已配置 ${configuredPayloadRuleCount} 条` : '未配置'}
              </span>
              <span style={getSettingsPillStyle(payloadAdvancedDirty ? 'warning' : 'neutral')}>
                {payloadAdvancedDirty ? '高级 JSON 待同步/保存' : '保存后立即生效'}
              </span>
            </div>
          </div>
          <div style={settingsModernFieldCardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                <div style={settingsModernFieldLabelStyle}>常用预设</div>
                <div style={settingsModernFieldHintStyle}>
                  先用预设快速填充，再通过下面的可视化规则编辑器细调。复杂场景仍可回退到高级 JSON。
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={applyCodexDefaultHighReasoningPreset}
                >
                  Codex 默认高推理
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={addPayloadVisualRule}
                >
                  新增规则
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)' }}
                  onClick={() => setShowPayloadRulesEditor((prev) => !prev)}
                >
                  {showPayloadRulesEditor ? '收起高级 JSON 编辑' : '展开高级 JSON 编辑'}
                </button>
              </div>
            </div>
          </div>
          {payloadVisualRules.length <= 0 ? (
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>还没有可视化规则</div>
              <div style={settingsModernFieldHintStyle}>
                可以先点上面的预设，也可以直接新增一条规则：选择动作、协议、模型匹配、字段路径和值即可。
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {payloadVisualRules.map((rule, index) => (
                <div
                  key={rule.id}
                  style={settingsModernFieldCardStyle}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <div style={settingsModernFieldLabelStyle}>规则 {index + 1}</div>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ border: '1px solid var(--color-border)', color: 'var(--color-danger)' }}
                      onClick={() => removePayloadVisualRule(rule.id)}
                    >
                      删除
                    </button>
                  </div>
                  <ResponsiveFormGrid columns={2}>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>动作</div>
                      <ModernSelect
                        size="sm"
                        data-testid={`payload-rule-action-${index + 1}`}
                        value={rule.action}
                        onChange={(value) => updatePayloadVisualRule(rule.id, { action: value as PayloadRuleAction })}
                        options={PAYLOAD_RULE_ACTION_OPTIONS}
                        placeholder="选择动作"
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>协议</div>
                      <ModernSelect
                        size="sm"
                        data-testid={`payload-rule-protocol-${index + 1}`}
                        value={rule.protocol}
                        onChange={(value) => updatePayloadVisualRule(rule.id, { protocol: String(value || '') })}
                        options={PAYLOAD_RULE_PROTOCOL_OPTIONS}
                        placeholder="全部协议"
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>模型匹配</div>
                      <input
                        type="text"
                        aria-label={`Payload 规则可视化模型 ${index + 1}`}
                        value={rule.modelPattern}
                        onChange={(e) => updatePayloadVisualRule(rule.id, { modelPattern: e.target.value })}
                        placeholder="例如 gpt-*"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>字段路径</div>
                      <input
                        type="text"
                        aria-label={`Payload 规则可视化路径 ${index + 1}`}
                        value={rule.path}
                        onChange={(e) => updatePayloadVisualRule(rule.id, { path: e.target.value })}
                        placeholder="例如 reasoning.effort"
                        style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                  </ResponsiveFormGrid>
                  {rule.action === 'filter' ? (
                    <div style={settingsModernFieldHintStyle}>
                      删除字段规则不需要填写值，命中后会从请求中移除这条路径。
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {(rule.action === 'default' || rule.action === 'override') && (
                        <div style={{ width: isMobile ? '100%' : 180 }}>
                          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>值类型</div>
                          <ModernSelect
                            size="sm"
                            data-testid={`payload-rule-value-mode-${index + 1}`}
                            value={rule.valueMode}
                            onChange={(value) => updatePayloadVisualRule(rule.id, {
                              valueMode: value as VisualPayloadRuleValueMode,
                              value: value === 'json' && rule.valueMode !== 'json'
                                ? (rule.value ? JSON.stringify(rule.value) : '')
                                : rule.value,
                            })}
                            options={PAYLOAD_RULE_VALUE_MODE_OPTIONS}
                            placeholder="值类型"
                          />
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                          {rule.action === 'default-raw' || rule.action === 'override-raw'
                            ? '原始 JSON 值'
                            : (rule.valueMode === 'json' ? 'JSON 值' : '文本值')}
                        </div>
                        {(rule.action === 'default-raw' || rule.action === 'override-raw' || rule.valueMode === 'json') ? (
                          <textarea
                            aria-label={`Payload 规则可视化值 ${index + 1}`}
                            value={rule.value}
                            onChange={(e) => updatePayloadVisualRule(rule.id, { value: e.target.value })}
                            placeholder={rule.action === 'default-raw' || rule.action === 'override-raw'
                              ? '{"type":"json_schema"}'
                              : '{"effort":"high"}'}
                            rows={3}
                            style={{
                              ...inputStyle,
                              minHeight: 88,
                              fontFamily: 'var(--font-mono)',
                              lineHeight: 1.6,
                              resize: 'vertical',
                            }}
                          />
                        ) : (
                          <input
                            type="text"
                            aria-label={`Payload 规则可视化值 ${index + 1}`}
                            value={rule.value}
                            onChange={(e) => updatePayloadVisualRule(rule.id, { value: e.target.value })}
                            placeholder="例如 high"
                            style={inputStyle}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className={`anim-collapse ${showPayloadRulesEditor ? 'is-open' : ''}`.trim()}>
            <div className="anim-collapse-inner" style={{ paddingTop: 2 }}>
              <div style={settingsModernFieldCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <div style={settingsModernFieldLabelStyle}>高级 JSON 编辑</div>
                    <div style={settingsModernFieldHintStyle}>
                      适合直接粘贴 CPA 风格规则。手动改完后，可点击“同步到可视化规则”回到上面的低门槛编辑器。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ border: '1px solid var(--color-border)' }}
                    onClick={syncVisualRulesFromAdvancedJson}
                  >
                    同步到可视化规则
                  </button>
                </div>
              </div>
              <ResponsiveFormGrid columns={2}>
                {PAYLOAD_RULES_EDITOR_SECTIONS.map((section) => (
                  <div key={section.key} style={settingsModernFieldCardStyle}>
                    <div style={settingsModernFieldLabelStyle}>{section.title}</div>
                    <div style={settingsModernFieldHintStyle}>{section.description}</div>
                    <textarea
                      aria-label={`Payload 规则 ${section.key}`}
                      value={payloadRuleDrafts[section.key]}
                      onChange={(e) => {
                        const nextValue = e.target.value;
                        setPayloadRuleDrafts((prev) => ({
                          ...prev,
                          [section.key]: nextValue,
                        }));
                        setPayloadAdvancedDirty(true);
                      }}
                      placeholder={section.placeholder}
                      rows={6}
                      style={{
                        ...inputStyle,
                        minHeight: 144,
                        fontFamily: 'var(--font-mono)',
                        lineHeight: 1.6,
                        resize: 'vertical',
                      }}
                    />
                  </div>
                ))}
              </ResponsiveFormGrid>
            </div>
          </div>
          <div style={settingsModernActionsStyle}>
            <button onClick={savePayloadRules} disabled={savingPayloadRules} className="btn btn-primary">
              {savingPayloadRules ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存 Payload 规则'}
            </button>
          </div>
        </div>

        {/* Codex 上游传输与会话并发 */}
        <div className="card animate-slide-up stagger-4" style={settingsModernCardStyle} data-settings-card="proxy-transport">
          <div style={settingsModernHeaderStyle}>
            <div style={settingsModernTitleBlockStyle}>
              <div style={settingsModernTitleStyle}>Codex 上游传输与会话并发</div>
              <div style={settingsModernDescriptionStyle}>
                默认采用 HTTP 优先。只有这里开启后，metapi 才会在 Codex 请求上尝试把上游升级为 WebSocket。下游 Codex 客户端也必须同时启用 `/v1/responses` websocket，单开这里不会生效。
              </div>
            </div>
            <div style={settingsModernPillRowStyle}>
              <span style={getSettingsPillStyle(runtime.codexUpstreamWebsocketEnabled ? 'primary' : 'neutral')}>
                {proxyTransportModeLabel}
              </span>
              <span style={getSettingsPillStyle('neutral')}>
                {proxyTransportQueueLabel}
              </span>
            </div>
          </div>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>允许 metapi 到 Codex 上游使用 WebSocket</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                仅在下游 Codex 客户端已同步开启 `/v1/responses` websocket 时启用；否则仍按 HTTP 优先执行。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.codexUpstreamWebsocketEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, codexUpstreamWebsocketEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Compact 明确不支持时回退到普通 Responses</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                仅对 `/v1/responses/compact` 生效。当上游明确返回 compact 不支持时，允许自动回退到普通 `/responses`。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.responsesCompactFallbackToResponsesEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, responsesCompactFallbackToResponsesEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          <ResponsiveFormGrid columns={2}>
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>会话通道并发上限</div>
              <input
                type="number"
                min={0}
                value={runtime.proxySessionChannelConcurrencyLimit}
                onChange={(e) => {
                  const nextValue = Number(e.target.value);
                  setRuntime((prev) => ({
                    ...prev,
                    proxySessionChannelConcurrencyLimit: Number.isFinite(nextValue) && nextValue >= 0
                      ? Math.trunc(nextValue)
                      : prev.proxySessionChannelConcurrencyLimit,
                  }));
                }}
                style={inputStyle}
              />
              <div style={settingsModernFieldHintStyle}>
                只作用于能识别稳定 `session_id` 的会话型请求；普通请求不会进入这组 lease 池。
              </div>
            </div>
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>排队等待时间（毫秒）</div>
              <input
                type="number"
                min={0}
                step={100}
                value={runtime.proxySessionChannelQueueWaitMs}
                onChange={(e) => {
                  const nextValue = Number(e.target.value);
                  setRuntime((prev) => ({
                    ...prev,
                    proxySessionChannelQueueWaitMs: Number.isFinite(nextValue) && nextValue >= 0
                      ? Math.trunc(nextValue)
                      : prev.proxySessionChannelQueueWaitMs,
                  }));
                }}
                style={inputStyle}
              />
              <div style={settingsModernFieldHintStyle}>
                超过该时间仍拿不到会话通道时，本次请求会直接放弃排队，避免长期挂起。
              </div>
            </div>
          </ResponsiveFormGrid>
          <div style={settingsModernActionsStyle}>
            <button onClick={saveProxyTransportSettings} disabled={savingProxyTransport} className="btn btn-primary">
              {savingProxyTransport ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存传输与并发'}
            </button>
          </div>
        </div>

        {/* 批量测活 */}
        <div className="card animate-slide-up stagger-4" style={settingsModernDangerCardStyle} data-settings-card="model-availability-probe">
          <div style={settingsModernHeaderStyle}>
            <div style={settingsModernTitleBlockStyle}>
              <div style={{ ...settingsModernTitleStyle, color: 'var(--color-danger)' }}>批量测活</div>
              <div style={settingsModernDescriptionStyle}>
                默认关闭。开启后，metapi 会在后台定时对活跃账号模型发送最小化探测请求，用来校正“/models 能看到但实际不可用”的假阳性。
              </div>
            </div>
            <div style={settingsModernPillRowStyle}>
              <span style={getSettingsPillStyle(modelAvailabilityProbeStatusTone)}>
                {modelAvailabilityProbeStatusLabel}
              </span>
              <span style={getSettingsPillStyle('danger')}>
                高风险操作
              </span>
            </div>
          </div>
          <div
            style={{
              ...settingsModernCalloutStyle,
              borderColor: 'color-mix(in srgb, var(--color-danger) 18%, var(--color-border-light))',
              background: 'color-mix(in srgb, var(--color-danger-soft) 38%, var(--color-bg-card))',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-danger)' }}>风险提示</div>
            <div style={{ fontSize: 12, lineHeight: 1.75, color: 'var(--color-text-secondary)' }}>
              只有在你确认自己使用的中转站明确允许批量测活时才应该开启。若上游不允许，这类探测可能带来封号或风控风险。
            </div>
          </div>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>允许 metapi 后台主动批量测活</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                首次从关闭切换到开启时，需要手动输入确认语句；关闭时可直接保存。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.modelAvailabilityProbeEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, modelAvailabilityProbeEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          <ResponsiveFormGrid columns={2}>
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>当前生效状态</div>
              <div style={settingsModernPillRowStyle}>
                <span style={getSettingsPillStyle(modelAvailabilityProbeStatusTone)}>
                  {modelAvailabilityProbeStatusLabel}
                </span>
              </div>
              <div style={settingsModernFieldHintStyle}>
                {savedModelAvailabilityProbeEnabled
                  ? '后台会定时执行最小化探测请求，用于校正模型可用性。'
                  : '后台不会主动发起模型可用性探测请求。'}
              </div>
            </div>
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>启用门槛</div>
              <div style={{ ...settingsModernFieldHintStyle, marginTop: 0 }}>
                首次开启必须手动输入确认语句，避免误把高风险探测当成普通开关。
              </div>
            </div>
          </ResponsiveFormGrid>
          <div style={settingsModernActionsStyle}>
            <button onClick={saveModelAvailabilityProbeSettings} disabled={savingModelAvailabilityProbe} className="btn btn-primary">
              {savingModelAvailabilityProbe ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存批量测活设置'}
            </button>
          </div>
        </div>

        {/* 上游探测 */}
        <div
          className="card animate-slide-up stagger-5"
          style={{ ...settingsModernCardStyle, scrollMarginTop: 64 }}
          id="settings-section-upstream-detect"
          data-settings-card={UPSTREAM_DETECT_SECTION_ID}
        >
          <div style={settingsModernHeaderStyle}>
            <div style={settingsModernTitleBlockStyle}>
              <div style={settingsModernTitleStyle}>上游探测</div>
              <div style={settingsModernDescriptionStyle}>
                解析上游网关返回的路由元数据（provider_metadata.gateway.routing），记录每笔请求实际命中的上游提供方；适用于返回该结构的网关（例如 Cline）。
              </div>
            </div>
            <div style={settingsModernPillRowStyle}>
              <span style={getSettingsPillStyle(runtime.upstreamProviderDetectEnabled ? 'primary' : 'neutral')}>
                {upstreamDetectStatusLabel}
              </span>
              <span style={getSettingsPillStyle(runtime.upstreamProviderDetectSiteIds.length > 0 ? 'primary' : 'neutral')}>
                {upstreamDetectSiteCountLabel}
              </span>
            </div>
          </div>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>开启上游探测</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                只旁路记录，不改下游字节、不参与计费；保存后立即生效。关闭时不会解析任何上游响应。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.upstreamProviderDetectEnabled}
              data-upstream-detect-field="enabled"
              onChange={(e) => setRuntime((prev) => ({ ...prev, upstreamProviderDetectEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          <ResponsiveFormGrid columns={2}>
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>采样率（0–1，1 = 全量）</div>
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={runtime.upstreamProviderDetectSampleRate}
                data-upstream-detect-field="sample-rate"
                onChange={(e) => {
                  const nextValue = Number(e.target.value);
                  setRuntime((prev) => ({
                    ...prev,
                    upstreamProviderDetectSampleRate: Number.isFinite(nextValue)
                      ? Math.min(1, Math.max(0, nextValue))
                      : prev.upstreamProviderDetectSampleRate,
                  }));
                }}
                style={inputStyle}
              />
              <div style={settingsModernFieldHintStyle}>
                按请求 ID 稳定采样，同一请求结果不随刷新变化。
              </div>
            </div>
            <div style={settingsModernFieldCardStyle}>
              <div style={settingsModernFieldLabelStyle}>观测保留天数（0 = 不清理）</div>
              <input
                type="number"
                min={0}
                value={runtime.upstreamProviderDetectRetentionDays}
                data-upstream-detect-field="retention-days"
                onChange={(e) => {
                  const nextValue = Number(e.target.value);
                  setRuntime((prev) => ({
                    ...prev,
                    upstreamProviderDetectRetentionDays: Number.isFinite(nextValue) && nextValue >= 0
                      ? Math.trunc(nextValue)
                      : prev.upstreamProviderDetectRetentionDays,
                  }));
                }}
                style={inputStyle}
              />
              <div style={settingsModernFieldHintStyle}>
                观测默认保留 14 天（短于日志 30 天）；请求详情按 ±2s 唯一匹配，对不上不猜测。
              </div>
            </div>
          </ResponsiveFormGrid>
          <div style={settingsModernFieldCardStyle} data-upstream-detect-sites>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={settingsModernFieldLabelStyle}>参与站点（多选）</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px' }}
                  onClick={selectAllUpstreamDetectSites}
                  disabled={!upstreamDetectSites || upstreamDetectSites.length === 0}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px' }}
                  onClick={clearUpstreamDetectSites}
                  disabled={runtime.upstreamProviderDetectSiteIds.length === 0}
                >
                  清空
                </button>
              </div>
            </div>
            {upstreamDetectSites === null ? (
              <div style={settingsModernFieldHintStyle}>
                {upstreamDetectSitesFailed ? '站点列表加载失败，请刷新页面后重试' : '加载站点列表中...'}
              </div>
            ) : upstreamDetectSites.length === 0 ? (
              <div style={settingsModernFieldHintStyle}>暂无站点，可先到「站点」页添加</div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gap: 6,
                  maxHeight: 240,
                  overflowY: 'auto',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg)',
                }}
              >
                {upstreamDetectSites.map((site) => (
                  <label
                    key={site.id}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)' }}
                  >
                    <input
                      type="checkbox"
                      checked={runtime.upstreamProviderDetectSiteIds.includes(site.id)}
                      data-upstream-detect-site={site.id}
                      onChange={(e) => toggleUpstreamDetectSite(site.id, e.target.checked)}
                    />
                    <span>{site.name}</span>
                    {site.url ? (
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{site.url}</span>
                    ) : null}
                  </label>
                ))}
              </div>
            )}
            {runtime.upstreamProviderDetectSiteIds.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-warning)' }}>
                未选择任何站点 = 不采集（即使总开关开启）
              </div>
            ) : (
              <div style={settingsModernFieldHintStyle}>
                只有勾选站点的请求才会解析并记录上游观测；勾选变化保存后立即生效，无需重启。
              </div>
            )}
          </div>
          <div style={settingsModernActionsStyle}>
            <button
              onClick={saveUpstreamDetect}
              disabled={savingUpstreamDetect}
              className="btn btn-primary"
            >
              {savingUpstreamDetect ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存上游探测设置'}
            </button>
          </div>
        </div>

        {/* 上游供应商钉选 */}
        <div
          className="card animate-slide-up stagger-5"
          style={{ ...settingsModernCardStyle, scrollMarginTop: 64 }}
          id="settings-section-upstream-pin"
          data-settings-card={UPSTREAM_PIN_SECTION_ID}
        >
          <div style={settingsModernHeaderStyle}>
            <div style={settingsModernTitleBlockStyle}>
              <div style={settingsModernTitleStyle}>上游供应商钉选</div>
              <div style={settingsModernDescriptionStyle}>
                按「站点 + 下游请求模型」向上游 JSON 请求体注入供应商钉选字段（内置双姿势：嵌套 providerOptions.gateway 与顶层 provider 两种，可按站点切换适配器）。适用于所有支持该字段约定的网关与聚合商。支持方会据此改变实际路由；不读取该约定的上游通常会忽略这些字段，个别严格校验者可能拒绝——建议先从实测支持的站点启用；一旦支持即自动生效，无需 metapi 变更。注入仅对 chat / responses 的默认路径生效（messages、gemini 原生、codex 站点与 WebSocket、测活等路径不注入）。选择 OpenRouter 适配器后，only / order 直接对应其原生 provider.only / provider.order 契约，语义即时真实生效，请确认规则正确后再开启。
              </div>
            </div>
            <div style={settingsModernPillRowStyle}>
              <span style={getSettingsPillStyle(runtime.upstreamProviderPinEnabled ? 'primary' : 'neutral')}>
                {upstreamPinStatusLabel}
              </span>
              <span style={getSettingsPillStyle(runtime.upstreamProviderPinRules.length > 0 ? 'primary' : 'neutral')}>
                {upstreamPinRuleCountLabel}
              </span>
            </div>
          </div>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>开启钉选注入</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                总开关关闭或规则为空 = 完全不注入，无配置零行为变化；保存后立即生效。注入只作用于 chat / responses 的 JSON 请求体，且在 payload 规则与字段清理之后写入。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.upstreamProviderPinEnabled}
              data-upstream-pin-field="enabled"
              onChange={(e) => setRuntime((prev) => ({ ...prev, upstreamProviderPinEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          {runtime.upstreamProviderPinRules.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-warning)' }}>
              未配置规则 = 不注入任何字段
            </div>
          ) : (
            <div style={settingsModernFieldHintStyle}>
              按自上而下顺序，首个命中的规则生效；model 匹配的是下游请求模型（非上游实际模型），支持精确或 * 通配、区分大小写。
            </div>
          )}
          {/* 网关适配器 */}
          <div
            data-upstream-pin-adapter-section="1"
            style={{ ...settingsModernFieldCardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>网关适配器</div>
            <div style={settingsModernFieldHintStyle}>
              按站点选择注入姿势，作用于该站点的全部命中规则；未配置的站点使用默认双姿势注入。适配器下拉只列出当前已支持的四家，不会出现未实现选项。
            </div>
            {upstreamPinAdapterRows.length === 0 ? (
              <div data-upstream-pin-adapter-empty style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                未配置 = 全部站点使用默认双姿势注入
              </div>
            ) : null}
            {upstreamPinAdapterRows.map((row) => {
              const catalogEntry = upstreamPinAdapterById.get(row.adapterId) ?? null;
              return (
                <div
                  key={row.siteId}
                  data-upstream-pin-adapter-row={row.siteId}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                    <div style={{ flex: '1 1 160px', minWidth: 140 }}>
                      <div style={settingsModernFieldLabelStyle}>站点</div>
                      <select
                        value={row.siteId}
                        data-upstream-pin-adapter-field={`site-${row.siteId}`}
                        onChange={(e) => updatePinAdapterRowSite(row.siteId, e.target.value)}
                        style={inputStyle}
                      >
                        <option value="">选择站点</option>
                        {(upstreamDetectSites || []).map((site) => (
                          <option key={site.id} value={String(site.id)}>{site.name}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex: '2 1 260px', minWidth: 200 }}>
                      <div style={settingsModernFieldLabelStyle}>适配器</div>
                      <select
                        value={row.adapterId}
                        data-upstream-pin-adapter-field={`adapter-${row.siteId}`}
                        onChange={(e) => updatePinAdapterRowAdapter(row.siteId, e.target.value)}
                        style={inputStyle}
                      >
                        {upstreamPinAdapterCatalog.map((entry) => (
                          <option key={entry.id} value={entry.id}>{entry.label}</option>
                        ))}
                        {catalogEntry ? null : (
                          <option value={row.adapterId}>未知适配器「{row.adapterId}」（不会注入）</option>
                        )}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      data-upstream-pin-adapter-action={`remove-${row.siteId}`}
                      style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px', color: 'var(--color-danger, #d33)' }}
                      onClick={() => removePinAdapterRow(row.siteId)}
                    >
                      删除
                    </button>
                  </div>
                  <div
                    data-upstream-pin-adapter-notes={row.siteId}
                    style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}
                  >
                    {catalogEntry
                      ? catalogEntry.notes
                      : '当前版本不支持该适配器 id，注入会被跳过；可更换适配器或删除该行。'}
                  </div>
                </div>
              );
            })}
            <div>
              <button
                type="button"
                className="btn btn-ghost"
                data-upstream-pin-adapter-action="add"
                style={{ border: '1px solid var(--color-border)' }}
                onClick={addPinAdapterRow}
              >
                添加适配器
              </button>
            </div>
          </div>
          {runtime.upstreamProviderPinRules.map((rule, index) => {
            const observation = pinObservation[index];
            const isDuplicated = duplicatedPinRuleIndexes.has(index);
            const pinAdapterResolution = resolveUpstreamPinAdapterForSite({
              adapterMap: runtime.upstreamProviderPinAdapterMap,
              siteId: rule.siteId,
            });
            const pinAdapterHint = resolveUpstreamPinRuleAdapterHint({
              adapter: pinAdapterResolution.adapter,
              unknownAdapterId: pinAdapterResolution.unknownAdapterId,
              mode: rule.mode,
            });
            return (
              <div
                key={index}
                data-upstream-pin-rule={index}
                style={{ ...settingsModernFieldCardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                  <div style={{ flex: '1 1 160px', minWidth: 140 }}>
                    <div style={settingsModernFieldLabelStyle}>站点</div>
                    <select
                      value={rule.siteId > 0 ? String(rule.siteId) : ''}
                      data-upstream-pin-field={`site-${index}`}
                      onChange={(e) => {
                        const nextSiteId = Math.trunc(Number(e.target.value));
                        updatePinRule(index, (current) => ({
                          ...current,
                          siteId: Number.isInteger(nextSiteId) && nextSiteId > 0 ? nextSiteId : 0,
                        }));
                      }}
                      style={inputStyle}
                    >
                      <option value="">选择站点</option>
                      {(upstreamDetectSites || []).map((site) => (
                        <option key={site.id} value={String(site.id)}>{site.name}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ flex: '2 1 260px', minWidth: 200 }}>
                    <div style={settingsModernFieldLabelStyle}>模型</div>
                    <input
                      value={rule.model}
                      data-upstream-pin-field={`model-${index}`}
                      placeholder="精确或 * 通配，例：cline-pass/deepseek-v4.1-flash；匹配的是下游请求模型"
                      onChange={(e) => updatePinRule(index, (current) => ({ ...current, model: e.target.value }))}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ flex: '2 1 240px', minWidth: 200 }}>
                    <div style={settingsModernFieldLabelStyle}>供应商（逗号或回车分隔）</div>
                    <div
                      data-upstream-pin-providers={index}
                      style={{
                        display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
                        padding: '6px 8px', borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--color-border-light)', background: 'var(--color-bg)',
                      }}
                    >
                      {rule.providers.map((provider) => (
                        <span
                          key={provider}
                          data-upstream-pin-provider={provider}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '2px 6px', fontSize: 12, borderRadius: 'var(--radius-sm)',
                            background: 'var(--color-surface-hover, rgba(127,127,127,0.12))',
                            color: 'var(--color-text-secondary)',
                          }}
                        >
                          {provider}
                          <button
                            type="button"
                            aria-label={`移除 ${provider}`}
                            onClick={() => removePinProvider(index, provider)}
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, color: 'inherit', lineHeight: 1 }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <input
                        value={pinProviderDrafts[index] ?? ''}
                        data-upstream-pin-provider-input={index}
                        placeholder="例如 deepseek"
                        onChange={(e) => handlePinProviderInputChange(index, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          commitPinProviders(index, pinProviderDrafts[index] ?? '');
                          setPinProviderDrafts((prev) => ({ ...prev, [index]: '' }));
                        }}
                        onBlur={() => {
                          commitPinProviders(index, pinProviderDrafts[index] ?? '');
                          setPinProviderDrafts((prev) => ({ ...prev, [index]: '' }));
                        }}
                        style={{ flex: '1 1 100px', minWidth: 90, border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text-primary)' }}
                      />
                    </div>
                  </div>
                  <div style={{ flex: '1 1 150px', minWidth: 130 }}>
                    <div style={settingsModernFieldLabelStyle}>模式</div>
                    <select
                      value={rule.mode}
                      data-upstream-pin-field={`mode-${index}`}
                      onChange={(e) => updatePinRule(index, (current) => ({
                        ...current,
                        mode: e.target.value === 'order' ? 'order' : 'only',
                      }))}
                      style={inputStyle}
                    >
                      <option value="only">only（严格）</option>
                      <option value="order">order（优先+回退）</option>
                    </select>
                  </div>
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                  严格 only：目标提供方不可用时请求直接失败，不会回退（OpenRouter 口径：无满足者返回 404）；order：按顺序优先，不满足时回退到其他提供方。
                </div>
                <div
                  data-upstream-pin-adapter-hint={index}
                  style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}
                >
                  网关适配器：{pinAdapterHint.label}
                </div>
                {pinAdapterHint.warning ? (
                  <div
                    data-upstream-pin-adapter-warning={index}
                    style={{ fontSize: 12, color: 'var(--color-warning)' }}
                  >
                    {pinAdapterHint.warning}
                  </div>
                ) : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-upstream-pin-action={`move-up-${index}`}
                    style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px' }}
                    onClick={() => moveUpstreamPinRule(index, -1)}
                    disabled={index === 0}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-upstream-pin-action={`move-down-${index}`}
                    style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px' }}
                    onClick={() => moveUpstreamPinRule(index, 1)}
                    disabled={index === runtime.upstreamProviderPinRules.length - 1}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-upstream-pin-action={`observe-${index}`}
                    style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px' }}
                    onClick={() => void togglePinObservation(index, rule)}
                  >
                    最近实际上游
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-upstream-pin-action={`fill-${index}`}
                    style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px' }}
                    onClick={() => void fillPinProvidersFromObservation(index, rule)}
                    disabled={!runtime.upstreamProviderDetectEnabled || !rule.siteId}
                    title={!runtime.upstreamProviderDetectEnabled ? '需先开启上游探测' : undefined}
                  >
                    从观测填充
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-upstream-pin-action={`remove-${index}`}
                    style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px', color: 'var(--color-danger, #d33)' }}
                    onClick={() => removeUpstreamPinRule(index)}
                  >
                    删除
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    「从观测填充」候选来自上游探测词表、仅适用同一网关；数据默认取最近 7 天窗口。
                  </span>
                </div>
                {isDuplicated ? (
                  <div data-upstream-pin-duplicate={index} style={{ fontSize: 12, color: 'var(--color-warning)' }}>
                    与同站点 + 同模型的规则重复，服务端将拒绝保存；请删除后重建以调整顺序。
                  </div>
                ) : null}
                {observation ? (
                  <div
                    data-upstream-pin-observation={index}
                    style={{
                      padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--color-border-light)', background: 'var(--color-bg)',
                      fontSize: 12, lineHeight: 1.8, color: 'var(--color-text-secondary)',
                    }}
                  >
                    {observation.loading ? (
                      '加载观测数据中...'
                    ) : observation.error ? (
                      observation.error
                    ) : observation.items && observation.items.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                        {observation.items.slice(0, 8).map((item) => (
                          <span key={item.provider} data-upstream-pin-observation-item={item.provider}>
                            {item.provider} · {item.requests} 次
                          </span>
                        ))}
                      </div>
                    ) : (
                      '暂无观测数据（需开启上游探测且有命中流量）'
                    )}
                    {rule.model.includes('*') ? (
                      <div style={{ color: 'var(--color-text-muted)' }}>
                        通配模式下按字面模型名查询，可能无结果。
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {runtime.upstreamProviderPinRules.length > 0 ? (
            <div style={settingsModernFieldHintStyle}>
              回退路径说明：downstreamFormat=claude 回退到 messages 端点时不注入（设计预期）；同一站点的多个规则按顺序首个命中生效。
            </div>
          ) : null}
          <div style={settingsModernActionsStyle}>
            <button
              type="button"
              className="btn btn-ghost"
              data-upstream-pin-action="add-rule"
              style={{ border: '1px solid var(--color-border)' }}
              onClick={addUpstreamPinRule}
            >
              添加规则
            </button>
            <button
              onClick={saveUpstreamPin}
              disabled={savingUpstreamPin}
              className="btn btn-primary"
              data-upstream-pin-action="save"
            >
              {savingUpstreamPin ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存上游钉选设置'}
            </button>
          </div>
        </div>

        {/* 上游参数兼容层 */}
        <div
          className="card animate-slide-up stagger-5"
          style={{ ...settingsModernCardStyle, scrollMarginTop: 64 }}
          id="settings-section-upstream-param-compat"
          data-settings-card="upstream-param-compat"
        >
          <div style={settingsModernHeaderStyle}>
            <div style={settingsModernTitleBlockStyle}>
              <div style={settingsModernTitleStyle}>上游参数兼容层</div>
              <div style={settingsModernDescriptionStyle}>
                在请求发往上游前，按站点 / 模型匹配自动剥除指定参数，用于兼容不支持某些字段的上游。仅对 chat / responses 的 JSON 请求体生效。
              </div>
            </div>
            <div style={settingsModernPillRowStyle}>
              <span style={getSettingsPillStyle(runtime.upstreamParamCompatEnabled ? 'primary' : 'neutral')}>
                {runtime.upstreamParamCompatEnabled ? '已开启' : '已关闭'}
              </span>
              <span style={getSettingsPillStyle(runtime.upstreamParamCompatSelfHealEnabled ? 'primary' : 'neutral')}>
                {runtime.upstreamParamCompatSelfHealEnabled ? '400 自愈已开启' : '400 自愈已关闭'}
              </span>
            </div>
          </div>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>启用参数兼容层</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                总开关关闭时不会触发任何参数剥除；保存后立即生效。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.upstreamParamCompatEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, upstreamParamCompatEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          <label style={settingsModernToggleStyle}>
            <div style={settingsModernToggleCopyStyle}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>遇到 400 时自动自愈</span>
              <span style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                上游返回 400 且错误信息含参数名时，本次请求剥掉被拒参数并重试一次，不写入规则列表。开启后请确保规则可覆盖常见 400 场景。
              </span>
            </div>
            <input
              type="checkbox"
              checked={runtime.upstreamParamCompatSelfHealEnabled}
              onChange={(e) => setRuntime((prev) => ({ ...prev, upstreamParamCompatSelfHealEnabled: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
            />
          </label>
          <div style={settingsModernFieldCardStyle} data-upstream-param-compat-rules>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={settingsModernFieldLabelStyle}>规则（{runtime.upstreamParamCompatRules.length} / 64）</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px' }}
                  onClick={addUpstreamParamCompatRule}
                  disabled={runtime.upstreamParamCompatRules.length >= 64}
                >
                  添加规则
                </button>
                {runtime.upstreamParamCompatRules.length >= 64 ? (
                  <span style={{ fontSize: 12, color: 'var(--color-warning)' }}>已达 64 条上限</span>
                ) : null}
              </div>
            </div>
            {runtime.upstreamParamCompatRules.length === 0 ? (
              <div style={settingsModernFieldHintStyle}>
                添加规则后，匹配站点与模型的请求会在发往上游前自动剥除指定参数。
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {runtime.upstreamParamCompatRules.map((rule, index) => (
                  <div
                    key={index}
                    data-upstream-param-compat-rule={index}
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                      <div style={{ flex: '1 1 160px', minWidth: 140 }}>
                        <div style={settingsModernFieldLabelStyle}>站点</div>
                        <select
                          value={rule.siteId != null && rule.siteId > 0 ? String(rule.siteId) : ''}
                          data-upstream-param-compat-field={`site-${index}`}
                          onChange={(e) => {
                            const nextSiteId = Math.trunc(Number(e.target.value));
                            updateUpstreamParamCompatRule(index, (current) => ({
                              ...current,
                              siteId: Number.isInteger(nextSiteId) && nextSiteId > 0 ? nextSiteId : 0,
                            }));
                          }}
                          style={inputStyle}
                        >
                          <option value="">选择站点</option>
                          {(upstreamDetectSites || []).map((site) => (
                            <option key={site.id} value={String(site.id)}>{site.name}</option>
                          ))}
                        </select>
                      </div>
                      <div style={{ flex: '2 1 260px', minWidth: 200 }}>
                        <div style={settingsModernFieldLabelStyle}>模型</div>
                        <input
                          value={rule.model}
                          data-upstream-param-compat-field={`model-${index}`}
                          placeholder="精确或 * 通配，匹配下游请求模型"
                          onChange={(e) => updateUpstreamParamCompatRule(index, (current) => ({ ...current, model: e.target.value }))}
                          style={inputStyle}
                        />
                      </div>
                    </div>
                    <div>
                      <div style={settingsModernFieldLabelStyle}>要剥除的参数名（逗号分隔）</div>
                      <input
                        value={paramCompatParamDrafts[index] ?? rule.params.join(',')}
                        data-upstream-param-compat-field={`params-${index}`}
                        placeholder="例如：prompt_cache_key, prompt_cache_retention, user"
                        onChange={(e) => {
                          const nextValue = e.target.value;
                          setParamCompatParamDrafts((prev) => ({ ...prev, [index]: nextValue }));
                        }}
                        onBlur={() => {
                          const draft = paramCompatParamDrafts[index] ?? rule.params.join(',');
                          const parsed = draft.split(',').map((p) => p.trim()).filter(Boolean);
                          updateUpstreamParamCompatRule(index, (current) => ({
                            ...current,
                            params: parsed,
                          }));
                          setParamCompatParamDrafts((prev) => {
                            const next = { ...prev };
                            delete next[index];
                            return next;
                          });
                        }}
                        style={inputStyle}
                      />
                      <div style={settingsModernFieldHintStyle}>
                        匹配到的请求中，这些顶层参数会被自动删除；支持 * 通配提示仅用于模型匹配。
                      </div>
                    </div>
                    <div>
                      <div style={settingsModernFieldLabelStyle}>接口范围（留空 = chat + responses）</div>
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        {(() => {
                          const baseEndpoints = (!rule.endpoints || rule.endpoints.length === 0)
                            ? DEFAULT_UPSTREAM_PARAM_COMPAT_ENDPOINTS
                            : rule.endpoints;
                          const checkedCount = baseEndpoints.length;
                          return (['chat', 'responses', 'messages'] as const).map((endpoint) => {
                            const checked = baseEndpoints.includes(endpoint);
                            const disabled = checked && checkedCount <= 1;
                            const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
                              if (e.target.checked) {
                                const nextEndpoints = baseEndpoints.includes(endpoint)
                                  ? baseEndpoints
                                  : [...baseEndpoints, endpoint];
                                updateUpstreamParamCompatRule(index, (current) => ({
                                  ...current,
                                  endpoints: nextEndpoints.length === 2 && nextEndpoints.includes('chat') && nextEndpoints.includes('responses')
                                    ? []
                                    : nextEndpoints,
                                }));
                              } else {
                                const nextEndpoints = baseEndpoints.filter((ep) => ep !== endpoint);
                                if (nextEndpoints.length === 0) {
                                  toast.error('至少需要保留一个接口');
                                  return;
                                }
                                updateUpstreamParamCompatRule(index, (current) => ({
                                  ...current,
                                  endpoints: nextEndpoints,
                                }));
                              }
                            };
                            return (
                              <label
                                key={endpoint}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--color-text-secondary)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={handleChange}
                                />
                                {endpoint}
                              </label>
                            );
                          });
                        })()}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        data-upstream-param-compat-action={`remove-${index}`}
                        style={{ border: '1px solid var(--color-border)', fontSize: 12, padding: '4px 10px', color: 'var(--color-danger, #d33)' }}
                        onClick={() => removeUpstreamParamCompatRule(index)}
                      >
                        删除规则
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={settingsModernActionsStyle}>
            <button onClick={saveUpstreamParamCompat} disabled={savingUpstreamParamCompat} className="btn btn-primary">
              {savingUpstreamParamCompat ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存参数兼容层'}
            </button>
          </div>
        </div>
      </div>
      <ModelAvailabilityProbeConfirmModal
        presence={modelAvailabilityProbeConfirmPresence}
        confirmText={MODEL_AVAILABILITY_PROBE_CONFIRM_TEXT}
        confirmationInput={modelAvailabilityProbeConfirmationInput}
        saving={savingModelAvailabilityProbe}
        onConfirmationInputChange={setModelAvailabilityProbeConfirmationInput}
        onClose={closeModelAvailabilityProbeConfirmModal}
        onConfirm={handleConfirmModelAvailabilityProbe}
      />
    </div>
  );
}
