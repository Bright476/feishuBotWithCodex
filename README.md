# Feishu CLI Bridge

Feishu CLI Bridge 用来把飞书 / Lark 消息转发给本机 CLI 后端，默认后端是 Codex CLI，也内置了 Claude CLI 配置。默认使用飞书长连接 WebSocket 模式，同时会启动一个本地 HTTP 服务用于健康检查、Webhook 模式和交互回调。

## 环境要求

- Node.js 18+，建议使用当前 LTS 版本。
- npm。
- 已安装并登录可用的 CLI 后端：
  - 默认：`codex`
  - 可选：`claude`
- Windows 守护进程 / 自启动命令只支持 Windows。

安装依赖：

```powershell
npm install
```

## 最快启动

首次使用建议先执行扫码配置，凭证会保存到默认数据目录，后续启动会自动复用。

```powershell
npm run start:setup
npm start
```

如果需要开机自启动，Windows 下可以直接执行：

```powershell
npm run bridge:quickstart
```

`bridge:quickstart` 会先执行飞书扫码配置，再创建 Windows 登录自启动任务，并立即启动后台守护进程。

## 启动命令

### 前台启动

```powershell
npm start
```

等价于：

```powershell
node --import tsx src/main.ts
```

用途：

- 启动 HTTP 服务。
- 默认以 `websocket` 模式连接飞书开放平台。
- 收到飞书消息后调用默认 CLI 后端 `codex-cli`。

启动参数：

```powershell
node --import tsx src/main.ts --help
node --import tsx src/main.ts --setup-feishu
node --import tsx src/main.ts --setup-only
node --import tsx src/main.ts --rescan-feishu
node --import tsx src/main.ts --qr-gui
node --import tsx src/main.ts --no-qr-gui
```

对应 npm 命令：

```powershell
npm run start:setup
npm run start:rescan
```

### 扫码初始化

```powershell
npm run start:setup
```

等价于：

```powershell
node --import tsx src/main.ts --setup-feishu --setup-only
```

用途：

- 检查已有飞书凭证。
- 如果没有凭证，弹出或打印二维码。
- 扫码完成后保存凭证并退出。

强制重新扫码：

```powershell
npm run start:rescan
```

等价于：

```powershell
node --import tsx src/main.ts --rescan-feishu --setup-only
```

### Windows 守护进程

这些命令通过 `scripts/bridge-service.cjs` 管理一个后台 Node 进程，并使用 Windows 计划任务实现登录自启动。

```powershell
npm run bridge:setup
npm run bridge:rescan
npm run bridge:quickstart
npm run bridge:install
npm run bridge:start
npm run bridge:stop
npm run bridge:status
npm run bridge:remove
```

等价直接命令：

```powershell
node scripts/bridge-service.cjs setup
node scripts/bridge-service.cjs rescan
node scripts/bridge-service.cjs quickstart
node scripts/bridge-service.cjs install
node scripts/bridge-service.cjs start
node scripts/bridge-service.cjs stop
node scripts/bridge-service.cjs status
node scripts/bridge-service.cjs remove
```

命令说明：

| 命令 | 说明 |
| --- | --- |
| `bridge:setup` | 扫码配置飞书凭证，完成后退出。 |
| `bridge:rescan` | 忽略已有凭证并强制重新扫码。 |
| `bridge:quickstart` | 先扫码配置，再安装登录自启动任务，并立即启动守护进程。 |
| `bridge:install` | 创建 Windows 登录自启动任务，并立即启动守护进程。 |
| `bridge:start` | 启动后台守护进程。 |
| `bridge:stop` | 停止后台守护进程。 |
| `bridge:status` | 查看守护进程、自启动任务和日志路径。 |
| `bridge:remove` | 停止守护进程并删除自启动任务。 |

后台日志默认写入：

```text
daemon/feishu-cli-bridge-daemon.out.log
daemon/feishu-cli-bridge-daemon.err.log
```

### 旧版 Windows Service

项目仍保留 `node-windows` 方式的旧版服务脚本。新部署优先使用上面的 `bridge:*` 守护进程命令。

```powershell
npm run service:install:legacy
npm run service:uninstall:legacy
```

兼容别名：

```powershell
npm run service:install
npm run service:uninstall
```

