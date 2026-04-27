import crypto from "node:crypto";
import dns from "node:dns";
import { existsSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import express from "express";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  CliDangerSandboxApprovalRequiredError,
  DEFAULT_CLI_BACKEND_PROFILES,
  runCliBackendTurn,
  type CliBackendProfile,
} from "./cli-backend.js";
import {
  clampHistoryLimit,
  hasLocalCodexSession,
  readRecentCodexHistoryEntries,
  readRecentCodexHistorySessions,
  type CodexHistoryEntry,
  type CodexHistorySessionSummary,
} from "./codex-history.js";
import {
  beginAppRegistration,
  initAppRegistration,
  openQrCodeWindow,
  pollAppRegistration,
  printQrCode,
  type FeishuDomain,
} from "./app-registration.js";
import type {
  BridgeConfig,
  ConversationState,
  ConversationStateMap,
  FeishuConnectionMode,
  FeishuInboundMessage,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
    };
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: "group" | "private" | "p2p";
    message_type: string;
    content: string;
    root_id?: string;
    thread_id?: string;
    parent_id?: string;
  };
};

type ParsedCommand =
  | { type: "help"; topic?: string }
  | { type: "reset" }
  | { type: "backend"; backendId: string }
  | { type: "model_show" }
  | { type: "model_set"; model: string }
  | { type: "model_reset" }
  | { type: "plan_show" }
  | { type: "plan_set"; enabled: boolean }
  | { type: "plan_invalid"; raw: string }
  | { type: "cwd_show" }
  | { type: "cwd_reset" }
  | { type: "cwd_set"; rawPath: string }
  | { type: "history_list"; limit: number }
  | { type: "context_show" }
  | { type: "context_list"; limit: number }
  | { type: "context_set"; sessionId: string; homeIndex?: number }
  | { type: "context_clear" }
  | { type: "none" };

const LEGACY_SESSION_STORE_PATH = path.resolve(process.cwd(), ".feishu-cli-bridge-sessions.json");
const LEGACY_AUTH_STORE_PATH = path.resolve(process.cwd(), ".feishu-cli-bridge-auth.json");
const DEFAULT_BRIDGE_DATA_DIR = resolveDefaultBridgeDataDir(process.env);
const DEFAULT_SESSION_STORE_PATH = path.join(DEFAULT_BRIDGE_DATA_DIR, "sessions.json");
const DEFAULT_AUTH_STORE_PATH = path.join(DEFAULT_BRIDGE_DATA_DIR, "auth.json");
const DEFAULT_WORKSPACE_ROOT = path.resolve(process.cwd(), "..", "..");
const DEFAULT_QUEUE_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CARD_WEBHOOK_PATH = "/feishu/card-actions";
const DEFAULT_PERMISSION_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REPLY_CHARS = 1900;
const MAX_HISTORY_PREVIEW_CHARS = 120;
const MAX_APPROVAL_PROMPT_PREVIEW_CHARS = 180;
const CONTEXT_SHORT_ID_LENGTH = 5;
const CONTEXT_SHORT_ID_PATTERN = /^[0-9a-zA-Z]{5}$/;
const APPROVAL_ACTION_TYPE = "codex-danger-sandbox-approval";
const DNS_FALLBACK_CACHE_TTL_MS = 10 * 60 * 1000;
const FEISHU_WS_DNS_FALLBACK_HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);
const FEISHU_WS_DNS_FALLBACK_SUFFIXES = [".feishu.cn", ".larksuite.com"];
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const DNS_OVER_HTTPS_ENDPOINTS: Array<{
  buildUrl: (hostname: string) => string;
  headers?: Record<string, string>;
}> = [
  {
    buildUrl: (hostname: string) => `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
  },
  {
    buildUrl: (hostname: string) => `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    headers: { accept: "application/dns-json" },
  },
];
const PLAN_MODE_PROMPT_PREFIX =
  "[Plan Mode Enabled]\n" +
  "请先给出简要执行计划（可分步骤），再继续完成用户请求，并在必要时更新计划。";
const IMAGE_REF_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|svg)(\?.*)?$/i;

type StoredFeishuCredentials = {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  openId?: string;
  updatedAt: string;
};

type CodexHistoryEntryView = CodexHistoryEntry & {
  codexHome: string;
  homeIndex: number;
};

type CodexHistorySessionView = CodexHistorySessionSummary & {
  codexHome: string;
  homeIndex: number;
};

type ApprovalDecision = {
  decision: "approve" | "reject" | "timeout";
  actorOpenId?: string;
  autoApproveFuture?: boolean;
};

type PendingApprovalRequest = {
  approvalId: string;
  conversationKey: string;
  requesterOpenId?: string;
  enforceRequesterCheck: boolean;
  resolve: (decision: ApprovalDecision) => void;
  timeoutHandle: NodeJS.Timeout;
};

type StartupOptions = {
  setupFeishu: boolean;
  forceRescanFeishu: boolean;
  setupOnly: boolean;
  qrGui: boolean;
  showHelp: boolean;
};

const feishuDnsFallbackCache = new Map<
  string,
  {
    address: string;
    expiresAtMs: number;
  }
>();
let feishuDnsFallbackInstalled = false;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolveDefaultBridgeDataDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.FEISHU_BRIDGE_DATA_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const appData = env.APPDATA?.trim();
  if (appData) {
    return path.join(appData, ".feishubridge");
  }

  const userProfile = env.USERPROFILE?.trim();
  if (userProfile) {
    return path.join(userProfile, "AppData", "Roaming", ".feishubridge");
  }

  return path.resolve(process.cwd(), ".feishubridge");
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseStartupOptions(argv: string[]): StartupOptions {
  const options: StartupOptions = {
    setupFeishu: false,
    forceRescanFeishu: false,
    setupOnly: false,
    qrGui: parseBoolean(process.env.FEISHU_QR_GUI, false),
    showHelp: false,
  };

  for (const rawArg of argv) {
    const arg = rawArg.trim();
    if (!arg) {
      continue;
    }
    if (arg === "--setup-feishu") {
      options.setupFeishu = true;
      options.qrGui = true;
      continue;
    }
    if (arg === "--setup-only") {
      options.setupOnly = true;
      options.setupFeishu = true;
      options.qrGui = true;
      continue;
    }
    if (arg === "--rescan-feishu") {
      options.forceRescanFeishu = true;
      options.qrGui = true;
      continue;
    }
    if (arg === "--qr-gui") {
      options.qrGui = true;
      continue;
    }
    if (arg === "--no-qr-gui") {
      options.qrGui = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.showHelp = true;
      continue;
    }
  }

  return options;
}

function renderStartupHelp(): string {
  return [
    "Feishu CLI Bridge 启动参数：",
    "  --setup-feishu   进行飞书配对检查（有凭证则复用，无凭证才扫码）",
    "  --setup-only     仅执行扫码配对并保存凭证，完成后退出",
    "  --rescan-feishu  强制重新扫码配对（忽略已有凭证）",
    "  --qr-gui         启用图形二维码页面（默认仅 setup 模式开启）",
    "  --no-qr-gui      禁用图形二维码页面，仅在终端打印二维码",
  ].join("\n");
}

async function resolveHostViaDoh(hostname: string): Promise<string | undefined> {
  for (const endpoint of DNS_OVER_HTTPS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint.buildUrl(hostname), {
        headers: endpoint.headers,
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> };
      const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
      for (const answer of answers) {
        if (answer.type !== 1 || typeof answer.data !== "string") {
          continue;
        }
        const ip = answer.data.trim();
        if (IPV4_PATTERN.test(ip)) {
          return ip;
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function shouldUseFeishuDnsFallback(hostname: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase();
  if (FEISHU_WS_DNS_FALLBACK_HOSTS.has(normalizedHost)) {
    return true;
  }
  return FEISHU_WS_DNS_FALLBACK_SUFFIXES.some((suffix) => normalizedHost.endsWith(suffix));
}

function putDnsFallbackCache(hostname: string, address: string): void {
  feishuDnsFallbackCache.set(hostname, {
    address,
    expiresAtMs: Date.now() + DNS_FALLBACK_CACHE_TTL_MS,
  });
}

function warmupFeishuDnsFallback(hostname: string): void {
  const normalizedHost = hostname.trim().toLowerCase();
  if (!shouldUseFeishuDnsFallback(normalizedHost)) {
    return;
  }
  const cached = feishuDnsFallbackCache.get(normalizedHost);
  if (cached && cached.expiresAtMs > Date.now()) {
    return;
  }
  void resolveHostViaDoh(normalizedHost)
    .then((address) => {
      if (!address) {
        return;
      }
      putDnsFallbackCache(normalizedHost, address);
      console.log(`[bridge] dns fallback warmup host=${normalizedHost}, address=${address}`);
    })
    .catch(() => undefined);
}

function installFeishuWebSocketDnsFallback(): void {
  if (feishuDnsFallbackInstalled) {
    return;
  }
  feishuDnsFallbackInstalled = true;
  const originalLookup = dns.lookup.bind(dns);

  (dns as { lookup: typeof dns.lookup }).lookup = ((
    hostname: string,
    options: unknown,
    callback: unknown,
  ) => {
    const normalizedHost = hostname.trim().toLowerCase();
    if (!shouldUseFeishuDnsFallback(normalizedHost)) {
      return (originalLookup as unknown as (...args: unknown[]) => unknown)(hostname, options, callback);
    }

    let resolvedOptions = options;
    let resolvedCallback = callback;
    if (typeof options === "function") {
      resolvedCallback = options;
      resolvedOptions = undefined;
    }
    if (typeof resolvedCallback !== "function") {
      return (originalLookup as unknown as (...args: unknown[]) => unknown)(
        hostname,
        resolvedOptions,
        resolvedCallback,
      );
    }

    const optionRecord =
      resolvedOptions && typeof resolvedOptions === "object"
        ? (resolvedOptions as Record<string, unknown>)
        : undefined;
    const requestsAll = optionRecord?.all === true;
    if (optionRecord?.family === 6) {
      return (originalLookup as unknown as (...args: unknown[]) => unknown)(
        hostname,
        resolvedOptions,
        resolvedCallback,
      );
    }

    const cached = feishuDnsFallbackCache.get(normalizedHost);
    if (cached && cached.expiresAtMs > Date.now()) {
      process.nextTick(() => {
        if (requestsAll) {
          (
            resolvedCallback as (
              err: NodeJS.ErrnoException | null,
              addresses: Array<{ address: string; family: number }>,
            ) => void
          )(null, [{ address: cached.address, family: 4 }]);
          return;
        }
        (resolvedCallback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null,
          cached.address,
          4,
        );
      });
      return;
    }

    return (originalLookup as unknown as (...args: unknown[]) => unknown)(
      hostname,
      resolvedOptions,
      (...lookupArgs: unknown[]) => {
        const [err, address, family] = lookupArgs as [
          NodeJS.ErrnoException | null,
          string | Array<{ address: string; family: number }> | undefined,
          number | undefined,
        ];
        if (!err) {
          (resolvedCallback as (...args: unknown[]) => void)(...lookupArgs);
          return;
        }

        const errorCode = err?.code ?? "";
        if (errorCode !== "ENOTFOUND" && errorCode !== "EAI_AGAIN" && errorCode !== "") {
          (resolvedCallback as (...args: unknown[]) => void)(...lookupArgs);
          return;
        }

        void resolveHostViaDoh(normalizedHost)
          .then((fallbackAddress) => {
            if (!fallbackAddress) {
              (resolvedCallback as (...args: unknown[]) => void)(...lookupArgs);
              return;
            }
            putDnsFallbackCache(normalizedHost, fallbackAddress);
            console.log(
              `[bridge] dns fallback resolved host=${normalizedHost}, address=${fallbackAddress}`,
            );
            if (requestsAll) {
              (
                resolvedCallback as (
                  err: NodeJS.ErrnoException | null,
                  addresses: Array<{ address: string; family: number }>,
                ) => void
              )(null, [{ address: fallbackAddress, family: 4 }]);
              return;
            }
            (resolvedCallback as (err: NodeJS.ErrnoException | null, nextAddress: string, nextFamily: number) => void)(
              null,
              fallbackAddress,
              4,
            );
          })
          .catch(() => {
            (resolvedCallback as (...args: unknown[]) => void)(...lookupArgs);
          });
      },
    );
  }) as typeof dns.lookup;

  console.log(
    `[bridge] websocket dns fallback enabled for: ${Array.from(FEISHU_WS_DNS_FALLBACK_HOSTS).join(", ")} + suffixes ${FEISHU_WS_DNS_FALLBACK_SUFFIXES.join(", ")}`,
  );
  warmupFeishuDnsFallback("open.feishu.cn");
  warmupFeishuDnsFallback("open.larksuite.com");
  warmupFeishuDnsFallback("msg-frontier.feishu.cn");
  warmupFeishuDnsFallback("msg-frontier.larksuite.com");
}

function formatLocalDateTimeFromUnixSeconds(unixSeconds: number): string {
  const timestampMs = unixSeconds * 1000;
  if (!Number.isFinite(timestampMs)) {
    return "-";
  }
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const second = `${date.getSeconds()}`.padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function normalizePreviewText(text: string, maxChars: number = MAX_HISTORY_PREVIEW_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(空)";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 1)}…`;
}

function parsePathList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[;,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePathKey(inputPath: string): string {
  const normalized = path.resolve(inputPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function mergeUniqueAbsolutePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    const key = normalizePathKey(resolved);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAbsoluteDir(inputPath: string): string {
  return path.resolve(process.cwd(), inputPath.trim());
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  if (!relativePath) {
    return true;
  }
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return false;
  }
  return true;
}

function isLikelyImageRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("data:image/")) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return IMAGE_REF_EXT_PATTERN.test(trimmed);
  }
  return IMAGE_REF_EXT_PATTERN.test(trimmed);
}

function isStaleResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("thread/resume failed") &&
    normalized.includes("no rollout found")
  ) || normalized.includes("no rollout found for thread id");
}

function isWindowsSandboxSetupRefreshError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return /windows sandbox\s*:?\s*setup refresh failed/.test(normalized);
}

function parseConnectionMode(value: string | undefined): FeishuConnectionMode {
  return value === "webhook" ? "webhook" : "websocket";
}

function isRunningAsWindowsLocalSystem(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const username = env.USERNAME?.trim().toLowerCase();
  const userProfile = env.USERPROFILE?.trim().toLowerCase();
  if (username === "system") {
    return true;
  }
  return Boolean(userProfile?.includes("\\windows\\system32\\config\\systemprofile"));
}

function parseFeishuDomain(value: string | undefined, fallback: FeishuDomain = "feishu"): FeishuDomain {
  return value?.trim().toLowerCase() === "lark" ? "lark" : fallback;
}

function resolveLarkDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (!normalized || normalized === "feishu") {
    return Lark.Domain.Feishu;
  }
  if (normalized === "lark") {
    return Lark.Domain.Lark;
  }
  return domain.replace(/\/+$/, "");
}

