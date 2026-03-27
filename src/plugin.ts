import { resolveConfig, StatocystClient } from "./statocyst-client.js";
import type {
  OpenClawPluginAPI,
  OpenClawPlugin,
  OpenClawToolDefinition,
  SkillExecutionRequest,
  SkillExecutionResult,
  StatocystPluginConfig
} from "./types.js";

interface StatocystClientContract {
  checkSession: () => Promise<{ status: string; sessionKey: string; transport: string }>;
  requestSkillExecution: (request: SkillExecutionRequest) => Promise<SkillExecutionResult>;
}

export interface PluginFactoryDeps {
  createClient?: (config: StatocystPluginConfig) => StatocystClientContract;
}

const skillRequestInputSchema: Record<string, unknown> = {
  type: "object",
  required: ["skillName"],
  properties: {
    toAgentUUID: {
      type: "string",
      description: "Target receiver agent UUID"
    },
    toAgentURI: {
      type: "string",
      description: "Target receiver canonical agent URI"
    },
    skillName: {
      type: "string",
      description: "Peer advertised skill name to execute"
    },
    input: {
      description: "Skill input payload"
    },
    timeoutMs: {
      type: "number",
      description: "Override timeout for this request"
    },
    sessionKey: {
      type: "string",
      description: "Override dedicated session key"
    },
    requestId: {
      type: "string",
      description: "Optional caller-provided correlation id"
    }
  }
};

const sessionStatusInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {}
};

function parseSkillExecutionRequest(input: Record<string, unknown>): SkillExecutionRequest {
  return {
    toAgentUUID: asTrimmedString(input.toAgentUUID),
    toAgentURI: asTrimmedString(input.toAgentURI),
    skillName: asTrimmedString(input.skillName) ?? "",
    input: input.input,
    timeoutMs: asNumber(input.timeoutMs),
    sessionKey: asTrimmedString(input.sessionKey),
    requestId: asTrimmedString(input.requestId)
  };
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asEnvMap(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(env ?? {})
  };
}

function formatToolText(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function toToolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: formatToolText(payload)
      }
    ],
    data: payload
  };
}

function skillRequestTool(client: () => StatocystClientContract): OpenClawToolDefinition {
  return {
    name: "statocyst_skill_request",
    description:
      "Send a Statocyst skill_request envelope to a peer and wait for the corresponding skill_result over the realtime websocket bus.",
    parameters: skillRequestInputSchema,
    execute: async (_callID, params) => {
      const request = parseSkillExecutionRequest(asRecord(params));
      const result = await client().requestSkillExecution(request);
      return toToolResult(result);
    }
  };
}

function sessionStatusTool(client: () => StatocystClientContract): OpenClawToolDefinition {
  return {
    name: "statocyst_session_status",
    description: "Check Statocyst realtime websocket connectivity for this plugin session.",
    parameters: sessionStatusInputSchema,
    execute: async () => {
      const result = await client().checkSession();
      return toToolResult(result);
    }
  };
}

function buildClient(api: OpenClawPluginAPI, factory: (config: StatocystPluginConfig) => StatocystClientContract) {
  const config = resolveConfig({
    config: api.pluginConfig ?? {},
    env: asEnvMap(api.env)
  });
  return factory(config);
}

export function createStatocystOpenClawPlugin(deps?: PluginFactoryDeps): OpenClawPlugin {
  const factory = deps?.createClient ?? ((config: StatocystPluginConfig) => new StatocystClient(config));

  return {
    id: "statocyst-openclaw",
    name: "Statocyst Realtime",
    description: "Molten AI maintained plugin for realtime skill request/result exchange via Statocyst.",
    version: "0.1.0",
    register: (api: OpenClawPluginAPI) => {
      const client = buildClient(api, factory);
      api.registerTool(skillRequestTool(() => client));
      api.registerTool(sessionStatusTool(() => client));
    }
  };
}