注意：当前 `service:install` 和 `service:uninstall` 实际分别指向 `bridge:install` 和 `bridge:remove`。

## 配置方式

配置优先级大致为：

1. `FEISHU_BRIDGE_CONFIG_PATH` 指向的 JSON 配置文件。
2. 环境变量。
3. 代码中的默认值。

### 常用环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FEISHU_BRIDGE_CONFIG_PATH` | 空 | JSON 配置文件路径。 |
| `FEISHU_CONNECTION_MODE` | `websocket` | 飞书连接模式，可选 `websocket` 或 `webhook`。 |
| `FEISHU_DOMAIN` | `feishu` | 可选 `feishu` 或 `lark`。 |
| `FEISHU_APP_ID` | 空 | 飞书应用 App ID。未设置时默认允许扫码激活。 |
| `FEISHU_APP_SECRET` | 空 | 飞书应用 App Secret。 |
| `FEISHU_QR_ACTIVATION` | `true` | 没有凭证时是否允许扫码激活。 |
| `FEISHU_FORCE_QR_ACTIVATION` | `false` | 是否强制重新扫码。 |
| `FEISHU_QR_GUI` | `false` | 是否打开图形二维码页面；setup 命令默认开启。 |
| `FEISHU_AUTH_STORE_PATH` | `%APPDATA%\.feishubridge\auth.json` | 飞书扫码凭证保存路径。 |
| `BRIDGE_SESSION_STORE_PATH` | `%APPDATA%\.feishubridge\sessions.json` | 会话状态保存路径。 |
| `BRIDGE_DEFAULT_CWD` | 当前项目目录 | CLI 后端默认工作目录。 |
| `BRIDGE_CWD_ALLOW_ROOTS` | 项目上两级目录 | 允许通过飞书命令切换到的工作目录根路径，多个路径用 `;` 或 `,` 分隔。 |
| `BRIDGE_CODEX_HOME_DIRS` | 空 | 可读取的 Codex home 目录列表，多个路径用 `;` 或 `,` 分隔。 |
| `BRIDGE_AUTO_RUN_BACKEND` | `true` | 收到消息后是否自动调用 CLI 后端。 |
| `BRIDGE_DEFAULT_BACKEND_ID` | `codex-cli` | 默认后端，可选内置 `codex-cli`、`claude-cli`，也可在配置文件中自定义。 |
| `BRIDGE_DEFAULT_MODEL` | 空 | 传给后端的默认模型名。 |
| `BRIDGE_CLI_TIMEOUT_MS` | `900000` | 单次 CLI 调用超时时间。 |
| `BRIDGE_INBOUND_QUEUE_LIMIT` | `100` | 入站消息队列限制。 |
| `BRIDGE_PERMISSION_APPROVAL_TIMEOUT_MS` | `300000` | Codex 权限审批等待超时。 |
| `CODEX_COMMAND` | `codex` | 覆盖 Codex CLI 命令路径。 |
| `BRIDGE_HTTP_HOST` | 跟随飞书 Webhook host | HTTP 服务监听地址。 |
| `BRIDGE_HTTP_PORT` | 跟随飞书 Webhook port | HTTP 服务监听端口。 |
| `BRIDGE_API_TOKEN` | 空 | HTTP API token，供扩展配置使用。 |
| `FEISHU_WEBHOOK_HOST` | `0.0.0.0` | Webhook 模式 HTTP 监听地址。 |
| `FEISHU_WEBHOOK_PORT` | `3000` | Webhook 模式 HTTP 监听端口。 |
| `FEISHU_WEBHOOK_PATH` | `/feishu/events` | 飞书事件 Webhook 路径。 |
| `FEISHU_CARD_WEBHOOK_PATH` | `/feishu/card-actions` | 飞书卡片回调路径。 |
| `FEISHU_VERIFICATION_TOKEN` | 空 | 飞书事件校验 token；Webhook 模式建议设置。 |
| `FEISHU_ENCRYPT_KEY` | 空 | 飞书事件加密 key。 |
| `FEISHU_ACCOUNT_ID` | `default` | 多账号标识。 |
| `FEISHU_BRIDGE_DAEMON_TASK_NAME` | `FeishuCliBridgeDaemon` | Windows 自启动计划任务名。 |
| `FEISHU_BRIDGE_SERVICE_RESTART_MS` | `5000` | 旧版 service bootstrap 子进程退出后的重启延迟。 |
| `FEISHU_BRIDGE_SERVICE_NAME` | `FeishuCodexBridge` | 旧版 Windows Service 名称。 |
| `FEISHU_BRIDGE_SERVICE_DESCRIPTION` | 默认描述 | 旧版 Windows Service 描述。 |

