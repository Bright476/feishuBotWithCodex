const { spawn } = require("node:child_process");
const path = require("node:path");

const projectRoot = __dirname;
const nodeExec = process.execPath;
const bridgeEntry = path.join(projectRoot, "src", "main.ts");
const restartDelayMs = Number.parseInt(process.env.FEISHU_BRIDGE_SERVICE_RESTART_MS || "5000", 10);

let child = null;
let stopping = false;

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[service-bootstrap] ${message}`);
}

function startBridge() {
  if (stopping) {
    return;
  }
  process.chdir(projectRoot);
  const childEnv = { ...process.env };
  child = spawn(nodeExec, ["--import", "tsx", bridgeEntry], {
    cwd: projectRoot,
    env: childEnv,
    stdio: "inherit",
  });
  log(`spawned bridge pid=${child.pid}`);

  child.on("exit", (code, signal) => {
    log(`bridge exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    child = null;
    if (stopping) {
      return;
    }
    const delay = Number.isFinite(restartDelayMs) && restartDelayMs > 0 ? restartDelayMs : 5000;
    setTimeout(() => {
      startBridge();
    }, delay);
  });

  child.on("error", (error) => {
    log(`bridge spawn error: ${String(error)}`);
  });
}

function stopBridge() {
  stopping = true;
  if (!child || child.killed) {
    process.exit(0);
    return;
  }
  child.once("exit", () => process.exit(0));
  try {
    child.kill("SIGTERM");
  } catch {
    process.exit(0);
  }
  setTimeout(() => {
    try {
      if (child && !child.killed) {
        child.kill("SIGKILL");
      }
    } finally {
      process.exit(0);
    }
  }, 8000).unref();
}

process.on("SIGINT", stopBridge);
process.on("SIGTERM", stopBridge);
process.on("SIGHUP", stopBridge);

startBridge();
