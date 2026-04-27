import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type CliOutputMode = "json" | "jsonl" | "text";
export type CliInputMode = "arg" | "stdin";
export type CliSessionMode = "always" | "existing" | "none";
export type CliJsonlDialect = "claude-stream-json";

export type CliBackendProfile = {
  id: string;
  command: string;
  args?: string[];
  resumeArgs?: string[];
  output?: CliOutputMode;
  resumeOutput?: CliOutputMode;
  input?: CliInputMode;
  maxPromptArgChars?: number;
  env?: Record<string, string>;
  modelArg?: string;
  sessionArg?: string;
  sessionArgs?: string[];
  sessionMode?: CliSessionMode;
  sessionIdFields?: string[];
  jsonlDialect?: CliJsonlDialect;
};

export type CliBackendProfileMap = Record<string, CliBackendProfile>;

export type CliOutput = {
  text: string;
  sessionId?: string;
  rawText?: string;
  imageRefs?: string[];
};

export type CliBackendRunResult = CliOutput & {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type DangerSandboxFallbackMode = "auto" | "require-approval" | "disabled";

export class CliDangerSandboxApprovalRequiredError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(params: {
    message: string;
    stdout: string;
    stderr: string;
    exitCode: number;
  }) {
    super(params.message);
    this.name = "CliDangerSandboxApprovalRequiredError";
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.exitCode = params.exitCode;
  }
}

const CLAUDE_SESSION_FIELDS = ["session_id", "sessionId"] as const;
const CODEX_SESSION_FIELDS = ["thread_id", "threadId"] as const;

export const DEFAULT_CLI_BACKEND_PROFILES: CliBackendProfileMap = {
  "codex-cli": {
    id: "codex-cli",
    command: "codex",
    args: [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
    ],
    resumeArgs: [
      "exec",
      "resume",
      "--json",
      "{sessionId}",
      "-c",
      'sandbox_mode="workspace-write"',
      "--skip-git-repo-check",
    ],
    output: "jsonl",
    resumeOutput: "jsonl",
    input: "arg",
    modelArg: "--model",
    sessionMode: "existing",
    sessionIdFields: [...CODEX_SESSION_FIELDS],
  },
  "claude-cli": {
    id: "claude-cli",
    command: "claude",
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      "user",
      "--permission-mode",
      "bypassPermissions",
    ],
    resumeArgs: [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      "user",
      "--permission-mode",
      "bypassPermissions",
      "--resume",
      "{sessionId}",
    ],
    output: "jsonl",
    input: "stdin",
    modelArg: "--model",
    sessionArg: "--session-id",
    sessionMode: "always",
    sessionIdFields: [...CLAUDE_SESSION_FIELDS],
    jsonlDialect: "claude-stream-json",
  },
};

type RunCliBackendTurnParams = {
  profile: CliBackendProfile;
  prompt: string;
  sessionId?: string;
  model?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  dangerSandboxFallbackMode?: DangerSandboxFallbackMode;
  forceDangerSandbox?: boolean;
};

type CliSpawnPlan = {
  command: string;
  argsPrefix: string[];
};

type CliExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const WINDOWS_SANDBOX_RUNNER_FAILURE_PATTERN =
  /windows sandbox: runner error: createprocessasuserw failed:\s*\d+/i;
const WINDOWS_SANDBOX_SETUP_REFRESH_FAILURE_PATTERN =
  /windows sandbox\s*:?\s*setup refresh failed/i;
const WINDOWS_SANDBOX_LOGON_SID_FAILURE_PATTERN =
  /windows sandbox\s*:?\s*logon sid not present on token/i;

function isWindowsSandboxFailureText(raw: string): boolean {
  return (
    WINDOWS_SANDBOX_RUNNER_FAILURE_PATTERN.test(raw) ||
    WINDOWS_SANDBOX_SETUP_REFRESH_FAILURE_PATTERN.test(raw) ||
    WINDOWS_SANDBOX_LOGON_SID_FAILURE_PATTERN.test(raw)
  );
}

function hasPathSeparator(input: string): boolean {
  return input.includes("/") || input.includes("\\");
}

function collectSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = [];
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  if (rawPath) {
    for (const part of rawPath.split(path.delimiter)) {
      const trimmed = part.trim();
      if (trimmed) {
        dirs.push(trimmed);
      }
    }
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim();
    const userProfile = env.USERPROFILE?.trim();
    if (appData) {
      dirs.push(path.join(appData, "npm"));
    }
    if (userProfile) {
      dirs.push(path.join(userProfile, "AppData", "Roaming", "npm"));
    }
  }
  return Array.from(new Set(dirs));
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveCliCommandFromPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  if (hasPathSeparator(trimmed) || path.isAbsolute(trimmed)) {
    return fileExists(trimmed) ? trimmed : undefined;
  }

  const searchDirs = collectSearchDirs(env);
  if (process.platform === "win32") {
    const ext = path.extname(trimmed).toLowerCase();
    const candidates =
      ext.length > 0
        ? [trimmed]
        : [`${trimmed}.cmd`, `${trimmed}.exe`, `${trimmed}.bat`, trimmed];
    for (const dir of searchDirs) {
      for (const candidate of candidates) {
        const fullPath = path.join(dir, candidate);
        if (fileExists(fullPath)) {
          return fullPath;
        }
      }
    }
    return undefined;
  }

  for (const dir of searchDirs) {
    const fullPath = path.join(dir, trimmed);
    if (fileExists(fullPath)) {
      return fullPath;
    }
  }
  return undefined;
}

function resolveCliSpawnPlan(command: string, env: NodeJS.ProcessEnv): CliSpawnPlan {
  const resolved = resolveCliCommandFromPath(command, env) ?? command;
  if (process.platform !== "win32") {
    return { command: resolved, argsPrefix: [] };
  }

  const lowerResolved = resolved.toLowerCase();
  if (!lowerResolved.endsWith("\\codex.cmd") && !lowerResolved.endsWith("/codex.cmd")) {
    return { command: resolved, argsPrefix: [] };
  }

  const shimDir = path.dirname(resolved);
  const codexJs = path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  if (fileExists(codexJs)) {
    return { command: process.execPath, argsPrefix: [codexJs] };
  }
  return { command: resolved, argsPrefix: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSessionIdForRun(params: {
  profile: CliBackendProfile;
  existingSessionId?: string;
}): { sessionId?: string; isNew: boolean } {
  const existing = params.existingSessionId?.trim();
  const mode = params.profile.sessionMode ?? "always";
  if (mode === "none") {
    return { sessionId: undefined, isNew: !existing };
  }
  if (mode === "existing") {
    return { sessionId: existing, isNew: !existing };
  }
  if (existing) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: crypto.randomUUID(), isNew: true };
}

function resolvePromptInput(params: {
  profile: CliBackendProfile;
  prompt: string;
}): { promptArg?: string; stdin?: string } {
  const mode = params.profile.input ?? "arg";
  if (mode === "stdin") {
    return { stdin: params.prompt };
  }
  if (
    typeof params.profile.maxPromptArgChars === "number" &&
    params.profile.maxPromptArgChars > 0 &&
    params.prompt.length > params.profile.maxPromptArgChars
  ) {
    return { stdin: params.prompt };
  }
  return { promptArg: params.prompt };
}

function replaceSessionPlaceholders(args: string[], sessionId?: string): string[] {
  return args.map((arg) => arg.replaceAll("{sessionId}", sessionId ?? ""));
}

function appendPromptArg(args: string[], promptArg?: string): string[] {
  if (promptArg === undefined) {
    return args;
  }
  let replaced = false;
  const next = args.map((arg) => {
    if (arg === "{prompt}") {
      replaced = true;
      return promptArg;
    }
    return arg;
  });
  if (!replaced) {
    next.push(promptArg);
  }
  return next;
}

function readSessionIdFromRecord(
  record: Record<string, unknown>,
  profile: CliBackendProfile,
): string | undefined {
  const keys = [
    ...(profile.sessionIdFields ?? []),
    "thread_id",
    "threadId",
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function collectText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.result === "string") {
    return value.result;
  }
  if (typeof value.response === "string") {
    return value.response;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectText(entry)).join("");
  }
  if (isRecord(value.message)) {
    return collectText(value.message);
  }
  if (isRecord(value.item)) {
    return collectText(value.item);
  }
  return "";
}

