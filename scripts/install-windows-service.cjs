const path = require("node:path");

if (process.platform !== "win32") {
  // eslint-disable-next-line no-console
  console.error("This command is only supported on Windows.");
  process.exit(1);
}

const { Service } = require("node-windows");

const projectRoot = path.resolve(__dirname, "..");
const serviceName = process.env.FEISHU_BRIDGE_SERVICE_NAME || "FeishuCodexBridge";
const serviceDescription =
  process.env.FEISHU_BRIDGE_SERVICE_DESCRIPTION ||
  "Feishu Codex bridge service (auto start on Windows boot)";
const serviceEnv = [
  {
    name: "NODE_ENV",
    value: process.env.NODE_ENV || "production",
  },
];

const svc = new Service({
  name: serviceName,
  description: serviceDescription,
  script: path.join(projectRoot, "service-bootstrap.cjs"),
  workingDirectory: projectRoot,
  wait: 2,
  grow: 0.5,
  maxRestarts: 999,
  env: serviceEnv,
});

svc.on("install", () => {
  // eslint-disable-next-line no-console
  console.log(`[service] installed: ${serviceName}`);
  svc.start();
});

svc.on("alreadyinstalled", () => {
  // eslint-disable-next-line no-console
  console.log(`[service] already installed: ${serviceName}`);
  svc.start();
});

svc.on("start", () => {
  // eslint-disable-next-line no-console
  console.log(`[service] started: ${serviceName}`);
});

svc.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error(`[service] error: ${String(error)}`);
});

svc.install();
