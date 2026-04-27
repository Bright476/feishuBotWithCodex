import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export type FeishuDomain = "feishu" | "lark";

export type AppRegistrationResult = {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  openId?: string;
};

type InitResponse = {
  nonce: string;
  supported_auth_methods: string[];
};

type RawBeginResponse = {
  device_code: string;
  verification_uri: string;
  user_code: string;
  verification_uri_complete: string;
  interval: number;
  expire_in: number;
};

export type BeginResult = {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expireIn: number;
};

type PollResponse = {
  client_id?: string;
  client_secret?: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: "feishu" | "lark";
  };
  error?: string;
  error_description?: string;
};

export type PollOutcome =
  | { status: "success"; result: AppRegistrationResult }
  | { status: "access_denied" }
  | { status: "expired" }
  | { status: "timeout" }
  | { status: "error"; message: string };

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 10_000;

function accountsBaseUrl(domain: FeishuDomain): string {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

async function postRegistration<T>(baseUrl: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(`${baseUrl}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return (await response.json()) as T;
}

export async function initAppRegistration(domain: FeishuDomain = "feishu"): Promise<void> {
  const baseUrl = accountsBaseUrl(domain);
  const response = await postRegistration<InitResponse>(baseUrl, { action: "init" });
  if (!response.supported_auth_methods?.includes("client_secret")) {
    throw new Error("当前环境不支持 client_secret 方式注册");
  }
}

export async function beginAppRegistration(domain: FeishuDomain = "feishu"): Promise<BeginResult> {
  const baseUrl = accountsBaseUrl(domain);
  const response = await postRegistration<RawBeginResponse>(baseUrl, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  const qrUrl = new URL(response.verification_uri_complete);
  qrUrl.searchParams.set("from", "feishu_cli_bridge");
  qrUrl.searchParams.set("tp", "ob_cli_app");

  return {
    deviceCode: response.device_code,
    qrUrl: qrUrl.toString(),
    userCode: response.user_code,
    interval: response.interval || 5,
    expireIn: response.expire_in || 600,
  };
}

export async function pollAppRegistration(params: {
  deviceCode: string;
  interval: number;
  expireIn: number;
  initialDomain?: FeishuDomain;
  abortSignal?: AbortSignal;
  tp?: string;
}): Promise<PollOutcome> {
  const { deviceCode, expireIn, initialDomain = "feishu", abortSignal, tp } = params;
  let currentInterval = params.interval;
  let currentDomain: FeishuDomain = initialDomain;
  let switched = false;
  const deadline = Date.now() + expireIn * 1000;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      return { status: "timeout" };
    }
    const baseUrl = accountsBaseUrl(currentDomain);

    let response: PollResponse;
    try {
      response = await postRegistration<PollResponse>(baseUrl, {
        action: "poll",
        device_code: deviceCode,
        ...(tp ? { tp } : {}),
      });
    } catch {
      await sleep(currentInterval * 1000);
      continue;
    }

    if (response.user_info?.tenant_brand === "lark" && !switched) {
      currentDomain = "lark";
      switched = true;
      continue;
    }

    if (response.client_id && response.client_secret) {
      return {
        status: "success",
        result: {
          appId: response.client_id,
          appSecret: response.client_secret,
          domain: currentDomain,
          openId: response.user_info?.open_id,
        },
      };
    }

    if (response.error) {
      if (response.error === "authorization_pending") {
        await sleep(currentInterval * 1000);
        continue;
      }
      if (response.error === "slow_down") {
        currentInterval += 5;
        await sleep(currentInterval * 1000);
        continue;
      }
      if (response.error === "access_denied") {
        return { status: "access_denied" };
      }
      if (response.error === "expired_token") {
        return { status: "expired" };
      }
      return {
        status: "error",
        message: `${response.error}: ${response.error_description ?? "unknown"}`,
      };
    }

    await sleep(currentInterval * 1000);
  }
  return { status: "timeout" };
}

export async function printQrCode(url: string): Promise<void> {
  const mod = await import("qrcode-terminal");
  const qrcode = mod.default ?? mod;
  qrcode.generate(url, { small: true });
  process.stdout.write("\n");
}

export async function openQrCodeWindow(params: {
  url: string;
  title?: string;
}): Promise<{ opened: boolean; htmlPath?: string; error?: string }> {
  const { url, title } = params;
  try {
    const safeTitle = escapeHtml(title?.trim() || "Feishu 扫码配对");
    const safeUrl = escapeHtml(url);
    const html = [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8" />',
      `<title>${safeTitle}</title>`,
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "<style>",
      "body{font-family:Arial,Microsoft YaHei,sans-serif;background:#f5f6f8;margin:0;padding:24px;color:#1f2329;}",
      ".wrap{max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.08);}",
      "h1{margin:0 0 12px;font-size:20px;line-height:1.4;}",
      "p{margin:8px 0;line-height:1.6;font-size:14px;}",
      ".qr{text-align:center;margin:16px 0;}",
      ".qr canvas,.qr img{width:320px;max-width:100%;height:auto;}",
      "a{word-break:break-all;}",
      "</style>",
      "</head>",
      "<body>",
      '<div class="wrap">',
      `<h1>${safeTitle}</h1>`,
      "<p>请使用飞书 App 扫描下方二维码完成授权。</p>",
      '<div class="qr" id="qr">二维码加载中...</div>',
      `<p>若扫码失败，可直接打开链接：<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a></p>`,
      '<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>',
      "<script>",
      `const targetUrl = ${JSON.stringify(url)};`,
      "const qrContainer = document.getElementById('qr');",
      "if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {",
      "  const canvas = document.createElement('canvas');",
      "  window.QRCode.toCanvas(canvas, targetUrl, { width: 320, margin: 1 }, (error) => {",
      "    if (error) {",
      "      qrContainer.textContent = '二维码生成失败，请使用下方链接继续授权。';",
      "      return;",
      "    }",
      "    qrContainer.innerHTML = '';",
      "    qrContainer.appendChild(canvas);",
      "  });",
      "} else {",
      "  qrContainer.textContent = '二维码组件加载失败，请使用下方链接继续授权。';",
      "}",
      "</script>",
      "</div>",
      "</body>",
      "</html>",
    ].join("\n");

    const htmlPath = path.join(os.tmpdir(), `feishu-cli-bridge-qr-${Date.now()}.html`);
    await fs.writeFile(htmlPath, html, "utf8");
    const fileUrl = pathToFileURL(htmlPath).href;
    const opened = openExternal(fileUrl);
    if (!opened) {
      return { opened: false, error: "failed to launch browser" };
    }
    return { opened: true, htmlPath };
  } catch (error) {
    return { opened: false, error: String(error) };
  }
}

function openExternal(target: string): boolean {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", target], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    }
    if (process.platform === "darwin") {
      const child = spawn("open", [target], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    }
    const child = spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
