import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import WebSocket, { type RawData } from "ws";

import type {
  ResolveConfigInput,
  SkillExecutionRequest,
  SkillExecutionResult,
  StatocystPluginConfig
} from "./types.js";

export interface WebSocketLike {
  on: (event: string, listener: (...args: unknown[]) => void) => WebSocketLike;
  send: (data: string, callback?: (error?: Error) => void) => void;
  close: (code?: number) => void;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface StatocystClientDeps {
  fetchImpl: typeof fetch;
  wsFactory: WebSocketFactory;
  now: () => Date;
  randomID: () => string;
}

const defaultTimeoutMs = 20_000;
const defaultPluginID = "statocyst-openclaw";
const defaultPluginPackage = "@moltenbot/openclaw-plugin-statocyst";
const defaultPluginVersion = "0.1.0";

const defaultDeps: StatocystClientDeps = {
  fetchImpl: fetch,
  wsFactory: (url, headers) => new WebSocket(url, { headers }),
  now: () => new Date(),
  randomID: () => randomUUID()
};

class MessageQueue {
  private queue: Record<string, unknown>[] = [];
  private pending: ((message: Record<string, unknown>) => void)[] = [];

  push(message: Record<string, unknown>): void {
    if (this.pending.length > 0) {
      const resolver = this.pending.shift();
      if (resolver) {
        resolver(message);
      }
      return;
    }
    this.queue.push(message);
  }

  next(timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.queue.length > 0) {
      const message = this.queue.shift();
      if (message) {
        return Promise.resolve(message);
      }
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((fn) => fn !== resolver);
        reject(new Error(`timed out waiting for websocket message after ${timeoutMs}ms`));
      }, timeoutMs);
      const resolver = (message: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.pending.push(resolver);
    });
  }
}

class WebSocketSession {
  private readonly queue = new MessageQueue();

  constructor(private readonly socket: WebSocketLike) {}

  attach(): void {
    this.socket.on("message", (raw: unknown) => {
      this.queue.push(parseWSMessage(raw));
    });
    this.socket.on("error", (error: unknown) => {
      this.queue.push({
        type: "__error__",
        error: String(error)
      });
    });
    this.socket.on("close", () => {
      this.queue.push({ type: "__close__" });
    });
  }

