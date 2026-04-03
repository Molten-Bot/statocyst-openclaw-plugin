import { resolveConfig, MoltenHubClient } from "./moltenhub-client.js";
import type {
  OpenClawPluginAPI,
  OpenClawPlugin,
  OpenClawToolDefinition,
  SkillExecutionRequest,
  SkillExecutionResult,
  MoltenHubPluginConfig,
  AgentProfileUpdateRequest,
  OpenClawPublishRequest,
  OpenClawPullRequest,
  OpenClawDeliveryActionRequest,
  OpenClawMessageStatusRequest,
  ReadinessCheckResult,
  SessionStatusResult
} from "./types.js";

interface MoltenHubClientContract {
  checkSession: () => Promise<SessionStatusResult>;
  checkReadiness: () => Promise<ReadinessCheckResult>;
  requestSkillExecution: (request: SkillExecutionRequest) => Promise<SkillExecutionResult>;
  getProfile: () => Promise<Record<string, unknown>>;
  updateProfile: (request: AgentProfileUpdateRequest) => Promise<Record<string, unknown>>;
  getCapabilities: () => Promise<Record<string, unknown>>;
  getManifest: (format?: "json" | "markdown") => Promise<Record<string, unknown>>;
  getSkillGuide: (format?: "json" | "markdown") => Promise<Record<string, unknown>>;
  openClawPublish: (request: OpenClawPublishRequest) => Promise<Record<string, unknown>>;
  openClawPull: (request?: OpenClawPullRequest) => Promise<Record<string, unknown>>;
  openClawAck: (request: OpenClawDeliveryActionRequest) => Promise<Record<string, unknown>>;
  openClawNack: (request: OpenClawDeliveryActionRequest) => Promise<Record<string, unknown>>;
  openClawStatus: (request: OpenClawMessageStatusRequest) => Promise<Record<string, unknown>>;
}

export interface PluginFactoryDeps {
  createClient?: (config: MoltenHubPluginConfig) => MoltenHubClientContract;
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
    payload: {
      description: "Skill payload body (JSON value or markdown string)"
    },
    payloadFormat: {
      type: "string",
      description: "Payload format. Defaults to json unless payload is a string.",
      enum: ["json", "markdown", "md"]
    },
    input: {
      description: "Deprecated alias for payload"
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

const readinessInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {}
};

const profileGetInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {}
};

const profileUpdateInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    handle: {
      type: "string",
      description: "Optional one-time stable handle finalize request"
    },
    metadata: {
      type: "object",
      description: "Agent metadata merge patch"
    }
  }
};

const capabilitiesInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {}
};

const manifestInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    format: {
      type: "string",
      description: "json (default) or markdown",
      enum: ["json", "markdown", "md"]
    }
  }
};

const skillGuideInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    format: {
      type: "string",
      description: "json (default) or markdown",
      enum: ["json", "markdown", "md"]
    }
  }
};

const openClawPublishInputSchema: Record<string, unknown> = {
  type: "object",
  required: ["message"],
  properties: {
    toAgentUUID: {
      type: "string",
      description: "Target receiver agent UUID"
    },
    toAgentURI: {
      type: "string",
      description: "Target receiver canonical agent URI"
    },
    clientMsgID: {
      type: "string",
      description: "Optional idempotency key"
    },
    message: {
      type: "object",
      description: "OpenClaw JSON envelope payload"
    }
  }
};

const openClawPullInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    timeoutMs: {
      type: "number",
      description: "Long-poll timeout in milliseconds (0-30000)"
    }
  }
};

const openClawAckInputSchema: Record<string, unknown> = {
  type: "object",
  required: ["deliveryId"],
  properties: {
    deliveryId: {
      type: "string",
      description: "Delivery id from pull/delivery event"
    }
  }
};

const openClawNackInputSchema: Record<string, unknown> = {
  type: "object",
  required: ["deliveryId"],
  properties: {
    deliveryId: {
      type: "string",
      description: "Delivery id from pull/delivery event"
    }
  }
};

const openClawStatusInputSchema: Record<string, unknown> = {
  type: "object",
  required: ["messageId"],
  properties: {
    messageId: {
      type: "string",
      description: "Message id to inspect status"
    }
  }
};

