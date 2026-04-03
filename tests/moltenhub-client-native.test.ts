import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { MoltenHubClient, resolveConfig, type WebSocketLike } from "../src/moltenhub-client.js";
import type { MoltenHubPluginConfig } from "../src/types.js";

type OnSend = (payload: Record<string, unknown>, socket: FakeWebSocket) => void;
type RouteHandler = (url: URL, init: RequestInit) => Promise<Response> | Response;

interface FetchCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

class FakeWebSocket implements WebSocketLike {
  private readonly emitter = new EventEmitter();

  constructor(private readonly onSend?: OnSend) {}

  on(event: string, listener: (...args: unknown[]) => void): WebSocketLike {
    this.emitter.on(event, listener);
    return this;
  }

  send(data: string, callback?: (error?: Error) => void): void {
    try {
      const payload = JSON.parse(data) as Record<string, unknown>;
      this.onSend?.(payload, this);
      callback?.();
    } catch (error) {
      callback?.(error as Error);
    }
  }

  close(): void {
    this.emitter.emit("close");
  }

  emitOpen(): void {
    this.emitter.emit("open");
  }

  emitMessage(payload: Record<string, unknown> | string): void {
    if (typeof payload === "string") {
      this.emitter.emit("message", payload);
      return;
    }
    this.emitter.emit("message", JSON.stringify(payload));
  }

  emitRaw(payload: unknown): void {
    this.emitter.emit("message", payload);
  }

  emitError(message: string): void {
    this.emitter.emit("error", new Error(message));
  }
}

function baseConfig(overrides: Partial<MoltenHubPluginConfig> = {}): MoltenHubPluginConfig {
  const profile = {
    enabled: true,
    handle: undefined,
    metadata: undefined,
    syncIntervalMs: 300_000,
    ...(overrides.profile ?? {})
  };
  const connection = {
    healthcheckTtlMs: 30_000,
    ...(overrides.connection ?? {})
  };
  const safety = {
    blockMetadataSecrets: true,
    warnMessageSecrets: true,
    secretMarkers: [] as string[],
    ...(overrides.safety ?? {})
  };

  return {
    baseUrl: "http://127.0.0.1:8080/v1",
    token: "agent-token",
    sessionKey: "main",
    timeoutMs: 1_000,
    pluginId: "openclaw-plugin-moltenhub",
    pluginPackage: "@moltenbot/openclaw-plugin-moltenhub",
    pluginVersion: "0.1.6-test",
    ...overrides,
    profile,
    connection,
    safety
  };
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function textResponse(payload: string, status = 200): Response {
  const noBodyStatus = status === 204 || status === 205 || status === 304;
  return new Response(noBodyStatus ? null : payload, { status });
}

function createHarness(options?: {
  config?: Partial<MoltenHubPluginConfig>;
  handshakePayload?: unknown;
  onSend?: OnSend;
}): {
  client: MoltenHubClient;
  fetchImpl: ReturnType<typeof vi.fn>;
  wsFactory: ReturnType<typeof vi.fn>;
  calls: FetchCall[];
  route: (method: string, path: string, handler: RouteHandler) => void;
} {
  const calls: FetchCall[] = [];
  const routes = new Map<string, RouteHandler>();

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestURL = new URL(String(input));
    const requestInit = init ?? {};
    const method = (requestInit.method ?? "GET").toUpperCase();

    calls.push({
      method,
      path: requestURL.pathname,
      search: requestURL.search,
      body: parseBody(requestInit.body)
    });

    const withQuery = `${method} ${requestURL.pathname}${requestURL.search}`;
    const withoutQuery = `${method} ${requestURL.pathname}`;
    const handler = routes.get(withQuery) ?? routes.get(withoutQuery);
    if (!handler) {
      return jsonResponse({ ok: true, result: {} });
    }
    return handler(requestURL, requestInit);
  });

  const wsFactory = vi.fn(() => {
    const socket = new FakeWebSocket(options?.onSend);
    queueMicrotask(() => {
      socket.emitOpen();
      setTimeout(() => {
        const payload = options?.handshakePayload ?? { type: "session_ready", session_key: "main" };
        if (typeof payload === "string") {
          socket.emitMessage(payload);
          return;
        }
        if (
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          !Buffer.isBuffer(payload) &&
          !(payload instanceof ArrayBuffer)
        ) {
          socket.emitMessage(payload as Record<string, unknown>);
          return;
        }
        socket.emitRaw(payload);
      }, 0);
    });
    return socket;
  });

  const client = new MoltenHubClient(baseConfig(options?.config), {
    fetchImpl,
    wsFactory,
    randomID: () => "generated-request-id",
    now: () => new Date("2026-03-31T00:00:00.000Z")
  });

  const route = (method: string, path: string, handler: RouteHandler): void => {
    routes.set(`${method.toUpperCase()} ${path}`, handler);
  };

  return {
    client,
    fetchImpl,
    wsFactory,
    calls,
    route
  };
}