const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|svg)(\?.*)?$/i;

function isLikelyImageRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("data:image/")) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return IMAGE_EXT_PATTERN.test(trimmed);
  }
  return IMAGE_EXT_PATTERN.test(trimmed);
}

function collectImageRefsFromText(text: string): string[] {
  const refs: string[] = [];
  const markdownPattern = /!\[[^\]]*]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownPattern.exec(text)) !== null) {
    const ref = match[1]?.trim();
    if (ref && isLikelyImageRef(ref)) {
      refs.push(ref);
    }
  }
  return refs;
}

function collectImageRefs(value: unknown): string[] {
  const refs: string[] = [];
  const visit = (input: unknown, parentKey?: string) => {
    if (typeof input === "string") {
      const normalized = input.trim();
      if (!normalized) {
        return;
      }
      const key = parentKey?.toLowerCase();
      if (
        key &&
        ["image", "imageurl", "image_url", "imagepath", "image_path", "path", "url", "uri"].includes(
          key,
        ) &&
        isLikelyImageRef(normalized)
      ) {
        refs.push(normalized);
      }
      if (isLikelyImageRef(normalized) && normalized.includes(path.sep)) {
        refs.push(normalized);
      }
      for (const found of collectImageRefsFromText(normalized)) {
        refs.push(found);
      }
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input) {
        visit(item, parentKey);
      }
      return;
    }
    if (!isRecord(input)) {
      return;
    }
    for (const [key, nested] of Object.entries(input)) {
      visit(nested, key);
    }
  };
  visit(value);
  return refs;
}

function parseJsonObjects(raw: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const trimmed = raw.trim();
  if (!trimmed) {
    return results;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      results.push(parsed);
      return results;
    }
  } catch {
    // Keep scanning fallback.
  }

  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) {
        results.push(parsed);
      }
    } catch {
      // Ignore malformed line.
    }
  }
  return results;
}

function shouldRetryWithStdin(params: {
  profile: CliBackendProfile;
  promptArg?: string;
  stdin?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}): boolean {
  if (params.exitCode === 0) {
    return false;
  }
  if (params.stdin !== undefined || params.promptArg === undefined) {
    return false;
  }
  if (params.profile.input === "stdin") {
    return false;
  }
  const combined = `${params.stderr}\n${params.stdout}`.toLowerCase();
  return combined.includes("reading additional input from stdin");
}

function profileLooksLikeCodex(profile: CliBackendProfile): boolean {
  const command = profile.command.trim().toLowerCase();
  const profileId = profile.id.trim().toLowerCase();
  return command.includes("codex") || profileId.includes("codex");
}

function hasWorkspaceWriteSandboxConfig(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const normalized = arg.trim().toLowerCase();
    if (normalized === "--sandbox" && args[index + 1]?.trim().toLowerCase() === "workspace-write") {
      return true;
    }
    if (
      normalized === "-c" &&
      typeof args[index + 1] === "string" &&
      /sandbox_mode\s*=\s*["']workspace-write["']/i.test(args[index + 1])
    ) {
      return true;
    }
  }
  return false;
}

function hasUnelevatedWindowsSandboxConfig(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.trim().toLowerCase() !== "-c") {
      continue;
    }
    const next = args[index + 1];
    if (typeof next !== "string") {
      continue;
    }
    if (/^\s*windows\.sandbox\s*=\s*["']?unelevated["']?\s*$/i.test(next)) {
      return true;
    }
  }
  return false;
}

