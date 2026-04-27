import type { CliBackendProfileMap } from "./cli-backend.js";

export type FeishuConnectionMode = "websocket" | "webhook";

export type FeishuBridgeConfig = {
  accountId: string;
  appId: string;
  appSecret: string;
  domain: string;
  connectionMode: FeishuConnectionMode;
  verificationToken?: string;
  encryptKey?: string;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
  cardWebhookPath: string;
};

export type BridgeHttpConfig = {
  host: string;
  port: number;
  apiToken?: string;
};

export type BridgeRuntimeConfig = {
  autoRunBackend: boolean;
  defaultBackendId: string;
  defaultModel?: string;
  cliTimeoutMs: number;
  permissionApprovalTimeoutMs: number;
  inboundQueueLimit: number;
  sessionStorePath: string;
  defaultCwd: string;
  cwdAllowRoots: string[];
  codexHomeDirs: string[];
};

export type BridgeConfig = {
  feishu: FeishuBridgeConfig;
  http: BridgeHttpConfig;
  runtime: BridgeRuntimeConfig;
  backends: CliBackendProfileMap;
};

export type FeishuDeliveryTarget = {
  accountId: string;
  to: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  threadId?: string;
};

export type FeishuInboundMessage = {
  accountId: string;
  conversationKey: string;
  chatId: string;
  chatType: "group" | "private" | "p2p";
  messageId: string;
  senderOpenId?: string;
  text: string;
  threadId?: string;
};

export type ConversationState = {
  backendId?: string;
  backendSessionId?: string;
  backendCodexHome?: string;
  backendModel?: string;
  planModeEnabled?: boolean;
  dangerSandboxAutoApprove?: boolean;
  backendCwd?: string;
  lastTarget?: FeishuDeliveryTarget;
  updatedAt: string;
};

export type ConversationStateMap = Record<string, ConversationState>;

export type InboundQueueItem = {
  id: string;
  receivedAt: string;
  message: FeishuInboundMessage;
};
