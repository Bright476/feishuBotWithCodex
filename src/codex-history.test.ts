import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clampHistoryLimit,
  hasLocalCodexSession,
  readRecentCodexHistoryEntries,
  readRecentCodexHistorySessions,
  resolveCodexHomeDir,
} from "./codex-history.js";

const tempRoots: string[] = [];

async function makeTempCodexHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-history-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("resolveCodexHomeDir", () => {
  it("prefers CODEX_HOME", () => {
    const resolved = resolveCodexHomeDir({
      CODEX_HOME: "D:/custom-codex-home",
      USERPROFILE: "C:/Users/Alice",
    });
    expect(resolved).toBe(path.resolve("D:/custom-codex-home"));
  });

  it("falls back to USERPROFILE/.codex", () => {
    const resolved = resolveCodexHomeDir({
      USERPROFILE: "C:/Users/Alice",
    });
    expect(resolved).toBe(path.resolve("C:/Users/Alice/.codex"));
  });
});

describe("codex history readers", () => {
  it("reads recent history entries in reverse chronology", async () => {
    const codexHome = await makeTempCodexHome();
    const historyPath = path.join(codexHome, "history.jsonl");
    await fs.writeFile(
      historyPath,
      [
        JSON.stringify({ session_id: "sess-1", ts: 100, text: "first prompt" }),
        "invalid-json-line",
        JSON.stringify({ session_id: "sess-2", ts: 200, text: "second prompt" }),
      ].join("\n"),
      "utf8",
    );

    const entries = await readRecentCodexHistoryEntries({
      codexHome,
      limit: 2,
    });
    expect(entries).toEqual([
      { sessionId: "sess-2", timestampSec: 200, text: "second prompt" },
      { sessionId: "sess-1", timestampSec: 100, text: "first prompt" },
    ]);
  });

  it("reads recent unique sessions", async () => {
    const codexHome = await makeTempCodexHome();
    const historyPath = path.join(codexHome, "history.jsonl");
    await fs.writeFile(
      historyPath,
      [
        JSON.stringify({ session_id: "sess-1", ts: 100, text: "first prompt" }),
        JSON.stringify({ session_id: "sess-1", ts: 101, text: "second prompt same session" }),
        JSON.stringify({ session_id: "sess-2", ts: 200, text: "another session prompt" }),
      ].join("\n"),
      "utf8",
    );

    const sessions = await readRecentCodexHistorySessions({
      codexHome,
      limit: 5,
    });
    expect(sessions).toEqual([
      { sessionId: "sess-2", lastTimestampSec: 200, lastPrompt: "another session prompt" },
      { sessionId: "sess-1", lastTimestampSec: 101, lastPrompt: "second prompt same session" },
    ]);
  });

  it("detects local codex session from rollout file", async () => {
    const codexHome = await makeTempCodexHome();
    const rolloutDir = path.join(codexHome, "sessions", "2026", "04", "20");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-2026-04-20T00-00-00-abc-session-id.jsonl"),
      "{}\n",
      "utf8",
    );

    const found = await hasLocalCodexSession({
      codexHome,
      sessionId: "abc-session-id",
    });
    expect(found).toBe(true);
  });
});

describe("clampHistoryLimit", () => {
  it("returns defaults and boundaries", () => {
    expect(clampHistoryLimit(undefined)).toBe(8);
    expect(clampHistoryLimit("not-number")).toBe(8);
    expect(clampHistoryLimit("2")).toBe(2);
    expect(clampHistoryLimit(200)).toBe(30);
  });
});