  async send(payload: Record<string, unknown>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.send(JSON.stringify(payload), (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async next(timeoutMs: number): Promise<Record<string, unknown>> {
    return this.queue.next(timeoutMs);
  }

  close(): void {
    this.socket.close(1000);
  }
}

export class StatocystClient {
  private readonly deps: StatocystClientDeps;

  constructor(private readonly config: StatocystPluginConfig, deps?: Partial<StatocystClientDeps>) {
    this.deps = {
      ...defaultDeps,
      ...deps
    };
  }

  async registerPlugin(): Promise<void> {
    const response = await this.deps.fetchImpl(`${this.config.baseUrl}/openclaw/messages/register-plugin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.token}`
      },
      body: JSON.stringify({
        plugin_id: this.config.pluginId,
        package: this.config.pluginPackage,
        version: this.config.pluginVersion,
        transport: "websocket",
        session_mode: "dedicated",
        session_key: this.config.sessionKey
      })
    });

    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`statocyst plugin registration failed (${response.status}): ${body}`);
    }
  }

  async checkSession(): Promise<{ status: string; sessionKey: string; transport: string }> {
    await this.registerPlugin();
    const session = await this.openSession(this.config.sessionKey, this.config.timeoutMs);
    try {
      return {
        status: "ok",
        sessionKey: this.config.sessionKey,
        transport: "websocket"
      };
    } finally {
      session.close();
    }
  }

  async requestSkillExecution(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    const targetUUID = trimOrEmpty(request.toAgentUUID);
    const targetURI = trimOrEmpty(request.toAgentURI);
    const skillName = trimOrEmpty(request.skillName);
    if (!targetUUID && !targetURI) {
      throw new Error("toAgentUUID or toAgentURI is required");
    }
    if (!skillName) {
      throw new Error("skillName is required");
    }

    const timeoutMs = normalizeTimeout(request.timeoutMs ?? this.config.timeoutMs);
    const requestId = trimOrEmpty(request.requestId) || this.deps.randomID();
    const sessionKey = trimOrEmpty(request.sessionKey) || this.config.sessionKey;

    await this.registerPlugin();

    const session = await this.openSession(sessionKey, timeoutMs);
    try {
      const publishRequestID = `publish:${requestId}`;
      await session.send({
        type: "publish",
        request_id: publishRequestID,
        to_agent_uuid: targetUUID || undefined,
        to_agent_uri: targetURI || undefined,
        message: {
          kind: "skill_request",
          request_id: requestId,
          skill_name: skillName,
          reply_required: true,
          input: request.input,
          session_key: sessionKey,
          timestamp: this.deps.now().toISOString()
        }
      });

      await this.waitForResponse(session, publishRequestID, timeoutMs);

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        const waitMs = Math.max(1, remaining);
        let payload: Record<string, unknown>;
        try {
          payload = await session.next(waitMs);
        } catch {
          throw new Error(`timed out waiting for skill_result for request_id=${requestId}`);
        }
        const payloadType = trimOrEmpty(payload.type);
        if (payloadType === "__error__") {
          throw new Error(`websocket error: ${trimOrEmpty(payload.error)}`);
        }
        if (payloadType === "__close__") {
          throw new Error("websocket session closed");
        }

        if (payloadType === "delivery") {
          const message = readObject(readObject(payload.result).openclaw_message);
          const deliveryID = trimOrEmpty(readObject(readObject(payload.result).delivery).delivery_id);
          const messageID = trimOrEmpty(readObject(readObject(payload.result).message).message_id);
          const kind = trimOrEmpty(message.kind);
          const resultRequestID = trimOrEmpty(message.request_id);

          if (kind === "skill_result" && resultRequestID === requestId) {
            await this.ackDelivery(session, deliveryID, timeoutMs);
            return {
              requestId,
              skillName,
              status: trimOrEmpty(message.status) || "ok",
              output: message.output,
              error: message.error,
              messageId: messageID,
              deliveryId: deliveryID
            };
          }

          if (deliveryID) {
            await this.nackDelivery(session, deliveryID);
          }
          continue;
        }

        if (payloadType === "response") {
          const ok = Boolean(payload.ok);
          if (!ok) {
            const code = trimOrEmpty(readObject(payload.error).code) || "unknown_error";
            const message = trimOrEmpty(readObject(payload.error).message) || "unknown error";
            throw new Error(`statocyst websocket response error (${code}): ${message}`);
          }
        }
      }
    } finally {
      session.close();
    }
  }

  private async openSession(sessionKey: string, timeoutMs: number): Promise<WebSocketSession> {
    const wsBase = this.config.baseUrl.replace(/^http/i, "ws");
    const wsURL = `${wsBase}/openclaw/messages/ws?session_key=${encodeURIComponent(sessionKey)}`;
    const socket = this.deps.wsFactory(wsURL, {
      Authorization: `Bearer ${this.config.token}`
    });

    await waitForOpen(socket, timeoutMs);
    const session = new WebSocketSession(socket);
    session.attach();

    const firstMessage = await session.next(timeoutMs);
    if (trimOrEmpty(firstMessage.type) !== "session_ready") {
      throw new Error(`unexpected websocket handshake message type=${trimOrEmpty(firstMessage.type)}`);
    }

    return session;
  }

  private async waitForResponse(session: WebSocketSession, requestID: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      const waitMs = Math.max(1, remaining);
      let payload: Record<string, unknown>;
      try {
        payload = await session.next(waitMs);
      } catch {
        throw new Error(`timed out waiting for websocket response request_id=${requestID}`);
      }
      if (trimOrEmpty(payload.type) === "__error__") {
        throw new Error(`websocket error: ${trimOrEmpty(payload.error)}`);
      }
      if (trimOrEmpty(payload.type) === "__close__") {
        throw new Error("websocket session closed");
      }
      if (trimOrEmpty(payload.type) !== "response") {
        if (trimOrEmpty(payload.type) === "delivery") {
          const deliveryID = trimOrEmpty(readObject(readObject(payload.result).delivery).delivery_id);
          if (deliveryID) {
            await this.nackDelivery(session, deliveryID);
          }
        }
        continue;
      }
      if (trimOrEmpty(payload.request_id) !== requestID) {
        continue;
      }
      if (!Boolean(payload.ok)) {
        const code = trimOrEmpty(readObject(payload.error).code) || "unknown_error";
        const message = trimOrEmpty(readObject(payload.error).message) || "unknown error";
        throw new Error(`statocyst websocket response error (${code}): ${message}`);
      }
      return;
    }
  }

  private async ackDelivery(session: WebSocketSession, deliveryID: string, timeoutMs: number): Promise<void> {
    if (!deliveryID) {
      return;
    }
    const requestID = `ack:${deliveryID}`;
    await session.send({
      type: "ack",
      request_id: requestID,
      delivery_id: deliveryID
    });
    await this.waitForResponse(session, requestID, timeoutMs);
  }

  private async nackDelivery(session: WebSocketSession, deliveryID: string): Promise<void> {
    await session.send({
      type: "nack",
      request_id: `nack:${deliveryID}`,
      delivery_id: deliveryID
    });
  }
}

