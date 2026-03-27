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

export interface StatocystPluginConfig {
  baseUrl: string;
  token: string;
  sessionKey: string;
  timeoutMs: number;
  pluginId: string;
  pluginPackage: string;
  pluginVersion: string;
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
}
