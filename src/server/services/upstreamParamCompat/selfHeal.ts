/**
 * (b) NIM 风格 400 自愈：解析「Unsupported parameter(s): …」点名的参数，
 * 同端点剥掉这些参数后重发一次（零学习、不写回 settings）。
 *
 * 本模块只做「解析 + 一次重试决策」：
 * - 入口先读两个 config 开关，门禁集合 = **总开关与自愈开关同时为真**，任一假即返回 null；
 * - 只认状态码 400；
 * - 每端点尝试最多一次（`alreadySelfHealed`）；
 * - 无 present 键不发（名字必须真实存在于出站体顶层，只删顶层、大小写敏感）；
 * - 解析出的名字先去掉结构键（与 (a) 共用同一份拒绝表）再过标识符校验；
 * - 不加 catch 收异常（fail fast：dispatch 异常原样抛出，由调用方既有失败路径处理）。
 *
 * 真正的第二次 dispatch 由 `endpointFlow.ts` 完成（走 `fetchWithObservedFirstByte`，
 * 保留站点代理与 codex 请求头 / 会话字段），本模块绝不自行出站。
 *
 * 禁止用 `/validation/i` 或单独的 `unsupported` 触发：`shouldRetryProxyRequest(400, 'Validation: ...')`
 * 必须仍为 false（通道重试分类函数不改）。
 */

import { config } from '../../config.js';
import {
  isSafeStrippableUpstreamParam,
  UPSTREAM_PARAM_COMPAT_MAX_SELF_HEAL_PARAMS,
} from './rules.js';

export type UpstreamParamCompatSelfHealPlan = {
  /** 真实出现在出站体顶层、即将被删除的键名（保持解析顺序、已去重）。 */
  params: string[];
  /** 浅拷贝并删除 `params` 后的下一份出站体。 */
  body: Record<string, unknown>;
};

/**
 * 只认带名字列表的句子，短语大小写不敏感；允许前缀 `Validation:`（在整段文本内搜索即可）。
 * `unsupported parameter(s):` 与 `unsupported parameter:` / `unsupported parameters:` 都覆盖。
 */
const UNSUPPORTED_PARAMETER_PHRASE = /(?:unsupported|unknown|unrecognized)\s+parameter(?:s|\(s\))?\s*[:：]/i;

const NAME_LIST_BOUNDARY = /[\n\r]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 先从 JSON 取 `error.message` 或顶层 `message`；解析失败就退回原文扫描。 */
function extractMessageText(rawErrText: string): string {
  const trimmed = rawErrText.trim();
  if (!trimmed.startsWith('{')) return rawErrText;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
        return error.message;
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message;
      }
    }
  } catch {
    // 非 JSON（含摘要过的 `Upstream returned HTTP 400: Validation: ...`）→ 扫描原文。
  }
  return rawErrText;
}

function extractNameListTail(text: string): string | null {
  const match = UNSUPPORTED_PARAMETER_PHRASE.exec(text);
  if (!match) return null;
  const tail = text.slice(match.index + match[0].length);
  const boundary = tail.search(NAME_LIST_BOUNDARY);
  const sentence = (boundary >= 0 ? tail.slice(0, boundary) : tail).slice(0, 512);
  // 句号视为分隔（`foo. bar` → `foo, bar`）与尾部句号剥除；
  // 点号夹在标识符中间（如 `prompt.cache_key`）不在此列，会在标识符校验处整名丢弃。
  return sentence.replace(/\.\s+/g, ',').replace(/\.+$/, '').trim();
}

function normalizeNamePiece(piece: string): string {
  return piece
    .trim()
    .replace(/^[`'"‘’“”]+/, '')
    .replace(/[`'"‘’“”]+$/, '')
    .replace(/\.+$/, '')
    .trim();
}

/**
 * 解析上游 400 文案里点名的参数名。
 * 名字按逗号 / 中文逗号 / ` and ` / 分号切开，去掉反引号与引号、丢掉尾部 `.`；
 * 只保留标识符且不在结构键拒绝表内，最多 8 个。解析不出合法名字就返回空数组（= 不重试）。
 */
export function parseUnsupportedParameterNames(rawErrText: string): string[] {
  const text = typeof rawErrText === 'string' ? rawErrText : '';
  if (!text) return [];

  const tail = extractNameListTail(extractMessageText(text));
  if (!tail) return [];

  const names: string[] = [];
  for (const piece of tail.split(/[,，;；]|\band\b/i)) {
    const name = normalizeNamePiece(piece);
    if (!name) continue;
    if (!isSafeStrippableUpstreamParam(name)) continue;
    if (names.includes(name)) continue;
    names.push(name);
    if (names.length >= UPSTREAM_PARAM_COMPAT_MAX_SELF_HEAL_PARAMS) break;
  }
  return names;
}

/**
 * 一次重试决策。返回 null = 不自愈：
 * 门禁（总开关 / 自愈开关）、状态码、每端点一次、无合法名字、无 present 键都会返回 null。
 */
export function resolveUpstreamParamCompatSelfHealPlan(input: {
  status: number;
  rawErrText: string;
  body: Record<string, unknown>;
  alreadySelfHealed?: boolean;
}): UpstreamParamCompatSelfHealPlan | null {
  // 门禁集合：总开关是总闸，关掉则 (b) 不自愈；只关自愈开关则 (a) 仍剥、(b) 不发。
  if (config.upstreamParamCompatEnabled !== true) return null;
  if (config.upstreamParamCompatSelfHealEnabled !== true) return null;
  if (input.alreadySelfHealed === true) return null;
  if (input.status !== 400) return null;

  const body = input.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const names = parseUnsupportedParameterNames(input.rawErrText);
  if (names.length === 0) return null;

  // 键删除大小写敏感，只删顶层已存在的键，不递归。
  const present = names.filter((name) => Object.prototype.hasOwnProperty.call(body, name));
  if (present.length === 0) return null;

  const nextBody: Record<string, unknown> = { ...body };
  for (const name of present) {
    delete nextBody[name];
  }

  return { params: present, body: nextBody };
}