function runtimeJSON(client: MoltenHubClient, method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>, options?: { allowNoContent?: boolean }): Promise<Record<string, unknown>> {
  return (
    client as unknown as {
      runtimeJSON: (
        runtimeMethod: "GET" | "POST" | "PATCH",
        runtimePath: string,
        runtimeBody?: Record<string, unknown>,
        runtimeOptions?: { allowNoContent?: boolean }
      ) => Promise<Record<string, unknown>>;
    }
  ).runtimeJSON(method, path, body, options);
}

function runtimeText(client: MoltenHubClient, path: string): Promise<string> {
  return (
    client as unknown as {
      runtimeText: (runtimePath: string) => Promise<string>;
    }
  ).runtimeText(path);
}

describe("MoltenHubClient native runtime", () => {
  it("checkReadiness reports ok state with skipped profile sync", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("registered", 200));
    harness.route("GET", "/v1/agents/me/capabilities", () =>
      jsonResponse({
        ok: true,
        result: {
          control_plane: {
            can_communicate: true
          }
        }
      })
    );

    const readiness = await harness.client.checkReadiness();

    expect(readiness.status).toBe("ok");
    expect(readiness.canCommunicate).toBe(true);
    expect(readiness.checks.pluginRegistration.ok).toBe(true);
    expect(readiness.checks.profileSync.ok).toBe(true);
    expect(readiness.checks.profileSync.skipped).toBe(true);
    expect(readiness.checks.session.ok).toBe(true);
    expect(readiness.checks.capabilities.ok).toBe(true);
    expect(typeof readiness.checks.session.checkedAt).toBe("string");
  });

  it("checkReadiness reports degraded status with explicit errors", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: true,
          metadata: {
            note: "contains password marker"
          },
          syncIntervalMs: 300_000
        }
      },
      handshakePayload: { type: "not_ready" }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("forbidden", 500));
    harness.route("GET", "/v1/agents/me/capabilities", () =>
      jsonResponse(
        {
          error: {
            code: "capabilities_unavailable",
            message: "caps down"
          }
        },
        503
      )
    );

    const readiness = await harness.client.checkReadiness();

    expect(readiness.status).toBe("degraded");
    expect(readiness.canCommunicate).toBeUndefined();
    expect(readiness.checks.pluginRegistration.ok).toBe(false);
    expect(readiness.checks.profileSync.ok).toBe(false);
    expect(readiness.checks.session.ok).toBe(false);
    expect(readiness.checks.capabilities.ok).toBe(false);
    expect(readiness.checks.capabilities.error).toContain("caps down");
  });

  it("treats missing register-plugin route as skipped readiness check", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () =>
      jsonResponse(
        {
          error: "route_not_found",
          error_detail: {
            code: "route_not_found",
            message: "missing route"
          }
        },
        404
      )
    );
    harness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: { can_communicate: true } }));

    const readiness = await harness.client.checkReadiness();
    await harness.client.getCapabilities();
    await harness.client.getCapabilities();

    expect(readiness.status).toBe("ok");
    expect(readiness.checks.pluginRegistration.ok).toBe(true);
    expect(readiness.checks.pluginRegistration.skipped).toBe(true);
    expect(readiness.transport).toBe("websocket");

    const registrationCalls = harness.calls.filter((call) => call.path === "/v1/openclaw/messages/register-plugin");
    expect(registrationCalls).toHaveLength(1);
  });

  it("gets profile data through runtime JSON API", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("GET", "/v1/agents/me", () =>
      jsonResponse({
        ok: true,
        result: {
          agent_uuid: "agent-123"
        }
      })
    );

    const profile = await harness.client.getProfile();

    expect(profile).toEqual({
      agent_uuid: "agent-123"
    });
  });

  it("blocks updateProfile metadata containing secret markers when policy blocks", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    await expect(
      harness.client.updateProfile({
        metadata: {
          unsafe: "api key = 123"
        }
      })
    ).rejects.toThrow("blocked by plugin safety policy");

    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.wsFactory).not.toHaveBeenCalled();
  });

  it("returns warnings when updateProfile allows secret-like metadata", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        },
        safety: {
          blockMetadataSecrets: false,
          warnMessageSecrets: true,
          secretMarkers: ["token:"]
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("PATCH", "/v1/agents/me/metadata", () =>
      jsonResponse({
        ok: true,
        result: {
          updated: true
        }
      })
    );

    const result = await harness.client.updateProfile({
      metadata: {
        note: "token: abc"
      }
    });

    expect(result).toMatchObject({
      updated: true
    });
    expect(Array.isArray(result.warnings)).toBe(true);
    expect((result.warnings as Array<{ marker: string }>)[0]?.marker).toBe("token:");
  });

  it("uses profile read endpoint when updateProfile patch payload is empty", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("GET", "/v1/agents/me", () =>
      jsonResponse({
        ok: true,
        result: {
          from: "get"
        }
      })
    );

    const result = await harness.client.updateProfile({});

    expect(result).toEqual({ from: "get" });
    expect(harness.calls.some((call) => call.path === "/v1/agents/me/metadata")).toBe(false);
  });

  it("retrieves capabilities, manifest, and skill guides in json/markdown modes", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: { caps: ["skill"] } }));
    harness.route("GET", "/v1/agents/me/manifest", () => jsonResponse({ ok: true, result: { manifest: "json" } }));
    harness.route("GET", "/v1/agents/me/manifest?format=markdown", () => textResponse("# manifest"));
    harness.route("GET", "/v1/agents/me/skill", () => jsonResponse({ ok: true, result: { skill: "json" } }));
    harness.route("GET", "/v1/agents/me/skill?format=markdown", () => textResponse("# skill"));

    const capabilities = await harness.client.getCapabilities();
    const manifestJSON = await harness.client.getManifest("json");
    const manifestMarkdown = await harness.client.getManifest("markdown");
    const skillJSON = await harness.client.getSkillGuide("json");
    const skillMarkdown = await harness.client.getSkillGuide("markdown");

    expect(capabilities).toEqual({ caps: ["skill"] });
    expect(manifestJSON).toEqual({ manifest: "json" });
    expect(manifestMarkdown).toEqual({ format: "markdown", content: "# manifest" });
    expect(skillJSON).toEqual({ skill: "json" });
    expect(skillMarkdown).toEqual({ format: "markdown", content: "# skill" });
  });

  it("parses runtimeText endpoint errors from markdown endpoints", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("GET", "/v1/agents/me/manifest?format=markdown", () =>
      jsonResponse(
        {
          error: {
            code: "manifest_error",
            message: "manifest unavailable"
          }
        },
        500
      )
    );

    await expect(harness.client.getManifest("markdown")).rejects.toThrow("manifest unavailable");
  });

  it("validates publish inputs and emits capped secret warnings", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        },
        safety: {
          blockMetadataSecrets: false,
          warnMessageSecrets: true,
          secretMarkers: ["secret"]
        }
      }
    });

    await expect(
      harness.client.openClawPublish({
        message: {
          kind: "event"
        }
      })
    ).rejects.toThrow("toAgentUUID or toAgentURI is required");

    await expect(
      harness.client.openClawPublish({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        message: {}
      })
    ).rejects.toThrow("message is required");

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("POST", "/v1/openclaw/messages/publish", () =>
      jsonResponse({ ok: true, result: { message_id: "message-1" } })
    );

    const warningMessage = {
      payload: Array.from({ length: 30 }, (_, index) => `secret-${index}`),
      nested: {
        value: "very secret"
      },
      numberValue: 12
    };

    const result = await harness.client.openClawPublish({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      message: warningMessage
    });
    const uriOnlyResult = await harness.client.openClawPublish({
      toAgentURI: "https://example.test/agents/peer-1",
      message: {
        kind: "ping"
      }
    });

    expect(result.message_id).toBe("message-1");
    expect(uriOnlyResult.message_id).toBe("message-1");
    expect(Array.isArray(result.warnings)).toBe(true);
    expect((result.warnings as unknown[]).length).toBe(20);
    const publishBodies = harness.calls
      .filter((call) => call.path === "/v1/openclaw/messages/publish")
      .map((call) => call.body as { to_agent_uuid?: string; to_agent_uri?: string });
    expect(
      publishBodies.some(
        (body) => body.to_agent_uuid === undefined && body.to_agent_uri === "https://example.test/agents/peer-1"
      )
    ).toBe(true);
  });

  it("supports disabling message secret warnings", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        },
        safety: {
          blockMetadataSecrets: false,
          warnMessageSecrets: false,
          secretMarkers: ["secret"]
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("POST", "/v1/openclaw/messages/publish", () =>
      jsonResponse({ ok: true, result: { message_id: "message-2" } })
    );

    const result = await harness.client.openClawPublish({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      message: {
        secret: "secret"
      }
    });

    expect(result).toEqual({ message_id: "message-2" });
  });

  it("handles openclaw pull timeout normalization and validation", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("GET", "/v1/openclaw/messages/pull?timeout_ms=5000", () => textResponse("", 204));
    harness.route("GET", "/v1/openclaw/messages/pull?timeout_ms=7", () =>
      jsonResponse({ ok: true, result: { delivery_id: "delivery-7" } })
    );

    const defaultPull = await harness.client.openClawPull({});
    const nanPull = await harness.client.openClawPull({ timeoutMs: Number.NaN });
    const customPull = await harness.client.openClawPull({ timeoutMs: 7 });

    expect(defaultPull).toEqual({ status: "empty" });
    expect(nanPull).toEqual({ status: "empty" });
    expect(customPull).toEqual({ delivery_id: "delivery-7" });

    await expect(harness.client.openClawPull({ timeoutMs: -1 })).rejects.toThrow("between 0 and 30000");
    await expect(harness.client.openClawPull({ timeoutMs: 30001 })).rejects.toThrow("between 0 and 30000");
  });

  it("validates and executes ack, nack, and status routes", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    await expect(harness.client.openClawAck({})).rejects.toThrow("deliveryId is required");
    await expect(harness.client.openClawNack({})).rejects.toThrow("deliveryId is required");
    await expect(harness.client.openClawStatus({})).rejects.toThrow("messageId is required");

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("POST", "/v1/openclaw/messages/ack", () => jsonResponse({ ok: true, result: { status: "acked" } }));
    harness.route("POST", "/v1/openclaw/messages/nack", () => jsonResponse({ ok: true, result: { status: "nacked" } }));
    harness.route("GET", "/v1/openclaw/messages/message%2Fid", () =>
      jsonResponse({ ok: true, result: { status: "delivered" } })
    );

    const ack = await harness.client.openClawAck({ deliveryId: "delivery-a" });
    const nack = await harness.client.openClawNack({ deliveryId: "delivery-b" });
    const status = await harness.client.openClawStatus({ messageId: "message/id" });

    expect(ack).toEqual({ status: "acked" });
    expect(nack).toEqual({ status: "nacked" });
    expect(status).toEqual({ status: "delivered" });
  });

  it("reports online status once and transitions offline on explicit close signal", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    const statusBodies: Array<Record<string, unknown>> = [];

    harness.route("PATCH", "/v1/agents/me/status", (_url, init) => {
      statusBodies.push(parseBody(init.body) as Record<string, unknown>);
      return jsonResponse({ ok: true, result: {} });
    });
    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: { can_communicate: true } }));

    await harness.client.getCapabilities();
    await harness.client.getCapabilities();
    await harness.client.markOffline();
    await harness.client.markOffline();

    expect(statusBodies).toEqual([{ status: "online" }, { status: "offline" }]);
  });

  it("disables agent status updates when update-status route is unavailable", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("PATCH", "/v1/agents/me/status", () =>
      jsonResponse(
        {
          error: "route_not_found",
          error_detail: {
            code: "route_not_found",
            message: "missing route"
          }
        },
        404
      )
    );
    harness.route("POST", "/v1/agents/me/status", () =>
      jsonResponse(
        {
          error: "route_not_found",
          error_detail: {
            code: "route_not_found",
            message: "missing route"
          }
        },
        404
      )
    );
    harness.route("POST", "/v1/agents/me/update-status", () =>
      jsonResponse(
        {
          error: "route_not_found",
          error_detail: {
            code: "route_not_found",
            message: "missing route"
          }
        },
        404
      )
    );
    harness.route("POST", "/v1/agents/update-status", () =>
      jsonResponse(
        {
          error: "route_not_found",
          error_detail: {
            code: "route_not_found",
            message: "missing route"
          }
        },
        404
      )
    );
    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: { can_communicate: true } }));

    await harness.client.getCapabilities();
    await harness.client.getCapabilities();
    await harness.client.markOffline();

    const statusCalls = harness.calls.filter(
      (call) =>
        call.path === "/v1/agents/me/status" ||
        call.path === "/v1/agents/me/update-status" ||
        call.path === "/v1/agents/update-status"
    );
    expect(statusCalls).toHaveLength(4);
  });

  it("reuses cached session health checks within configured ttl", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        },
        connection: {
          healthcheckTtlMs: 60_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: { can_communicate: false } }));

    await harness.client.getCapabilities();
    await harness.client.getCapabilities();

    const registrationCalls = harness.calls.filter((call) => call.path.endsWith("/openclaw/messages/register-plugin"));
    expect(registrationCalls).toHaveLength(2);
    expect(harness.wsFactory).toHaveBeenCalledTimes(1);
  });

  it("syncs profile metadata and only finalizes handle once", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: true,
          handle: "agent-handle",
          metadata: {
            profile_markdown: "# hello"
          },
          syncIntervalMs: 300_000
        }
      }
    });

    const patchBodies: Array<Record<string, unknown>> = [];

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("PATCH", "/v1/agents/me/metadata", (_url, init) => {
      patchBodies.push(parseBody(init.body) as Record<string, unknown>);
      return jsonResponse({ ok: true, result: {} });
    });
    harness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: { can_communicate: false } }));

    await harness.client.getCapabilities();
    await harness.client.getCapabilities();
    expect(patchBodies).toHaveLength(1);

    const readiness = await harness.client.checkReadiness();

    expect(patchBodies).toHaveLength(2);
    expect(patchBodies[0]?.handle).toBe("agent-handle");
    expect(patchBodies[1]?.handle).toBeUndefined();
    expect(readiness.canCommunicate).toBe(false);
  });

  it("normalizes legacy runtime config defaults for missing or non-finite fields", () => {
    const sparseLegacyConfig = {
      baseUrl: "http://127.0.0.1:8080/v1",
      token: "agent-token",
      sessionKey: "main",
      timeoutMs: 1_000,
      pluginId: "openclaw-plugin-moltenhub",
      pluginPackage: "@moltenbot/openclaw-plugin-moltenhub",
      pluginVersion: "0.1.6-test"
    } as unknown as MoltenHubPluginConfig;

    const sparseClient = new MoltenHubClient(sparseLegacyConfig);
    const sparseNormalized = (sparseClient as unknown as { config: MoltenHubPluginConfig }).config;

    expect(sparseNormalized.profile.enabled).toBe(true);
    expect(sparseNormalized.profile.syncIntervalMs).toBe(300_000);
    expect(sparseNormalized.connection.healthcheckTtlMs).toBe(30_000);
    expect(sparseNormalized.safety.blockMetadataSecrets).toBe(true);
    expect(sparseNormalized.safety.warnMessageSecrets).toBe(true);

    const legacyConfig = {
      baseUrl: "http://127.0.0.1:8080/v1",
      token: "agent-token",
      sessionKey: "main",
      timeoutMs: 1_000,
      pluginId: "openclaw-plugin-moltenhub",
      pluginPackage: "@moltenbot/openclaw-plugin-moltenhub",
      pluginVersion: "0.1.6-test",
      profile: {
        enabled: true,
        syncIntervalMs: Number.NaN
      },
      connection: {
        healthcheckTtlMs: Number.NaN
      },
      safety: {}
    } as unknown as MoltenHubPluginConfig;

    const client = new MoltenHubClient(legacyConfig);
    const normalized = (client as unknown as { config: MoltenHubPluginConfig }).config;

    expect(normalized.profile.syncIntervalMs).toBe(300_000);
    expect(normalized.connection.healthcheckTtlMs).toBe(30_000);
    expect(normalized.safety.blockMetadataSecrets).toBe(true);
    expect(normalized.safety.warnMessageSecrets).toBe(true);
    expect(normalized.safety.secretMarkers.length).toBeGreaterThan(0);
  });

  it("normalizes plugin metadata key fallback for empty and invalid plugin ids", async () => {
    const emptyKeyHarness = createHarness({
      config: {
        pluginId: "   ",
        profile: {
          enabled: true,
          syncIntervalMs: 300_000
        }
      }
    });
    let emptyKey = "";

    emptyKeyHarness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    emptyKeyHarness.route("PATCH", "/v1/agents/me/metadata", (_url, init) => {
      const body = parseBody(init.body) as { metadata?: { plugins?: Record<string, unknown> } };
      emptyKey = Object.keys(body.metadata?.plugins ?? {})[0] ?? "";
      return jsonResponse({ ok: true, result: {} });
    });
    emptyKeyHarness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: {} }));

    await emptyKeyHarness.client.getCapabilities();
    expect(emptyKey).toBe("moltenhub-openclaw");

    const invalidKeyHarness = createHarness({
      config: {
        pluginId: "!!!",
        profile: {
          enabled: true,
          syncIntervalMs: 300_000
        }
      }
    });
    let invalidKey = "";

    invalidKeyHarness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    invalidKeyHarness.route("PATCH", "/v1/agents/me/metadata", (_url, init) => {
      const body = parseBody(init.body) as { metadata?: { plugins?: Record<string, unknown> } };
      invalidKey = Object.keys(body.metadata?.plugins ?? {})[0] ?? "";
      return jsonResponse({ ok: true, result: {} });
    });
    invalidKeyHarness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: {} }));

    await invalidKeyHarness.client.getCapabilities();
    expect(invalidKey).toBe("moltenhub_openclaw");
  });

  it("retries profile sync without handle when API says handle is locked", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: true,
          handle: "locked-handle",
          metadata: {
            bio: "hello"
          },
          syncIntervalMs: 300_000
        }
      }
    });

    const patchBodies: Array<Record<string, unknown>> = [];

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("PATCH", "/v1/agents/me/metadata", (_url, init) => {
      patchBodies.push(parseBody(init.body) as Record<string, unknown>);
      if (patchBodies.length === 1) {
        return jsonResponse(
          {
            error: {
              code: "agent_handle_locked",
              message: "handle already locked"
            }
          },
          409
        );
      }
      return jsonResponse({ ok: true, result: {} });
    });
    harness.route("GET", "/v1/agents/me", () => jsonResponse({ ok: true, result: { agent_uuid: "agent-1" } }));

    const profile = await harness.client.getProfile();

    expect(profile.agent_uuid).toBe("agent-1");
    expect(patchBodies).toHaveLength(2);
    expect(patchBodies[0]?.handle).toBe("locked-handle");
    expect(patchBodies[1]?.handle).toBeUndefined();
  });

  it("retries profile sync metadata patch when non-API error mentions agent_exists", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: true,
          handle: "retry-handle",
          metadata: {
            bio: "hello"
          },
          syncIntervalMs: 300_000
        }
      }
    });

    let patchCalls = 0;

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("PATCH", "/v1/agents/me/metadata", () => {
      patchCalls += 1;
      if (patchCalls === 1) {
        throw new Error("agent_exists");
      }
      return jsonResponse({ ok: true, result: {} });
    });
    harness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: {} }));

    await harness.client.getCapabilities();

    expect(patchCalls).toBe(2);
  });

  it("fails profile sync when handle error is not ignorable", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: true,
          handle: "bad-handle",
          metadata: {
            bio: "hello"
          },
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("PATCH", "/v1/agents/me/metadata", () =>
      jsonResponse(
        {
          error: {
            code: "forbidden_handle",
            message: "cannot use this handle"
          }
        },
        409
      )
    );

    await expect(harness.client.getCapabilities()).rejects.toThrow("cannot use this handle");
  });

  it("blocks profile sync when metadata contains secret markers", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: true,
          metadata: {
            secret: "password=abc"
          },
          syncIntervalMs: 300_000
        }
      }
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));

    await expect(harness.client.getCapabilities()).rejects.toThrow("profile sync metadata contains secret-like values");
    expect(harness.wsFactory).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.path === "/v1/agents/me/metadata")).toBe(false);
  });

  it("reuses in-flight profile sync promise for concurrent readiness calls", async () => {
    const harness = createHarness({
      config: {
        profile: {
          enabled: true,
          metadata: {
            profile_markdown: "# hi"
          },
          syncIntervalMs: 300_000
        }
      }
    });

    let patchCalls = 0;
    let resolvePatch: ((value: Response) => void) | undefined;

    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });

    harness.route("POST", "/v1/openclaw/messages/register-plugin", () => textResponse("ok"));
    harness.route("PATCH", "/v1/agents/me/metadata", () => {
      patchCalls += 1;
      if (patchCalls === 1) {
        return pendingPatch;
      }
      return jsonResponse({ ok: true, result: {} });
    });
    harness.route("GET", "/v1/agents/me/capabilities", () => jsonResponse({ ok: true, result: { caps: true } }));
    harness.route("GET", "/v1/agents/me/manifest", () => jsonResponse({ ok: true, result: { manifest: true } }));

    const first = harness.client.getCapabilities();
    const second = harness.client.getManifest("json");

    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvePatch?.(jsonResponse({ ok: true, result: {} }));

    const [capabilities, manifest] = await Promise.all([first, second]);

    expect(capabilities).toEqual({ caps: true });
    expect(manifest).toEqual({ manifest: true });
    expect(patchCalls).toBe(1);
  });

  it("returns warnings from requestSkillExecution input payload scanning", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: payload.request_id,
          status: 202,
          result: {}
        });
        current.emitMessage({
          type: "delivery",
          result: {
            message: { message_id: "message-req" },
            delivery: { delivery_id: "delivery-req" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "generated-request-id",
              status: "ok",
              output: "done"
            }
          }
        });
      }
      if (payload.type === "ack") {
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: payload.request_id,
          status: 200,
          result: {}
        });
      }
    });

    const client = new MoltenHubClient(
      baseConfig({
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        },
        safety: {
          blockMetadataSecrets: false,
          warnMessageSecrets: true,
          secretMarkers: ["token:"]
        }
      }),
      {
        fetchImpl: vi.fn(async () => textResponse("ok", 200)),
        wsFactory: () => {
          queueMicrotask(() => {
            socket.emitOpen();
            setTimeout(() => {
              socket.emitMessage({ type: "session_ready", session_key: "main" });
            }, 0);
          });
          return socket;
        },
        randomID: () => "generated-request-id"
      }
    );

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "echo",
      input: {
        text: "token:abc"
      }
    });

    expect(result.status).toBe("ok");
    expect(Array.isArray(result.warnings)).toBe(true);
    expect((result.warnings as Array<{ fieldPath: string }>)[0]?.fieldPath).toContain("$.payload");
  });

  it("covers runtimeJSON envelope normalization and error parsing branches", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse("", 204))
      .mockResolvedValueOnce(textResponse("", 204))
      .mockResolvedValueOnce(textResponse("gateway exploded", 502))
      .mockResolvedValueOnce(textResponse("   ", 200))
      .mockResolvedValueOnce(textResponse("not-json", 200))
      .mockResolvedValueOnce(textResponse("[]", 200))
      .mockResolvedValueOnce(
        textResponse('{"ok":false,"error":"bad_request","message":"bad envelope","retryable":true,"next_action":"retry"}', 200)
      )
      .mockResolvedValueOnce(textResponse('{"ok":true,"result":{"value":1}}', 200))
      .mockResolvedValueOnce(textResponse('{"ok":true,"result":42}', 200))
      .mockResolvedValueOnce(textResponse('{"hello":"world"}', 200))
      .mockResolvedValueOnce(textResponse('{"error":{"code":"nested_fail","message":"nested message"}}', 500))
      .mockResolvedValueOnce(textResponse("", 500))
      .mockResolvedValueOnce(textResponse("{}", 500))
      .mockResolvedValueOnce(textResponse('{"ok":true}', 200));

    const client = new MoltenHubClient(baseConfig(), {
      fetchImpl
    });

    await expect(runtimeJSON(client, "GET", "/a", undefined, { allowNoContent: true })).resolves.toEqual({ status: "empty" });
    await expect(runtimeJSON(client, "GET", "/b")).resolves.toEqual({});
    await expect(runtimeJSON(client, "GET", "/c")).rejects.toThrow("gateway exploded");
    await expect(runtimeJSON(client, "GET", "/d")).resolves.toEqual({});
    await expect(runtimeJSON(client, "GET", "/e")).resolves.toEqual({ content: "not-json" });
    await expect(runtimeJSON(client, "GET", "/f")).resolves.toEqual({ value: [] });

    await expect(runtimeJSON(client, "GET", "/g")).rejects.toMatchObject({
      code: "bad_request",
      retryable: true,
      nextAction: "retry"
    });

    await expect(runtimeJSON(client, "GET", "/h")).resolves.toEqual({ value: 1 });
    await expect(runtimeJSON(client, "GET", "/i")).resolves.toEqual({ value: 42 });
    await expect(runtimeJSON(client, "GET", "/j")).resolves.toEqual({ hello: "world" });

    await expect(runtimeJSON(client, "GET", "/k")).rejects.toMatchObject({
      code: "nested_fail",
      message: "nested message"
    });
    await expect(runtimeJSON(client, "GET", "/l")).rejects.toThrow("request failed with status 500");
    await expect(runtimeJSON(client, "GET", "/m")).rejects.toMatchObject({
      code: "http_error",
      message: "{}"
    });
    await expect(runtimeJSON(client, "GET", "n")).resolves.toEqual({ ok: true });
  });

  it("covers runtimeText success and fallback error parsing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse("# markdown", 200))
      .mockResolvedValueOnce(textResponse('{"error":{"code":"md_fail","message":"markdown failed"}}', 500))
      .mockResolvedValueOnce(textResponse("plain failure", 500));

    const client = new MoltenHubClient(baseConfig(), {
      fetchImpl
    });

    await expect(runtimeText(client, "/markdown")).resolves.toBe("# markdown");
    await expect(runtimeText(client, "/markdown-error")).rejects.toMatchObject({
      code: "md_fail"
    });
    await expect(runtimeText(client, "/markdown-fallback")).rejects.toThrow("plain failure");
  });

  it("resolveConfig merges nested metadata, clamps values, and parses marker lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "moltenhub-native-config-"));
    const filePath = join(dir, "config.json");

    writeFileSync(
      filePath,
      JSON.stringify({
        baseUrl: "https://file.example.com/v1/",
        token: "token-file",
        profile: {
          enabled: true,
          syncIntervalMs: 1,
          metadata: {
            nested: {
              file: true
            }
          }
        },
        connection: {
          healthcheckTtlMs: 9_999_999
        },
        safety: {
          secretMarkers: ["file-marker"]
        },
        secretMarkers: ["file-root-marker"]
      }),
      "utf8"
    );

    const resolved = resolveConfig({
      config: {
        configFile: filePath,
        baseURL: "https://inline.example.com/v1/",
        token: "token-inline",
        profileMetadata: {
          nested: {
            legacy: true
          }
        },
        profile: {
          enabled: false,
          syncIntervalMs: 99_999_999,
          metadata: {
            nested: {
              inline: true
            }
          }
        },
        connection: {
          healthcheckTtlMs: 2
        },
        safety: {
          blockMetadataSecrets: false,
          warnMessageSecrets: false,
          secretMarkers: "inline-marker-a, inline-marker-b" as unknown as string[]
        },
        secretMarkers: "legacy-marker-a, legacy-marker-b" as unknown as string[]
      },
      env: {
        MOLTENHUB_SECRET_MARKERS: "env-marker-a, env-marker-b",
        MOLTENHUB_PROFILE_ENABLED: "on",
        MOLTENHUB_HEALTHCHECK_TTL_MS: "777777"
      }
    });

    expect(resolved.baseUrl).toBe("https://inline.example.com/v1");
    expect(resolved.token).toBe("token-inline");
    expect(resolved.profile.enabled).toBe(false);
    expect(resolved.profile.syncIntervalMs).toBe(86_400_000);
    expect(resolved.connection.healthcheckTtlMs).toBe(1_000);
    expect(resolved.profile.metadata).toEqual({
      nested: {
        file: true,
        legacy: true,
        inline: true
      }
    });
    expect(resolved.safety.blockMetadataSecrets).toBe(false);
    expect(resolved.safety.warnMessageSecrets).toBe(false);
    expect(resolved.safety.secretMarkers).toEqual(expect.arrayContaining(["file-marker", "file-root-marker", "legacy-marker-a", "inline-marker-a", "env-marker-a"]));
  });

  it("resolveConfig supports api-base env fallback and string booleans", () => {
    const resolved = resolveConfig({
      env: {
        MOLTENHUB_API_BASE: "https://api-base.example.com/v1/",
        MOLTENHUB_AGENT_TOKEN: "token-env",
        MOLTENHUB_PROFILE_ENABLED: "no",
        MOLTENHUB_BLOCK_METADATA_SECRETS: "yes",
        MOLTENHUB_WARN_MESSAGE_SECRETS: "0"
      }
    });

    expect(resolved.baseUrl).toBe("https://api-base.example.com/v1");
    expect(resolved.profile.enabled).toBe(false);
    expect(resolved.safety.blockMetadataSecrets).toBe(true);
    expect(resolved.safety.warnMessageSecrets).toBe(false);
  });

  it("resolveConfig ignores invalid boolean strings and falls back to defaults", () => {
    const resolved = resolveConfig({
      env: {
        MOLTENHUB_API_BASE: "https://api-base.example.com/v1/",
        MOLTENHUB_AGENT_TOKEN: "token-env",
        MOLTENHUB_PROFILE_ENABLED: "maybe",
        MOLTENHUB_WARN_MESSAGE_SECRETS: "unclear"
      }
    });

    expect(resolved.profile.enabled).toBe(true);
    expect(resolved.safety.warnMessageSecrets).toBe(true);
  });
});
