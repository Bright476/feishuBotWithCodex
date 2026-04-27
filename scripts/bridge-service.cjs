const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const nodeExec = process.execPath;
const bridgeEntry = path.join(projectRoot, "src", "main.ts");
const taskName = process.env.FEISHU_BRIDGE_DAEMON_TASK_NAME || "FeishuCliBridgeDaemon";
const daemonDir = path.join(projectRoot, "daemon");
const daemonPidPath = path.join(daemonDir, "feishu-cli-bridge-daemon.pid.json");
const daemonOutLog = path.join(daemonDir, "feishu-cli-bridge-daemon.out.log");
const daemonErrLog = path.join(daemonDir, "feishu-cli-bridge-daemon.err.log");

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage: node scripts/bridge-service.cjs <command>",
      "",
      "Commands:",
      "  setup       配置飞书连接（有凭证则复用，无凭证才扫码），完成后退出",
      "  rescan      强制重新扫码配置飞书连接（忽略已有凭证），完成后退出",
      "  install     安装守护进程开机自启（任务计划）并立即启动",
      "  start       启动守护进程",
      "  stop        停止守护进程",
      "  status      查看守护进程和自启任务状态",
      "  remove      删除自启任务并停止守护进程",
      "  quickstart  先 setup，再 install（开箱即用）",
    ].join("\n"),
  );
}

function ensureWindows() {
  if (process.platform === "win32") {
    return;
  }
  // eslint-disable-next-line no-console
  console.error("This command is only supported on Windows.");
  process.exit(1);
}