function chunkText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return ["(无输出)"];
  }
  const lines = normalized.split(/\r?\n/g);
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= MAX_REPLY_CHARS) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (line.length <= MAX_REPLY_CHARS) {
      current = line;
      continue;
    }
    for (let index = 0; index < line.length; index += MAX_REPLY_CHARS) {
      chunks.push(line.slice(index, index + MAX_REPLY_CHARS));
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : ["(无输出)"];
}

function flattenUnknownText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenUnknownText(item)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  const keys = Object.keys(value);
  return keys.map((key) => flattenUnknownText(value[key])).join("");
}

function parseFeishuMessageEvent(payload: unknown): FeishuMessageEvent | null {
  if (!isRecord(payload)) {
    return null;
  }
  const sender = payload.sender;
  const message = payload.message;
  if (!isRecord(sender) || !isRecord(message)) {
    return null;
  }
  const senderId = sender.sender_id;
  if (!isRecord(senderId)) {
    return null;
  }
  const messageId = asNonEmptyString(message.message_id);
  const chatId = asNonEmptyString(message.chat_id);
  const chatType = asNonEmptyString(message.chat_type);
  const messageType = asNonEmptyString(message.message_type);
  const content = typeof message.content === "string" ? message.content : undefined;
  if (!messageId || !chatId || !messageType || !content) {
    return null;
  }
  if (chatType !== "group" && chatType !== "private" && chatType !== "p2p") {
    return null;
  }
  return {
    sender: {
      sender_id: {
        open_id: asNonEmptyString(senderId.open_id),
        user_id: asNonEmptyString(senderId.user_id),
      },
      sender_type: asNonEmptyString(sender.sender_type),
    },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      message_type: messageType,
      content,
      root_id: asNonEmptyString(message.root_id),
      thread_id: asNonEmptyString(message.thread_id),
      parent_id: asNonEmptyString(message.parent_id),
    },
  };
}

function extractTextFromMessage(event: FeishuMessageEvent): string {
  const messageType = event.message.message_type;
  if (messageType === "text") {
    try {
      const parsed = JSON.parse(event.message.content) as { text?: unknown };
      return asNonEmptyString(parsed.text) ?? "";
    } catch {
      return event.message.content.trim();
    }
  }
  if (messageType === "post") {
    try {
      const parsed = JSON.parse(event.message.content);
      return flattenUnknownText(parsed).trim();
    } catch {
      return "";
    }
  }
  return "";
}

function resolveConversationKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
}): string {
  const { accountId, event } = params;
  const chatId = event.message.chat_id;
  const topicId = event.message.root_id ?? event.message.thread_id;
  if (event.message.chat_type === "group" && topicId) {
    return `${accountId}:${chatId}:topic:${topicId}`;
  }
  if (event.message.chat_type === "group") {
    return `${accountId}:${chatId}:group`;
  }
  const senderId =
    event.sender.sender_id.open_id ?? event.sender.sender_id.user_id ?? event.message.chat_id;
  return `${accountId}:${chatId}:dm:${senderId}`;
}

function parseCommand(text: string): ParsedCommand {
  const normalized = text.trim();
  if (!normalized.startsWith("/")) {
    return { type: "none" };
  }
  const helpMatch = normalized.match(/^\/help(?:\s+(.+))?$/i);
  if (helpMatch) {
    const topic = helpMatch[1]?.trim();
    return { type: "help", topic: topic || undefined };
  }
  if (normalized === "/reset") {
    return { type: "reset" };
  }
  const backendMatch = normalized.match(/^\/backend\s+([a-zA-Z0-9_-]+)$/);
  if (backendMatch) {
    return { type: "backend", backendId: backendMatch[1] };
  }
  const modelMatch = normalized.match(/^\/model(?:\s+(.+))?$/i);
  if (modelMatch) {
    const arg = modelMatch[1]?.trim();
    if (!arg) {
      return { type: "model_show" };
    }
    const normalizedArg = arg.toLowerCase();
    if (normalizedArg === "reset" || normalizedArg === "clear" || normalizedArg === "default") {
      return { type: "model_reset" };
    }
    return { type: "model_set", model: arg };
  }
  const planMatch = normalized.match(/^\/plan(?:\s+(.+))?$/i);
  if (planMatch) {
    const arg = planMatch[1]?.trim();
    if (!arg) {
      return { type: "plan_show" };
    }
    const normalizedArg = arg.toLowerCase();
    if (
      ["on", "true", "1", "yes", "y", "enable", "enabled", "open", "开启", "开"].includes(
        normalizedArg,
      )
    ) {
      return { type: "plan_set", enabled: true };
    }
    if (
      ["off", "false", "0", "no", "n", "disable", "disabled", "close", "关闭", "关"].includes(
        normalizedArg,
      )
    ) {
      return { type: "plan_set", enabled: false };
    }
    return { type: "plan_invalid", raw: arg };
  }
  const cwdMatch = normalized.match(/^\/cwd(?:\s+(.+))?$/i);
  if (cwdMatch) {
    const arg = cwdMatch[1]?.trim();
    if (!arg) {
      return { type: "cwd_show" };
    }
    if (arg.toLowerCase() === "reset") {
      return { type: "cwd_reset" };
    }
    return { type: "cwd_set", rawPath: arg };
  }
  const historyMatch = normalized.match(/^\/history(?:\s+(\d+))?$/i);
  if (historyMatch) {
    return { type: "history_list", limit: clampHistoryLimit(historyMatch[1]) };
  }
  const contextMatch = normalized.match(/^\/context(?:\s+(.+))?$/i);
  if (contextMatch) {
    const arg = contextMatch[1]?.trim();
    if (!arg) {
      return { type: "context_show" };
    }
    if (arg.toLowerCase() === "clear" || arg.toLowerCase() === "reset") {
      return { type: "context_clear" };
    }
    const listMatch = arg.match(/^list(?:\s+(\d+))?$/i);
    if (listMatch) {
      return { type: "context_list", limit: clampHistoryLimit(listMatch[1]) };
    }
    const useMatch = arg.match(/^(?:use|set|switch)\s+([a-zA-Z0-9_.:-]+)(?:\s+@(\d+))?$/i);
    if (useMatch) {
      const homeIndex = useMatch[2] ? Number.parseInt(useMatch[2], 10) : undefined;
      return { type: "context_set", sessionId: useMatch[1], homeIndex };
    }
  }
  return { type: "none" };
}

function parseApprovalDecisionInput(text: string): { decision: "approve" | "reject"; autoApproveFuture: boolean } | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1") {
    return { decision: "approve", autoApproveFuture: false };
  }
  if (normalized === "2") {
    return { decision: "approve", autoApproveFuture: true };
  }
  if (normalized === "3") {
    return { decision: "reject", autoApproveFuture: false };
  }
  return undefined;
}

class SessionStore {
  private state: ConversationStateMap = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        this.state = parsed as ConversationStateMap;
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
      this.state = {};
    }
  }

  get(conversationKey: string): ConversationState | undefined {
    return this.state[conversationKey];
  }

  set(conversationKey: string, nextState: ConversationState): void {
    this.state[conversationKey] = nextState;
    this.queuePersist();
  }

  delete(conversationKey: string): void {
    delete this.state[conversationKey];
    this.queuePersist();
  }

  private queuePersist(): void {
    this.writeChain = this.writeChain
      .then(async () => {
        const dir = path.dirname(this.storePath);
        await fs.mkdir(dir, { recursive: true });
        const tempPath = `${this.storePath}.${crypto.randomUUID()}.tmp`;
        const serialized = JSON.stringify(this.state, null, 2);
        await fs.writeFile(tempPath, serialized, "utf8");
        await fs.rename(tempPath, this.storePath);
      })
      .catch((error) => {
        console.error("[bridge] failed to persist session store:", error);
      });
  }
}

function readBridgeConfigFromFile(configPath: string): Partial<BridgeConfig> {
  const absolutePath = path.resolve(process.cwd(), configPath);
  try {
    const raw = readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("config root must be an object");
    }
    return parsed as Partial<BridgeConfig>;
  } catch (error) {
    throw new Error(`[bridge] failed to load config file ${absolutePath}: ${String(error)}`);
  }
}