PowerShell 设置示例：

```powershell
$env:BRIDGE_DEFAULT_CWD = "D:\git"
$env:BRIDGE_CWD_ALLOW_ROOTS = "D:\git;D:\work"
$env:BRIDGE_DEFAULT_MODEL = "gpt-5.4"
npm start
```

### JSON 配置文件示例

创建一个本地 JSON 文件，例如 `bridge.local.json`，再通过 `FEISHU_BRIDGE_CONFIG_PATH` 指向它。

```json
{
  "feishu": {
    "domain": "feishu",
    "connectionMode": "websocket",
    "webhookHost": "0.0.0.0",
    "webhookPort": 3000,
    "webhookPath": "/feishu/events",
    "cardWebhookPath": "/feishu/card-actions"
  },
  "runtime": {
    "defaultBackendId": "codex-cli",
    "defaultCwd": "D:\\git",
    "cwdAllowRoots": ["D:\\git"],
    "codexHomeDirs": ["C:\\Users\\your-name\\.codex"],
    "cliTimeoutMs": 900000
  },
  "http": {
    "host": "0.0.0.0",
    "port": 3000
  }
}
```

启动：

```powershell
$env:FEISHU_BRIDGE_CONFIG_PATH = ".\bridge.local.json"
npm start
```

## Webhook 模式

默认使用 `websocket`，一般不需要公网回调地址。如果要使用飞书 Webhook 事件订阅：

```powershell
$env:FEISHU_CONNECTION_MODE = "webhook"
$env:FEISHU_WEBHOOK_PORT = "3000"
$env:FEISHU_VERIFICATION_TOKEN = "your-token"
npm start
```

飞书事件订阅地址配置为：

```text
http://<你的公网域名或内网穿透地址>/feishu/events
```

交互卡片回调地址默认为：

```text
http://<你的公网域名或内网穿透地址>/feishu/card-actions
```

## 健康检查

服务启动后可访问：

```powershell
curl http://127.0.0.1:3000/healthz
```

如果改过 `BRIDGE_HTTP_PORT` 或 `FEISHU_WEBHOOK_PORT`，请使用实际端口。

## 测试命令

```powershell
npm test
```

等价于：

```powershell
vitest run src/cli-backend.test.ts src/codex-history.test.ts
```

## package.json 脚本总览

| npm script | 命令 |
| --- | --- |
| `npm start` | `node --import tsx src/main.ts` |
| `npm run start:setup` | `node --import tsx src/main.ts --setup-feishu --setup-only` |
| `npm run start:rescan` | `node --import tsx src/main.ts --rescan-feishu --setup-only` |
| `npm test` | `vitest run src/cli-backend.test.ts src/codex-history.test.ts` |
| `npm run bridge:setup` | `node scripts/bridge-service.cjs setup` |
| `npm run bridge:rescan` | `node scripts/bridge-service.cjs rescan` |
| `npm run bridge:quickstart` | `node scripts/bridge-service.cjs quickstart` |
| `npm run bridge:install` | `node scripts/bridge-service.cjs install` |
| `npm run bridge:start` | `node scripts/bridge-service.cjs start` |
| `npm run bridge:stop` | `node scripts/bridge-service.cjs stop` |
| `npm run bridge:remove` | `node scripts/bridge-service.cjs remove` |
| `npm run bridge:status` | `node scripts/bridge-service.cjs status` |
| `npm run service:install` | `node scripts/bridge-service.cjs install` |
| `npm run service:uninstall` | `node scripts/bridge-service.cjs remove` |
| `npm run service:install:legacy` | `node scripts/install-windows-service.cjs` |
| `npm run service:uninstall:legacy` | `node scripts/uninstall-windows-service.cjs` |
