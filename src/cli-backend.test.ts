import { describe, expect, it } from "vitest";
import {
  CliDangerSandboxApprovalRequiredError,
  parseCliOutput,
  parseJsonlOutput,
  runCliBackendTurn,
  type CliBackendProfile,
} from "./cli-backend.js";

describe("parseJsonlOutput", () => {
  it("parses codex jsonl reply text and thread id", () => {
    const profile: CliBackendProfile = {
      id: "codex-cli",
      command: "codex",
      output: "jsonl",
      sessionIdFields: ["thread_id"],
    };
    const raw = [
      '{"type":"thread.started","thread_id":"thread_123"}',
      '{"type":"item.completed","item":{"type":"message","text":"hello from codex"}}',
    ].join("\n");
    const parsed = parseJsonlOutput(raw, profile);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe("thread_123");
    expect(parsed?.text).toContain("hello from codex");
  });

  it("extracts image refs from codex jsonl payload", () => {
    const profile: CliBackendProfile = {
      id: "codex-cli",
      command: "codex",
      output: "jsonl",
      sessionIdFields: ["thread_id"],
    };
    const raw = [
      '{"type":"thread.started","thread_id":"thread_888"}',
      '{"type":"item.completed","item":{"type":"image","image_path":"outputs/render.png"}}',
      '{"type":"item.completed","item":{"type":"message","text":"done ![img](outputs/final.webp)"}}',
    ].join("\n");
    const parsed = parseJsonlOutput(raw, profile);
    expect(parsed).not.toBeNull();
    expect(parsed?.imageRefs).toEqual(expect.arrayContaining(["outputs/render.png", "outputs/final.webp"]));
  });

  it("parses claude stream-json final result", () => {
    const profile: CliBackendProfile = {
      id: "claude-cli",
      command: "claude",
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      sessionIdFields: ["session_id"],
    };
    const raw = [
      '{"type":"stream_event","session_id":"sess_1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}}',
      '{"type":"result","session_id":"sess_1","result":"final answer"}',
    ].join("\n");
    const parsed = parseJsonlOutput(raw, profile);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe("sess_1");
    expect(parsed?.text).toBe("final answer");
  });
});

describe("parseCliOutput", () => {
  it("falls back to text mode", () => {
    const profile: CliBackendProfile = {
      id: "text",
      command: "echo",
      output: "text",
    };
    const parsed = parseCliOutput("  hello  ", profile);
    expect(parsed.text).toBe("hello");
  });
});

