import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveConfig, StatocystClient, type WebSocketLike } from "../src/statocyst-client.js";

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
    pluginId: "statocyst-openclaw",
    pluginPackage: "@moltenbot/openclaw-plugin-statocyst",
    pluginVersion: "0.1.0-test"
  };
}

function writeTempJSONFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "statocyst-openclaw-plugin-"));
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

describe("StatocystClient", () => {
  it("registers plugin and completes skill request over websocket", async () => {
    let receivedURL = "";
    let receivedAuth = "";

    const socket = new FakeWebSocket((payload, current) => {
      if (payload.type === "publish") {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(
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

    const client = new StatocystClient(
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

    const client = new StatocystClient(
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

    const client = new StatocystClient(testConfig(), {
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

  it("checkSession rejects unexpected websocket handshake payload", async () => {
    const socket = new FakeWebSocket();

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(
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
    const client = new StatocystClient(
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

  it("times out waiting for publish response", async () => {
    const socket = new FakeWebSocket((payload) => {
      if (payload.type === "publish") {
        // Intentionally do not reply.
      }
    });

    const client = new StatocystClient(
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

    const client = new StatocystClient(
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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
    const client = new StatocystClient(testConfig(), {
      fetchImpl: vi.fn(async () => new Response("forbidden", { status: 403 }))
    });

    await expect(client.registerPlugin()).rejects.toThrow("registration failed (403)");
  });

  it("fails with empty registration body when response text throws", async () => {
    const client = new StatocystClient(testConfig(), {
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
    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(testConfig(), {
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

    const client = new StatocystClient(
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
    expect(resolvedFromFile).toEqual({
      baseUrl: "https://file.example.com/v1",
      token: "token-file",
      sessionKey: "session-file",
      timeoutMs: 2501,
      pluginId: "plugin-file",
      pluginPackage: "pkg-file",
      pluginVersion: "9.9.9"
    });

    const resolvedFromEnvConfigFile = resolveConfig({
      env: {
        STATOCYST_CONFIG_FILE: filePath
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

    expect(resolved).toEqual({
      baseUrl: "https://hub.example.com/v1",
      token: "token-a",
      sessionKey: "session-a",
      timeoutMs: 2500,
      pluginId: "plugin-a",
      pluginPackage: "pkg-a",
      pluginVersion: "1.2.3"
    });

    const resolvedFromEnv = resolveConfig({
      env: {
        STATOCYST_BASE_URL: "https://hub.example.com/v1",
        STATOCYST_AGENT_TOKEN: "token-b",
        STATOCYST_SESSION_KEY: "session-b",
        STATOCYST_TIMEOUT_MS: "72000"
      }
    });

    expect(resolvedFromEnv.timeoutMs).toBe(60000);
    expect(resolvedFromEnv.sessionKey).toBe("session-b");

    const resolvedInvalidTimeout = resolveConfig({
      env: {
        STATOCYST_BASE_URL: "https://hub.example.com/v1",
        STATOCYST_AGENT_TOKEN: "token-c",
        STATOCYST_TIMEOUT_MS: "not-a-number"
      }
    });
    expect(resolvedInvalidTimeout.timeoutMs).toBe(20000);

    const resolvedZeroTimeout = resolveConfig({
      env: {
        STATOCYST_BASE_URL: "https://hub.example.com/v1",
        STATOCYST_AGENT_TOKEN: "token-d",
        STATOCYST_TIMEOUT_MS: "0"
      }
    });
    expect(resolvedZeroTimeout.timeoutMs).toBe(20000);
  });

  it("resolveConfig fails for unreadable or invalid config files", () => {
    const missingPath = join(tmpdir(), "statocyst-openclaw-plugin-missing", "config.json");
    expect(() =>
      resolveConfig({
        config: {
          configFile: missingPath
        }
      })
    ).toThrow("failed reading Statocyst plugin config file");

    const invalidJSONPath = writeTempJSONFile({});
    writeFileSync(invalidJSONPath, "{", "utf8");
    expect(() =>
      resolveConfig({
        config: {
          configFile: invalidJSONPath
        }
      })
    ).toThrow("invalid Statocyst plugin config file");

    const invalidShapePath = writeTempJSONFile(["bad-shape"]);
    expect(() =>
      resolveConfig({
        config: {
          configFile: invalidShapePath
        }
      })
    ).toThrow("config file must contain a JSON object");
  });

  it("resolveConfig enforces baseUrl and token", () => {
    expect(() => resolveConfig({ config: { token: "token-a" } })).toThrow("requires baseUrl");
    expect(() => resolveConfig({ config: { baseUrl: "https://hub.example.com/v1" } })).toThrow("requires token");
  });
});