function trySetWindowsSandboxMode(args: string[], mode: "unelevated" | "elevated"): string[] | null {
  let changed = false;
  const nextArgs = [...args];
  const overrideValue = `windows.sandbox="${mode}"`;

  for (let index = 0; index < nextArgs.length; index += 1) {
    const arg = nextArgs[index];
    if (arg.trim().toLowerCase() !== "-c") {
      continue;
    }
    const existing = nextArgs[index + 1];
    if (typeof existing !== "string") {
      continue;
    }
    if (/^\s*windows\.sandbox\s*=/i.test(existing)) {
      if (existing.trim().toLowerCase() === overrideValue) {
        return null;
      }
      nextArgs[index + 1] = overrideValue;
      changed = true;
      return changed ? nextArgs : null;
    }
  }

  nextArgs.push("-c", overrideValue);
  changed = true;
  return changed ? nextArgs : null;
}

function tryUpgradeSandboxArgs(args: string[]): string[] | null {
  let changed = false;
  let sawWorkspaceSandboxConfig = false;
  const nextArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const normalized = arg.trim().toLowerCase();

    if (normalized === "--sandbox" && args[index + 1]?.trim().toLowerCase() === "workspace-write") {
      sawWorkspaceSandboxConfig = true;
      changed = true;
      index += 1;
      continue;
    }

    if (
      normalized === "-c" &&
      typeof args[index + 1] === "string" &&
      /sandbox_mode\s*=\s*["']workspace-write["']/i.test(args[index + 1])
    ) {
      sawWorkspaceSandboxConfig = true;
      changed = true;
      index += 1;
      continue;
    }

    nextArgs.push(arg);
  }

  if (!sawWorkspaceSandboxConfig) {
    return null;
  }

  const hasBypassFlag = nextArgs.some(
    (entry) => entry.trim().toLowerCase() === "--dangerously-bypass-approvals-and-sandbox",
  );
  if (!hasBypassFlag) {
    nextArgs.push("--dangerously-bypass-approvals-and-sandbox");
    changed = true;
  }

  return changed ? nextArgs : null;
}

function hasWindowsSandboxCommandExecutionFailure(raw: string): boolean {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const item = isRecord(parsed.item) ? parsed.item : undefined;
    if (!item || item.type !== "command_execution") {
      continue;
    }
    const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : 0;
    const aggregatedOutput =
      typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    const failed = status === "failed" || exitCode !== 0;
    if (failed && isWindowsSandboxFailureText(aggregatedOutput)) {
      return true;
    }
  }

  return false;
}

function hasWindowsSandboxSetupRefreshFailure(raw: string): boolean {
  if (WINDOWS_SANDBOX_SETUP_REFRESH_FAILURE_PATTERN.test(raw)) {
    return true;
  }

  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const item = isRecord(parsed.item) ? parsed.item : undefined;
    if (!item || item.type !== "command_execution") {
      continue;
    }
    const aggregatedOutput =
      typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    if (WINDOWS_SANDBOX_SETUP_REFRESH_FAILURE_PATTERN.test(aggregatedOutput)) {
      return true;
    }
  }
  return false;
}