describe("runCliBackendTurn", () => {
  const itWindows = process.platform === "win32" ? it : it.skip;

  it("supports stdin input and json output", async () => {
    const profile: CliBackendProfile = {
      id: "node-test",
      command: process.execPath,
      args: [
        "-e",
        "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({text:b.trim(),session_id:'s-stdin'}));});",
      ],
      input: "stdin",
      output: "json",
      sessionIdFields: ["session_id"],
      sessionMode: "none",
    };
    const result = await runCliBackendTurn({
      profile,
      prompt: "ping from stdin",
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("ping from stdin");
    expect(result.sessionId).toBe("s-stdin");
  });

  it("retries with stdin when cli asks for additional stdin", async () => {
    const profile: CliBackendProfile = {
      id: "node-stdin-fallback",
      command: process.execPath,
      args: [
        "-e",
        "const hasArg=process.argv.length>1;if(hasArg){process.stderr.write('Reading additional input from stdin...');process.exit(1);}let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({text:b.trim(),session_id:'s-fallback'}));});",
      ],
      input: "arg",
      output: "json",
      sessionIdFields: ["session_id"],
      sessionMode: "none",
    };
    const result = await runCliBackendTurn({
      profile,
      prompt: "ping via fallback",
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("ping via fallback");
    expect(result.sessionId).toBe("s-fallback");
  });

  itWindows("retries codex with danger-full-access on windows sandbox runner failure", async () => {
    const profile: CliBackendProfile = {
      id: "codex-cli",
      command: process.execPath,
      args: [
        "-e",
        "const hasBypass=process.argv.includes('--dangerously-bypass-approvals-and-sandbox');if(!hasBypass){process.stderr.write('windows sandbox: runner error: CreateProcessAsUserW failed: 5');process.exit(1);}process.stdout.write(JSON.stringify({text:'sandbox retry ok',thread_id:'thread-danger'}));",
        "--",
        "--sandbox",
        "workspace-write",
      ],
      input: "arg",
      output: "json",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
    };
    const result = await runCliBackendTurn({
      profile,
      prompt: "trigger sandbox fallback",
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("sandbox retry ok");
    expect(result.sessionId).toBe("thread-danger");
  });

  itWindows("retries codex when command_execution failed in jsonl but exit code is zero", async () => {
    const profile: CliBackendProfile = {
      id: "codex-cli",
      command: process.execPath,
      args: [
        "-e",
        "const hasBypass=process.argv.includes('--dangerously-bypass-approvals-and-sandbox');const out=(line)=>process.stdout.write(`${line}\\n`);if(!hasBypass){out(JSON.stringify({type:'thread.started',thread_id:'thread-jsonl'}));out(JSON.stringify({type:'item.completed',item:{type:'command_execution',status:'failed',exit_code:-1,aggregated_output:'execution error: Io(Custom { kind: Other, error: \"windows sandbox: runner error: CreateProcessAsUserW failed: 5\" })'}}));out(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'first run failed'}}));process.exit(0);}out(JSON.stringify({type:'thread.started',thread_id:'thread-jsonl'}));out(JSON.stringify({type:'item.completed',item:{type:'command_execution',status:'completed',exit_code:0,aggregated_output:'ok'}}));out(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'second run succeeded'}}));",
        "--",
        "--sandbox",
        "workspace-write",
      ],
      input: "arg",
      output: "jsonl",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
    };
    const result = await runCliBackendTurn({
      profile,
      prompt: "trigger jsonl fallback",
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("second run succeeded");
    expect(result.sessionId).toBe("thread-jsonl");
  });

  itWindows("retries with windows.sandbox=unelevated before danger-full-access", async () => {
    const profile: CliBackendProfile = {
      id: "codex-cli",
      command: process.execPath,
      args: [
        "-e",
        "const hasUnelevated=process.argv.includes('windows.sandbox=\"unelevated\"');if(!hasUnelevated){process.stderr.write('windows sandbox: setup refresh failed with status exit code: 1');process.exit(1);}process.stdout.write(JSON.stringify({text:'unelevated retry ok',thread_id:'thread-unelevated'}));",
        "--",
        "--sandbox",
        "workspace-write",
      ],
      input: "arg",
      output: "json",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
    };
    const result = await runCliBackendTurn({
      profile,
      prompt: "trigger unelevated fallback",
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("unelevated retry ok");
    expect(result.sessionId).toBe("thread-unelevated");
  });

  itWindows("reports approval required when danger fallback mode is require-approval", async () => {
    const profile: CliBackendProfile = {
      id: "codex-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('windows sandbox: runner error: CreateProcessAsUserW failed: 5');process.exit(1);",
        "--",
        "--sandbox",
        "workspace-write",
      ],
      input: "arg",
      output: "json",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
    };

    await expect(
      runCliBackendTurn({
        profile,
        prompt: "need approval",
        dangerSandboxFallbackMode: "require-approval",
      }),
    ).rejects.toBeInstanceOf(CliDangerSandboxApprovalRequiredError);
  });

  itWindows("reports approval required for windows sandbox setup refresh failure", async () => {
    const profile: CliBackendProfile = {
      id: "codex-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('windows sandbox: setup refresh failed with status exit code: 1');process.exit(1);",
        "--",
        "--sandbox",
        "workspace-write",
      ],
      input: "arg",
      output: "json",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
    };

    await expect(
      runCliBackendTurn({
        profile,
        prompt: "need approval",
        dangerSandboxFallbackMode: "require-approval",
      }),
    ).rejects.toBeInstanceOf(CliDangerSandboxApprovalRequiredError);
  });

  itWindows("reports approval required for windows sandbox Logon SID token failure", async () => {
    const profile: CliBackendProfile = {
      id: "codex-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('windows sandbox :Logon SID not present on token');process.exit(1);",
        "--",
        "--sandbox",
        "workspace-write",
      ],
      input: "arg",
      output: "json",
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
    };

    await expect(
      runCliBackendTurn({
        profile,
        prompt: "need approval",
        dangerSandboxFallbackMode: "require-approval",
      }),
    ).rejects.toBeInstanceOf(CliDangerSandboxApprovalRequiredError);
  });
});
