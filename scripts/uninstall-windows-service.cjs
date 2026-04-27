if (process.platform !== "win32") {
  // eslint-disable-next-line no-console
  console.error("This command is only supported on Windows.");
  process.exit(1);
}

const { Service } = require("node-windows");

const serviceName = process.env.FEISHU_BRIDGE_SERVICE_NAME || "FeishuCodexBridge";

const svc = new Service({
  name: serviceName,
  script: "service-bootstrap.cjs",
});

svc.on("uninstall", () => {
  // eslint-disable-next-line no-console
  console.log(`[service] uninstalled: ${serviceName}`);
});

svc.on("alreadyuninstalled", () => {
  // eslint-disable-next-line no-console
  console.log(`[service] already uninstalled: ${serviceName}`);
});

svc.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error(`[service] error: ${String(error)}`);
});

svc.uninstall();

