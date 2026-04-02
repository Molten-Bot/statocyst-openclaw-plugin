import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveConfig, MoltenHubClient, type WebSocketLike } from "../src/moltenhub-client.js";

type OnSend = (payload: Record<string, unknown>, socket: FakeWebSocket) => void;

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

function testConfig() {
  return {
    baseUrl: "http://127.0.0.1:8080/v1",
    token: "agent-token",
    sessionKey: "main",
    timeoutMs: 1000,
    pluginId: "openclaw-plugin-moltenhub",
    pluginPackage: "@moltenbot/openclaw-plugin-moltenhub",
    pluginVersion: "0.1.0-test",
    profile: {
      enabled: true,
      syncIntervalMs: 300000
    },
    connection: {
      healthcheckTtlMs: 30000
    },
    safety: {
      blockMetadataSecrets: true,
      warnMessageSecrets: true,
      secretMarkers: []
    }
  };
}

function writeTempJSONFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "moltenhub-openclaw-plugin-"));
  const filePath = join(dir, "config.json");
  writeFileSync(filePath, JSON.stringify(content), "utf8");
  return filePath;
}

function fetchOKSpy() {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

function openAndReady(
  socket: FakeWebSocket,
  payload: Record<string, unknown> | string | unknown = { type: "session_ready", session_key: "main" }
): void {
  queueMicrotask(() => {
    socket.emitOpen();
    setTimeout(() => {
      if (typeof payload === "string") {
        socket.emitMessage(payload);
        return;
      }
      if (payload && typeof payload === "object" && !Buffer.isBuffer(payload) && !(payload instanceof ArrayBuffer) && !Array.isArray(payload)) {
        socket.emitMessage(payload as Record<string, unknown>);
        return;
      }
      socket.emitRaw(payload);
    }, 0);
  });
}

describe("MoltenHubClient", () => {
  it("registers plugin and completes skill request over websocket", async () => {
    let receivedURL = "";
    let receivedAuth = "";
    let sentSkillRequest: Record<string, unknown> | undefined;

    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        sentSkillRequest = (payload.message ?? {}) as Record<string, unknown>;
        current.emitRaw(
          Buffer.from(
            JSON.stringify({
              type: "response",
              ok: true,
              request_id: payload.request_id,
              status: 202,
              result: { message_id: "message-1" }
            }),
            "utf8"
          )
        );
        current.emitRaw([
          Buffer.from(
            JSON.stringify({
              type: "delivery",
              result: {
                message: { message_id: "message-1" },
                delivery: { delivery_id: "delivery-1" },
                openclaw_message: {
                  kind: "skill_result",
                  request_id: "req-1",
                  status: "ok",
                  output: { weather: "sunny" }
                }
              }
            }),
            "utf8"
          )
        ]);
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

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-1",
      wsFactory: (url, headers) => {
        receivedURL = url;
        receivedAuth = String(headers.Authorization ?? "");
        openAndReady(
          socket,
          new TextEncoder().encode(JSON.stringify({ type: "session_ready", session_key: "main" })).buffer
        );
        return socket;
      }
    });

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "weather_lookup"
    });

    expect(result).toEqual({
      requestId: "req-1",
      skillName: "weather_lookup",
      status: "ok",
      output: { weather: "sunny" },
      error: undefined,
      messageId: "message-1",
      deliveryId: "delivery-1"
    });
    expect(receivedURL).toBe("ws://127.0.0.1:8080/v1/openclaw/messages/ws?session_key=main");
    expect(receivedAuth).toBe("Bearer agent-token");
    expect(sentSkillRequest?.skill_name).toBe("weather_lookup");
    expect(sentSkillRequest?.payload_format).toBe("json");
    expect(sentSkillRequest?.payload).toEqual({});
  });

  it("sends markdown skill payload when requested", async () => {
    let sentSkillRequest: Record<string, unknown> | undefined;

    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        sentSkillRequest = (payload.message ?? {}) as Record<string, unknown>;
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
            message: { message_id: "message-markdown" },
            delivery: { delivery_id: "delivery-markdown" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "req-markdown",
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

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-markdown",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "markdown_echo",
      payloadFormat: "markdown",
      payload: "# hello"
    });

    expect(result.status).toBe("ok");
    expect(sentSkillRequest?.payload_format).toBe("markdown");
    expect(sentSkillRequest?.payload).toBe("# hello");
    expect(sentSkillRequest?.input).toBe("# hello");
  });

  it("rejects markdown payload format when payload is not a string", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const wsFactory = vi.fn(() => new FakeWebSocket());

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl,
      wsFactory
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "bad_markdown",
        payloadFormat: "markdown",
        payload: {
          text: "not-allowed"
        }
      })
    ).rejects.toThrow("payloadFormat=markdown requires a string payload");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(wsFactory).not.toHaveBeenCalled();
  });

  it("rejects json payload format when payload string is not valid json", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const wsFactory = vi.fn(() => new FakeWebSocket());

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl,
      wsFactory
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "bad_json",
        payloadFormat: "json",
        payload: "{bad-json"
      })
    ).rejects.toThrow("payloadFormat=json requires a JSON payload");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(wsFactory).not.toHaveBeenCalled();
  });

  it("parses json payload strings when payloadFormat=json", async () => {
    let sentSkillRequest: Record<string, unknown> | undefined;

    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        sentSkillRequest = (payload.message ?? {}) as Record<string, unknown>;
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
            message: { message_id: "message-json-string" },
            delivery: { delivery_id: "delivery-json-string" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "req-json-string",
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

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-json-string",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "json_echo",
      payloadFormat: "json",
      payload: "{\"city\":\"Seattle\"}"
    });

    expect(sentSkillRequest?.payload_format).toBe("json");
    expect(sentSkillRequest?.payload).toEqual({ city: "Seattle" });
    expect(sentSkillRequest?.input).toEqual({ city: "Seattle" });
  });

  it("infers markdown payload format when payload is a string", async () => {
    let sentSkillRequest: Record<string, unknown> | undefined;

    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        sentSkillRequest = (payload.message ?? {}) as Record<string, unknown>;
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
            message: { message_id: "message-inferred-markdown" },
            delivery: { delivery_id: "delivery-inferred-markdown" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "req-inferred-markdown",
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

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-inferred-markdown",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "markdown_auto",
      payload: "# inferred"
    });

    expect(sentSkillRequest?.payload_format).toBe("markdown");
    expect(sentSkillRequest?.payload).toBe("# inferred");
  });

  it("defaults markdown payload to empty string when payload is omitted", async () => {
    let sentSkillRequest: Record<string, unknown> | undefined;

    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        sentSkillRequest = (payload.message ?? {}) as Record<string, unknown>;
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
            message: { message_id: "message-empty-markdown" },
            delivery: { delivery_id: "delivery-empty-markdown" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "req-empty-markdown",
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

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-empty-markdown",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "markdown_empty",
      payloadFormat: "markdown"
    });

    expect(sentSkillRequest?.payload_format).toBe("markdown");
    expect(sentSkillRequest?.payload).toBe("");
  });

  it("nacks unrelated deliveries before returning matching result", async () => {
    let nackDeliveryID = "";

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
            message: { message_id: "message-x" },
            delivery: { delivery_id: "delivery-x" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "different-request",
              status: "ok",
              output: "other"
            }
          }
        });
        current.emitMessage({
          type: "delivery",
          result: {
            message: { message_id: "message-y" },
            delivery: { delivery_id: "delivery-y" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "req-2",
              status: "ok",
              output: "final"
            }
          }
        });
      }
      if (payload.type === "nack") {
        nackDeliveryID = String(payload.delivery_id ?? "");
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

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-2",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    const result = await client.requestSkillExecution({
      toAgentURI: "https://example.test/org/agent",
      skillName: "summarize"
    });

    expect(result.output).toBe("final");
    expect(nackDeliveryID).toBe("delivery-x");
  });

  it("throws when websocket closes before result is delivered", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: payload.request_id,
          status: 202,
          result: {}
        });
        current.close();
      }
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-3",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("session closed");
  });

  it("throws when websocket closes while waiting for publish response", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.close();
      }
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-close-wait",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("session closed");
  });

  it("throws on websocket runtime error payload", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: payload.request_id,
          status: 202,
          result: {}
        });
        current.emitError("boom");
      }
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-4",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("websocket error");
  });

  it("throws on websocket error while waiting for publish response", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitError("publish wait failed");
      }
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-error-wait",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("websocket error");
  });

  it("generates request id when not provided", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        const message = (payload.message ?? {}) as Record<string, unknown>;
        const generatedRequestID = String(message.request_id ?? "");
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
            message: { message_id: "message-generated" },
            delivery: { delivery_id: "delivery-generated" },
            openclaw_message: {
              kind: "skill_result",
              request_id: generatedRequestID,
              status: "ok",
              output: "generated"
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

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "summarize"
    });
    expect(result.requestId.length).toBeGreaterThan(0);
  });

  it("times out when matching result does not arrive", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: payload.request_id,
          status: 202,
          result: {}
        });
        current.emitMessage("not-json");
      }
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 60
      },
      {
        fetchImpl: fetchOKSpy(),
        randomID: () => "req-5",
        wsFactory: () => {
          openAndReady(socket);
          return socket;
        }
      }
    );

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("timed out waiting for skill_result");
  });

  it("handles non-object websocket payload values", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: payload.request_id,
          status: 202,
          result: {}
        });
        current.emitRaw(42);
      }
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 60
      },
      {
        fetchImpl: fetchOKSpy(),
        randomID: () => "req-non-object",
        wsFactory: () => {
          openAndReady(socket);
          return socket;
        }
      }
    );

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("timed out waiting for skill_result");
  });

  it("handles empty websocket payload values", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: payload.request_id,
          status: 202,
          result: {}
        });
        current.emitRaw(undefined);
      }
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 60
      },
      {
        fetchImpl: fetchOKSpy(),
        randomID: () => "req-empty-payload",
        wsFactory: () => {
          openAndReady(socket);
          return socket;
        }
      }
    );

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("timed out waiting for skill_result");
  });

  it("checkSession verifies websocket handshake", async () => {
    const socket = new FakeWebSocket();

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    const status = await client.checkSession();
    expect(status).toEqual({
      status: "ok",
      sessionKey: "main",
      transport: "websocket"
    });
  });

  it("checkSession handles session_ready emitted immediately after open", async () => {
    const socket = new FakeWebSocket();

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      wsFactory: () => {
        queueMicrotask(() => {
          socket.emitOpen();
          socket.emitMessage({ type: "session_ready", session_key: "main" });
        });
        return socket;
      }
    });

    const status = await client.checkSession();
    expect(status).toEqual({
      status: "ok",
      sessionKey: "main",
      transport: "websocket"
    });
  });

  it("checkSession rejects unexpected websocket handshake payload", async () => {
    const socket = new FakeWebSocket();

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      wsFactory: () => {
        openAndReady(socket, { type: "not_ready" });
        return socket;
      }
    });

    await expect(client.checkSession()).rejects.toThrow("unexpected websocket handshake");
  });

  it("checkSession rejects websocket open errors", async () => {
    const socket = new FakeWebSocket();

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      wsFactory: () => {
        queueMicrotask(() => {
          socket.emitError("cannot connect");
        });
        return socket;
      }
    });

    await expect(client.checkSession()).rejects.toThrow("cannot connect");
  });

  it("checkSession times out waiting for websocket open", async () => {
    const socket = new FakeWebSocket();

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 20
      },
      {
        fetchImpl: fetchOKSpy(),
        wsFactory: () => socket
      }
    );

    await expect(client.checkSession()).rejects.toThrow("timed out waiting for websocket open");
  });

  it("uses default websocket factory when one is not provided", async () => {
    const client = new MoltenHubClient(
      {
        ...testConfig(),
        baseUrl: "http://127.0.0.1:1/v1",
        timeoutMs: 20
      },
      {
        fetchImpl: fetchOKSpy()
      }
    );

    await expect(client.checkSession()).rejects.toThrow();
  });

  it("falls back to openclaw publish/pull when websocket route is unavailable", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestURL = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const path = requestURL.pathname + requestURL.search;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });

      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/register-plugin") {
        return new Response(
          JSON.stringify({
            error: "route_not_found",
            error_detail: {
              code: "route_not_found",
              message: "missing route"
            }
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      if (method === "GET" && requestURL.pathname === "/v1/agents/me/capabilities") {
        return new Response(JSON.stringify({ ok: true, result: { can_communicate: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/publish") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: "message-http" } }), {
          status: 202,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "GET" && requestURL.pathname === "/v1/openclaw/messages/pull") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message: { message_id: "message-http" },
              delivery: { delivery_id: "delivery-http" },
              openclaw_message: {
                kind: "skill_result",
                request_id: "req-http",
                status: "ok",
                output: { value: 1 }
              }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/ack") {
        return new Response(JSON.stringify({ ok: true, result: { status: "acked" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const wsFactory = vi.fn(() => {
      const socket = new FakeWebSocket();
      queueMicrotask(() => {
        socket.emitError("Unexpected server response: 404");
      });
      return socket;
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 1_000,
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      },
      {
        fetchImpl,
        randomID: () => "req-http",
        wsFactory
      }
    );

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "fallback_echo",
      payload: {
        ping: true
      }
    });

    expect(result).toMatchObject({
      requestId: "req-http",
      skillName: "fallback_echo",
      status: "ok",
      output: { value: 1 },
      messageId: "message-http",
      deliveryId: "delivery-http"
    });
    expect(wsFactory).toHaveBeenCalledTimes(1);
    expect(
      calls.some((call) => call.method === "POST" && call.path === "/v1/openclaw/messages/publish")
    ).toBe(true);
    expect(
      calls.some((call) => call.method === "GET" && call.path.startsWith("/v1/openclaw/messages/pull?timeout_ms="))
    ).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.path === "/v1/openclaw/messages/ack")).toBe(true);
  });

  it("falls back mid-request and processes empty/unrelated pull deliveries", async () => {
    let wsConnectCount = 0;
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    let pullCount = 0;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestURL = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const path = requestURL.pathname + requestURL.search;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });

      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/register-plugin") {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/publish") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: "message-mid-fallback" } }), {
          status: 202,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "GET" && requestURL.pathname === "/v1/openclaw/messages/pull") {
        pullCount += 1;
        if (pullCount === 1) {
          return new Response(null, { status: 204 });
        }
        if (pullCount === 2) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                delivery: { delivery_id: "delivery-unrelated-kind" },
                message: {
                  message_id: "message-unrelated-kind",
                  kind: "agent_message",
                  request_id: "different-request"
                }
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (pullCount === 3) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                delivery: { delivery_id: "delivery-unrelated-empty" },
                message: {
                  message_id: "message-unrelated-empty"
                }
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message: { message_id: "message-final-mid-fallback" },
              delivery: { delivery_id: "delivery-final-mid-fallback" },
              openclaw_message: {
                kind: "skill_result",
                request_id: "req-mid-fallback",
                status: "ok",
                output: "done"
              }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/nack") {
        return new Response(JSON.stringify({ ok: true, result: { status: "nacked" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/ack") {
        return new Response(JSON.stringify({ ok: true, result: { status: "acked" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const wsFactory = vi.fn(() => {
      wsConnectCount += 1;
      const socket = new FakeWebSocket();
      queueMicrotask(() => {
        if (wsConnectCount === 1) {
          socket.emitOpen();
          setTimeout(() => {
            socket.emitMessage({ type: "session_ready", session_key: "main" });
          }, 0);
          return;
        }
        socket.emitError("Unexpected server response: 404");
      });
      return socket;
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      },
      {
        fetchImpl,
        wsFactory,
        randomID: () => "req-mid-fallback"
      }
    );

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "fallback_with_queue"
    });

    expect(result).toMatchObject({
      requestId: "req-mid-fallback",
      status: "ok",
      output: "done",
      messageId: "message-final-mid-fallback",
      deliveryId: "delivery-final-mid-fallback"
    });
    expect(wsFactory).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.method === "POST" && call.path === "/v1/openclaw/messages/nack")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "POST" && call.path === "/v1/openclaw/messages/ack")).toHaveLength(1);
  });

  it("reports http-pull readiness transport when websocket routes are unavailable", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestURL = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/register-plugin") {
        return new Response(
          JSON.stringify({
            error: "route_not_found",
            error_detail: {
              code: "route_not_found",
              message: "missing route"
            }
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      if (method === "GET" && requestURL.pathname === "/v1/agents/me/capabilities") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              control_plane: {
                can_communicate: true
              }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const wsFactory = vi.fn(() => {
      const socket = new FakeWebSocket();
      queueMicrotask(() => {
        socket.emitError("Unexpected server response: 404");
      });
      return socket;
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      },
      {
        fetchImpl,
        wsFactory
      }
    );

    const readiness = await client.checkReadiness();
    expect(readiness.transport).toBe("http-pull");
    expect(readiness.checks.session.ok).toBe(true);
    expect(readiness.checks.capabilities.ok).toBe(true);
  });

  it("times out while waiting for pull-based skill result", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestURL = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/register-plugin") {
        return new Response(
          JSON.stringify({
            error: "route_not_found",
            error_detail: {
              code: "route_not_found",
              message: "missing route"
            }
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      if (method === "GET" && requestURL.pathname === "/v1/agents/me/capabilities") {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/publish") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: "message-timeout" } }), {
          status: 202,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "GET" && requestURL.pathname === "/v1/openclaw/messages/pull") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const wsFactory = vi.fn(() => {
      const socket = new FakeWebSocket();
      queueMicrotask(() => {
        socket.emitError("Unexpected server response: 404");
      });
      return socket;
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 1,
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        }
      },
      {
        fetchImpl,
        wsFactory,
        randomID: () => "req-timeout-pull"
      }
    );

    await expect(
      client.requestSkillExecution({
        toAgentURI: "https://example.test/agents/peer-timeout",
        skillName: "timeout_pull"
      })
    ).rejects.toThrow("timed out waiting for skill_result for request_id=req-timeout-pull");
  });

  it("uses top-level pull ids and returns default status with warnings in pull fallback mode", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestURL = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/register-plugin") {
        return new Response(
          JSON.stringify({
            error: "route_not_found",
            error_detail: {
              code: "route_not_found",
              message: "missing route"
            }
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      if (method === "GET" && requestURL.pathname === "/v1/agents/me/capabilities") {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/publish") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: "message-top-level" } }), {
          status: 202,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (method === "GET" && requestURL.pathname === "/v1/openclaw/messages/pull") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: "message-top-level",
              delivery_id: "delivery-top-level",
              openclaw_message: {
                kind: "skill_result",
                request_id: "req-top-level-pull",
                output: {
                  ok: true
                }
              }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (method === "POST" && requestURL.pathname === "/v1/openclaw/messages/ack") {
        return new Response(JSON.stringify({ ok: true, result: { status: "acked" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const wsFactory = vi.fn(() => {
      const socket = new FakeWebSocket();
      queueMicrotask(() => {
        socket.emitError("Unexpected server response: 404");
      });
      return socket;
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        profile: {
          enabled: false,
          syncIntervalMs: 300_000
        },
        safety: {
          blockMetadataSecrets: false,
          warnMessageSecrets: true,
          secretMarkers: ["token"]
        }
      },
      {
        fetchImpl,
        wsFactory,
        randomID: () => "req-top-level-pull"
      }
    );

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "top_level_pull",
      payload: {
        note: "token:abc"
      }
    });

    expect(result).toMatchObject({
      requestId: "req-top-level-pull",
      status: "ok",
      output: {
        ok: true
      },
      messageId: "message-top-level",
      deliveryId: "delivery-top-level"
    });
    expect(Array.isArray(result.warnings)).toBe(true);
    expect((result.warnings ?? []).length).toBeGreaterThan(0);
  });

  it("times out waiting for publish response", async () => {
    const socket = new FakeWebSocket((payload) => {
      if (payload.type === "publish") {
        // Intentionally do not reply.
      }
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 50
      },
      {
        fetchImpl: fetchOKSpy(),
        randomID: () => "req-timeout-response",
        wsFactory: () => {
          openAndReady(socket);
          return socket;
        }
      }
    );

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("timed out waiting for websocket response request_id=publish:req-timeout-response");
  });

  it("times out waiting for websocket response deadline after non-response payloads", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "delivery",
          result: {
            message: { message_id: "message-pre-response" },
            openclaw_message: {
              kind: "agent_message"
            }
          }
        });
      }
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 1
      },
      {
        fetchImpl: fetchOKSpy(),
        randomID: () => "req-deadline-response",
        wsFactory: () => {
          openAndReady(socket);
          return socket;
        }
      }
    );

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("timed out waiting for websocket response request_id=");
  });

  it("waitForResponse handles deliveries and mismatched request ids", async () => {
    let sawWaitNack = false;

    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "delivery",
          result: {
            message: { message_id: "message-pre-response" },
            delivery: { delivery_id: "delivery-pre-response" },
            openclaw_message: {
              kind: "agent_message",
              request_id: "different",
              status: "ok",
              output: "ignored"
            }
          }
        });
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: "wrong-request-id",
          status: 202,
          result: {}
        });
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
            message: { message_id: "message-final" },
            delivery: { delivery_id: "delivery-final" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "req-wait-for-response",
              status: "ok",
              output: "done"
            }
          }
        });
      }
      if (payload.type === "nack" && payload.delivery_id === "delivery-pre-response") {
        sawWaitNack = true;
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

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-wait-for-response",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "summarize"
    });

    expect(result.output).toBe("done");
    expect(sawWaitNack).toBe(true);
  });

  it("propagates websocket response errors", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "response",
          ok: false,
          request_id: payload.request_id,
          status: 500,
          error: "bad"
        });
      }
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-error-response",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("unknown_error");
  });

  it("propagates response errors while waiting for skill result", async () => {
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
          type: "response",
          ok: false,
          request_id: "runtime-error",
          status: 500,
          error: {
            code: "runtime_failure",
            message: "failed in runtime loop"
          }
        });
      }
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-runtime-response-error",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("runtime_failure");
  });

  it("uses unknown defaults for response errors while waiting for skill result", async () => {
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
          type: "response",
          ok: false,
          request_id: "runtime-error",
          status: 500,
          error: {}
        });
      }
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-runtime-response-defaults",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("unknown_error");
  });

  it("returns result when matching delivery is missing delivery_id", async () => {
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
            message: { message_id: "message-no-delivery-id" },
            openclaw_message: {
              kind: "skill_result",
              request_id: "req-no-delivery-id",
              output: "done"
            }
          }
        });
      }
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-no-delivery-id",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    const result = await client.requestSkillExecution({
      toAgentUUID: "11111111-1111-1111-1111-111111111111",
      skillName: "summarize"
    });
    expect(result.deliveryId).toBe("");
  });

  it("fails when plugin registration response is not ok", async () => {
    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: vi.fn(async () => new Response("forbidden", { status: 403 }))
    });

    await expect(client.registerPlugin()).rejects.toThrow("registration failed (403)");
  });

  it("fails with empty registration body when response text throws", async () => {
    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: vi.fn(async () => {
        return {
          ok: false,
          status: 500,
          text: async () => {
            throw new Error("unavailable");
          }
        } as unknown as Response;
      })
    });

    await expect(client.registerPlugin()).rejects.toThrow("registration failed (500)");
  });

  it("validates required request fields", async () => {
    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy()
    });

    await expect(client.requestSkillExecution({ skillName: "weather_lookup" })).rejects.toThrow(
      "toAgentUUID or toAgentURI is required"
    );
    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: ""
      })
    ).rejects.toThrow("skillName is required");
  });

  it("fails when websocket send callback returns an error", async () => {
    const socket = new FakeWebSocket(() => {
      throw new Error("send failed");
    });

    const client = new MoltenHubClient(testConfig(), {
      fetchImpl: fetchOKSpy(),
      randomID: () => "req-send-error",
      wsFactory: () => {
        openAndReady(socket);
        return socket;
      }
    });

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("send failed");
  });

  it("hits immediate deadline check while waiting for skill result", async () => {
    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
        current.emitMessage({
          type: "response",
          ok: true,
          request_id: payload.request_id,
          status: 202,
          result: {}
        });
        for (let i = 0; i < 400; i++) {
          current.emitMessage({
            type: "response",
            ok: true,
            request_id: `noop-${i}`,
            status: 200,
            result: {}
          });
        }
      }
    });

    const client = new MoltenHubClient(
      {
        ...testConfig(),
        timeoutMs: 1
      },
      {
        fetchImpl: fetchOKSpy(),
        randomID: () => "req-deadline-check",
        wsFactory: () => {
          openAndReady(socket);
          return socket;
        }
      }
    );

    await expect(
      client.requestSkillExecution({
        toAgentUUID: "11111111-1111-1111-1111-111111111111",
        skillName: "summarize"
      })
    ).rejects.toThrow("timed out waiting for skill_result");
  });

  it("resolveConfig reads config, file, and env values", () => {
    const filePath = writeTempJSONFile({
      baseUrl: "https://file.example.com/v1/",
      token: "token-file",
      sessionKey: "session-file",
      timeoutMs: 2501,
      pluginId: "plugin-file",
      pluginPackage: "pkg-file",
      pluginVersion: "9.9.9"
    });

    const resolvedFromFile = resolveConfig({
      config: {
        configFile: filePath
      }
    });
    expect(resolvedFromFile).toMatchObject({
      baseUrl: "https://file.example.com/v1",
      token: "token-file",
      sessionKey: "session-file",
      timeoutMs: 2501,
      pluginId: "plugin-file",
      pluginPackage: "pkg-file",
      pluginVersion: "9.9.9",
      profile: {
        enabled: true,
        syncIntervalMs: 300000
      },
      connection: {
        healthcheckTtlMs: 30000
      },
      safety: {
        blockMetadataSecrets: true,
        warnMessageSecrets: true
      }
    });
    expect(resolvedFromFile.safety.secretMarkers.length).toBeGreaterThan(0);

    const resolvedFromEnvConfigFile = resolveConfig({
      env: {
        MOLTENHUB_CONFIG_FILE: filePath
      }
    });
    expect(resolvedFromEnvConfigFile.token).toBe("token-file");

    const resolvedInlineOverridesFile = resolveConfig({
      config: {
        configFile: filePath,
        baseURL: "https://inline.example.com/v1/",
        token: "token-inline"
      }
    });
    expect(resolvedInlineOverridesFile.baseUrl).toBe("https://inline.example.com/v1");
    expect(resolvedInlineOverridesFile.token).toBe("token-inline");

    const resolved = resolveConfig({
      config: {
        baseUrl: "https://hub.example.com/v1/",
        token: "token-a",
        sessionKey: "session-a",
        timeoutMs: 2500,
        pluginId: "plugin-a",
        pluginPackage: "pkg-a",
        pluginVersion: "1.2.3"
      }
    });

    expect(resolved).toMatchObject({
      baseUrl: "https://hub.example.com/v1",
      token: "token-a",
      sessionKey: "session-a",
      timeoutMs: 2500,
      pluginId: "plugin-a",
      pluginPackage: "pkg-a",
      pluginVersion: "1.2.3",
      profile: {
        enabled: true,
        syncIntervalMs: 300000
      },
      connection: {
        healthcheckTtlMs: 30000
      },
      safety: {
        blockMetadataSecrets: true,
        warnMessageSecrets: true
      }
    });
    expect(resolved.safety.secretMarkers.length).toBeGreaterThan(0);

    const resolvedFromEnv = resolveConfig({
      env: {
        MOLTENHUB_BASE_URL: "https://hub.example.com/v1",
        MOLTENHUB_AGENT_TOKEN: "token-b",
        MOLTENHUB_SESSION_KEY: "session-b",
        MOLTENHUB_TIMEOUT_MS: "72000"
      }
    });

    expect(resolvedFromEnv.timeoutMs).toBe(60000);
    expect(resolvedFromEnv.sessionKey).toBe("session-b");

    const resolvedInvalidTimeout = resolveConfig({
      env: {
        MOLTENHUB_BASE_URL: "https://hub.example.com/v1",
        MOLTENHUB_AGENT_TOKEN: "token-c",
        MOLTENHUB_TIMEOUT_MS: "not-a-number"
      }
    });
    expect(resolvedInvalidTimeout.timeoutMs).toBe(20000);

    const resolvedZeroTimeout = resolveConfig({
      env: {
        MOLTENHUB_BASE_URL: "https://hub.example.com/v1",
        MOLTENHUB_AGENT_TOKEN: "token-d",
        MOLTENHUB_TIMEOUT_MS: "0"
      }
    });
    expect(resolvedZeroTimeout.timeoutMs).toBe(20000);
  });

  it("resolveConfig fails for unreadable or invalid config files", () => {
    const missingPath = join(tmpdir(), "moltenhub-openclaw-plugin-missing", "config.json");
    expect(() =>
      resolveConfig({
        config: {
          configFile: missingPath
        }
      })
    ).toThrow("failed reading MoltenHub plugin config file");

    const invalidJSONPath = writeTempJSONFile({});
    writeFileSync(invalidJSONPath, "{", "utf8");
    expect(() =>
      resolveConfig({
        config: {
          configFile: invalidJSONPath
        }
      })
    ).toThrow("invalid MoltenHub plugin config file");

    const invalidShapePath = writeTempJSONFile(["bad-shape"]);
    expect(() =>
      resolveConfig({
        config: {
          configFile: invalidShapePath
        }
      })
    ).toThrow("config file must contain a JSON object");
  });

  it("resolveConfig defaults baseUrl and enforces token", () => {
    expect(resolveConfig({ config: { token: "token-a" } }).baseUrl).toBe("https://na.hub.molten.bot/v1");
    expect(resolveConfig({ config: { baseUrl: "   ", token: "token-b" } }).baseUrl).toBe(
      "https://na.hub.molten.bot/v1"
    );
    expect(() => resolveConfig({ config: { baseUrl: "https://hub.example.com/v1" } })).toThrow("requires token");
  });
});