function parseSkillExecutionRequest(input: Record<string, unknown>): SkillExecutionRequest {
  const payloadFormat = parseSkillPayloadFormat(input.payloadFormat);
  const payload = input.payload !== undefined ? input.payload : input.input;
  return {
    toAgentUUID: asTrimmedString(input.toAgentUUID),
    toAgentURI: asTrimmedString(input.toAgentURI),
    skillName: asTrimmedString(input.skillName) ?? "",
    payload,
    payloadFormat,
    input: input.input,
    timeoutMs: asNumber(input.timeoutMs),
    sessionKey: asTrimmedString(input.sessionKey),
    requestId: asTrimmedString(input.requestId)
  };
}

function parseSkillPayloadFormat(value: unknown): "json" | "markdown" | undefined {
  const raw = asTrimmedString(value)?.toLowerCase();
  if (raw === "json") {
    return "json";
  }
  if (raw === "md" || raw === "markdown") {
    return "markdown";
  }
  return undefined;
}

function parseProfileUpdateRequest(input: Record<string, unknown>): AgentProfileUpdateRequest {
  return {
    handle: asTrimmedString(input.handle),
    metadata: asRecord(input.metadata)
  };
}

function parseManifestFormat(input: Record<string, unknown>): "json" | "markdown" {
  const raw = asTrimmedString(input.format)?.toLowerCase();
  if (raw === "md" || raw === "markdown") {
    return "markdown";
  }
  return "json";
}

function parseOpenClawPublishRequest(input: Record<string, unknown>): OpenClawPublishRequest {
  return {
    toAgentUUID: asTrimmedString(input.toAgentUUID),
    toAgentURI: asTrimmedString(input.toAgentURI),
    clientMsgID: asTrimmedString(input.clientMsgID),
    message: asRecord(input.message)
  };
}

function parseOpenClawPullRequest(input: Record<string, unknown>): OpenClawPullRequest {
  return {
    timeoutMs: asNumber(input.timeoutMs)
  };
}

function parseOpenClawDeliveryActionRequest(input: Record<string, unknown>): OpenClawDeliveryActionRequest {
  return {
    deliveryId: asTrimmedString(input.deliveryId) ?? ""
  };
}

function parseOpenClawStatusRequest(input: Record<string, unknown>): OpenClawMessageStatusRequest {
  return {
    messageId: asTrimmedString(input.messageId) ?? ""
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

function skillRequestTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_skill_request",
    description:
      "Send a MoltenHub skill_request envelope (`skill_name` + `payload` in json/markdown format) to a peer and wait for the matching skill_result. Includes secret-safety warnings when payload markers are detected.",
    parameters: skillRequestInputSchema,
    execute: async (_callID, params) => {
      const request = parseSkillExecutionRequest(asRecord(params));
      const result = await client().requestSkillExecution(request);
      return toToolResult(result);
    }
  };
}

function sessionStatusTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_session_status",
    description: "Check MoltenHub runtime connectivity for this plugin session.",
    parameters: sessionStatusInputSchema,
    execute: async () => {
      const result = await client().checkSession();
      return toToolResult(result);
    }
  };
}

function readinessTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_readiness_check",
    description:
      "Run plugin registration/profile-sync/runtime connectivity/capability checks to verify this agent is connected and ready.",
    parameters: readinessInputSchema,
    execute: async () => {
      const result = await client().checkReadiness();
      return toToolResult(result);
    }
  };
}

function profileGetTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_profile_get",
    description: "Read this authenticated agent profile, owner context, and metadata from MoltenHub.",
    parameters: profileGetInputSchema,
    execute: async () => {
      const result = await client().getProfile();
      return toToolResult(result);
    }
  };
}

function profileUpdateTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_profile_update",
    description:
      "Update this agent profile metadata (and optional handle finalize). Metadata updates are blocked when secret-like markers are detected by plugin safety policy.",
    parameters: profileUpdateInputSchema,
    execute: async (_callID, params) => {
      const request = parseProfileUpdateRequest(asRecord(params));
      const result = await client().updateProfile(request);
      return toToolResult(result);
    }
  };
}

function capabilitiesTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_capabilities_get",
    description: "Read machine-readable runtime capabilities, communication graph, and peer skill catalog.",
    parameters: capabilitiesInputSchema,
    execute: async () => {
      const result = await client().getCapabilities();
      return toToolResult(result);
    }
  };
}

function manifestTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_manifest_get",
    description: "Read this agent manifest in JSON (default) or markdown form.",
    parameters: manifestInputSchema,
    execute: async (_callID, params) => {
      const format = parseManifestFormat(asRecord(params));
      const result = await client().getManifest(format);
      return toToolResult(result);
    }
  };
}

function skillGuideTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_skill_guide_get",
    description: "Read this agent skill guide in JSON (default) or markdown form.",
    parameters: skillGuideInputSchema,
    execute: async (_callID, params) => {
      const format = parseManifestFormat(asRecord(params));
      const result = await client().getSkillGuide(format);
      return toToolResult(result);
    }
  };
}

function openClawPublishTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_openclaw_publish",
    description:
      "Publish an OpenClaw JSON envelope to a trusted peer via MoltenHub adapter routes. Secret-like payload markers produce warnings without blocking send.",
    parameters: openClawPublishInputSchema,
    execute: async (_callID, params) => {
      const request = parseOpenClawPublishRequest(asRecord(params));
      const result = await client().openClawPublish(request);
      return toToolResult(result);
    }
  };
}

function openClawPullTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_openclaw_pull",
    description: "Pull the next OpenClaw delivery for this agent with optional long-poll timeout.",
    parameters: openClawPullInputSchema,
    execute: async (_callID, params) => {
      const request = parseOpenClawPullRequest(asRecord(params));
      const result = await client().openClawPull(request);
      return toToolResult(result);
    }
  };
}

function openClawAckTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_openclaw_ack",
    description: "Acknowledge a leased OpenClaw delivery id.",
    parameters: openClawAckInputSchema,
    execute: async (_callID, params) => {
      const request = parseOpenClawDeliveryActionRequest(asRecord(params));
      const result = await client().openClawAck(request);
      return toToolResult(result);
    }
  };
}

function openClawNackTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_openclaw_nack",
    description: "Release a leased OpenClaw delivery id back to queue.",
    parameters: openClawNackInputSchema,
    execute: async (_callID, params) => {
      const request = parseOpenClawDeliveryActionRequest(asRecord(params));
      const result = await client().openClawNack(request);
      return toToolResult(result);
    }
  };
}

function openClawStatusTool(client: () => MoltenHubClientContract): OpenClawToolDefinition {
  return {
    name: "moltenhub_openclaw_status",
    description: "Read OpenClaw message status for a given message id.",
    parameters: openClawStatusInputSchema,
    execute: async (_callID, params) => {
      const request = parseOpenClawStatusRequest(asRecord(params));
      const result = await client().openClawStatus(request);
      return toToolResult(result);
    }
  };
}

function buildClient(api: OpenClawPluginAPI, factory: (config: MoltenHubPluginConfig) => MoltenHubClientContract) {
  const config = resolveConfig({
    config: api.pluginConfig ?? {},
    env: asEnvMap(api.env)
  });
  return factory(config);
}

export function createMoltenHubOpenClawPlugin(deps?: PluginFactoryDeps): OpenClawPlugin {
  const factory = deps?.createClient ?? ((config: MoltenHubPluginConfig) => new MoltenHubClient(config));

  return {
    id: "openclaw-plugin-moltenhub",
    name: "MoltenHub Realtime",
    description:
      "Molten AI maintained plugin for native MoltenHub interaction: realtime skill exchange, OpenClaw adapter routes, profile/capability discovery, and safety guardrails.",
    version: "0.1.8",
    register: (api: OpenClawPluginAPI) => {
      const client = buildClient(api, factory);

      api.registerTool(skillRequestTool(() => client));
      api.registerTool(sessionStatusTool(() => client));
      api.registerTool(readinessTool(() => client));
      api.registerTool(profileGetTool(() => client));
      api.registerTool(profileUpdateTool(() => client));
      api.registerTool(capabilitiesTool(() => client));
      api.registerTool(manifestTool(() => client));
      api.registerTool(skillGuideTool(() => client));
      api.registerTool(openClawPublishTool(() => client));
      api.registerTool(openClawPullTool(() => client));
      api.registerTool(openClawAckTool(() => client));
      api.registerTool(openClawNackTool(() => client));
      api.registerTool(openClawStatusTool(() => client));
    }
  };
}
