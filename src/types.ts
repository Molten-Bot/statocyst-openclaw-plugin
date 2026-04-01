export interface OpenClawToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (callID: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface OpenClawToolRegisterOptions {
  optional?: boolean;
}

export interface OpenClawPluginAPI {
  registerTool: (tool: OpenClawToolDefinition, options?: OpenClawToolRegisterOptions) => void;
  pluginConfig?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

export interface OpenClawPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  register: (api: OpenClawPluginAPI) => void;
}

export interface ResolveConfigInput {
  config?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

export interface MoltenHubProfileSyncConfig {
  enabled: boolean;
  handle?: string;
  metadata?: Record<string, unknown>;
  syncIntervalMs: number;
}

export interface MoltenHubConnectionConfig {
  healthcheckTtlMs: number;
}

export interface MoltenHubSafetyConfig {
  blockMetadataSecrets: boolean;
  warnMessageSecrets: boolean;
  secretMarkers: string[];
}

export interface MoltenHubPluginConfig {
  baseUrl: string;
  token: string;
  sessionKey: string;
  timeoutMs: number;
  pluginId: string;
  pluginPackage: string;
  pluginVersion: string;
  profile: MoltenHubProfileSyncConfig;
  connection: MoltenHubConnectionConfig;
  safety: MoltenHubSafetyConfig;
}

export interface SecretWarning {
  fieldPath: string;
  marker: string;
  message: string;
}

export interface SkillExecutionRequest {
  toAgentUUID?: string;
  toAgentURI?: string;
  skillName: string;
  input?: unknown;
  timeoutMs?: number;
  sessionKey?: string;
  requestId?: string;
}

export interface SkillExecutionResult {
  requestId: string;
  skillName: string;
  status: string;
  output: unknown;
  error?: unknown;
  messageId: string;
  deliveryId: string;
  warnings?: SecretWarning[];
}

export interface OpenClawPublishRequest {
  toAgentUUID?: string;
  toAgentURI?: string;
  clientMsgID?: string;
  message: Record<string, unknown>;
}

export interface OpenClawPullRequest {
  timeoutMs?: number;
}

export interface OpenClawDeliveryActionRequest {
  deliveryId: string;
}

export interface OpenClawMessageStatusRequest {
  messageId: string;
}

export interface AgentProfileUpdateRequest {
  handle?: string;
  metadata?: Record<string, unknown>;
}

export interface ReadinessCheckItem {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  checkedAt: string;
}

export interface ReadinessCheckResult {
  status: "ok" | "degraded";
  baseUrl: string;
  sessionKey: string;
  transport: "websocket";
  canCommunicate?: boolean;
  checks: {
    pluginRegistration: ReadinessCheckItem;
    profileSync: ReadinessCheckItem;
    session: ReadinessCheckItem;
    capabilities: ReadinessCheckItem;
  };
}

export interface SessionStatusResult {
  status: string;
  sessionKey: string;
  transport: string;
}
