import { createStatocystOpenClawPlugin } from "./plugin.js";

export { createStatocystOpenClawPlugin };
export { resolveConfig, StatocystClient } from "./statocyst-client.js";
export type {
  OpenClawPlugin,
  OpenClawPluginAPI,
  OpenClawToolRegisterOptions,
  ResolveConfigInput,
  OpenClawToolDefinition,
  SkillExecutionRequest,
  SkillExecutionResult,
  StatocystPluginConfig
} from "./types.js";

const plugin = createStatocystOpenClawPlugin();

export default plugin;
