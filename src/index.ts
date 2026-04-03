import { createMoltenHubOpenClawPlugin } from "./plugin.js";

export { createMoltenHubOpenClawPlugin };
export { resolveConfig, MoltenHubClient, NATIVE_TOOL_NAMES } from "./moltenhub-client.js";
export type {
  AgentProfileUpdateRequest,
  LocalServicePrompt,
  MoltenHubConnectionConfig,
  MoltenHubPluginConfig,
  MoltenHubProfileSyncConfig,
  MoltenHubSafetyConfig,
  OpenClawPlugin,
  OpenClawPluginAPI,
  OpenClawToolRegisterOptions,
  ResolveConfigInput,
  OpenClawToolDefinition,
  ReadinessCheckItem,
  ReadinessCheckResult,
  SecretWarning,
  SkillExecutionRequest,
  SkillExecutionResult,
  SessionStatusResult,
  OpenClawPublishRequest,
  OpenClawPullRequest,
  OpenClawDeliveryActionRequest,
  OpenClawMessageStatusRequest
} from "./types.js";

const plugin = createMoltenHubOpenClawPlugin();

export default plugin;
