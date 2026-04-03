import { describe, expect, it, vi } from "vitest";

import { NATIVE_TOOL_NAMES } from "../src/moltenhub-client.js";
import { createMoltenHubOpenClawPlugin } from "../src/plugin.js";
import type { OpenClawToolDefinition, SkillExecutionResult } from "../src/types.js";

function setupPluginWithMockClient() {
  const tools: OpenClawToolDefinition[] = [];

  const requestSkillExecution = vi.fn(async () => ({
    requestId: "req-1",
    skillName: "weather_lookup",
    status: "ok",
    output: "sunny",
    messageId: "message-1",
    deliveryId: "delivery-1"
  }));
  const checkSession = vi.fn(async () => ({
    status: "ok",
    sessionKey: "main",
    transport: "websocket"
  }));
  const checkReadiness = vi.fn(async () => ({
    status: "ok",
    checks: {
      session: { ok: true }
    }
  }));
  const getProfile = vi.fn(async () => ({
    agent: {
      agent_uuid: "agent-1"
    }
  }));
  const updateProfile = vi.fn(async () => ({
    agent: {
      metadata: {
        agent_type: "openclaw"
      }
    }
  }));
  const getCapabilities = vi.fn(async () => ({
    control_plane: {
      can_communicate: true
    }
  }));
  const getManifest = vi.fn(async (format?: "json" | "markdown") =>
    format === "markdown" ? { format: "markdown", content: "# manifest" } : { manifest: { schema_version: "1.0" } }
  );
  const getSkillGuide = vi.fn(async (format?: "json" | "markdown") =>
    format === "markdown" ? { format: "markdown", content: "# skill" } : { skill: { format: "markdown" } }
  );
  const openClawPublish = vi.fn(async () => ({ message_id: "message-9" }));
  const openClawPull = vi.fn(async () => ({ delivery: { delivery_id: "delivery-9" } }));
  const openClawAck = vi.fn(async () => ({ status: "acked" }));
  const openClawNack = vi.fn(async () => ({ status: "nacked" }));
  const openClawStatus = vi.fn(async () => ({ message_id: "message-9" }));

  const plugin = createMoltenHubOpenClawPlugin({
    createClient: () => ({
      requestSkillExecution,
      checkSession,
      checkReadiness,
      getProfile,
      updateProfile,
      getCapabilities,
      getManifest,
      getSkillGuide,
      openClawPublish,
      openClawPull,
      openClawAck,
      openClawNack,
      openClawStatus
    })
  });

  return {
    plugin,
    tools,
    requestSkillExecution,
    checkSession,
    checkReadiness,
    getProfile,
    updateProfile,
    getCapabilities,
    getManifest,
    getSkillGuide,
    openClawPublish,
    openClawPull,
    openClawAck,
    openClawNack,
    openClawStatus,
    api: {
      pluginConfig: {
        baseUrl: "http://localhost:8080/v1",
        token: "token-a"
      },
      registerTool: (tool: OpenClawToolDefinition) => {
        tools.push(tool);
      }
    }
  };
}

function unwrapToolData(result: unknown): unknown {
  const payload = result as { data?: unknown };
  if (payload && payload.data !== undefined) {
    return payload.data;
  }
  return result;
}