async function loadStoredFeishuCredentials(
  storePath: string,
): Promise<StoredFeishuCredentials | undefined> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const appId = asNonEmptyString(parsed.appId);
    const appSecret = asNonEmptyString(parsed.appSecret);
    if (!appId || !appSecret) {
      return undefined;
    }
    return {
      appId,
      appSecret,
      domain: parseFeishuDomain(asNonEmptyString(parsed.domain)),
      openId: asNonEmptyString(parsed.openId),
      updatedAt: asNonEmptyString(parsed.updatedAt) ?? new Date(0).toISOString(),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function saveStoredFeishuCredentials(
  storePath: string,
  credentials: StoredFeishuCredentials,
): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = `${storePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(credentials, null, 2), "utf8");
  await fs.rename(tempPath, storePath);
}

async function migrateLegacyStoreFileIfNeeded(params: {
  currentPath: string;
  defaultPath: string;
  legacyPath: string;
  label: string;
}): Promise<void> {
  const currentResolved = path.resolve(params.currentPath);
  const defaultResolved = path.resolve(params.defaultPath);
  const legacyResolved = path.resolve(params.legacyPath);

  if (normalizePathKey(currentResolved) !== normalizePathKey(defaultResolved)) {
    return;
  }
  if (normalizePathKey(defaultResolved) === normalizePathKey(legacyResolved)) {
    return;
  }
  if (existsSync(defaultResolved) || !existsSync(legacyResolved)) {
    return;
  }

  await fs.mkdir(path.dirname(defaultResolved), { recursive: true });
  try {
    await fs.rename(legacyResolved, defaultResolved);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EXDEV") {
      throw error;
    }
    await fs.copyFile(legacyResolved, defaultResolved);
    await fs.unlink(legacyResolved);
  }
  console.log(`[bridge] migrated ${params.label}: ${legacyResolved} -> ${defaultResolved}`);
}

async function activateFeishuByQrCode(params: {
  initialDomain: FeishuDomain;
  authStorePath: string;
  openQrWindow: boolean;
}): Promise<StoredFeishuCredentials> {
  const { initialDomain, authStorePath, openQrWindow } = params;
  console.log("[bridge] 未检测到飞书凭证，开始扫码激活...");
  await initAppRegistration(initialDomain);
  const begin = await beginAppRegistration(initialDomain);

  if (openQrWindow) {
    const popup = await openQrCodeWindow({
      url: begin.qrUrl,
      title: "Feishu CLI Bridge 扫码配对",
    });
    if (popup.opened) {
      console.log(
        `[bridge] 已弹出图形二维码窗口，请在飞书 App 扫码（临时文件：${popup.htmlPath ?? "unknown"}）`,
      );
    } else {
      console.warn(`[bridge] 图形二维码窗口打开失败：${popup.error ?? "unknown"}`);
    }
  }

  console.log("[bridge] 请使用飞书/飞书国际版 App 扫描下方二维码完成授权：");
  await printQrCode(begin.qrUrl);
  console.log(`[bridge] 若二维码扫描失败，可手动打开：${begin.qrUrl}`);
  console.log(`[bridge] user_code: ${begin.userCode}`);

  const result = await pollAppRegistration({
    deviceCode: begin.deviceCode,
    interval: begin.interval,
    expireIn: begin.expireIn,
    initialDomain,
    tp: "ob_app",
  });

  if (result.status !== "success") {
    if (result.status === "access_denied") {
      throw new Error("扫码授权被拒绝，请重新执行 npm start 后再次扫码");
    }
    if (result.status === "expired" || result.status === "timeout") {
      throw new Error("扫码授权已超时，请重新执行 npm start 后再次扫码");
    }
    throw new Error(`扫码激活失败：${result.message}`);
  }

  const credentials: StoredFeishuCredentials = {
    appId: result.result.appId,
    appSecret: result.result.appSecret,
    domain: result.result.domain,
    openId: result.result.openId,
    updatedAt: new Date().toISOString(),
  };
  await saveStoredFeishuCredentials(authStorePath, credentials);
  console.log(`[bridge] 扫码激活成功，凭证已保存到 ${authStorePath}`);
  return credentials;
}

async function resolveFeishuCredentials(params: {
  appId?: string;
  appSecret?: string;
  domain: FeishuDomain;
  authStorePath: string;
  enableQrActivation: boolean;
  forceQrActivation: boolean;
  enableQrWindow: boolean;
}): Promise<StoredFeishuCredentials> {
  const {
    appId,
    appSecret,
    domain,
    authStorePath,
    enableQrActivation,
    forceQrActivation,
    enableQrWindow,
  } = params;

  const inlineAppId = appId?.trim();
  const inlineAppSecret = appSecret?.trim();
  if (!forceQrActivation && inlineAppId && inlineAppSecret) {
    return {
      appId: inlineAppId,
      appSecret: inlineAppSecret,
      domain,
      updatedAt: new Date().toISOString(),
    };
  }

  if (!forceQrActivation) {
    const stored = await loadStoredFeishuCredentials(authStorePath);
    if (stored) {
      return stored;
    }
  }

  if (!enableQrActivation) {
    throw new Error(
      `[bridge] 缺少飞书凭证。请开启扫码激活（FEISHU_QR_ACTIVATION=true）或设置 FEISHU_APP_ID/FEISHU_APP_SECRET`,
    );
  }

  return await activateFeishuByQrCode({
    initialDomain: domain,
    authStorePath,
    openQrWindow: enableQrWindow,
  });
}

async function loadConfig(startupOptions: StartupOptions): Promise<BridgeConfig> {
  const configPath = process.env.FEISHU_BRIDGE_CONFIG_PATH?.trim();
  const fileConfig = configPath ? readBridgeConfigFromFile(configPath) : {};

  const defaultConnectionMode = parseConnectionMode(process.env.FEISHU_CONNECTION_MODE);
  const authStorePath = process.env.FEISHU_AUTH_STORE_PATH?.trim() ?? DEFAULT_AUTH_STORE_PATH;
  const sessionStorePath =
    fileConfig.runtime?.sessionStorePath ??
    process.env.BRIDGE_SESSION_STORE_PATH?.trim() ??
    DEFAULT_SESSION_STORE_PATH;
  const qrActivationEnabled = startupOptions.setupFeishu || startupOptions.forceRescanFeishu
    ? true
    : parseBoolean(process.env.FEISHU_QR_ACTIVATION, true);
  const forceQrActivation =
    startupOptions.forceRescanFeishu ||
    parseBoolean(process.env.FEISHU_FORCE_QR_ACTIVATION, false);
  const qrWindowEnabled = startupOptions.qrGui;

  await migrateLegacyStoreFileIfNeeded({
    currentPath: authStorePath,
    defaultPath: DEFAULT_AUTH_STORE_PATH,
    legacyPath: LEGACY_AUTH_STORE_PATH,
    label: "auth store",
  });
  await migrateLegacyStoreFileIfNeeded({
    currentPath: sessionStorePath,
    defaultPath: DEFAULT_SESSION_STORE_PATH,
    legacyPath: LEGACY_SESSION_STORE_PATH,
    label: "session store",
  });

  const requestedDomain = parseFeishuDomain(
    fileConfig.feishu?.domain ?? process.env.FEISHU_DOMAIN?.trim(),
  );
  const credentials = await resolveFeishuCredentials({
    appId: fileConfig.feishu?.appId ?? process.env.FEISHU_APP_ID?.trim(),
    appSecret: fileConfig.feishu?.appSecret ?? process.env.FEISHU_APP_SECRET?.trim(),
    domain: requestedDomain,
    authStorePath,
    enableQrActivation: qrActivationEnabled,
    forceQrActivation,
    enableQrWindow: qrWindowEnabled,
  });

  const feishuConfig = {
    accountId: fileConfig.feishu?.accountId ?? process.env.FEISHU_ACCOUNT_ID?.trim() ?? "default",
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: credentials.domain,
    connectionMode: fileConfig.feishu?.connectionMode ?? defaultConnectionMode,
    verificationToken:
      fileConfig.feishu?.verificationToken ?? process.env.FEISHU_VERIFICATION_TOKEN?.trim(),
    encryptKey: fileConfig.feishu?.encryptKey ?? process.env.FEISHU_ENCRYPT_KEY?.trim(),
    webhookHost:
      fileConfig.feishu?.webhookHost ?? process.env.FEISHU_WEBHOOK_HOST?.trim() ?? "0.0.0.0",
    webhookPort:
      fileConfig.feishu?.webhookPort ?? parseInteger(process.env.FEISHU_WEBHOOK_PORT, 3000),
    webhookPath:
      fileConfig.feishu?.webhookPath ?? process.env.FEISHU_WEBHOOK_PATH?.trim() ?? "/feishu/events",
    cardWebhookPath:
      fileConfig.feishu?.cardWebhookPath ??
      process.env.FEISHU_CARD_WEBHOOK_PATH?.trim() ??
      DEFAULT_CARD_WEBHOOK_PATH,
  };
  if (feishuConfig.connectionMode === "webhook" && !feishuConfig.verificationToken) {
    console.warn("[bridge] FEISHU_VERIFICATION_TOKEN is empty; webhook token check is disabled");
  }

  const mergedBackends = {
    ...DEFAULT_CLI_BACKEND_PROFILES,
    ...(fileConfig.backends ?? {}),
  };
  const codexCommandOverride = process.env.CODEX_COMMAND?.trim();
  if (codexCommandOverride && mergedBackends["codex-cli"]) {
    mergedBackends["codex-cli"] = {
      ...mergedBackends["codex-cli"],
      command: codexCommandOverride,
    };
  }

  const configuredDefaultCwd =
    fileConfig.runtime?.defaultCwd ?? process.env.BRIDGE_DEFAULT_CWD?.trim() ?? process.cwd();
  const defaultCwd = normalizeAbsoluteDir(configuredDefaultCwd);
  const configuredAllowRoots = Array.isArray(fileConfig.runtime?.cwdAllowRoots)
    ? fileConfig.runtime.cwdAllowRoots
    : parsePathList(process.env.BRIDGE_CWD_ALLOW_ROOTS);
  const cwdAllowRoots =
    configuredAllowRoots.length > 0
      ? configuredAllowRoots.map((entry) => normalizeAbsoluteDir(entry))
      : [DEFAULT_WORKSPACE_ROOT];
  const configuredCodexHomes = Array.isArray(fileConfig.runtime?.codexHomeDirs)
    ? fileConfig.runtime.codexHomeDirs
    : parsePathList(process.env.BRIDGE_CODEX_HOME_DIRS);
  const codexHomeDirs = mergeUniqueAbsolutePaths([...configuredCodexHomes]);

  const runtime = {
    autoRunBackend:
      fileConfig.runtime?.autoRunBackend ??
      parseBoolean(process.env.BRIDGE_AUTO_RUN_BACKEND, true),
    defaultBackendId:
      fileConfig.runtime?.defaultBackendId ??
      process.env.BRIDGE_DEFAULT_BACKEND_ID?.trim() ??
      "codex-cli",
    defaultModel: fileConfig.runtime?.defaultModel ?? process.env.BRIDGE_DEFAULT_MODEL?.trim(),
    cliTimeoutMs:
      fileConfig.runtime?.cliTimeoutMs ??
      parseInteger(process.env.BRIDGE_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    permissionApprovalTimeoutMs:
      fileConfig.runtime?.permissionApprovalTimeoutMs ??
      parseInteger(
        process.env.BRIDGE_PERMISSION_APPROVAL_TIMEOUT_MS,
        DEFAULT_PERMISSION_APPROVAL_TIMEOUT_MS,
      ),
    inboundQueueLimit:
      fileConfig.runtime?.inboundQueueLimit ??
      parseInteger(process.env.BRIDGE_INBOUND_QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT),
    sessionStorePath,
    defaultCwd,
    cwdAllowRoots,
    codexHomeDirs,
  };

  if (!mergedBackends[runtime.defaultBackendId]) {
    throw new Error(
      `[bridge] default backend "${runtime.defaultBackendId}" not found in configured backends`,
    );
  }
  if (!existsSync(runtime.defaultCwd) || !statSync(runtime.defaultCwd).isDirectory()) {
    throw new Error(`[bridge] runtime.defaultCwd does not exist or is not a directory: ${runtime.defaultCwd}`);
  }
  const defaultCwdAllowed = runtime.cwdAllowRoots.some((root) =>
    isPathWithinRoot(runtime.defaultCwd, root),
  );
  if (!defaultCwdAllowed) {
    throw new Error(
      `[bridge] runtime.defaultCwd is outside allowed roots: defaultCwd=${runtime.defaultCwd}, roots=${runtime.cwdAllowRoots.join(", ")}`,
    );
  }

  return {
    feishu: feishuConfig,
    http: {
      host: fileConfig.http?.host ?? process.env.BRIDGE_HTTP_HOST?.trim() ?? feishuConfig.webhookHost,
      port:
        fileConfig.http?.port ??
        parseInteger(process.env.BRIDGE_HTTP_PORT, feishuConfig.webhookPort),
      apiToken: fileConfig.http?.apiToken ?? process.env.BRIDGE_API_TOKEN?.trim(),
    },
    runtime,
    backends: mergedBackends,
  };
}

class FeishuCliBridgeApp {
  private readonly app = express();
  private readonly sessionStore: SessionStore;
  private readonly eventDispatcher: Lark.EventDispatcher;
  private readonly cardActionHandler: Lark.CardActionHandler;
  private readonly feishuClient: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private server: ReturnType<typeof this.app.listen> | null = null;
  private pendingQueueCount = 0;
  private readonly conversationChains = new Map<string, Promise<void>>();
  private readonly seenMessageIds = new Map<string, number>();
  private readonly pendingApprovalRequests = new Map<string, PendingApprovalRequest>();
  private readonly pendingApprovalByConversation = new Map<string, string>();

  constructor(private readonly config: BridgeConfig) {
    this.sessionStore = new SessionStore(path.resolve(process.cwd(), config.runtime.sessionStorePath));
    this.eventDispatcher = new Lark.EventDispatcher({
      verificationToken: config.feishu.verificationToken,
      encryptKey: config.feishu.encryptKey,
    });
    this.cardActionHandler = new Lark.CardActionHandler(
      {
        verificationToken: config.feishu.verificationToken,
        encryptKey: config.feishu.encryptKey,
      },
      async (data: Lark.InteractiveCardActionEvent) => await this.handleCardAction(data),
    );
    this.feishuClient = new Lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: resolveLarkDomain(config.feishu.domain),
    });
    this.registerEventHandlers();
    this.configureHttpRoutes();
  }

  async start(): Promise<void> {
    await this.sessionStore.load();
    await this.startHttpServer();
    if (this.config.feishu.connectionMode === "websocket") {
      await this.startWebSocketClient();
    }
    this.installSignalHandlers();
    console.log(
      `[bridge] started. mode=${this.config.feishu.connectionMode}, backend=${this.config.runtime.defaultBackendId}, listen=${this.config.http.host}:${this.config.http.port}, defaultCwd=${this.config.runtime.defaultCwd}`,
    );
    console.log(`[bridge] cwd allow roots: ${this.formatAllowedRoots()}`);
    console.log(
      `[bridge] webhook paths: events=${this.config.feishu.webhookPath}, cardActions=${this.config.feishu.cardWebhookPath}`,
    );
    console.log(
      `[bridge] codex homes: ${this.config.runtime.codexHomeDirs.length > 0 ? this.config.runtime.codexHomeDirs.join(", ") : "(none)"}`,
    );
    if (isRunningAsWindowsLocalSystem()) {
      console.warn(
        "[bridge] 当前进程运行账号为 LocalSystem。该模式下 Codex Windows 沙箱更容易出现 setup refresh/CreateProcessAsUserW/Logon SID not present on token 失败，建议改为普通用户账号运行服务。",
      );
    }
    if (this.config.feishu.connectionMode === "websocket") {
      console.log(
        "[bridge] 注意：当前权限审批使用文本指令（1/2/3）方式，不依赖卡片回调。",
      );
    }
  }

  private installSignalHandlers(): void {
    const shutdown = async () => {
      try {
        await this.stop();
      } finally {
        process.exit(0);
      }
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  }

  private async stop(): Promise<void> {
    for (const pending of this.pendingApprovalRequests.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.resolve({ decision: "timeout" });
    }
    this.pendingApprovalRequests.clear();
    this.pendingApprovalByConversation.clear();

    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch (error) {
        console.error("[bridge] close websocket failed:", error);
      }
      this.wsClient = null;
    }
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.server = null;
    }
  }

  private async startHttpServer(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = this.app
        .listen(this.config.http.port, this.config.http.host, () => resolve())
        .on("error", (error) => reject(error));
    });
  }

  private async startWebSocketClient(): Promise<void> {
    installFeishuWebSocketDnsFallback();
    this.wsClient = new Lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      domain: resolveLarkDomain(this.config.feishu.domain),
      loggerLevel: Lark.LoggerLevel.info,
    });
    void this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    console.log("[bridge] websocket client started");
  }

  private configureHttpRoutes(): void {
    this.app.use(express.json({ limit: "2mb" }));

    this.app.get("/healthz", (_req, res) => {
      res.json({
        ok: true,
        mode: this.config.feishu.connectionMode,
        backend: this.config.runtime.defaultBackendId,
        pendingQueue: this.pendingQueueCount,
        pendingApprovals: this.pendingApprovalRequests.size,
        defaultCwd: this.config.runtime.defaultCwd,
        codexHomeDirs: this.config.runtime.codexHomeDirs,
      });
    });

    this.app.post(this.config.feishu.webhookPath, async (req, res) => {
      if (this.config.feishu.connectionMode !== "webhook") {
        res.status(400).json({ error: "connection mode is not webhook" });
        return;
      }
      const payload = req.body;
      if (!isRecord(payload)) {
        res.status(400).json({ error: "invalid JSON body" });
        return;
      }

      const challengeResult = Lark.generateChallenge(payload, {
        encryptKey: this.config.feishu.encryptKey,
      });
      if (challengeResult.isChallenge) {
        res.status(200).json(challengeResult.challenge);
        return;
      }

      if (!this.isVerificationTokenValid(payload)) {
        res.status(401).json({ error: "invalid verification token" });
        return;
      }

      try {
        const envelope = Object.assign(Object.create({ headers: req.headers }), payload);
        const result = await this.eventDispatcher.invoke(envelope, { needCheck: false });
        res.status(200).json(result ?? { ok: true });
      } catch (error) {
        console.error("[bridge] webhook invoke failed:", error);
        res.status(500).json({ error: "webhook invoke failed" });
      }
    });

    this.app.post(this.config.feishu.cardWebhookPath, async (req, res) => {
      const payload = req.body;
      if (!isRecord(payload)) {
        res.status(400).json({ error: "invalid JSON body" });
        return;
      }
      try {
        console.log(
          `[bridge] card callback received: path=${this.config.feishu.cardWebhookPath}, pendingApprovals=${this.pendingApprovalRequests.size}`,
        );
        const envelope = Object.assign(Object.create({ headers: req.headers }), payload);
        const result = await this.cardActionHandler.invoke(envelope);
        if (!result) {
          console.warn(
            `[bridge] card callback handled with empty result (possible verification mismatch or unsupported action): pendingApprovals=${this.pendingApprovalRequests.size}`,
          );
        }
        res.status(200).json(result ?? {});
      } catch (error) {
        console.error("[bridge] card action invoke failed:", error);
        res.status(500).json({ error: "card action invoke failed" });
      }
    });
  }

  private isVerificationTokenValid(payload: JsonRecord): boolean {
    const expected = this.config.feishu.verificationToken?.trim();
    if (!expected) {
      return true;
    }
    const direct = asNonEmptyString(payload.token);
    if (direct === expected) {
      return true;
    }
    const header = payload.header;
    if (isRecord(header)) {
      const token = asNonEmptyString(header.token);
      if (token === expected) {
        return true;
      }
    }
    if (asNonEmptyString(payload.encrypt)) {
      return true;
    }
    return false;
  }

  private registerEventHandlers(): void {
    this.eventDispatcher.register({
      "im.message.receive_v1": async (payload: unknown) => {
        const parsed = parseFeishuMessageEvent(payload);
        if (!parsed) {
          console.warn("[bridge] ignored malformed im.message.receive_v1 payload");
          return;
        }
        console.log(
          `[bridge] inbound event received: messageId=${parsed.message.message_id}, chatId=${parsed.message.chat_id}, chatType=${parsed.message.chat_type}, messageType=${parsed.message.message_type}`,
        );
        if (this.isDuplicateMessage(parsed.message.message_id)) {
          console.log(`[bridge] duplicate message ignored: ${parsed.message.message_id}`);
          return;
        }
        this.enqueueInbound(parsed);
      },
    });
  }

  private isDuplicateMessage(messageId: string): boolean {
    const now = Date.now();
    const existing = this.seenMessageIds.get(messageId);
    if (existing && now - existing < 10 * 60 * 1000) {
      return true;
    }
    this.seenMessageIds.set(messageId, now);
    if (this.seenMessageIds.size > 2000) {
      for (const [id, timestamp] of this.seenMessageIds) {
        if (now - timestamp > 60 * 60 * 1000) {
          this.seenMessageIds.delete(id);
        }
      }
    }
    return false;
  }

  private getActiveCwd(state: ConversationState | undefined): string {
    return state?.backendCwd?.trim() || this.config.runtime.defaultCwd;
  }

  private isSamePath(leftPath: string, rightPath: string): boolean {
    return normalizePathKey(leftPath) === normalizePathKey(rightPath);
  }

  private getConfiguredCodexHomes(): string[] {
    return this.config.runtime.codexHomeDirs;
  }

  private getCodexHomeLabel(codexHome: string): string {
    const index = this.getConfiguredCodexHomes().findIndex((entry) => this.isSamePath(entry, codexHome));
    return index >= 0 ? `home#${index + 1}` : "home#?";
  }

  private renderConfiguredCodexHomes(): string {
    const codexHomes = this.getConfiguredCodexHomes();
    if (codexHomes.length === 0) {
      return "(未配置)";
    }
    return codexHomes.map((codexHome, index) => `${index + 1}. ${codexHome}`).join("\n");
  }

  private resolveActiveCodexHome(state: ConversationState | undefined): string | undefined {
    const selected = state?.backendCodexHome?.trim();
    if (selected) {
      return path.resolve(selected);
    }
    return this.getConfiguredCodexHomes()[0];
  }

  private getContextShortId(params: { sessionId: string; codexHome: string }): string {
    const normalizedHome = normalizePathKey(params.codexHome);
    const digest = crypto
      .createHash("sha1")
      .update(`${params.sessionId.trim()}@@${normalizedHome}`)
      .digest("hex")
      .slice(0, 12);
    let value = BigInt(`0x${digest}`);
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let result = "";
    for (let index = 0; index < CONTEXT_SHORT_ID_LENGTH; index += 1) {
      const charIndex = Number(value % BigInt(alphabet.length));
      result = `${alphabet[charIndex]}${result}`;
      value = value / BigInt(alphabet.length);
    }
    return result;
  }

  private normalizeContextShortId(input: string): string | undefined {
    const normalized = input.trim().toUpperCase();
    if (!CONTEXT_SHORT_ID_PATTERN.test(normalized)) {
      return undefined;
    }
    return normalized;
  }

  private async findSessionsByShortId(params: {
    shortId: string;
    codexHomes: string[];
    limitPerHome: number;
  }): Promise<{ matches: CodexHistorySessionView[]; errors: string[] }> {
    const matches: CodexHistorySessionView[] = [];
    const errors: string[] = [];
    for (const codexHome of params.codexHomes) {
      try {
        const sessions = await readRecentCodexHistorySessions({
          codexHome,
          limit: params.limitPerHome,
        });
        const homeIndex = params.codexHomes.findIndex((entry) => this.isSamePath(entry, codexHome)) + 1;
        for (const session of sessions) {
          const shortId = this.getContextShortId({
            sessionId: session.sessionId,
            codexHome,
          });
          if (shortId !== params.shortId) {
            continue;
          }
          matches.push({
            ...session,
            codexHome,
            homeIndex,
          });
        }
      } catch (error) {
        errors.push(`${codexHome}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { matches, errors };
  }

  private normalizeHelpTopic(topic: string): string {
    return topic.trim().toLowerCase().replace(/^\/+/, "").replace(/\s+/g, " ");
  }

  private resolveHelpTopicKey(topic: string): string | undefined {
    const normalized = this.normalizeHelpTopic(topic);
    if (!normalized) {
      return undefined;
    }
    const aliasMap: Record<string, string> = {
      help: "help",
      h: "help",
      text: "text",
      message: "text",
      msg: "text",
      "普通消息": "text",
      "普通文本": "text",
      "文本消息": "text",
      reset: "reset",
      backend: "backend",
      model: "model",
      "backend model": "model",
      "codex model": "model",
      "模型": "model",
      plan: "plan",
      "plan mode": "plan",
      "计划": "plan",
      "计划模式": "plan",
      cwd: "cwd",
      history: "history",
      context: "context",
      ctx: "context",
      "context show": "context",
      "ctx show": "context",
      "context list": "context_list",
      "ctx list": "context_list",
      "context use": "context_use",
      "ctx use": "context_use",
      "context set": "context_use",
      "context switch": "context_use",
      "context clear": "context_clear",
      "context reset": "context_clear",
      "ctx clear": "context_clear",
      shortid: "context_shortid",
      "short id": "context_shortid",
      "short-id": "context_shortid",
      "短id": "context_shortid",
      "短 id": "context_shortid",
      "短码": "context_shortid",
      "短号": "context_shortid",
      "短id映射": "context_shortid",
    };
    if (aliasMap[normalized]) {
      return aliasMap[normalized];
    }
    const parts = normalized.split(" ");
    if (parts.length >= 2) {
      const firstTwo = `${parts[0]} ${parts[1]}`;
      if (aliasMap[firstTwo]) {
        return aliasMap[firstTwo];
      }
    }
    if (aliasMap[parts[0]]) {
      return aliasMap[parts[0]];
    }
    return undefined;
  }

  private renderSupportedHelpTopics(): string {
    return "help | text | reset | backend | model | plan | cwd | history | context | context list | context use | context clear | context shortid";
  }

  private renderGeneralCommandHint(): string {
    return (
      "可用命令：/help [命令] | /reset | /backend <backendId> | " +
      "/model [name|reset] | /plan [on|off] | /cwd [path|reset] | /history [n] | /context [list|use|clear]"
    );
  }

  private renderContextCommandHint(): string {
    return "可用命令：/help [命令] | /context list [n] | /context use <短ID或sessionId> [@home序号] | /context clear";
  }

  private buildHelpOverviewReply(): string {
    const backendIds = Object.keys(this.config.backends);
    const backendText = backendIds.length > 0 ? backendIds.join(", ") : "(无)";
    return (
      "帮助总览（请求触发方式）\n" +
      "1) 普通文本消息：直接触发后端对话（自动续接当前上下文）\n" +
      "2) /help [命令]：查看总览或某个命令详情\n" +
      "3) /reset：重置当前会话状态（后端/上下文/CWD）\n" +
      `4) /backend <backendId>：切换后端（可用：${backendText}）\n` +
      "5) /model [name|reset]：切换当前会话的后端模型\n" +
      "6) /plan [on|off]：开启或关闭当前会话的 plan mode\n" +
      "7) /cwd：查看工作目录；/cwd <path> 设置目录；/cwd reset 重置目录\n" +
      "8) /history [n]：查看跨终端聚合历史\n" +
      "9) /context：查看上下文状态；/context list [n] 列表；/context use <短ID或sessionId> [@home序号] 切换；/context clear 清除\n" +
      "10) 权限审批：当触发 Full Access 申请时，回复 1/2/3 进行批准或拒绝\n\n" +
      "查看单个命令详情示例：/help context use\n" +
      `可查询主题：${this.renderSupportedHelpTopics()}`
    );
  }

  private buildHelpDetailReply(topicKey: string): string {
    const backendIds = Object.keys(this.config.backends);
    const backendText = backendIds.length > 0 ? backendIds.join(", ") : "(无)";
    const codexHomes = this.getConfiguredCodexHomes();
    const codexHomeText =
      codexHomes.length > 0 ? `\n已配置 CODEX_HOME：\n${this.renderConfiguredCodexHomes()}` : "";
    if (topicKey === "help") {
      return (
        "命令：/help [命令]\n" +
        "作用：查看命令总览，或查看某个命令的详细说明。\n" +
        "示例：/help\n" +
        "示例：/help context use\n" +
        `可查询主题：${this.renderSupportedHelpTopics()}`
      );
    }
    if (topicKey === "text") {
      return (
        "触发：普通文本消息（不以 / 命令开头）\n" +
        "作用：将消息转发给当前后端进行对话；若已设置 context，会继续对应会话。\n" +
        "补充：若 autoRunBackend 关闭，则不会自动调用后端。\n" +
        "补充：如触发 Full Access 审批，请直接回复 1/2/3（1=仅本次批准，2=批准并后续自动批准，3=拒绝）。"
      );
    }
    if (topicKey === "reset") {
      return (
        "命令：/reset\n" +
        "作用：清空当前会话状态，包括 backend、context、CWD。\n" +
        "结果：下一条普通消息会按默认后端和默认目录新建会话。"
      );
    }
    if (topicKey === "backend") {
      return (
        "命令：/backend <backendId>\n" +
        `作用：切换当前会话使用的后端（可用：${backendText}）。\n` +
        "结果：会重置当前 context（session），CWD 保持不变。\n" +
        "示例：/backend codex-cli"
      );
    }
    if (topicKey === "model") {
      return (
        "命令：/model\n" +
        "作用：查看当前会话正在使用的模型（优先会话模型，否则使用全局默认模型）。\n\n" +
        "命令：/model <name>\n" +
        "作用：设置当前会话模型（如 gpt-5.4）。\n\n" +
        "命令：/model reset\n" +
        "作用：清除会话模型，回退到全局默认模型。"
      );
    }
    if (topicKey === "plan") {
      return (
        "命令：/plan\n" +
        "作用：查看当前会话 plan mode 状态。\n\n" +
        "命令：/plan on\n" +
        "作用：开启 plan mode，后续普通消息会自动附加计划化执行提示。\n\n" +
        "命令：/plan off\n" +
        "作用：关闭 plan mode。"
      );
    }
    if (topicKey === "cwd") {
      return (
        "命令：/cwd\n" +
        "作用：查看当前工作目录、默认目录、允许根目录。\n\n" +
        "命令：/cwd <path>\n" +
        "作用：设置当前会话工作目录（必须在允许根目录内）。\n\n" +
        "命令：/cwd reset\n" +
        "作用：将工作目录重置为默认目录。"
      );
    }
    if (topicKey === "history") {
      return (
        "命令：/history [n]\n" +
        "作用：展示最近 n 条 Codex 历史（跨已配置 CODEX_HOME 聚合）。\n" +
        "参数：n 可选，默认 8，最大 30。\n" +
        "用途：可从输出中拿到 sessionId，再配合 /context use 切换。"
      );
    }
    if (topicKey === "context") {
      return (
        "命令：/context\n" +
        "作用：查看当前上下文状态（backend、sessionId、短ID、当前 CODEX_HOME、最近摘要）。\n\n" +
        "相关子命令：/context list [n] | /context use <短ID或sessionId> [@home序号] | /context clear" +
        codexHomeText
      );
    }
    if (topicKey === "context_list") {
      return (
        "命令：/context list [n]\n" +
        "作用：列出最近可切换的 session（跨终端聚合），并显示 5 位短ID 和 home 序号。\n" +
        "参数：n 可选，默认 8，最大 30。\n" +
        "后续：使用 /context use <短ID或sessionId> [@home序号] 切换。"
      );
    }
    if (topicKey === "context_use") {
      return (
        "命令：/context use <短ID或sessionId> [@home序号]\n" +
        "作用：将当前会话绑定到指定 session，并在后续普通消息中继续该历史。\n" +
        "参数：@home序号 可选，用于指定来自哪个 CODEX_HOME（如 @1）。\n" +
        "行为：如果不指定 home 且多个目录都命中，会提示你补充 @home序号。"
      );
    }
    if (topicKey === "context_clear") {
      return (
        "命令：/context clear\n" +
        "作用：清除当前绑定的 session/context。\n" +
        "结果：下一条普通消息会从新会话开始。"
      );
    }
    if (topicKey === "context_shortid") {
      return (
        "主题：context 短ID\n" +
        "说明：服务会把每个 context session 映射成 5 位字母数字短ID（如 A1B2C），便于手输。\n" +
        "查看：/context list\n" +
        "使用：/context use <短ID>\n" +
        "补充：若短ID极少数情况下冲突，可改用完整 sessionId 或加 @home序号。"
      );
    }
    return this.buildHelpOverviewReply();
  }

  private buildHelpReply(topic: string | undefined): string {
    if (!topic) {
      return this.buildHelpOverviewReply();
    }
    const topicKey = this.resolveHelpTopicKey(topic);
    if (!topicKey) {
      return (
        `未识别的帮助主题：${topic}\n` +
        `可查询主题：${this.renderSupportedHelpTopics()}\n` +
        "示例：/help context use"
      );
    }
    return this.buildHelpDetailReply(topicKey);
  }

  private async findSessionMatchesAcrossHomes(
    sessionId: string,
    codexHomes: string[],
  ): Promise<{ matchedHomes: string[]; errors: string[] }> {
    const matchedHomes: string[] = [];
    const errors: string[] = [];
    for (const codexHome of codexHomes) {
      try {
        const exists = await hasLocalCodexSession({
          codexHome,
          sessionId,
        });
        if (exists) {
          matchedHomes.push(codexHome);
        }
      } catch (error) {
        errors.push(`${codexHome}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { matchedHomes, errors };
  }

  private renderCodexHistoryEntries(entries: CodexHistoryEntryView[]): string {
    const lines = entries.map((entry, index) => {
      const indexLabel = `${index + 1}`.padStart(2, "0");
      const homeLabel = this.getCodexHomeLabel(entry.codexHome);
      return (
        `${indexLabel}. ${formatLocalDateTimeFromUnixSeconds(entry.timestampSec)} | session=${entry.sessionId} | ${homeLabel}\n` +
        `    home: ${entry.codexHome}\n` +
        `    ${normalizePreviewText(entry.text)}`
      );
    });
    return lines.join("\n");
  }

  private renderCodexHistorySessions(
    sessions: CodexHistorySessionView[],
    current: {
      sessionId?: string;
      codexHome?: string;
    },
  ): string {
    const lines = sessions.map((session, index) => {
      const sameSession = current.sessionId && current.sessionId === session.sessionId;
      const sameHome = current.codexHome ? this.isSamePath(current.codexHome, session.codexHome) : true;
      const isCurrent = sameSession && sameHome ? " (当前)" : "";
      const indexLabel = `${index + 1}`.padStart(2, "0");
      const homeLabel = this.getCodexHomeLabel(session.codexHome);
      const shortId = this.getContextShortId({
        sessionId: session.sessionId,
        codexHome: session.codexHome,
      });
      return (
        `${indexLabel}. ${shortId} => ${session.sessionId}${isCurrent} | ${homeLabel}\n` +
        `    home: ${session.codexHome}\n` +
        `    最后提问：${formatLocalDateTimeFromUnixSeconds(session.lastTimestampSec)}\n` +
        `    ${normalizePreviewText(session.lastPrompt)}`
      );
    });
    return lines.join("\n");
  }

  private async buildHistoryReply(limit: number): Promise<string> {
    const codexHomes = this.getConfiguredCodexHomes();
    if (codexHomes.length === 0) {
      return (
        "未配置可读取的 CODEX_HOME 目录，无法读取历史。\n" +
        "请设置 CODEX_HOME，或通过 BRIDGE_CODEX_HOME_DIRS 增加目录。"
      );
    }
    const mergedEntries: CodexHistoryEntryView[] = [];
    const errors: string[] = [];
    for (const codexHome of codexHomes) {
      try {
        const entries = await readRecentCodexHistoryEntries({
          codexHome,
          limit,
        });
        const homeIndex = codexHomes.findIndex((entry) => this.isSamePath(entry, codexHome)) + 1;
        for (const entry of entries) {
          mergedEntries.push({
            ...entry,
            codexHome,
            homeIndex,
          });
        }
      } catch (error) {
        errors.push(`${codexHome}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const entries = mergedEntries
      .sort((left, right) => right.timestampSec - left.timestampSec)
      .slice(0, limit);
    if (entries.length === 0) {
      const errorSection = errors.length > 0 ? `\n错误：\n${errors.join("\n")}` : "";
      return (
        `未读取到 Codex 聊天历史。\n` +
        `已配置目录：\n${this.renderConfiguredCodexHomes()}` +
        `${errorSection}`
      );
    }
    const errorSection = errors.length > 0 ? `\n\n部分目录读取失败：\n${errors.join("\n")}` : "";
    return (
      `Codex 聊天历史（跨终端最近 ${entries.length} 条）：\n` +
      `${this.renderCodexHistoryEntries(entries)}\n\n` +
      `${this.renderContextCommandHint()}` +
      `${errorSection}`
    );
  }

  private async buildContextStatusReply(
    currentState: ConversationState | undefined,
  ): Promise<string> {
    const backendId = currentState?.backendId ?? this.config.runtime.defaultBackendId;
    const activeSessionId = currentState?.backendSessionId?.trim();
    const activeModel = currentState?.backendModel?.trim() || this.config.runtime.defaultModel || "(未设置)";
    const planModeEnabled = currentState?.planModeEnabled === true;
    const dangerSandboxAutoApprove = currentState?.dangerSandboxAutoApprove === true;
    const activeCodexHome = this.resolveActiveCodexHome(currentState);
    const codexHomeLabel = activeCodexHome ? this.getCodexHomeLabel(activeCodexHome) : "(未绑定)";
    if (!activeSessionId) {
      return (
        `当前后端：${backendId}\n` +
        `当前模型：${activeModel}\n` +
        `Plan Mode：${planModeEnabled ? "开启" : "关闭"}\n` +
        `Full Access 自动批准：${dangerSandboxAutoApprove ? "开启" : "关闭"}\n` +
        `当前 CODEX_HOME：${activeCodexHome ?? "(未配置)"} ${activeCodexHome ? `(${codexHomeLabel})` : ""}\n` +
        "当前上下文：未设置（将新建会话）\n" +
        `${this.renderContextCommandHint()}`
      );
    }

    const codexHomes = this.getConfiguredCodexHomes();
    const homesToSearch = activeCodexHome
      ? [activeCodexHome, ...codexHomes.filter((entry) => !this.isSamePath(entry, activeCodexHome))]
      : [...codexHomes];
    let resolvedCodexHome = activeCodexHome;
    let summaryLine = "最近提问：未找到本地历史摘要。";
    const errors: string[] = [];
    for (const codexHome of homesToSearch) {
      try {
        const entries = await readRecentCodexHistoryEntries({
          codexHome,
          limit: 80,
        });
        const matched = entries.find((entry) => entry.sessionId === activeSessionId);
        if (matched) {
          resolvedCodexHome = codexHome;
          summaryLine =
            `最近提问（${formatLocalDateTimeFromUnixSeconds(matched.timestampSec)}）：` +
            `${normalizePreviewText(matched.text)}`;
          break;
        }
      } catch (error) {
        errors.push(`${codexHome}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (summaryLine === "最近提问：未找到本地历史摘要。" && errors.length > 0) {
      summaryLine = `最近提问：读取历史失败（${errors.join(" | ")}）`;
    }
    const resolvedLabel = resolvedCodexHome ? this.getCodexHomeLabel(resolvedCodexHome) : "(未绑定)";
    const shortId =
      resolvedCodexHome
        ? this.getContextShortId({ sessionId: activeSessionId, codexHome: resolvedCodexHome })
        : "(未知)";
    return (
      `当前后端：${backendId}\n` +
      `当前模型：${activeModel}\n` +
      `Plan Mode：${planModeEnabled ? "开启" : "关闭"}\n` +
      `Full Access 自动批准：${dangerSandboxAutoApprove ? "开启" : "关闭"}\n` +
      `当前上下文 sessionId：${activeSessionId}\n` +
      `当前上下文短ID：${shortId}\n` +
      `当前 CODEX_HOME：${resolvedCodexHome ?? "(未配置)"} ${resolvedCodexHome ? `(${resolvedLabel})` : ""}\n` +
      `${summaryLine}\n` +
      `${this.renderContextCommandHint()}`
    );
  }

  private async buildContextListReply(
    limit: number,
    currentState: ConversationState | undefined,
  ): Promise<string> {
    const codexHomes = this.getConfiguredCodexHomes();
    if (codexHomes.length === 0) {
      return (
        "未配置可读取的 CODEX_HOME 目录，无法列出上下文。\n" +
        "请设置 CODEX_HOME，或通过 BRIDGE_CODEX_HOME_DIRS 增加目录。"
      );
    }
    const mergedSessions: CodexHistorySessionView[] = [];
    const errors: string[] = [];
    for (const codexHome of codexHomes) {
      try {
        const sessions = await readRecentCodexHistorySessions({
          codexHome,
          limit,
        });
        const homeIndex = codexHomes.findIndex((entry) => this.isSamePath(entry, codexHome)) + 1;
        for (const session of sessions) {
          mergedSessions.push({
            ...session,
            codexHome,
            homeIndex,
          });
        }
      } catch (error) {
        errors.push(`${codexHome}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const sessions = mergedSessions
      .sort((left, right) => right.lastTimestampSec - left.lastTimestampSec)
      .slice(0, limit);
    if (sessions.length === 0) {
      const errorSection = errors.length > 0 ? `\n错误：\n${errors.join("\n")}` : "";
      return (
        `未读取到可切换的本地会话。\n` +
        `已配置目录：\n${this.renderConfiguredCodexHomes()}` +
        `${errorSection}`
      );
    }
    const errorSection = errors.length > 0 ? `\n\n部分目录读取失败：\n${errors.join("\n")}` : "";
    return (
      `可切换上下文（跨终端最近 ${sessions.length} 个 session）：\n` +
      `${this.renderCodexHistorySessions(sessions, {
        sessionId: currentState?.backendSessionId?.trim(),
        codexHome: this.resolveActiveCodexHome(currentState),
      })}\n\n` +
      "切换命令：/context use <短ID或sessionId> [@home序号]\n" +
      `可用 home 序号：\n${this.renderConfiguredCodexHomes()}` +
      `${errorSection}`
    );
  }

  private formatAllowedRoots(): string {
    return this.config.runtime.cwdAllowRoots.join(", ");
  }

  private resolveCommandCwd(rawPath: string, currentCwd: string): { ok: true; cwd: string } | { ok: false; reason: string } {
    const unquoted = rawPath.trim().replace(/^"(.*)"$/, "$1");
    const candidatePath = path.isAbsolute(unquoted) ? unquoted : path.resolve(currentCwd, unquoted);
    const normalized = path.resolve(candidatePath);
    if (!existsSync(normalized)) {
      return { ok: false, reason: `目录不存在：${normalized}` };
    }
    if (!statSync(normalized).isDirectory()) {
      return { ok: false, reason: `不是目录：${normalized}` };
    }
    const isAllowed = this.config.runtime.cwdAllowRoots.some((root) =>
      isPathWithinRoot(normalized, root),
    );
    if (!isAllowed) {
      return {
        ok: false,
        reason: `目录不在允许范围内：${normalized}\n允许根目录：${this.formatAllowedRoots()}`,
      };
    }
    return { ok: true, cwd: normalized };
  }

  private resolveImageRefs(imageRefs: string[] | undefined, activeCwd: string): string[] {
    if (!Array.isArray(imageRefs) || imageRefs.length === 0) {
      return [];
    }
    const result = new Set<string>();
    for (const item of imageRefs) {
      const raw = item?.trim();
      if (!raw || !isLikelyImageRef(raw)) {
        continue;
      }
      if (/^https?:\/\//i.test(raw) || raw.startsWith("data:image/")) {
        result.add(raw);
        continue;
      }
      const unquoted = raw.replace(/^"(.*)"$/, "$1");
      const resolved = path.isAbsolute(unquoted)
        ? path.resolve(unquoted)
        : path.resolve(activeCwd, unquoted);
      if (existsSync(resolved) && statSync(resolved).isFile()) {
        result.add(resolved);
      }
    }
    return [...result];
  }

  private async uploadFeishuImageKeyFromRef(imageRef: string): Promise<string> {
    let imagePayload: Buffer;
    if (/^https?:\/\//i.test(imageRef)) {
      const response = await fetch(imageRef, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        throw new Error(`download image failed (${response.status}) for ${imageRef}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      imagePayload = Buffer.from(arrayBuffer);
    } else if (imageRef.startsWith("data:image/")) {
      const commaIndex = imageRef.indexOf(",");
      if (commaIndex < 0) {
        throw new Error(`invalid data url image ref: ${imageRef.slice(0, 40)}...`);
      }
      const base64 = imageRef.slice(commaIndex + 1);
      imagePayload = Buffer.from(base64, "base64");
    } else {
      imagePayload = await fs.readFile(imageRef);
    }

    const response = await this.feishuClient.im.image.create({
      data: {
        image_type: "message",
        image: imagePayload,
      },
    });

    const wrapped = response as { code?: number; msg?: string; image_key?: string; data?: { image_key?: string } };
    if (wrapped.code !== undefined && wrapped.code !== 0) {
      throw new Error(`upload image failed: ${wrapped.msg || `code ${wrapped.code}`}`);
    }
    const imageKey = wrapped.image_key ?? wrapped.data?.image_key;
    if (!imageKey) {
      throw new Error("upload image failed: no image_key returned");
    }
    return imageKey;
  }

  private async sendImageByKeyWithFallback(params: {
    chatId: string;
    imageKey: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
  }): Promise<void> {
    if (params.replyToMessageId) {
      try {
        await this.feishuClient.im.message.reply({
          path: { message_id: params.replyToMessageId },
          data: {
            msg_type: "image",
            content: JSON.stringify({ image_key: params.imageKey }),
            ...(params.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        return;
      } catch (error) {
        console.warn(`[bridge] image reply failed, fallback to create: ${String(error)}`);
      }
    }
    await this.feishuClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: params.chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: params.imageKey }),
      },
    });
  }

  private async forwardImageRefsToFeishu(params: {
    chatId: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
    imageRefs: string[];
  }): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (let index = 0; index < params.imageRefs.length; index += 1) {
      const imageRef = params.imageRefs[index];
      try {
        const imageKey = await this.uploadFeishuImageKeyFromRef(imageRef);
        await this.sendImageByKeyWithFallback({
          chatId: params.chatId,
          imageKey,
          replyToMessageId: index === 0 ? params.replyToMessageId : undefined,
          replyInThread: params.replyInThread,
        });
        sent += 1;
        console.log(`[bridge] image forwarded: ${imageRef}`);
      } catch (error) {
        failed += 1;
        console.error(`[bridge] image forward failed (${imageRef}): ${String(error)}`);
      }
    }
    return { sent, failed };
  }

  private tryHandlePendingApprovalInbound(event: FeishuMessageEvent, conversationKey: string): boolean {
    const pendingApprovalId = this.pendingApprovalByConversation.get(conversationKey);
    if (!pendingApprovalId) {
      return false;
    }
    const pending = this.pendingApprovalRequests.get(pendingApprovalId);
    if (!pending) {
      this.pendingApprovalByConversation.delete(conversationKey);
      return false;
    }

    const actorOpenId = event.sender.sender_id.open_id ?? event.sender.sender_id.user_id;
    if (pending.enforceRequesterCheck && pending.requesterOpenId && actorOpenId !== pending.requesterOpenId) {
      void this.replyWithFallback({
        chatId: event.message.chat_id,
        replyToMessageId: event.message.message_id,
        replyInThread: Boolean(event.message.root_id || event.message.thread_id),
        text: "仅申请发起人可审批该权限请求。",
      });
      return true;
    }

    const decisionInput = parseApprovalDecisionInput(extractTextFromMessage(event));
    if (!decisionInput) {
      void this.replyWithFallback({
        chatId: event.message.chat_id,
        replyToMessageId: event.message.message_id,
        replyInThread: Boolean(event.message.root_id || event.message.thread_id),
        text:
          "当前有待处理的权限申请，请回复数字：\n" +
          "1 = 仅本次批准\n" +
          "2 = 本次批准并后续自动批准\n" +
          "3 = 拒绝",
      });
      return true;
    }

    clearTimeout(pending.timeoutHandle);
    this.pendingApprovalRequests.delete(pendingApprovalId);
    this.pendingApprovalByConversation.delete(conversationKey);
    pending.resolve({
      decision: decisionInput.decision,
      actorOpenId,
      autoApproveFuture: decisionInput.autoApproveFuture,
    });

    if (decisionInput.decision === "approve" && decisionInput.autoApproveFuture) {
      const currentState = this.sessionStore.get(conversationKey);
      this.sessionStore.set(conversationKey, {
        ...currentState,
        dangerSandboxAutoApprove: true,
        updatedAt: new Date().toISOString(),
      });
    }

    const decisionText =
      decisionInput.decision === "approve"
        ? decisionInput.autoApproveFuture
          ? "已批准本次权限申请，并开启后续自动批准。"
          : "已批准本次权限申请。"
        : "已拒绝本次权限申请。";
    console.log(
      `[bridge] approval decided by text: approvalId=${pendingApprovalId}, decision=${decisionInput.decision}, autoApprove=${decisionInput.autoApproveFuture ? "true" : "false"}, actor=${actorOpenId ?? "unknown"}`,
    );
    void this.replyWithFallback({
      chatId: event.message.chat_id,
      replyToMessageId: event.message.message_id,
      replyInThread: Boolean(event.message.root_id || event.message.thread_id),
      text: decisionText,
    });
    return true;
  }

  private enqueueInbound(event: FeishuMessageEvent): void {
    const conversationKey = resolveConversationKey({
      accountId: this.config.feishu.accountId,
      event,
    });
    if (this.tryHandlePendingApprovalInbound(event, conversationKey)) {
      return;
    }

    if (this.pendingQueueCount >= this.config.runtime.inboundQueueLimit) {
      void this.replyWithFallback({
        chatId: event.message.chat_id,
        replyToMessageId: event.message.message_id,
        replyInThread: Boolean(event.message.root_id || event.message.thread_id),
        text: "系统繁忙，请稍后重试。",
      });
      return;
    }
    console.log(
      `[bridge] enqueue inbound: messageId=${event.message.message_id}, conversationKey=${conversationKey}, pendingBefore=${this.pendingQueueCount}`,
    );

    const queueDepth = this.pendingQueueCount + 1;
    if (event.sender.sender_type !== "app") {
      void this.sendInboundAcceptedStatus(event, queueDepth);
    }

    this.pendingQueueCount += 1;
    const previous = this.conversationChains.get(conversationKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await this.processInboundEvent(event, conversationKey);
      })
      .catch((error) => {
        console.error("[bridge] inbound processing failed:", error);
      })
      .finally(() => {
        this.pendingQueueCount = Math.max(0, this.pendingQueueCount - 1);
        if (this.conversationChains.get(conversationKey) === current) {
          this.conversationChains.delete(conversationKey);
        }
      });
    this.conversationChains.set(conversationKey, current);
  }

  private async sendInboundAcceptedStatus(
    event: FeishuMessageEvent,
    queueDepth: number,
  ): Promise<void> {
    const statusText =
      queueDepth > 1
        ? `✅ 已收到消息，正在排队处理中（队列位置 ${queueDepth}）。`
        : "✅ 已收到消息，正在处理中。";
    try {
      await this.replyWithFallback({
        chatId: event.message.chat_id,
        replyToMessageId: event.message.message_id,
        replyInThread: Boolean(event.message.root_id || event.message.thread_id),
        text: statusText,
      });
      console.log(
        `[bridge] inbound ack sent: messageId=${event.message.message_id}, queueDepth=${queueDepth}`,
      );
    } catch (error) {
      console.warn(
        `[bridge] inbound ack failed: messageId=${event.message.message_id}, error=${String(error)}`,
      );
    }
  }

  private profileLooksLikeCodex(profile: CliBackendProfile): boolean {
    const command = profile.command.trim().toLowerCase();
    const profileId = profile.id.trim().toLowerCase();
    return command.includes("codex") || profileId.includes("codex");
  }

  private formatApprovalPromptPreview(prompt: string): string {
    const compact = prompt.replace(/\s+/g, " ").trim();
    if (!compact) {
      return "(空)";
    }
    if (compact.length <= MAX_APPROVAL_PROMPT_PREVIEW_CHARS) {
      return compact;
    }
    return `${compact.slice(0, MAX_APPROVAL_PROMPT_PREVIEW_CHARS - 1)}…`;
  }

  private buildDangerSandboxApprovalCard(params: {
    approvalId: string;
    backendId: string;
    cwd: string;
    sessionId?: string;
    prompt: string;
    timeoutMs: number;
  }): Lark.InteractiveCard {
    const timeoutSec = Math.max(1, Math.ceil(params.timeoutMs / 1000));
    const sessionText = params.sessionId?.trim() || "(新会话)";
    const promptPreview = this.formatApprovalPromptPreview(params.prompt);
    return {
      config: {
        wide_screen_mode: true,
        update_multi: true,
        enable_forward: false,
      },
      header: {
        template: "orange",
        title: {
          tag: "plain_text",
          content: "Codex 权限申请",
        },
      },
      elements: [
        {
          tag: "markdown",
          content:
            "检测到 Codex 需要提升到 `danger-full-access` 才能继续执行本次请求。\n" +
            `审批超时：${timeoutSec} 秒`,
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content:
              `**backend**: ${params.backendId}\n` +
              `**cwd**: ${params.cwd}\n` +
              `**session**: ${sessionText}\n` +
              `**请求摘要**: ${promptPreview}`,
          },
        },
        {
          tag: "action",
          layout: "bisected",
          actions: [
            {
              tag: "button",
              type: "primary",
              text: {
                tag: "plain_text",
                content: "批准并继续",
              },
              value: {
                action_type: APPROVAL_ACTION_TYPE,
                approval_id: params.approvalId,
                decision: "approve",
              },
            },
            {
              tag: "button",
              type: "danger",
              text: {
                tag: "plain_text",
                content: "拒绝",
              },
              value: {
                action_type: APPROVAL_ACTION_TYPE,
                approval_id: params.approvalId,
                decision: "reject",
              },
            },
          ],
        },
      ],
    };
  }

  private buildDangerSandboxDecisionCard(params: {
    decision: ApprovalDecision["decision"];
    actorOpenId?: string;
    detail?: string;
  }): Lark.InteractiveCard {
    if (params.decision === "approve") {
      return {
        header: {
          template: "green",
          title: { tag: "plain_text", content: "已批准" },
        },
        elements: [
          {
            tag: "markdown",
            content: `已批准本次 Codex 提权请求。${params.actorOpenId ? `\n操作人：${params.actorOpenId}` : ""}`,
          },
        ],
      };
    }
    if (params.decision === "reject") {
      return {
        header: {
          template: "red",
          title: { tag: "plain_text", content: "已拒绝" },
        },
        elements: [
          {
            tag: "markdown",
            content: `已拒绝本次 Codex 提权请求。${params.actorOpenId ? `\n操作人：${params.actorOpenId}` : ""}`,
          },
        ],
      };
    }
    return {
      header: {
        template: "grey",
        title: { tag: "plain_text", content: "审批已失效" },
      },
      elements: [
        {
          tag: "markdown",
          content: params.detail || "该权限申请已过期，请重新发起。",
        },
      ],
    };
  }

  private async replyInteractiveCardWithFallback(params: {
    chatId: string;
    card: Lark.InteractiveCard;
    replyToMessageId?: string;
    replyInThread?: boolean;
  }): Promise<void> {
    const content = JSON.stringify(params.card);
    if (params.replyToMessageId) {
      try {
        await this.feishuClient.im.message.reply({
          path: { message_id: params.replyToMessageId },
          data: {
            msg_type: "interactive",
            content,
            ...(params.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        return;
      } catch (error) {
        console.warn(`[bridge] interactive card reply failed, fallback to create: ${String(error)}`);
      }
    }
    await this.feishuClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: params.chatId,
        msg_type: "interactive",
        content,
      },
    });
  }

  private async requestDangerSandboxApproval(params: {
    inboundMessage: FeishuInboundMessage;
    backendId: string;
    activeCwd: string;
    sessionId?: string;
    prompt: string;
  }): Promise<ApprovalDecision> {
    const approvalId = crypto.randomUUID();
    const timeoutMs = this.config.runtime.permissionApprovalTimeoutMs;
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const sessionText = params.sessionId?.trim() || "(新会话)";
    const promptPreview = this.formatApprovalPromptPreview(params.prompt);
    const existingApprovalId = this.pendingApprovalByConversation.get(params.inboundMessage.conversationKey);
    if (existingApprovalId) {
      const existing = this.pendingApprovalRequests.get(existingApprovalId);
      if (existing) {
        clearTimeout(existing.timeoutHandle);
        existing.resolve({ decision: "timeout" });
        this.pendingApprovalRequests.delete(existingApprovalId);
      }
      this.pendingApprovalByConversation.delete(params.inboundMessage.conversationKey);
    }
    const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        const pending = this.pendingApprovalRequests.get(approvalId);
        if (!pending) {
          return;
        }
        if (this.pendingApprovalByConversation.get(pending.conversationKey) === approvalId) {
          this.pendingApprovalByConversation.delete(pending.conversationKey);
        }
        this.pendingApprovalRequests.delete(approvalId);
        pending.resolve({ decision: "timeout" });
      }, timeoutMs);
      timeoutHandle.unref();
      this.pendingApprovalRequests.set(approvalId, {
        approvalId,
        conversationKey: params.inboundMessage.conversationKey,
        requesterOpenId: params.inboundMessage.senderOpenId,
        enforceRequesterCheck: params.inboundMessage.chatType === "group",
        resolve,
        timeoutHandle,
      });
      this.pendingApprovalByConversation.set(params.inboundMessage.conversationKey, approvalId);
    });
    console.log(
      `[bridge] approval pending created: approvalId=${approvalId}, chatType=${params.inboundMessage.chatType}, requester=${params.inboundMessage.senderOpenId ?? "unknown"}, timeoutMs=${timeoutMs}`,
    );

    try {
      await this.replyWithFallback({
        chatId: params.inboundMessage.chatId,
        replyToMessageId: params.inboundMessage.messageId,
        replyInThread: Boolean(params.inboundMessage.threadId),
        text:
          "检测到 Codex 需要申请 Full Access（danger-full-access）权限。\n" +
          `backend: ${params.backendId}\n` +
          `cwd: ${params.activeCwd}\n` +
          `session: ${sessionText}\n` +
          `请求摘要: ${promptPreview}\n` +
          `请在 ${timeoutSec} 秒内回复：\n` +
          "1 = 仅本次批准\n" +
          "2 = 本次批准并后续自动批准\n" +
          "3 = 拒绝",
      });
    } catch (error) {
      const pending = this.pendingApprovalRequests.get(approvalId);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        if (this.pendingApprovalByConversation.get(pending.conversationKey) === approvalId) {
          this.pendingApprovalByConversation.delete(pending.conversationKey);
        }
        this.pendingApprovalRequests.delete(approvalId);
      }
      throw error;
    }

    return await decisionPromise;
  }

  private async handleCardAction(
    event: Lark.InteractiveCardActionEvent,
  ): Promise<Lark.InteractiveCard | undefined> {
    const value = isRecord(event.action?.value) ? event.action.value : undefined;
    if (!value) {
      return undefined;
    }
    const actionType = asNonEmptyString(value.action_type);
    if (actionType !== APPROVAL_ACTION_TYPE) {
      return undefined;
    }
    const approvalId = asNonEmptyString(value.approval_id);
    const decision = asNonEmptyString(value.decision)?.toLowerCase();
    if (!approvalId || (decision !== "approve" && decision !== "reject")) {
      return this.buildDangerSandboxDecisionCard({
        decision: "timeout",
        detail: "审批参数无效，请重新发起。",
      });
    }

    const pending = this.pendingApprovalRequests.get(approvalId);
    if (!pending) {
      return this.buildDangerSandboxDecisionCard({
        decision: "timeout",
        detail: "该权限申请已过期，请重新发起。",
      });
    }
    const actorIds = [event.open_id, event.user_id].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    const matchedRequester =
      !pending.requesterOpenId || actorIds.includes(pending.requesterOpenId);
    if (pending.enforceRequesterCheck && !matchedRequester) {
      console.warn(
        `[bridge] ignore approval from non-requester: approvalId=${approvalId}, actor=${actorIds.join("|") || "unknown"}, requester=${pending.requesterOpenId}`,
      );
      return this.buildDangerSandboxDecisionCard({
        decision: "reject",
        detail: "仅申请发起人可审批该请求。",
      });
    }

    clearTimeout(pending.timeoutHandle);
    if (this.pendingApprovalByConversation.get(pending.conversationKey) === approvalId) {
      this.pendingApprovalByConversation.delete(pending.conversationKey);
    }
    this.pendingApprovalRequests.delete(approvalId);
    pending.resolve({ decision, actorOpenId: event.open_id });
    console.log(
      `[bridge] approval decided: approvalId=${approvalId}, decision=${decision}, actor=${actorIds.join("|") || "unknown"}`,
    );
    return this.buildDangerSandboxDecisionCard({
      decision,
      actorOpenId: event.open_id,
    });
  }

  private async processInboundEvent(
    event: FeishuMessageEvent,
    conversationKey: string,
  ): Promise<void> {
    if (event.sender.sender_type === "app") {
      return;
    }

    const text = extractTextFromMessage(event);
    console.log(
      `[bridge] processing inbound: messageId=${event.message.message_id}, extractedTextLength=${text.length}`,
    );
    if (!text) {
      await this.replyWithFallback({
        chatId: event.message.chat_id,
        replyToMessageId: event.message.message_id,
        replyInThread: Boolean(event.message.root_id || event.message.thread_id),
        text: "暂不支持该消息类型，请发送文本消息。",
      });
      return;
    }

    const inboundMessage: FeishuInboundMessage = {
      accountId: this.config.feishu.accountId,
      conversationKey,
      chatId: event.message.chat_id,
      chatType: event.message.chat_type,
      messageId: event.message.message_id,
      senderOpenId: event.sender.sender_id.open_id ?? event.sender.sender_id.user_id,
      text,
      threadId: event.message.root_id ?? event.message.thread_id,
    };

    const command = parseCommand(inboundMessage.text);
    const currentState = this.sessionStore.get(conversationKey);
    const activeCwd = this.getActiveCwd(currentState);
    if (command.type === "help") {
      const helpText = this.buildHelpReply(command.topic);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: helpText,
      });
      return;
    }
    if (command.type === "reset") {
      this.sessionStore.delete(conversationKey);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: "会话已重置。",
      });
      return;
    }
    if (command.type === "cwd_show") {
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text:
          `当前工作目录：${activeCwd}\n` +
          `默认工作目录：${this.config.runtime.defaultCwd}\n` +
          `允许根目录：${this.formatAllowedRoots()}\n` +
          `${this.renderGeneralCommandHint()}`,
      });
      return;
    }
    if (command.type === "cwd_reset") {
      const nextState: ConversationState = {
        ...currentState,
        backendCwd: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(conversationKey, nextState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: `工作目录已重置为默认：${this.config.runtime.defaultCwd}`,
      });
      return;
    }
    if (command.type === "cwd_set") {
      const resolved = this.resolveCommandCwd(command.rawPath, activeCwd);
      if (!resolved.ok) {
        await this.replyWithFallback({
          chatId: inboundMessage.chatId,
          replyToMessageId: inboundMessage.messageId,
          replyInThread: Boolean(inboundMessage.threadId),
          text: `设置工作目录失败：${resolved.reason}`,
        });
        return;
      }
      const nextState: ConversationState = {
        ...currentState,
        backendCwd: resolved.cwd,
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(conversationKey, nextState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: `工作目录已更新：${resolved.cwd}`,
      });
      return;
    }
    if (command.type === "backend") {
      if (!this.config.backends[command.backendId]) {
        await this.replyWithFallback({
          chatId: inboundMessage.chatId,
          replyToMessageId: inboundMessage.messageId,
          replyInThread: Boolean(inboundMessage.threadId),
          text: `未找到后端 ${command.backendId}。可用后端：${Object.keys(this.config.backends).join(", ")}`,
        });
        return;
      }
      const nextState: ConversationState = {
        backendId: command.backendId,
        backendSessionId: undefined,
        backendCodexHome: currentState?.backendCodexHome,
        backendModel: currentState?.backendModel,
        planModeEnabled: currentState?.planModeEnabled,
        dangerSandboxAutoApprove: currentState?.dangerSandboxAutoApprove,
        backendCwd: currentState?.backendCwd,
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(conversationKey, nextState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: `已切换后端为 ${command.backendId}，并重置会话。`,
      });
      return;
    }
    if (command.type === "model_show") {
      const selectedModel = currentState?.backendModel?.trim();
      const runtimeDefaultModel = this.config.runtime.defaultModel?.trim();
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text:
          `当前会话模型：${selectedModel ?? "(未设置)"}\n` +
          `全局默认模型：${runtimeDefaultModel ?? "(未设置)"}\n` +
          "设置命令：/model <模型名>\n" +
          "清除命令：/model reset",
      });
      return;
    }
    if (command.type === "model_set") {
      const nextState: ConversationState = {
        ...currentState,
        backendModel: command.model.trim(),
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(conversationKey, nextState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: `当前会话模型已设置为：${command.model.trim()}`,
      });
      return;
    }
    if (command.type === "model_reset") {
      const nextState: ConversationState = {
        ...currentState,
        backendModel: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(conversationKey, nextState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: "当前会话模型已清除，将使用全局默认模型。",
      });
      return;
    }
    if (command.type === "plan_show") {
      const enabled = currentState?.planModeEnabled === true;
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text:
          `当前会话 Plan Mode：${enabled ? "开启" : "关闭"}\n` +
          "开启命令：/plan on\n" +
          "关闭命令：/plan off",
      });
      return;
    }
    if (command.type === "plan_invalid") {
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: `plan 参数无效：${command.raw}\n用法：/plan on | /plan off`,
      });
      return;
    }
    if (command.type === "plan_set") {
      const nextState: ConversationState = {
        ...currentState,
        planModeEnabled: command.enabled,
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(conversationKey, nextState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: `当前会话 Plan Mode 已${command.enabled ? "开启" : "关闭"}。`,
      });
      return;
    }
    if (command.type === "history_list") {
      const historyText = await this.buildHistoryReply(command.limit);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: historyText,
      });
      return;
    }
    if (command.type === "context_show") {
      const statusText = await this.buildContextStatusReply(currentState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: statusText,
      });
      return;
    }
    if (command.type === "context_list") {
      const listText = await this.buildContextListReply(command.limit, currentState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: listText,
      });
      return;
    }
    if (command.type === "context_clear") {
      if (!currentState?.backendSessionId) {
        await this.replyWithFallback({
          chatId: inboundMessage.chatId,
          replyToMessageId: inboundMessage.messageId,
          replyInThread: Boolean(inboundMessage.threadId),
          text: "当前未绑定上下文，无需清除。",
        });
        return;
      }
      const nextState: ConversationState = {
        ...currentState,
        backendSessionId: undefined,
        backendCodexHome: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(conversationKey, nextState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: "上下文已清除，下一条消息将开启新会话。",
      });
      return;
    }
    if (command.type === "context_set") {
      const rawSessionInput = command.sessionId.trim();
      const configuredCodexHomes = this.getConfiguredCodexHomes();
      const requestedHomeIndex = command.homeIndex;
      if (
        requestedHomeIndex !== undefined &&
        (!Number.isInteger(requestedHomeIndex) ||
          requestedHomeIndex < 1 ||
          requestedHomeIndex > configuredCodexHomes.length)
      ) {
        await this.replyWithFallback({
          chatId: inboundMessage.chatId,
          replyToMessageId: inboundMessage.messageId,
          replyInThread: Boolean(inboundMessage.threadId),
          text: `home 序号无效，当前可用序号：\n${this.renderConfiguredCodexHomes()}`,
        });
        return;
      }

      const requestedCodexHome =
        requestedHomeIndex !== undefined ? configuredCodexHomes[requestedHomeIndex - 1] : undefined;
      let homesForLookup = requestedCodexHome ? [requestedCodexHome] : configuredCodexHomes;
      let selectedCodexHome = requestedCodexHome ?? this.resolveActiveCodexHome(currentState);
      const existenceHints: string[] = [];
      let targetSessionId = rawSessionInput;
      const shortIdCandidate = this.normalizeContextShortId(rawSessionInput);
      let resolvedFromShortId = false;

      if (shortIdCandidate) {
        const { matches, errors } = await this.findSessionsByShortId({
          shortId: shortIdCandidate,
          codexHomes: homesForLookup,
          limitPerHome: 300,
        });
        if (matches.length === 0) {
          await this.replyWithFallback({
            chatId: inboundMessage.chatId,
            replyToMessageId: inboundMessage.messageId,
            replyInThread: Boolean(inboundMessage.threadId),
            text:
              `未找到短ID=${shortIdCandidate} 对应的 session。\n` +
              "请先执行 /context list 查看可用短ID。",
          });
          return;
        }
        if (matches.length > 1) {
          const options = matches
            .map(
              (entry) =>
                `${this.getContextShortId({ sessionId: entry.sessionId, codexHome: entry.codexHome })} => ${entry.sessionId} (${this.getCodexHomeLabel(entry.codexHome)})`,
            )
            .join("\n");
          await this.replyWithFallback({
            chatId: inboundMessage.chatId,
            replyToMessageId: inboundMessage.messageId,
            replyInThread: Boolean(inboundMessage.threadId),
            text:
              `短ID=${shortIdCandidate} 命中了多个会话，请改用完整 sessionId 或指定 @home序号：\n` +
              `${options}`,
          });
          return;
        }
        const resolved = matches[0];
        targetSessionId = resolved.sessionId;
        selectedCodexHome = resolved.codexHome;
        resolvedFromShortId = true;
        if (!requestedCodexHome) {
          homesForLookup = [resolved.codexHome];
        }
        existenceHints.push(
          `短ID=${shortIdCandidate} 已解析为 sessionId=${targetSessionId} (${this.getCodexHomeLabel(selectedCodexHome)})`,
        );
        if (errors.length > 0) {
          existenceHints.push(`短ID检索告警：${errors.join(" | ")}`);
        }
      }

      if (homesForLookup.length > 0) {
        const { matchedHomes, errors } = await this.findSessionMatchesAcrossHomes(
          targetSessionId,
          homesForLookup,
        );
        if (!resolvedFromShortId && !requestedCodexHome && matchedHomes.length > 1) {
          const options = matchedHomes
            .map((entry) => `${this.getCodexHomeLabel(entry)} => ${entry}`)
            .join("\n");
          await this.replyWithFallback({
            chatId: inboundMessage.chatId,
            replyToMessageId: inboundMessage.messageId,
            replyInThread: Boolean(inboundMessage.threadId),
            text:
              `在多个 CODEX_HOME 中都找到 sessionId=${targetSessionId}，请指定 home 序号：\n` +
              `${options}\n` +
              "示例：/context use <短ID或sessionId> @1",
          });
          return;
        }
        if (matchedHomes.length > 0) {
          selectedCodexHome = matchedHomes[0];
          existenceHints.push(`已在 ${this.getCodexHomeLabel(selectedCodexHome)} 中确认该 session。`);
        } else if (requestedCodexHome) {
          selectedCodexHome = requestedCodexHome;
          existenceHints.push(
            `未在指定目录中找到该 session，仍按 ${requestedCodexHome} 写入上下文（可能是较早会话）。`,
          );
        } else if (selectedCodexHome) {
          existenceHints.push(
            `未在已配置目录中找到该 session，已使用当前目录：${selectedCodexHome}`,
          );
        } else {
          existenceHints.push("未在已配置目录中找到该 session，且当前没有可用 CODEX_HOME。");
        }
        if (errors.length > 0) {
          existenceHints.push(`历史校验告警：${errors.join(" | ")}`);
        }
      } else {
        existenceHints.push("当前未配置可用 CODEX_HOME，已仅写入 sessionId。");
      }

      const nextState: ConversationState = {
        ...currentState,
        backendSessionId: targetSessionId,
        backendCodexHome: selectedCodexHome,
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(conversationKey, nextState);
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text:
          `已切换上下文到 sessionId=${targetSessionId}\n` +
          `${selectedCodexHome ? `短ID=${this.getContextShortId({ sessionId: targetSessionId, codexHome: selectedCodexHome })}\n` : ""}` +
          `${selectedCodexHome ? `CODEX_HOME=${selectedCodexHome} (${this.getCodexHomeLabel(selectedCodexHome)})\n` : ""}` +
          `${existenceHints.join("\n")}\n` +
          "如需查看可切换列表：/context list",
      });
      return;
    }

    if (!this.config.runtime.autoRunBackend) {
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: "autoRunBackend 已关闭，当前不会自动调用 CLI 后端。",
      });
      return;
    }

    const backendId = currentState?.backendId ?? this.config.runtime.defaultBackendId;
    const profile = this.config.backends[backendId];
    if (!profile) {
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: `后端配置 ${backendId} 不存在。`,
      });
      return;
    }

    const activeCodexHome = this.resolveActiveCodexHome(currentState);

    await this.runBackendAndReply({
      inboundMessage,
      conversationKey,
      profile,
      existingState: currentState,
      backendId,
      activeCwd,
      activeCodexHome,
    });
  }

  private async runBackendAndReply(params: {
    inboundMessage: FeishuInboundMessage;
    conversationKey: string;
    profile: CliBackendProfile;
    existingState?: ConversationState;
    backendId: string;
    activeCwd: string;
    activeCodexHome?: string;
    backendEnv?: NodeJS.ProcessEnv;
  }): Promise<void> {
    const {
      inboundMessage,
      conversationKey,
      profile,
      existingState,
      backendId,
      activeCwd,
      activeCodexHome,
      backendEnv,
    } = params;
    const startedAt = Date.now();
    const initialSessionId = existingState?.backendSessionId;
    const resolvedModel = existingState?.backendModel?.trim() || this.config.runtime.defaultModel;
    const planModeEnabled = existingState?.planModeEnabled === true;
    let dangerSandboxAutoApprove = existingState?.dangerSandboxAutoApprove === true;
    const effectivePrompt = planModeEnabled
      ? `${PLAN_MODE_PROMPT_PREFIX}\n\n用户请求：\n${inboundMessage.text}`
      : inboundMessage.text;
    console.log(
      `[bridge] backend start: backendId=${backendId}, profileCommand=${profile.command}, messageId=${inboundMessage.messageId}, sessionId=${initialSessionId ?? "none"}, cwd=${activeCwd}, codexHome=${activeCodexHome ?? "none"}, model=${resolvedModel ?? "none"}, planMode=${planModeEnabled ? "on" : "off"}`,
    );
    try {
      const codexApprovalEnabled = this.profileLooksLikeCodex(profile);
      const executeTurn = async (
        sessionId: string | undefined,
        forceDangerSandbox: boolean,
      ) =>
        await runCliBackendTurn({
          profile,
          prompt: effectivePrompt,
          sessionId,
          model: resolvedModel,
          timeoutMs: this.config.runtime.cliTimeoutMs,
          cwd: activeCwd,
          env: backendEnv,
          forceDangerSandbox,
          dangerSandboxFallbackMode: forceDangerSandbox
            ? "disabled"
            : codexApprovalEnabled
              ? "require-approval"
              : "auto",
        });

      const executeWithStaleSessionFallback = async (forceDangerSandbox: boolean) => {
        try {
          return await executeTurn(initialSessionId, forceDangerSandbox);
        } catch (error) {
          if (!initialSessionId || !isStaleResumeError(error)) {
            throw error;
          }
          console.warn(
            `[bridge] stale session detected, retrying without session: messageId=${inboundMessage.messageId}, oldSessionId=${initialSessionId}`,
          );
          return await executeTurn(undefined, forceDangerSandbox);
        }
      };

      let result;
      try {
        result = await executeWithStaleSessionFallback(false);
      } catch (error) {
        if (!(error instanceof CliDangerSandboxApprovalRequiredError) || !codexApprovalEnabled) {
          throw error;
        }
        console.log(
          `[bridge] codex danger sandbox approval required: messageId=${inboundMessage.messageId}, backendId=${backendId}`,
        );
        const approval = dangerSandboxAutoApprove
          ? ({ decision: "approve", autoApproveFuture: true } satisfies ApprovalDecision)
          : await this.requestDangerSandboxApproval({
              inboundMessage,
              backendId,
              activeCwd,
              sessionId: initialSessionId,
              prompt: effectivePrompt,
            });
        if (approval.autoApproveFuture) {
          dangerSandboxAutoApprove = true;
        }
        if (approval.decision !== "approve") {
          const rejectedText =
            approval.decision === "timeout"
              ? "Codex 权限申请已超时，未执行 Full Access。"
              : "已拒绝本次 Codex 权限申请，未执行 Full Access。";
          await this.replyWithFallback({
            chatId: inboundMessage.chatId,
            replyToMessageId: inboundMessage.messageId,
            replyInThread: Boolean(inboundMessage.threadId),
            text: rejectedText,
          });
          return;
        }
        try {
          result = await executeWithStaleSessionFallback(true);
        } catch (dangerError) {
          if (!initialSessionId || !isWindowsSandboxSetupRefreshError(dangerError)) {
            throw dangerError;
          }
          console.warn(
            `[bridge] danger sandbox resume refresh failed, retry without session: messageId=${inboundMessage.messageId}, oldSessionId=${initialSessionId}`,
          );
          result = await executeTurn(undefined, true);
        }
      }

      const replyText = result.text?.trim() || "(无输出)";
      const resolvedImageRefs = this.resolveImageRefs(result.imageRefs, activeCwd);
      console.log(
        `[bridge] backend success: backendId=${backendId}, messageId=${inboundMessage.messageId}, elapsedMs=${Date.now() - startedAt}, replyLength=${replyText.length}, images=${resolvedImageRefs.length}, nextSessionId=${result.sessionId ?? "none"}`,
      );
      if (replyText !== "(无输出)" || resolvedImageRefs.length === 0) {
        await this.replyWithFallback({
          chatId: inboundMessage.chatId,
          replyToMessageId: inboundMessage.messageId,
          replyInThread: Boolean(inboundMessage.threadId),
          text: replyText,
        });
      }
      if (resolvedImageRefs.length > 0) {
        const imageResult = await this.forwardImageRefsToFeishu({
          chatId: inboundMessage.chatId,
          replyToMessageId: inboundMessage.messageId,
          replyInThread: Boolean(inboundMessage.threadId),
          imageRefs: resolvedImageRefs,
        });
        if (imageResult.failed > 0) {
          await this.replyWithFallback({
            chatId: inboundMessage.chatId,
            replyToMessageId: undefined,
            replyInThread: Boolean(inboundMessage.threadId),
            text: `图片转发完成：成功 ${imageResult.sent}，失败 ${imageResult.failed}`,
          });
        }
      }

      const nextState: ConversationState = {
        backendId,
        backendSessionId: result.sessionId ?? existingState?.backendSessionId,
        backendCodexHome: activeCodexHome ?? existingState?.backendCodexHome,
        backendModel: existingState?.backendModel,
        planModeEnabled: existingState?.planModeEnabled,
        dangerSandboxAutoApprove,
        backendCwd: activeCwd,
        updatedAt: new Date().toISOString(),
        lastTarget: {
          accountId: inboundMessage.accountId,
          to: inboundMessage.chatId,
          replyToMessageId: inboundMessage.messageId,
          replyInThread: Boolean(inboundMessage.threadId),
          threadId: inboundMessage.threadId,
        },
      };
      this.sessionStore.set(conversationKey, nextState);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      console.error(
        `[bridge] backend failed: backendId=${backendId}, messageId=${inboundMessage.messageId}, elapsedMs=${Date.now() - startedAt}, error=${err}`,
      );
      await this.replyWithFallback({
        chatId: inboundMessage.chatId,
        replyToMessageId: inboundMessage.messageId,
        replyInThread: Boolean(inboundMessage.threadId),
        text: `调用后端失败：${err}`,
      });
    }
  }

  private async replyWithFallback(params: {
    chatId: string;
    text: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
  }): Promise<void> {
    const chunks = chunkText(params.text);
    console.log(
      `[bridge] reply start: chatId=${params.chatId}, replyTo=${params.replyToMessageId ?? "none"}, chunks=${chunks.length}, replyInThread=${params.replyInThread === true ? "true" : "false"}`,
    );
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const shouldUseReply = index === 0 && params.replyToMessageId;
      if (shouldUseReply) {
        try {
          await this.feishuClient.im.message.reply({
            path: { message_id: params.replyToMessageId! },
            data: {
              msg_type: "text",
              content: JSON.stringify({ text: chunk }),
              ...(params.replyInThread ? { reply_in_thread: true } : {}),
            },
          });
          console.log(`[bridge] reply via message.reply success: chunk=${index + 1}/${chunks.length}`);
          continue;
        } catch (error) {
          console.warn(`[bridge] message.reply failed, fallback to create: ${String(error)}`);
        }
      }
      await this.feishuClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: params.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      });
      console.log(`[bridge] reply via message.create success: chunk=${index + 1}/${chunks.length}`);
    }
  }
}

async function main(): Promise<void> {
  const startupOptions = parseStartupOptions(process.argv.slice(2));
  if (startupOptions.showHelp) {
    console.log(renderStartupHelp());
    return;
  }

  const config = await loadConfig(startupOptions);
  if (startupOptions.setupOnly) {
    console.log("[bridge] 飞书扫码配对完成，已保存凭证。当前为 setup-only 模式，程序退出。");
    return;
  }
  const app = new FeishuCliBridgeApp(config);
  await app.start();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
