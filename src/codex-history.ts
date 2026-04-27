import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export type CodexHistoryEntry = {
  sessionId: string;
  timestampSec: number;
  text: string;
};

export type CodexHistorySessionSummary = {
  sessionId: string;
  lastTimestampSec: number;
  lastPrompt: string;
};

const CODEX_HISTORY_FILE_NAME = "history.jsonl";
const CODEX_SESSIONS_DIR_NAME = "sessions";
const DEFAULT_HISTORY_LIMIT = 8;
const MAX_HISTORY_LIMIT = 30;
const LOCAL_CODEX_HOME_DIR_NAME = ".codex";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function parseHistoryLine(line: string): CodexHistoryEntry | undefined {
  try {
    const parsed = JSON.parse(line);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const sessionId = asNonEmptyString(parsed.session_id);
    const timestampSec = asPositiveInteger(parsed.ts);
    const text = asNonEmptyString(parsed.text);
    if (!sessionId || !timestampSec || !text) {
      return undefined;
    }
    return {
      sessionId,
      timestampSec,
      text,
    };
  } catch {
    return undefined;
  }
}

function normalizeLines(raw: string): string[] {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readHistoryLines(codexHome: string): Promise<string[]> {
  const historyPath = path.join(codexHome, CODEX_HISTORY_FILE_NAME);
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    return normalizeLines(raw);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function clampHistoryLimit(value: string | number | undefined): number {
  if (value === undefined) {
    return DEFAULT_HISTORY_LIMIT;
  }
  const source = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(source) || source <= 0) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(MAX_HISTORY_LIMIT, Math.floor(source));
}

export function resolveCodexHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.CODEX_HOME?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const userHome = env.USERPROFILE?.trim() ?? env.HOME?.trim();
  if (!userHome) {
    return undefined;
  }
  return path.resolve(userHome, LOCAL_CODEX_HOME_DIR_NAME);
}

export async function readRecentCodexHistoryEntries(params: {
  codexHome: string;
  limit: number;
}): Promise<CodexHistoryEntry[]> {
  const lines = await readHistoryLines(params.codexHome);
  if (lines.length === 0) {
    return [];
  }
  const result: CodexHistoryEntry[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseHistoryLine(lines[index]);
    if (!parsed) {
      continue;
    }
    result.push(parsed);
    if (result.length >= params.limit) {
      break;
    }
  }
  return result;
}

export async function readRecentCodexHistorySessions(params: {
  codexHome: string;
  limit: number;
}): Promise<CodexHistorySessionSummary[]> {
  const lines = await readHistoryLines(params.codexHome);
  if (lines.length === 0) {
    return [];
  }
  const result: CodexHistorySessionSummary[] = [];
  const seen = new Set<string>();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseHistoryLine(lines[index]);
    if (!parsed || seen.has(parsed.sessionId)) {
      continue;
    }
    seen.add(parsed.sessionId);
    result.push({
      sessionId: parsed.sessionId,
      lastTimestampSec: parsed.timestampSec,
      lastPrompt: parsed.text,
    });
    if (result.length >= params.limit) {
      break;
    }
  }
  return result;
}

async function hasRolloutFileForSession(params: {
  sessionsDir: string;
  sessionId: string;
}): Promise<boolean> {
  const expectedSuffix = `-${params.sessionId}.jsonl`.toLowerCase();
  const stack = [params.sessionsDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const normalizedName = entry.name.toLowerCase();
      if (normalizedName.endsWith(expectedSuffix)) {
        return true;
      }
    }
  }
  return false;
}

export async function hasLocalCodexSession(params: {
  codexHome: string;
  sessionId: string;
}): Promise<boolean> {
  const targetSessionId = params.sessionId.trim();
  if (!targetSessionId) {
    return false;
  }
  const recent = await readRecentCodexHistoryEntries({
    codexHome: params.codexHome,
    limit: 500,
  });
  if (recent.some((entry) => entry.sessionId === targetSessionId)) {
    return true;
  }
  return await hasRolloutFileForSession({
    sessionsDir: path.join(params.codexHome, CODEX_SESSIONS_DIR_NAME),
    sessionId: targetSessionId,
  });
}