function shouldRetryWithUnelevatedWindowsSandbox(params: {
  profile: CliBackendProfile;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  if (!profileLooksLikeCodex(params.profile)) {
    return false;
  }
  if (!hasWorkspaceWriteSandboxConfig(params.args)) {
    return false;
  }
  if (hasUnelevatedWindowsSandboxConfig(params.args)) {
    return false;
  }
  if (params.exitCode === 0 && !hasWindowsSandboxCommandExecutionFailure(params.stdout)) {
    return false;
  }
  return hasWindowsSandboxSetupRefreshFailure(`${params.stderr}\n${params.stdout}`);
}

function shouldRetryWithDangerSandbox(params: {
  profile: CliBackendProfile;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  if (!profileLooksLikeCodex(params.profile)) {
    return false;
  }
  if (!hasWorkspaceWriteSandboxConfig(params.args)) {
    return false;
  }
  if (hasWindowsSandboxCommandExecutionFailure(params.stdout)) {
    return true;
  }
  if (isWindowsSandboxFailureText(params.stdout)) {
    return true;
  }
  if (params.exitCode !== 0) {
    return isWindowsSandboxFailureText(`${params.stderr}\n${params.stdout}`);
  }
  return false;
}

function parseJsonOutput(raw: string, profile: CliBackendProfile): CliOutput | null {
  const candidates = parseJsonObjects(raw);
  if (candidates.length === 0) {
    return null;
  }
  let sessionId: string | undefined;
  let text = "";
  const imageRefs = new Set<string>();
  for (const candidate of candidates) {
    sessionId = readSessionIdFromRecord(candidate, profile) ?? sessionId;
    const nextText = collectText(candidate).trim();
    if (nextText) {
      text = nextText;
    }
    for (const ref of collectImageRefs(candidate)) {
      imageRefs.add(ref);
    }
    for (const ref of collectImageRefsFromText(nextText)) {
      imageRefs.add(ref);
    }
  }
  if (!text && !sessionId && imageRefs.size === 0) {
    return null;
  }
  return { text, sessionId, rawText: raw, imageRefs: [...imageRefs] };
}

export function parseJsonlOutput(raw: string, profile: CliBackendProfile): CliOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  let sessionId: string | undefined;
  const fragments: string[] = [];
  const imageRefs = new Set<string>();

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    sessionId = readSessionIdFromRecord(parsed, profile) ?? sessionId;
    for (const ref of collectImageRefs(parsed)) {
      imageRefs.add(ref);
    }

    if (
      (profile.jsonlDialect === "claude-stream-json" || profile.id === "claude-cli") &&
      parsed.type === "result" &&
      typeof parsed.result === "string"
    ) {
      const text = parsed.result.trim();
      for (const ref of collectImageRefsFromText(text)) {
        imageRefs.add(ref);
      }
      return { text, sessionId, rawText: raw, imageRefs: [...imageRefs] };
    }

    const item = isRecord(parsed.item) ? parsed.item : undefined;
    if (item && typeof item.text === "string" && item.text.trim()) {
      fragments.push(item.text.trim());
      continue;
    }

    if (parsed.type === "assistant") {
      const assistantText = collectText(parsed.message).trim();
      if (assistantText) {
        fragments.push(assistantText);
        continue;
      }
    }

    const genericText = collectText(parsed).trim();
    if (genericText) {
      fragments.push(genericText);
      for (const ref of collectImageRefsFromText(genericText)) {
        imageRefs.add(ref);
      }
    }
  }

  const text = fragments.join("\n").trim();
  if (!text && !sessionId && imageRefs.size === 0) {
    return null;
  }
  return { text, sessionId, rawText: raw, imageRefs: [...imageRefs] };
}

export function parseCliOutput(raw: string, profile: CliBackendProfile, outputMode?: CliOutputMode) {
  const mode = outputMode ?? profile.output ?? "text";
  if (mode === "text") {
    const text = raw.trim();
    const imageRefs = collectImageRefsFromText(text);
    return { text, rawText: raw, imageRefs } satisfies CliOutput;
  }
  if (mode === "json") {
    return parseJsonOutput(raw, profile) ?? { text: raw.trim(), rawText: raw };
  }
  return parseJsonlOutput(raw, profile) ?? { text: raw.trim(), rawText: raw };
}

