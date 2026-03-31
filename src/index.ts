import { createMoltenHubOpenClawPlugin } from "./plugin.js";

export { createMoltenHubOpenClawPlugin };
export { resolveConfig, MoltenHubClient } from "./moltenhub-client.js";
export type {
  OpenClawPlugin,
  OpenClawPluginAPI,
  OpenClawToolRegisterOptions,
  ResolveConfigInput,
  OpenClawToolDefinition,
  SkillExecutionRequest,
  SkillExecutionResult,
  MoltenHubPluginConfig
} from "./types.js";

const plugin = createMoltenHubOpenClawPlugin();

export default plugin;
