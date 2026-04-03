import { createMoltenHubOpenClawPlugin } from "./plugin.js";

export { createMoltenHubOpenClawPlugin };
export { resolveConfig, MoltenHubClient, NATIVE_TOOL_NAMES } from "./moltenhub-client.js";
export type {
  AgentProfileUpdateRequest,
  MoltenHubConnectionConfig,
  MoltenHubPluginConfig,
  MoltenHubProfileSyncConfig,
  MoltenHubSafetyConfig,
  OpenClawPlugin,
  OpenClawPluginAPI,
  OpenClawPluginCleanup,
  OpenClawToolRegisterOptions,
  ResolveConfigInput,
  OpenClawToolDefinition,
  ReadinessCheckItem,
  ReadinessCheckResult,
  SecretWarning,
  SkillExecutionRequest,
  SkillExecutionResult,
  SessionStatusResult,
  AgentRuntimeStatus,
  OpenClawPublishRequest,
  OpenClawPullRequest,
  OpenClawDeliveryActionRequest,
  OpenClawMessageStatusRequest
} from "./types.js";

const plugin = createMoltenHubOpenClawPlugin();

export default plugin;