export async function runCliBackendTurn(params: RunCliBackendTurnParams): Promise<CliBackendRunResult> {
  const sessionInfo = resolveSessionIdForRun({
    profile: params.profile,
    existingSessionId: params.sessionId,
  });
  const shouldResume =
    Boolean(params.sessionId?.trim()) && Array.isArray(params.profile.resumeArgs);

  const baseArgs = shouldResume
    ? [...(params.profile.resumeArgs ?? [])]
    : [...(params.profile.args ?? [])];
  const args = replaceSessionPlaceholders(baseArgs, params.sessionId?.trim());

  const { promptArg, stdin } = resolvePromptInput({
    profile: params.profile,
    prompt: params.prompt,
  });

  if (params.profile.modelArg && params.model?.trim()) {
    args.push(params.profile.modelArg, params.model.trim());
  }

  if (!shouldResume && sessionInfo.sessionId) {
    if (Array.isArray(params.profile.sessionArgs) && params.profile.sessionArgs.length > 0) {
      for (const arg of params.profile.sessionArgs) {
        args.push(arg.replaceAll("{sessionId}", sessionInfo.sessionId));
      }
    } else if (params.profile.sessionArg) {
      args.push(params.profile.sessionArg, sessionInfo.sessionId);
    }
  }

  const timeoutMs = params.timeoutMs ?? 15 * 60 * 1000;
  const dangerSandboxFallbackMode = params.dangerSandboxFallbackMode ?? "auto";
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...params.env,
    ...params.profile.env,
  };
  const spawnPlan = resolveCliSpawnPlan(params.profile.command, childEnv);
  const executeOnce = async (attempt: {
    argsForRun: string[];
    promptArg?: string;
    stdin?: string;
  }): Promise<CliExecutionResult> => {
    const runArgs = appendPromptArg([...attempt.argsForRun], attempt.promptArg);
    const spawnArgs = [...spawnPlan.argsPrefix, ...runArgs];
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(spawnPlan.command, spawnArgs, {
        cwd: params.cwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, timeoutMs);

      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

      child.on("error", (error) => {
        clearTimeout(timeoutHandle);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              `CLI backend command not found: "${params.profile.command}". ` +
                `Please ensure it is installed and on PATH, or set backends.${params.profile.id}.command to an absolute executable path.`,
            ),
          );
          return;
        }
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (timedOut) {
          reject(new Error(`CLI backend timed out after ${timeoutMs}ms`));
          return;
        }
        resolve(code ?? 0);
      });

      if (attempt.stdin !== undefined) {
        child.stdin.write(attempt.stdin);
      }
      child.stdin.end();
    });

    return {
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode,
    };
  };

  const executeWithArgs = async (argsForRun: string[]): Promise<CliExecutionResult> => {
    let execution = await executeOnce({ argsForRun, promptArg, stdin });
    if (
      shouldRetryWithStdin({
        profile: params.profile,
        promptArg,
        stdin,
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
      })
    ) {
      execution = await executeOnce({ argsForRun, stdin: params.prompt });
    }
    return execution;
  };

  const initialArgs =
    params.forceDangerSandbox === true ? (tryUpgradeSandboxArgs(args) ?? args) : args;
  let execution = await executeWithArgs(initialArgs);
  const argsAfterUnelevatedRetry =
    !params.forceDangerSandbox &&
    shouldRetryWithUnelevatedWindowsSandbox({
      profile: params.profile,
      args: initialArgs,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
    })
      ? trySetWindowsSandboxMode(initialArgs, "unelevated")
      : null;
  const argsForDangerDecision = argsAfterUnelevatedRetry ?? initialArgs;
  if (argsAfterUnelevatedRetry) {
    execution = await executeWithArgs(argsAfterUnelevatedRetry);
  }
  const needDangerSandbox =
    params.forceDangerSandbox !== true &&
    shouldRetryWithDangerSandbox({
      profile: params.profile,
      args: argsForDangerDecision,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
    });
  if (needDangerSandbox) {
    if (dangerSandboxFallbackMode === "require-approval") {
      throw new CliDangerSandboxApprovalRequiredError({
        message:
          "Codex requested danger-full-access sandbox to continue. External approval is required.",
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
      });
    }
    if (dangerSandboxFallbackMode === "auto") {
      const fallbackArgs = tryUpgradeSandboxArgs(initialArgs);
      if (fallbackArgs) {
        execution = await executeWithArgs(fallbackArgs);
      }
    }
  }

  const stdout = execution.stdout;
  const stderr = execution.stderr;
  const exitCode = execution.exitCode;
  const outputMode = shouldResume
    ? params.profile.resumeOutput ?? params.profile.output
    : params.profile.output;
  const parsed = parseCliOutput(stdout, params.profile, outputMode);
  const sessionId = parsed.sessionId ?? sessionInfo.sessionId;
  const result: CliBackendRunResult = {
    text: parsed.text,
    rawText: parsed.rawText,
    imageRefs: parsed.imageRefs,
    sessionId,
    stdout,
    stderr,
    exitCode,
  };

  if (exitCode !== 0) {
    const message = [stderr.trim(), stdout.trim()]
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(`CLI backend exited with code ${exitCode}${message ? `: ${message}` : ""}`);
  }

  return result;
}