export function resolveConfig(context: ResolveConfigInput): StatocystPluginConfig {
  const config = context.config ?? {};
  const env = context.env ?? {};
  const configFilePath = trimOrEmpty(asString(config.configFile) || env.STATOCYST_CONFIG_FILE || "");
  const fileConfig = readConfigFile(configFilePath);

  const baseUrl = normalizeBaseURL(
    asString(config.baseUrl) ||
      asString(config.baseURL) ||
      asString(fileConfig.baseUrl) ||
      asString(fileConfig.baseURL) ||
      env.STATOCYST_BASE_URL ||
      env.STATOCYST_API_BASE ||
      ""
  );
  const token = trimOrEmpty(asString(config.token) || asString(fileConfig.token) || env.STATOCYST_AGENT_TOKEN || "");
  const sessionKey = trimOrEmpty(asString(config.sessionKey) || asString(fileConfig.sessionKey) || env.STATOCYST_SESSION_KEY || "main");
  const timeoutMs = normalizeTimeout(
    asNumber(config.timeoutMs) ?? asNumber(fileConfig.timeoutMs) ?? asNumber(env.STATOCYST_TIMEOUT_MS) ?? defaultTimeoutMs
  );
  const pluginId = trimOrEmpty(asString(config.pluginId) || asString(fileConfig.pluginId) || defaultPluginID);
  const pluginPackage = trimOrEmpty(
    asString(config.pluginPackage) || asString(fileConfig.pluginPackage) || defaultPluginPackage
  );
  const pluginVersion = trimOrEmpty(
    asString(config.pluginVersion) || asString(fileConfig.pluginVersion) || defaultPluginVersion
  );

  if (!baseUrl) {
    throw new Error("Statocyst plugin configuration requires baseUrl");
  }
  if (!token) {
    throw new Error("Statocyst plugin configuration requires token");
  }

  return {
    baseUrl,
    token,
    sessionKey,
    timeoutMs,
    pluginId,
    pluginPackage,
    pluginVersion
  };
}

function waitForOpen(socket: WebSocketLike, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for websocket open after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("error", (error: unknown) => {
      clearTimeout(timer);
      reject(new Error(String(error)));
    });
  });
}

function parseWSMessage(raw: unknown): Record<string, unknown> {
  try {
    const value = normalizeWSRawData(raw);
    if (!value) {
      return { type: "__invalid__", raw: "" };
    }
    const decoded = JSON.parse(value);
    if (decoded && typeof decoded === "object") {
      return decoded as Record<string, unknown>;
    }
    return { type: "__invalid__", raw: value };
  } catch {
    return { type: "__invalid__", raw: String(raw) };
  }
}

function normalizeWSRawData(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  const maybeWSRaw = raw as RawData;
  if (Array.isArray(maybeWSRaw)) {
    return Buffer.concat(maybeWSRaw as Buffer[]).toString("utf8");
  }
  return String(raw ?? "");
}

function normalizeBaseURL(raw: string): string {
  const trimmed = trimOrEmpty(raw);
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

function readConfigFile(configPath: string): Record<string, unknown> {
  if (!configPath) {
    return {};
  }

  const absolutePath = resolvePath(configPath);
  let rawContent = "";
  try {
    rawContent = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`failed reading Statocyst plugin config file (${absolutePath}): ${String(error)}`);
  }

  try {
    const parsed = JSON.parse(rawContent.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config file must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid Statocyst plugin config file (${absolutePath}): ${String(error)}`);
  }
}

function normalizeTimeout(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    return defaultTimeoutMs;
  }
  if (raw > 60_000) {
    return 60_000;
  }
  return Math.trunc(raw);
}

function trimOrEmpty(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return undefined;
    }
    return parsed;
  }
  return undefined;
}

function readObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