describe("createMoltenHubOpenClawPlugin", () => {
  it("registers full native tool surface", () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    expect(ctx.tools.map((tool) => tool.name)).toEqual([...NATIVE_TOOL_NAMES]);
  });

  it("forwards normalized skill request input to the client and returns tool content", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const skillTool = ctx.tools.find((tool) => tool.name === "moltenhub_skill_request");
    expect(skillTool).toBeDefined();

    const result = await skillTool!.execute("call-1", {
      toAgentUUID: " 11111111-1111-1111-1111-111111111111 ",
      toAgentURI: "   ",
      skillName: " weather_lookup ",
      input: { city: "Seattle" },
      timeoutMs: 500,
      sessionKey: " main ",
      requestId: " req-123 "
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text:
            '{"requestId":"req-1","skillName":"weather_lookup","status":"ok","output":"sunny","messageId":"message-1","deliveryId":"delivery-1"}'
        }
      ],
      data: {
        requestId: "req-1",
        skillName: "weather_lookup",
        status: "ok",
        output: "sunny",
        messageId: "message-1",
        deliveryId: "delivery-1"
      }
    });

    expect(ctx.requestSkillExecution).toHaveBeenCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      skillName: "weather_lookup",
      payload: { city: "Seattle" },
      payloadFormat: undefined,
      input: { city: "Seattle" },
      timeoutMs: 500,
      sessionKey: "main",
      requestId: "req-123"
    });
  });

  it("drops non-finite timeout values in skill request", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const skillTool = ctx.tools.find((tool) => tool.name === "moltenhub_skill_request");
    await skillTool!.execute("call-2", {
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "weather_lookup",
      timeoutMs: Number.POSITIVE_INFINITY
    });

    expect(ctx.requestSkillExecution).toHaveBeenLastCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      skillName: "weather_lookup",
      payload: undefined,
      payloadFormat: undefined,
      input: undefined,
      timeoutMs: undefined,
      sessionKey: undefined,
      requestId: undefined
    });
  });

  it("normalizes explicit markdown payload fields", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const skillTool = ctx.tools.find((tool) => tool.name === "moltenhub_skill_request");
    await skillTool!.execute("call-2b", {
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "weather_lookup",
      payload: "# hello",
      payloadFormat: "md"
    });

    expect(ctx.requestSkillExecution).toHaveBeenLastCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      skillName: "weather_lookup",
      payload: "# hello",
      payloadFormat: "markdown",
      input: undefined,
      timeoutMs: undefined,
      sessionKey: undefined,
      requestId: undefined
    });
  });

  it("normalizes explicit json payload format", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const skillTool = ctx.tools.find((tool) => tool.name === "moltenhub_skill_request");
    await skillTool!.execute("call-2c", {
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "weather_lookup",
      payload: {
        city: "Seattle"
      },
      payloadFormat: "json"
    });

    expect(ctx.requestSkillExecution).toHaveBeenLastCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      skillName: "weather_lookup",
      payload: {
        city: "Seattle"
      },
      payloadFormat: "json",
      input: undefined,
      timeoutMs: undefined,
      sessionKey: undefined,
      requestId: undefined
    });
  });

  it("runs session and readiness tools", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const status = await ctx.tools.find((tool) => tool.name === "moltenhub_session_status")!.execute("call-3", {});
    const readiness = await ctx.tools.find((tool) => tool.name === "moltenhub_readiness_check")!.execute("call-4", {});

    expect(unwrapToolData(status)).toEqual({
      status: "ok",
      sessionKey: "main",
      transport: "websocket"
    });
    expect(unwrapToolData(readiness)).toEqual({
      status: "ok",
      checks: {
        session: { ok: true }
      }
    });
    expect(ctx.checkSession).toHaveBeenCalledTimes(1);
    expect(ctx.checkReadiness).toHaveBeenCalledTimes(1);
  });

  it("supports profile and capabilities tools", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const profileGet = await ctx.tools.find((tool) => tool.name === "moltenhub_profile_get")!.execute("call-5", {});
    const profileUpdate = await ctx.tools
      .find((tool) => tool.name === "moltenhub_profile_update")!
      .execute("call-6", { handle: " alpha ", metadata: { profile_markdown: "# hi" } });
    const capabilities = await ctx.tools.find((tool) => tool.name === "moltenhub_capabilities_get")!.execute("call-7", {});

    expect(unwrapToolData(profileGet)).toEqual({
      agent: {
        agent_uuid: "agent-1"
      }
    });
    expect(unwrapToolData(profileUpdate)).toEqual({
      agent: {
        metadata: {
          agent_type: "openclaw"
        }
      }
    });
    expect(unwrapToolData(capabilities)).toEqual({
      control_plane: {
        can_communicate: true
      }
    });

    expect(ctx.getProfile).toHaveBeenCalledTimes(1);
    expect(ctx.updateProfile).toHaveBeenCalledWith({
      handle: "alpha",
      metadata: { profile_markdown: "# hi" }
    });
    expect(ctx.getCapabilities).toHaveBeenCalledTimes(1);
  });

  it("normalizes manifest and skill-guide format parameters", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    await ctx.tools.find((tool) => tool.name === "moltenhub_manifest_get")!.execute("call-8", { format: "md" });
    await ctx.tools.find((tool) => tool.name === "moltenhub_manifest_get")!.execute("call-9", { format: "json" });
    await ctx.tools.find((tool) => tool.name === "moltenhub_skill_guide_get")!.execute("call-10", { format: "markdown" });
    await ctx.tools.find((tool) => tool.name === "moltenhub_skill_guide_get")!.execute("call-11", {});

    expect(ctx.getManifest).toHaveBeenNthCalledWith(1, "markdown");
    expect(ctx.getManifest).toHaveBeenNthCalledWith(2, "json");
    expect(ctx.getSkillGuide).toHaveBeenNthCalledWith(1, "markdown");
    expect(ctx.getSkillGuide).toHaveBeenNthCalledWith(2, "json");
  });

  it("normalizes openclaw publish, pull, ack, nack, and status requests", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    await ctx.tools.find((tool) => tool.name === "moltenhub_openclaw_publish")!.execute("call-12", {
      toAgentUUID: " 11111111-1111-1111-1111-111111111111 ",
      toAgentURI: " ",
      clientMsgID: " client-1 ",
      message: { kind: "node_event" }
    });
    await ctx.tools.find((tool) => tool.name === "moltenhub_openclaw_pull")!.execute("call-13", {
      timeoutMs: 1000
    });
    await ctx.tools.find((tool) => tool.name === "moltenhub_openclaw_ack")!.execute("call-14", {
      deliveryId: " delivery-1 "
    });
    await ctx.tools.find((tool) => tool.name === "moltenhub_openclaw_nack")!.execute("call-15", {
      deliveryId: " delivery-2 "
    });
    await ctx.tools.find((tool) => tool.name === "moltenhub_openclaw_status")!.execute("call-16", {
      messageId: " message-1 "
    });

    expect(ctx.openClawPublish).toHaveBeenCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      clientMsgID: "client-1",
      message: { kind: "node_event" }
    });
    expect(ctx.openClawPull).toHaveBeenCalledWith({ timeoutMs: 1000 });
    expect(ctx.openClawAck).toHaveBeenCalledWith({ deliveryId: "delivery-1" });
    expect(ctx.openClawNack).toHaveBeenCalledWith({ deliveryId: "delivery-2" });
    expect(ctx.openClawStatus).toHaveBeenCalledWith({ messageId: "message-1" });
  });

  it("normalizes missing tool string fields to empty defaults where required", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    await ctx.tools.find((tool) => tool.name === "moltenhub_skill_request")!.execute("call-16b", {
      toAgentUUID: "11111111-1111-1111-1111-111111111111"
    });
    await ctx.tools.find((tool) => tool.name === "moltenhub_openclaw_ack")!.execute("call-16c", {});
    await ctx.tools.find((tool) => tool.name === "moltenhub_openclaw_status")!.execute("call-16d", {});

    expect(ctx.requestSkillExecution).toHaveBeenLastCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      skillName: "",
      payload: undefined,
      payloadFormat: undefined,
      input: undefined,
      timeoutMs: undefined,
      sessionKey: undefined,
      requestId: undefined
    });
    expect(ctx.openClawAck).toHaveBeenLastCalledWith({ deliveryId: "" });
    expect(ctx.openClawStatus).toHaveBeenLastCalledWith({ messageId: "" });
  });

  it("treats non-object tool params as empty input", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const profileUpdateTool = ctx.tools.find((tool) => tool.name === "moltenhub_profile_update");
    await profileUpdateTool!.execute("call-17", null as unknown as Record<string, unknown>);

    expect(ctx.updateProfile).toHaveBeenLastCalledWith({
      handle: undefined,
      metadata: {}
    });
  });

  it("uses default MoltenHubClient factory when none is provided", () => {
    const tools: OpenClawToolDefinition[] = [];
    const plugin = createMoltenHubOpenClawPlugin();

    plugin.register({
      pluginConfig: {
        baseUrl: "http://localhost:8080/v1",
        token: "token-a"
      },
      registerTool: (tool) => tools.push(tool)
    });

    expect(tools.length).toBe(NATIVE_TOOL_NAMES.length);
  });

  it("uses env fallback when plugin token is omitted", () => {
    const tools: OpenClawToolDefinition[] = [];
    const plugin = createMoltenHubOpenClawPlugin();

    plugin.register({
      pluginConfig: {
        baseUrl: "http://localhost:8080/v1"
      },
      env: {
        MOLTENHUB_AGENT_TOKEN: "token-from-env"
      },
      registerTool: (tool) => tools.push(tool)
    });

    expect(tools.length).toBe(NATIVE_TOOL_NAMES.length);
  });

  it("builds client when pluginConfig is omitted and env provides baseUrl + token", () => {
    const tools: OpenClawToolDefinition[] = [];
    const plugin = createMoltenHubOpenClawPlugin();

    plugin.register({
      env: {
        MOLTENHUB_BASE_URL: "http://localhost:8080/v1",
        MOLTENHUB_AGENT_TOKEN: "token-from-env-only"
      },
      registerTool: (tool) => tools.push(tool)
    });

    expect(tools.length).toBe(NATIVE_TOOL_NAMES.length);
  });

  it("falls back to string conversion for non-serializable tool output", async () => {
    const cyclic: Record<string, unknown> = { status: "ok" };
    cyclic.self = cyclic;

    const plugin = createMoltenHubOpenClawPlugin({
      createClient: () => ({
        requestSkillExecution: vi.fn(async () => cyclic as unknown as SkillExecutionResult),
        checkSession: vi.fn(async () => ({ status: "ok", sessionKey: "main", transport: "websocket" })),
        checkReadiness: vi.fn(async () => ({ status: "ok", checks: {} })),
        getProfile: vi.fn(async () => ({})),
        updateProfile: vi.fn(async () => ({})),
        getCapabilities: vi.fn(async () => ({})),
        getManifest: vi.fn(async () => ({})),
        getSkillGuide: vi.fn(async () => ({})),
        openClawPublish: vi.fn(async () => ({})),
        openClawPull: vi.fn(async () => ({})),
        openClawAck: vi.fn(async () => ({})),
        openClawNack: vi.fn(async () => ({})),
        openClawStatus: vi.fn(async () => ({}))
      })
    });

    const tools: OpenClawToolDefinition[] = [];
    plugin.register({
      pluginConfig: {
        baseUrl: "http://localhost:8080/v1",
        token: "token-a"
      },
      registerTool: (tool) => tools.push(tool)
    });

    const skillTool = tools.find((tool) => tool.name === "moltenhub_skill_request");
    const result = await skillTool!.execute("call-18", {
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "weather_lookup"
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "[object Object]" }],
      data: cyclic
    });
  });
});