function runNode(args, env = process.env) {
  const result = spawnSync(nodeExec, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function runBridgeSetup() {
  return runNode(
    ["--import", "tsx", bridgeEntry, "--setup-feishu", "--setup-only"],
    {
      ...process.env,
      FEISHU_QR_ACTIVATION: "true",
      FEISHU_QR_GUI: "true",
    },
  );
}

function runBridgeRescan() {
  return runNode(
    ["--import", "tsx", bridgeEntry, "--rescan-feishu", "--setup-only"],
    {
      ...process.env,
      FEISHU_QR_ACTIVATION: "true",
      FEISHU_QR_GUI: "true",
    },
  );
}

function ensureDaemonDir() {
  fs.mkdirSync(daemonDir, { recursive: true });
}

function readDaemonPidInfo() {
  try {
    const raw = fs.readFileSync(daemonPidPath, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number.parseInt(String(parsed?.pid), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return undefined;
    }
    return {
      pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearPidFile() {
  try {
    fs.unlinkSync(daemonPidPath);
  } catch {
    // ignore
  }
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function queryLegacyWindowsService() {
  const result = spawnSync("sc.exe", ["query", "feishucodexbridge.exe"], {
    cwd: projectRoot,
    stdio: "pipe",
    env: process.env,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    return { exists: false, running: false };
  }
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`.toUpperCase();
  return {
    exists: true,
    running: combined.includes("RUNNING"),
  };
}

function blockIfLegacyServiceRunning() {
  const legacy = queryLegacyWindowsService();
  if (!legacy.running) {
    return false;
  }
  // eslint-disable-next-line no-console
  console.error(
    "[daemon] 检测到旧版 Windows Service (feishucodexbridge.exe) 正在运行。请先停止/卸载旧服务，再启动守护进程模式。",
  );
  // eslint-disable-next-line no-console
  console.error("[daemon] 旧服务卸载：node scripts/uninstall-windows-service.cjs");
  return true;
}

function listDaemonPidsByCommandLine() {
  const script =
    `$target = ${psSingleQuote(bridgeEntry.toLowerCase())}; ` +
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $cmd = ($_.CommandLine -as [string]); $cmd -and $cmd.ToLower().Contains($target) } | " +
    "ForEach-Object { $_.ProcessId }";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: projectRoot,
      stdio: "pipe",
      env: process.env,
      encoding: "utf8",
    },
  );
  if ((result.status ?? 1) !== 0) {
    return [];
  }
  return String(result.stdout || "")
    .split(/\r?\n/g)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function getActiveDaemonPid() {
  const scanned = listDaemonPidsByCommandLine();
  const pidInfo = readDaemonPidInfo();
  if (!pidInfo) {
    if (scanned.length === 0) {
      return undefined;
    }
    writePidFile(scanned[0]);
    return scanned[0];
  }
  if (isProcessAlive(pidInfo.pid) && scanned.includes(pidInfo.pid)) {
    return pidInfo.pid;
  }
  if (scanned.length === 0) {
    clearPidFile();
    return undefined;
  }
  writePidFile(scanned[0]);
  return scanned[0];
}

function writePidFile(pid) {
  ensureDaemonDir();
  const payload = {
    pid,
    startedAt: new Date().toISOString(),
    node: nodeExec,
    entry: bridgeEntry,
  };
  fs.writeFileSync(daemonPidPath, JSON.stringify(payload, null, 2), "utf8");
}

function startDaemon() {
  if (blockIfLegacyServiceRunning()) {
    return 1;
  }
  const existingPid = getActiveDaemonPid();
  if (existingPid) {
    // eslint-disable-next-line no-console
    console.log(`[daemon] already running, pid=${existingPid}`);
    return 0;
  }

  ensureDaemonDir();
  const outFd = fs.openSync(daemonOutLog, "a");
  const errFd = fs.openSync(daemonErrLog, "a");

  const child = spawn(nodeExec, ["--import", "tsx", bridgeEntry], {
    cwd: projectRoot,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || "production",
    },
    stdio: ["ignore", outFd, errFd],
  });
  child.unref();
  writePidFile(child.pid);

  // eslint-disable-next-line no-console
  console.log(`[daemon] started, pid=${child.pid}`);
  // eslint-disable-next-line no-console
  console.log(`[daemon] logs: ${daemonOutLog}`);
  return 0;
}

function stopDaemon() {
  const pids = Array.from(new Set([...(getActiveDaemonPid() ? [getActiveDaemonPid()] : []), ...listDaemonPidsByCommandLine()])).filter(
    (pid) => typeof pid === "number",
  );
  if (pids.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[daemon] not running");
    return 0;
  }

  let hasError = false;
  for (const pid of pids) {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      // eslint-disable-next-line no-console
      console.error(`[daemon] failed to stop pid=${pid}: ${String(result.error)}`);
      hasError = true;
      continue;
    }
    if ((result.status ?? 1) !== 0) {
      hasError = true;
    }
    // eslint-disable-next-line no-console
    console.log(`[daemon] stopped pid=${pid}`);
  }
  clearPidFile();
  return hasError ? 1 : 0;
}

function runSchtasks(args) {
  const result = spawnSync("schtasks.exe", args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function createAutoStartTask() {
  const taskCommand = `"${nodeExec}" "${path.join(projectRoot, "scripts", "bridge-service.cjs")}" start --from-task`;
  return runSchtasks([
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/TN",
    taskName,
    "/TR",
    taskCommand,
  ]);
}

function removeAutoStartTask() {
  return runSchtasks(["/Delete", "/F", "/TN", taskName]);
}

function queryAutoStartTask() {
  const result = spawnSync("schtasks.exe", ["/Query", "/TN", taskName], {
    cwd: projectRoot,
    stdio: "pipe",
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) {
    return { installed: false, detail: String(result.error) };
  }
  if ((result.status ?? 1) !== 0) {
    return { installed: false, detail: (result.stderr || result.stdout || "").trim() };
  }
  return { installed: true, detail: "task exists" };
}

function showStatus() {
  const pid = getActiveDaemonPid();
  const allPids = listDaemonPidsByCommandLine();
  const task = queryAutoStartTask();
  const legacy = queryLegacyWindowsService();
  if (pid) {
    // eslint-disable-next-line no-console
    console.log(`[daemon] running pid=${pid}`);
  } else {
    // eslint-disable-next-line no-console
    console.log("[daemon] not running");
  }
  if (allPids.length > 1) {
    // eslint-disable-next-line no-console
    console.log(`[daemon] warning: found multiple bridge processes: ${allPids.join(", ")}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[daemon] autostart task (${taskName}): ${task.installed ? "installed" : "not installed"}`);
  if (legacy.exists) {
    // eslint-disable-next-line no-console
    console.log(`[daemon] legacy windows service (feishucodexbridge.exe): ${legacy.running ? "running" : "installed"}`);
  }
  if (task.detail && !task.installed) {
    // eslint-disable-next-line no-console
    console.log(`[daemon] task detail: ${task.detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[daemon] logs: ${daemonOutLog}`);
  return 0;
}

async function main() {
  const command = (process.argv[2] || "help").trim().toLowerCase();

  if (command === "help" || command === "-h" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "setup") {
    process.exitCode = runBridgeSetup();
    return;
  }
  if (command === "rescan") {
    process.exitCode = runBridgeRescan();
    return;
  }

  ensureWindows();

  if (command === "quickstart") {
    const setupStatus = runBridgeSetup();
    if (setupStatus !== 0) {
      process.exitCode = setupStatus;
      return;
    }
    const installStatus = createAutoStartTask();
    if (installStatus !== 0) {
      process.exitCode = installStatus;
      return;
    }
    process.exitCode = startDaemon();
    return;
  }

  if (command === "install") {
    const installStatus = createAutoStartTask();
    if (installStatus !== 0) {
      process.exitCode = installStatus;
      return;
    }
    process.exitCode = startDaemon();
    return;
  }

  if (command === "remove") {
    const stopStatus = stopDaemon();
    const removeStatus = removeAutoStartTask();
    process.exitCode = stopStatus !== 0 ? stopStatus : removeStatus;
    return;
  }

  if (command === "start") {
    process.exitCode = startDaemon();
    return;
  }
  if (command === "stop") {
    process.exitCode = stopDaemon();
    return;
  }
  if (command === "status") {
    process.exitCode = showStatus();
    return;
  }

  printUsage();
  process.exitCode = 1;
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[bridge-service] ${String(error)}`);
  process.exit(1);
});
