import { describe, expect, it, vi } from "vitest";

import { createMoltenHubOpenClawPlugin } from "../src/plugin.js";
import type { OpenClawToolDefinition } from "../src/types.js";

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

  const plugin = createMoltenHubOpenClawPlugin({
    createClient: () => ({
      requestSkillExecution,
      checkSession
    })
  });

  return {
    plugin,
    tools,
    requestSkillExecution,
    checkSession,
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

describe("createMoltenHubOpenClawPlugin", () => {
  it("registers skill and session tools", () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    expect(ctx.tools.map((tool) => tool.name)).toEqual([
      "moltenhub_skill_request",
      "moltenhub_session_status"
    ]);
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
    expect(ctx.requestSkillExecution).toHaveBeenCalledTimes(1);
    expect(ctx.requestSkillExecution).toHaveBeenCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      skillName: "weather_lookup",
      input: { city: "Seattle" },
      timeoutMs: 500,
      sessionKey: "main",
      requestId: "req-123"
    });
  });

  it("drops non-finite timeout values", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const skillTool = ctx.tools.find((tool) => tool.name === "moltenhub_skill_request");
    expect(skillTool).toBeDefined();

    await skillTool!.execute("call-2", {
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "weather_lookup",
      timeoutMs: Number.POSITIVE_INFINITY
    });

    expect(ctx.requestSkillExecution).toHaveBeenLastCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      skillName: "weather_lookup",
      input: undefined,
      timeoutMs: undefined,
      sessionKey: undefined,
      requestId: undefined
    });
  });

  it("passes empty skillName when omitted", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const skillTool = ctx.tools.find((tool) => tool.name === "moltenhub_skill_request");
    expect(skillTool).toBeDefined();

    await skillTool!.execute("call-3", {
      toAgentUUID: "11111111-1111-1111-1111-111111111111"
    });

    expect(ctx.requestSkillExecution).toHaveBeenLastCalledWith({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      toAgentURI: undefined,
      skillName: "",
      input: undefined,
      timeoutMs: undefined,
      sessionKey: undefined,
      requestId: undefined
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

    expect(tools.length).toBe(2);
  });

  it("calls session status on demand and returns tool content", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);

    const statusTool = ctx.tools.find((tool) => tool.name === "moltenhub_session_status");
    expect(statusTool).toBeDefined();

    const status = await statusTool!.execute("call-4", {});
    expect(status).toEqual({
      content: [
        {
          type: "text",
          text: '{"status":"ok","sessionKey":"main","transport":"websocket"}'
        }
      ],
      data: {
        status: "ok",
        sessionKey: "main",
        transport: "websocket"
      }
    });
    expect(ctx.checkSession).toHaveBeenCalledTimes(1);
  });

  it("uses api env fallback for required configuration", () => {
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
    expect(tools.length).toBe(2);
  });

  it("supports env-only configuration when plugin config is omitted", () => {
    const tools: OpenClawToolDefinition[] = [];
    const plugin = createMoltenHubOpenClawPlugin();
    plugin.register({
      env: {
        MOLTENHUB_BASE_URL: "http://localhost:8080/v1",
        MOLTENHUB_AGENT_TOKEN: "token-only-env"
      },
      registerTool: (tool) => tools.push(tool)
    });
    expect(tools.length).toBe(2);
  });

  it("treats non-object tool params as empty input", async () => {
    const ctx = setupPluginWithMockClient();
    ctx.plugin.register(ctx.api);
    const skillTool = ctx.tools.find((tool) => tool.name === "moltenhub_skill_request");
    expect(skillTool).toBeDefined();

    await skillTool!.execute("call-5", null as unknown as Record<string, unknown>);

    expect(ctx.requestSkillExecution).toHaveBeenLastCalledWith({
      toAgentUUID: undefined,
      toAgentURI: undefined,
      skillName: "",
      input: undefined,
      timeoutMs: undefined,
      sessionKey: undefined,
      requestId: undefined
    });
  });

  it("falls back to string conversion for non-serializable tool output", async () => {
    const cyclic: Record<string, unknown> = { status: "ok" };
    cyclic.self = cyclic;
    const requestSkillExecution = vi.fn(async () => cyclic as unknown as {
      requestId: string;
      skillName: string;
      status: string;
      output: unknown;
      messageId: string;
      deliveryId: string;
    });
    const plugin = createMoltenHubOpenClawPlugin({
      createClient: () => ({
        requestSkillExecution,
        checkSession: vi.fn(async () => ({ status: "ok", sessionKey: "main", transport: "websocket" }))
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
    expect(skillTool).toBeDefined();

    const result = await skillTool!.execute("call-6", {
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "weather_lookup"
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "[object Object]" }],
      data: cyclic
    });
  });
});
