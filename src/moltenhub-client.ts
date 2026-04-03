import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import WebSocket, { type RawData } from "ws";

import type {
  AgentProfileUpdateRequest,
  LocalServicePrompt,
  MoltenHubPluginConfig,
  OpenClawDeliveryActionRequest,
  OpenClawMessageStatusRequest,
  OpenClawPublishRequest,
  OpenClawPullRequest,
  ReadinessCheckItem,
  ReadinessCheckResult,
  ResolveConfigInput,
  SecretWarning,
  SessionStatusResult,
  SkillExecutionRequest,
  SkillExecutionResult
} from "./types.js";

export interface WebSocketLike {
  on: (event: string, listener: (...args: unknown[]) => void) => WebSocketLike;
  send: (data: string, callback?: (error?: Error) => void) => void;
  close: (code?: number) => void;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface MoltenHubClientDeps {
  fetchImpl: typeof fetch;
  wsFactory: WebSocketFactory;
  now: () => Date;
  randomID: () => string;
}

interface RuntimeRequestOptions {
  allowNoContent?: boolean;
}

interface ParsedDelivery {
  deliveryId: string;
  messageId: string;
  message: Record<string, unknown>;
}

interface WaitForResponseOptions {
  preserveSkillResultRequestId?: string;
}

const defaultTimeoutMs = 20_000;
const defaultPluginID = "openclaw-plugin-moltenhub";
const defaultPluginPackage = "@moltenbot/openclaw-plugin-moltenhub";
const defaultPluginVersion = "0.1.8";
const defaultProfileSyncIntervalMs = 300_000;
const defaultHealthcheckTtlMs = 30_000;
const defaultPullTimeoutMs = 5_000;

const defaultSecretMarkers = [
  "api key",
  "api_key",
  "apikey",
  "access key",
  "secret",
  "password",
  "passwd",
  "private key",
  "bearer ",
  "token=",
  "token:"
];

export const NATIVE_TOOL_NAMES = [
  "moltenhub_skill_request",
  "moltenhub_session_status",
  "moltenhub_readiness_check",
  "moltenhub_profile_get",
  "moltenhub_profile_update",
  "moltenhub_capabilities_get",
  "moltenhub_manifest_get",
  "moltenhub_skill_guide_get",
  "moltenhub_openclaw_publish",
  "moltenhub_openclaw_pull",
  "moltenhub_openclaw_ack",
  "moltenhub_openclaw_nack",
  "moltenhub_openclaw_status"
] as const;

const defaultDeps: MoltenHubClientDeps = {
  fetchImpl: fetch,
  wsFactory: (url, headers) => new WebSocket(url, { headers }),
  now: () => new Date(),
  randomID: () => randomUUID()
};

class MoltenHubAPIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly nextAction: string;

  constructor(message: string, status: number, code: string, retryable = false, nextAction = "") {
    super(message);
    this.name = "MoltenHubAPIError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.nextAction = nextAction;
  }
}

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

export class MoltenHubClient {
  private readonly config: MoltenHubPluginConfig;
  private readonly deps: MoltenHubClientDeps;
  private lastSessionCheckAt = 0;
  private lastProfileSyncAt = 0;
  private handleFinalizeAttempted = false;
  private pluginRegistrationSupported = true;
  private cachedSessionStatus: SessionStatusResult | null = null;
  private profileSyncInFlight: Promise<void> | null = null;

  constructor(config: MoltenHubPluginConfig, deps?: Partial<MoltenHubClientDeps>) {
    this.config = normalizeRuntimeConfig(config);
    this.deps = {
      ...defaultDeps,
      ...deps
    };
  }

  async registerPlugin(): Promise<boolean> {
    if (!this.pluginRegistrationSupported) {
      return false;
    }

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
      if (this.isRegistrationRouteUnsupported(response.status, body)) {
        this.pluginRegistrationSupported = false;
        return false;
      }
      throw new Error(`moltenhub plugin registration failed (${response.status}): ${body}`);
    }
    return true;
  }

  async checkSession(): Promise<SessionStatusResult> {
    await this.registerPlugin();
    return this.checkSessionAfterRegistration();
  }

  async checkReadiness(): Promise<ReadinessCheckResult> {
    const checks = {
      pluginRegistration: readinessItem(),
      profileSync: readinessItem(),
      session: readinessItem(),
      capabilities: readinessItem()
    };

    let canCommunicate: boolean | undefined;
    let sessionTransport: ReadinessCheckResult["transport"] = "websocket";

    try {
      const registered = await this.registerPlugin();
      if (registered) {
        checks.pluginRegistration = readinessItem(true);
      } else {
        checks.pluginRegistration = readinessItem(
          true,
          "registration route unavailable; continuing without explicit plugin registration",
          true
        );
      }
    } catch (error) {
      checks.pluginRegistration = readinessItem(false, String(error));
    }

    if (!this.config.profile.enabled) {
      checks.profileSync = readinessItem(true, undefined, true);
    } else {
      try {
        await this.syncProfileIfDue(true);
        checks.profileSync = readinessItem(true);
      } catch (error) {
        checks.profileSync = readinessItem(false, String(error));
      }
    }

    try {
      const session = await this.checkSessionAfterRegistration();
      const normalizedTransport = trimOrEmpty(session.transport);
      sessionTransport = normalizedTransport === "http-pull" ? "http-pull" : "websocket";
      checks.session = readinessItem(true);
    } catch (error) {
      checks.session = readinessItem(false, String(error));
    }

    try {
      const capabilities = await this.getCapabilitiesRaw();
      canCommunicate = readBoolean(
        readObject(capabilities.control_plane).can_communicate ?? readObject(capabilities).can_communicate
      );
      checks.capabilities = readinessItem(true);
    } catch (error) {
      checks.capabilities = readinessItem(false, String(error));
    }

    const ok =
      checks.pluginRegistration.ok &&
      checks.profileSync.ok &&
      checks.session.ok &&
      checks.capabilities.ok;

    return {
      status: ok ? "ok" : "degraded",
      baseUrl: this.config.baseUrl,
      sessionKey: this.config.sessionKey,
      transport: sessionTransport,
      canCommunicate,
      checks
    };
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
    const payloadInput = request.payload !== undefined ? request.payload : request.input;
    const payload = this.normalizeSkillPayload(payloadInput, request.payloadFormat);
    const warnings = this.maybeWarnPayload(payload.payload, "$.payload");

    await this.ensureReady();

    if (this.cachedSessionStatus?.transport === "http-pull") {
      return this.requestSkillExecutionOverPull({
        targetUUID,
        targetURI,
        skillName,
        payload: payload.payload,
        payloadFormat: payload.format,
        requestId,
        sessionKey,
        timeoutMs,
        warnings
      });
    }

    try {
      return await this.requestSkillExecutionOverWebSocket({
        targetUUID,
        targetURI,
        skillName,
        payload: payload.payload,
        payloadFormat: payload.format,
        requestId,
        sessionKey,
        timeoutMs,
        warnings
      });
    } catch (error) {
      if (!this.isWebSocketRouteUnsupported(error)) {
        throw error;
      }

      const fallbackStatus: SessionStatusResult = {
        status: "ok",
        sessionKey,
        transport: "http-pull"
      };
      this.cachedSessionStatus = fallbackStatus;
      this.lastSessionCheckAt = Date.now();

      return this.requestSkillExecutionOverPull({
        targetUUID,
        targetURI,
        skillName,
        payload: payload.payload,
        payloadFormat: payload.format,
        requestId,
        sessionKey,
        timeoutMs,
        warnings
      });
    }
  }

  private async requestSkillExecutionOverWebSocket(args: {
    targetUUID: string;
    targetURI: string;
    skillName: string;
    payload: unknown;
    payloadFormat: "json" | "markdown";
    requestId: string;
    sessionKey: string;
    timeoutMs: number;
    warnings: SecretWarning[];
  }): Promise<SkillExecutionResult> {
    const session = await this.openSession(args.sessionKey, args.timeoutMs);
    try {
      const skillContext = {
        requestId: args.requestId,
        skillName: args.skillName,
        warnings: args.warnings
      };
      const publishRequestID = `publish:${args.requestId}`;
      await session.send({
        type: "publish",
        request_id: publishRequestID,
        to_agent_uuid: args.targetUUID || undefined,
        to_agent_uri: args.targetURI || undefined,
        message: {
          kind: "skill_request",
          request_id: args.requestId,
          skill_name: args.skillName,
          reply_required: true,
          payload: args.payload,
          payload_format: args.payloadFormat,
          input: args.payload,
          session_key: args.sessionKey,
          timestamp: this.deps.now().toISOString()
        }
      });

      const preservedDelivery = await this.waitForResponse(session, publishRequestID, args.timeoutMs, {
        preserveSkillResultRequestId: args.requestId
      });
      if (preservedDelivery) {
        const parsedDelivery = this.parseDeliveryRecord(readObject(preservedDelivery.result));
        const matchedResult = this.toSkillExecutionResult(skillContext, parsedDelivery);
        if (matchedResult) {
          await this.ackDelivery(session, parsedDelivery.deliveryId, args.timeoutMs);
          return matchedResult;
        }
      }

      const deadline = Date.now() + args.timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        const waitMs = Math.max(1, remaining);
        let payload: Record<string, unknown>;
        try {
          payload = await session.next(waitMs);
        } catch {
          throw new Error(`timed out waiting for skill_result for request_id=${args.requestId}`);
        }
        const payloadType = trimOrEmpty(payload.type);
        if (payloadType === "__error__") {
          throw new Error(`websocket error: ${trimOrEmpty(payload.error)}`);
        }
        if (payloadType === "__close__") {
          throw new Error("websocket session closed");
        }

        if (payloadType === "delivery") {
          const parsedDelivery = this.parseDeliveryRecord(readObject(payload.result));
          const matchedResult = this.toSkillExecutionResult(skillContext, parsedDelivery);

          if (matchedResult) {
            await this.ackDelivery(session, parsedDelivery.deliveryId, args.timeoutMs);
            return matchedResult;
          }

          if (parsedDelivery.deliveryId) {
            await this.nackDelivery(session, parsedDelivery.deliveryId);
          }
          continue;
        }

        if (payloadType === "response") {
          const ok = Boolean(payload.ok);
          if (!ok) {
            const code = trimOrEmpty(readObject(payload.error).code) || "unknown_error";
            const message = trimOrEmpty(readObject(payload.error).message) || "unknown error";
            throw new Error(`moltenhub websocket response error (${code}): ${message}`);
          }
        }
      }
    } finally {
      session.close();
    }
  }

  private async requestSkillExecutionOverPull(args: {
    targetUUID: string;
    targetURI: string;
    skillName: string;
    payload: unknown;
    payloadFormat: "json" | "markdown";
    requestId: string;
    sessionKey: string;
    timeoutMs: number;
    warnings: SecretWarning[];
  }): Promise<SkillExecutionResult> {
    const skillContext = {
      requestId: args.requestId,
      skillName: args.skillName,
      warnings: args.warnings
    };

    await this.runtimeJSON("POST", "/openclaw/messages/publish", {
      to_agent_uuid: args.targetUUID || undefined,
      to_agent_uri: args.targetURI || undefined,
      client_msg_id: args.requestId,
      message: {
        kind: "skill_request",
        request_id: args.requestId,
        skill_name: args.skillName,
        reply_required: true,
        payload: args.payload,
        payload_format: args.payloadFormat,
        input: args.payload,
        session_key: args.sessionKey,
        timestamp: this.deps.now().toISOString()
      }
    });

    const deadline = Date.now() + args.timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for skill_result for request_id=${args.requestId}`);
      }

      const pullTimeoutMs = Math.max(0, Math.min(defaultPullTimeoutMs, remaining));
      const pullResult = await this.runtimeJSON(
        "GET",
        `/openclaw/messages/pull?timeout_ms=${encodeURIComponent(String(pullTimeoutMs))}`,
        undefined,
        { allowNoContent: true }
      );
      if (trimOrEmpty(pullResult.status) === "empty") {
        continue;
      }

      const parsedDelivery = this.parseDeliveryRecord(pullResult);
      const matchedResult = this.toSkillExecutionResult(skillContext, parsedDelivery);

      if (matchedResult) {
        if (parsedDelivery.deliveryId) {
          await this.runtimeJSON("POST", "/openclaw/messages/ack", {
            delivery_id: parsedDelivery.deliveryId
          });
        }
        return matchedResult;
      }

      if (parsedDelivery.deliveryId) {
        await this.runtimeJSON("POST", "/openclaw/messages/nack", {
          delivery_id: parsedDelivery.deliveryId
        });
      }
    }
  }

  async getProfile(): Promise<Record<string, unknown>> {
    await this.ensureReady();
    return this.getProfileRaw();
  }

  async updateProfile(request: AgentProfileUpdateRequest): Promise<Record<string, unknown>> {
    const metadata = readObject(request.metadata);
    const warnings = this.collectSecretWarnings(metadata, "$.metadata");
    if (warnings.length > 0 && this.config.safety.blockMetadataSecrets) {
      throw new Error("metadata contains secret-like values and was blocked by plugin safety policy");
    }

    await this.ensureReady();
    const result = await this.patchProfileRaw({
      handle: trimOptional(request.handle),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined
    });

    if (warnings.length === 0) {
      return result;
    }
    return {
      ...result,
      warnings
    };
  }

  async getCapabilities(): Promise<Record<string, unknown>> {
    await this.ensureReady();
    return this.getCapabilitiesRaw();
  }

  async getManifest(format: "json" | "markdown" = "json"): Promise<Record<string, unknown>> {
    await this.ensureReady();
    if (format === "markdown") {
      const content = await this.runtimeText("/agents/me/manifest?format=markdown");
      return {
        format,
        content
      };
    }
    return this.runtimeJSON("GET", "/agents/me/manifest");
  }

  async getSkillGuide(format: "json" | "markdown" = "json"): Promise<Record<string, unknown>> {
    await this.ensureReady();
    if (format === "markdown") {
      const content = await this.runtimeText("/agents/me/skill?format=markdown");
      return {
        format,
        content
      };
    }
    return this.runtimeJSON("GET", "/agents/me/skill");
  }

  async openClawPublish(request: OpenClawPublishRequest): Promise<Record<string, unknown>> {
    const targetUUID = trimOrEmpty(request.toAgentUUID);
    const targetURI = trimOrEmpty(request.toAgentURI);
    const message = readObject(request.message);
    if (!targetUUID && !targetURI) {
      throw new Error("toAgentUUID or toAgentURI is required");
    }
    if (Object.keys(message).length === 0) {
      throw new Error("message is required");
    }

    const warnings = this.maybeWarnPayload(message, "$.message");

    await this.ensureReady();

    const result = await this.runtimeJSON("POST", "/openclaw/messages/publish", {
      to_agent_uuid: targetUUID || undefined,
      to_agent_uri: targetURI || undefined,
      client_msg_id: trimOptional(request.clientMsgID),
      message
    });

    if (warnings.length === 0) {
      return result;
    }
    return {
      ...result,
      warnings
    };
  }

  async openClawPull(request: OpenClawPullRequest = {}): Promise<Record<string, unknown>> {
    await this.ensureReady();

    const timeoutMs = request.timeoutMs === undefined ? defaultPullTimeoutMs : normalizePullTimeout(request.timeoutMs);
    const query = `?timeout_ms=${encodeURIComponent(String(timeoutMs))}`;
    return this.runtimeJSON("GET", `/openclaw/messages/pull${query}`, undefined, { allowNoContent: true });
  }

  async openClawAck(request: OpenClawDeliveryActionRequest): Promise<Record<string, unknown>> {
    const deliveryID = trimOrEmpty(request.deliveryId);
    if (!deliveryID) {
      throw new Error("deliveryId is required");
    }

    await this.ensureReady();
    return this.runtimeJSON("POST", "/openclaw/messages/ack", {
      delivery_id: deliveryID
    });
  }

  async openClawNack(request: OpenClawDeliveryActionRequest): Promise<Record<string, unknown>> {
    const deliveryID = trimOrEmpty(request.deliveryId);
    if (!deliveryID) {
      throw new Error("deliveryId is required");
    }

    await this.ensureReady();
    return this.runtimeJSON("POST", "/openclaw/messages/nack", {
      delivery_id: deliveryID
    });
  }

  async openClawStatus(request: OpenClawMessageStatusRequest): Promise<Record<string, unknown>> {
    const messageID = trimOrEmpty(request.messageId);
    if (!messageID) {
      throw new Error("messageId is required");
    }

    await this.ensureReady();
    return this.runtimeJSON("GET", `/openclaw/messages/${encodeURIComponent(messageID)}`);
  }

  private async ensureReady(): Promise<void> {
    await this.registerPlugin();
    await this.syncProfileIfDue(false);
    await this.ensureSessionHealthy(false);
  }

  private async ensureSessionHealthy(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && this.cachedSessionStatus && now - this.lastSessionCheckAt <= this.config.connection.healthcheckTtlMs) {
      return;
    }
    await this.checkSessionAfterRegistration();
  }

  private async checkSessionAfterRegistration(): Promise<SessionStatusResult> {
    try {
      const session = await this.openSession(this.config.sessionKey, this.config.timeoutMs);
      try {
        const status: SessionStatusResult = {
          status: "ok",
          sessionKey: this.config.sessionKey,
          transport: "websocket"
        };
        this.cachedSessionStatus = status;
        this.lastSessionCheckAt = Date.now();
        return status;
      } finally {
        session.close();
      }
    } catch (error) {
      if (!this.isWebSocketRouteUnsupported(error)) {
        throw error;
      }

      await this.getCapabilitiesRaw();

      const status: SessionStatusResult = {
        status: "ok",
        sessionKey: this.config.sessionKey,
        transport: "http-pull"
      };
      this.cachedSessionStatus = status;
      this.lastSessionCheckAt = Date.now();
      return status;
    }
  }

  private isRegistrationRouteUnsupported(status: number, body: string): boolean {
    if (status === 404 || status === 405 || status === 501) {
      return true;
    }
    const parsed = readObject(tryParseJSON(body));
    const errorObject = readObject(parsed.error);
    const detailObject = readObject(parsed.error_detail);
    const code =
      trimOrEmpty(parsed.error) || trimOrEmpty(errorObject.code) || trimOrEmpty(detailObject.code) || "";
    return (
      code === "not_found" ||
      code === "route_not_found" ||
      code === "method_not_allowed" ||
      code === "not_implemented"
    );
  }

  private isWebSocketRouteUnsupported(error: unknown): boolean {
    const message = String(error);
    return /unexpected server response:\s*(404|405|426)\b/i.test(message);
  }

  private async syncProfileIfDue(force: boolean): Promise<void> {
    if (!this.config.profile.enabled) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastProfileSyncAt < this.config.profile.syncIntervalMs) {
      return;
    }

    if (this.profileSyncInFlight) {
      await this.profileSyncInFlight;
      return;
    }

    this.profileSyncInFlight = this.performProfileSync();
    try {
      await this.profileSyncInFlight;
    } finally {
      this.profileSyncInFlight = null;
    }
  }

  private async performProfileSync(): Promise<void> {
    const metadataPatch = this.buildProfileMetadataPatch();
    const handle = this.nextHandleFinalizeValue();

    const profileMetadata = readObject(this.config.profile.metadata);
    const warnings = this.collectSecretWarnings(profileMetadata, "$.metadata");
    if (warnings.length > 0 && this.config.safety.blockMetadataSecrets) {
      throw new Error("profile sync metadata contains secret-like values and was blocked by plugin safety policy");
    }

    const payload: AgentProfileUpdateRequest = {
      handle,
      metadata: metadataPatch
    };

    try {
      await this.patchProfileRaw(payload);
    } catch (error) {
      if (handle && this.shouldIgnoreHandleError(error)) {
        await this.patchProfileRaw({ metadata: metadataPatch });
      } else {
        throw error;
      }
    }

    this.lastProfileSyncAt = Date.now();
  }

  private nextHandleFinalizeValue(): string | undefined {
    const requested = trimOrEmpty(this.config.profile.handle);
    if (!requested || this.handleFinalizeAttempted) {
      return undefined;
    }
    this.handleFinalizeAttempted = true;
    return requested;
  }

  private shouldIgnoreHandleError(error: unknown): boolean {
    if (error instanceof MoltenHubAPIError) {
      return error.code === "agent_handle_locked" || error.code === "agent_exists";
    }
    const text = String(error).toLowerCase();
    return text.includes("agent_handle_locked") || text.includes("agent_exists");
  }

  private buildProfileMetadataPatch(): Record<string, unknown> {
    const baseMetadata = copyRecord(readObject(this.config.profile.metadata));
    const pluginKey = normalizePluginMetadataKey(this.config.pluginId);

    const metadataPatch: Record<string, unknown> = {
      ...baseMetadata,
      agent_type: "openclaw",
      plugins: {
        [pluginKey]: {
          native_contract: {
            schema_version: "1.0.0",
            plugin_id: this.config.pluginId,
            plugin_package: this.config.pluginPackage,
            plugin_version: this.config.pluginVersion,
            session_key: this.config.sessionKey,
            api_base: this.config.baseUrl,
            tool_names: [...NATIVE_TOOL_NAMES],
            safety_policy: {
              block_metadata_secrets: this.config.safety.blockMetadataSecrets,
              warn_message_secrets: this.config.safety.warnMessageSecrets,
              secret_markers: this.config.safety.secretMarkers
            },
            updated_at: this.deps.now().toISOString()
          }
        }
      }
    };

    return deepMergeRecords(baseMetadata, metadataPatch);
  }

  private maybeWarnPayload(payload: unknown, path: string): SecretWarning[] {
    if (!this.config.safety.warnMessageSecrets) {
      return [];
    }
    return this.collectSecretWarnings(payload, path);
  }

  private normalizeSkillPayload(
    payload: unknown,
    requestedFormat: SkillExecutionRequest["payloadFormat"]
  ): { payload: unknown; format: "json" | "markdown" } {
    const normalizedFormat =
      requestedFormat === "json" || requestedFormat === "markdown"
        ? requestedFormat
        : typeof payload === "string"
          ? "markdown"
          : "json";

    if (normalizedFormat === "markdown") {
      if (payload === undefined || payload === null) {
        return { payload: "", format: "markdown" };
      }
      if (typeof payload !== "string") {
        throw new Error("payloadFormat=markdown requires a string payload");
      }
      return { payload, format: "markdown" };
    }

    if (payload === undefined) {
      return { payload: {}, format: "json" };
    }

    if (typeof payload === "string") {
      const parsed = tryParseJSON(payload);
      if (parsed === undefined) {
        throw new Error("payloadFormat=json requires a JSON payload");
      }
      return { payload: parsed, format: "json" };
    }

    return { payload, format: "json" };
  }

  private collectSecretWarnings(payload: unknown, rootPath: string): SecretWarning[] {
    return collectSecretWarnings(payload, this.config.safety.secretMarkers, rootPath);
  }

  private async getProfileRaw(): Promise<Record<string, unknown>> {
    return this.runtimeJSON("GET", "/agents/me");
  }

  private async getCapabilitiesRaw(): Promise<Record<string, unknown>> {
    return this.runtimeJSON("GET", "/agents/me/capabilities");
  }

  private async patchProfileRaw(request: AgentProfileUpdateRequest): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {};
    const handle = trimOptional(request.handle);
    const metadata = readObject(request.metadata);
    if (handle) {
      payload.handle = handle;
    }
    if (Object.keys(metadata).length > 0) {
      payload.metadata = metadata;
    }
    if (Object.keys(payload).length === 0) {
      return this.getProfileRaw();
    }
    return this.runtimeJSON("PATCH", "/agents/me/metadata", payload);
  }

  private async openSession(sessionKey: string, timeoutMs: number): Promise<WebSocketSession> {
    const wsBase = this.config.baseUrl.replace(/^http/i, "ws");
    const wsURL = `${wsBase}/openclaw/messages/ws?session_key=${encodeURIComponent(sessionKey)}`;
    const socket = this.deps.wsFactory(wsURL, {
      Authorization: `Bearer ${this.config.token}`
    });

    const session = new WebSocketSession(socket);
    session.attach();
    await waitForOpen(socket, timeoutMs);

    const firstMessage = await session.next(timeoutMs);
    if (trimOrEmpty(firstMessage.type) !== "session_ready") {
      throw new Error(`unexpected websocket handshake message type=${trimOrEmpty(firstMessage.type)}`);
    }

    return session;
  }

  private async waitForResponse(
    session: WebSocketSession,
    requestID: string,
    timeoutMs: number
  ): Promise<Record<string, unknown> | undefined>;
  private async waitForResponse(
    session: WebSocketSession,
    requestID: string,
    timeoutMs: number,
    options: WaitForResponseOptions
  ): Promise<Record<string, unknown> | undefined>;
  private async waitForResponse(
    session: WebSocketSession,
    requestID: string,
    timeoutMs: number,
    options: WaitForResponseOptions = {}
  ): Promise<Record<string, unknown> | undefined> {
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
          const parsedDelivery = this.parseDeliveryRecord(readObject(payload.result));
          const deliveryKind = trimOrEmpty(parsedDelivery.message.kind);
          const deliveryRequestID = trimOrEmpty(parsedDelivery.message.request_id);
          if (
            options.preserveSkillResultRequestId &&
            deliveryKind === "skill_result" &&
            deliveryRequestID === options.preserveSkillResultRequestId
          ) {
            return payload;
          }
          if (parsedDelivery.deliveryId) {
            await this.nackDelivery(session, parsedDelivery.deliveryId);
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
        throw new Error(`moltenhub websocket response error (${code}): ${message}`);
      }
      return undefined;
    }
  }

  private parseDeliveryRecord(record: Record<string, unknown>): ParsedDelivery {
    const messageRecord = readObject(record.message);
    const primaryMessage = readObject(record.openclaw_message);
    const message =
      Object.keys(primaryMessage).length > 0
        ? primaryMessage
        : trimOrEmpty(messageRecord.kind)
          ? messageRecord
          : {};

    return {
      deliveryId: trimOrEmpty(readObject(record.delivery).delivery_id ?? trimOptional(asString(record.delivery_id))),
      messageId: trimOrEmpty(messageRecord.message_id ?? trimOptional(asString(record.message_id))),
      message
    };
  }

  private toSkillExecutionResult(
    skillContext: { requestId: string; skillName: string; warnings: SecretWarning[] },
    delivery: ParsedDelivery
  ): SkillExecutionResult | undefined {
    const kind = trimOrEmpty(delivery.message.kind);
    const resultRequestID = trimOrEmpty(delivery.message.request_id);
    if (kind !== "skill_result" || resultRequestID !== skillContext.requestId) {
      return undefined;
    }

    return {
      requestId: skillContext.requestId,
      skillName: skillContext.skillName,
      status: trimOrEmpty(delivery.message.status) || "ok",
      output: delivery.message.output,
      error: delivery.message.error,
      messageId: delivery.messageId,
      deliveryId: delivery.deliveryId,
      warnings: skillContext.warnings.length > 0 ? skillContext.warnings : undefined
    };
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

  private async runtimeJSON(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: Record<string, unknown>,
    options?: RuntimeRequestOptions
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.deps.fetchImpl(this.runtimeURL(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (response.status === 204) {
      if (options?.allowNoContent) {
        return { status: "empty" };
      }
      return {};
    }

    const raw = await safeReadText(response);

    if (!response.ok) {
      throw parseRuntimeError(response.status, raw);
    }

    if (!raw) {
      return {};
    }

    const parsed = tryParseJSON(raw);
    if (parsed === undefined) {
      return { content: raw };
    }

    const parsedObject = readObject(parsed);
    if (Object.keys(parsedObject).length === 0) {
      return { value: parsed };
    }

    if (parsedObject.ok === false) {
      throw parseRuntimeError(response.status, raw);
    }

    const result = parsedObject.result;
    if (result !== undefined) {
      const asRecord = readObject(result);
      if (Object.keys(asRecord).length > 0) {
        return asRecord;
      }
      return { value: result };
    }

    return parsedObject;
  }

  private async runtimeText(path: string): Promise<string> {
    const response = await this.deps.fetchImpl(this.runtimeURL(path), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "text/markdown"
      }
    });

    const raw = await safeReadText(response);
    if (!response.ok) {
      throw parseRuntimeError(response.status, raw);
    }
    return raw;
  }

  private runtimeURL(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.config.baseUrl}${normalizedPath}`;
  }
}

function normalizeRuntimeConfig(config: MoltenHubPluginConfig): MoltenHubPluginConfig {
  const unsafe = config as unknown as {
    localPrompts?: unknown;
    profile?: Partial<MoltenHubPluginConfig["profile"]>;
    connection?: Partial<MoltenHubPluginConfig["connection"]>;
    safety?: Partial<MoltenHubPluginConfig["safety"]>;
  };

  const localPrompts = normalizeLocalPrompts(unsafe.localPrompts, "localPrompts");
  const profile = unsafe.profile ?? {};
  const connection = unsafe.connection ?? {};
  const safety = unsafe.safety ?? {};

  return {
    ...config,
    localPrompts,
    profile: {
      enabled: profile.enabled ?? true,
      handle: trimOptional(profile.handle),
      metadata: readObject(profile.metadata),
      syncIntervalMs: normalizeBoundedNumber(
        typeof profile.syncIntervalMs === "number" ? profile.syncIntervalMs : defaultProfileSyncIntervalMs,
        10_000,
        86_400_000,
        defaultProfileSyncIntervalMs
      )
    },
    connection: {
      healthcheckTtlMs: normalizeBoundedNumber(
        typeof connection.healthcheckTtlMs === "number" ? connection.healthcheckTtlMs : defaultHealthcheckTtlMs,
        1_000,
        3_600_000,
        defaultHealthcheckTtlMs
      )
    },
    safety: {
      blockMetadataSecrets: safety.blockMetadataSecrets ?? true,
      warnMessageSecrets: safety.warnMessageSecrets ?? true,
      secretMarkers: normalizeSecretMarkers(readStringArray(safety.secretMarkers))
    }
  };
}

export function resolveConfig(context: ResolveConfigInput): MoltenHubPluginConfig {
  const config = context.config ?? {};
  const env = context.env ?? {};
  const configFilePath = trimOrEmpty(asString(config.configFile) || env.MOLTENHUB_CONFIG_FILE || "");
  const fileConfig = readConfigFile(configFilePath);

  const baseUrl = normalizeBaseURL(
    asString(config.baseUrl) ||
      asString(config.baseURL) ||
      asString(fileConfig.baseUrl) ||
      asString(fileConfig.baseURL) ||
      env.MOLTENHUB_BASE_URL ||
      env.MOLTENHUB_API_BASE ||
      ""
  );
  const token = trimOrEmpty(asString(config.token) || asString(fileConfig.token) || env.MOLTENHUB_AGENT_TOKEN || "");
  const sessionKey = trimOrEmpty(
    asString(config.sessionKey) || asString(fileConfig.sessionKey) || env.MOLTENHUB_SESSION_KEY || "main"
  );
  const timeoutMs = normalizeTimeout(
    asNumber(config.timeoutMs) ?? asNumber(fileConfig.timeoutMs) ?? asNumber(env.MOLTENHUB_TIMEOUT_MS) ?? defaultTimeoutMs
  );
  const pluginId = trimOrEmpty(asString(config.pluginId) || asString(fileConfig.pluginId) || defaultPluginID);
  const pluginPackage = trimOrEmpty(
    asString(config.pluginPackage) || asString(fileConfig.pluginPackage) || defaultPluginPackage
  );
  const pluginVersion = trimOrEmpty(
    asString(config.pluginVersion) || asString(fileConfig.pluginVersion) || defaultPluginVersion
  );
  const localPrompts = normalizeLocalPrompts(
    config.localPrompts !== undefined ? config.localPrompts : fileConfig.localPrompts,
    "localPrompts"
  );

  const fileProfile = readObject(fileConfig.profile);
  const inlineProfile = readObject(config.profile);
  const profileEnabled =
    asBoolean(inlineProfile.enabled) ??
    asBoolean(config.profileEnabled) ??
    asBoolean(fileProfile.enabled) ??
    asBoolean(env.MOLTENHUB_PROFILE_ENABLED) ??
    true;
  const profileHandle =
    trimOrEmpty(
      asString(inlineProfile.handle) ||
        asString(config.profileHandle) ||
        asString(fileProfile.handle) ||
        env.MOLTENHUB_PROFILE_HANDLE ||
        ""
    ) || undefined;
  const profileMetadata = deepMergeRecords(
    readObject(fileProfile.metadata),
    readObject(config.profileMetadata),
    readObject(inlineProfile.metadata)
  );
  const profileSyncIntervalMs = normalizeBoundedNumber(
    asNumber(inlineProfile.syncIntervalMs) ??
      asNumber(config.profileSyncIntervalMs) ??
      asNumber(fileProfile.syncIntervalMs) ??
      asNumber(env.MOLTENHUB_PROFILE_SYNC_INTERVAL_MS) ??
      defaultProfileSyncIntervalMs,
    10_000,
    86_400_000,
    defaultProfileSyncIntervalMs
  );

  const fileConnection = readObject(fileConfig.connection);
  const inlineConnection = readObject(config.connection);
  const healthcheckTtlMs = normalizeBoundedNumber(
    asNumber(inlineConnection.healthcheckTtlMs) ??
      asNumber(config.healthcheckTtlMs) ??
      asNumber(fileConnection.healthcheckTtlMs) ??
      asNumber(env.MOLTENHUB_HEALTHCHECK_TTL_MS) ??
      defaultHealthcheckTtlMs,
    1_000,
    3_600_000,
    defaultHealthcheckTtlMs
  );

  const fileSafety = readObject(fileConfig.safety);
  const inlineSafety = readObject(config.safety);
  const blockMetadataSecrets =
    asBoolean(inlineSafety.blockMetadataSecrets) ??
    asBoolean(config.blockMetadataSecrets) ??
    asBoolean(fileSafety.blockMetadataSecrets) ??
    asBoolean(env.MOLTENHUB_BLOCK_METADATA_SECRETS) ??
    true;
  const warnMessageSecrets =
    asBoolean(inlineSafety.warnMessageSecrets) ??
    asBoolean(config.warnMessageSecrets) ??
    asBoolean(fileSafety.warnMessageSecrets) ??
    asBoolean(env.MOLTENHUB_WARN_MESSAGE_SECRETS) ??
    true;
  const secretMarkers = normalizeSecretMarkers([
    ...readStringArray(fileConfig.secretMarkers),
    ...readStringArray(fileSafety.secretMarkers),
    ...readStringArray(config.secretMarkers),
    ...readStringArray(inlineSafety.secretMarkers),
    ...splitCommaSeparated(asString(env.MOLTENHUB_SECRET_MARKERS))
  ]);

  if (!baseUrl) {
    throw new Error("MoltenHub plugin configuration requires baseUrl");
  }

  if (!token) {
    throw new Error("MoltenHub plugin configuration requires token");
  }

  return {
    baseUrl,
    token,
    sessionKey,
    timeoutMs,
    pluginId,
    pluginPackage,
    pluginVersion,
    localPrompts,
    profile: {
      enabled: profileEnabled,
      handle: profileHandle,
      metadata: Object.keys(profileMetadata).length > 0 ? profileMetadata : undefined,
      syncIntervalMs: profileSyncIntervalMs
    },
    connection: {
      healthcheckTtlMs
    },
    safety: {
      blockMetadataSecrets,
      warnMessageSecrets,
      secretMarkers
    }
  };
}

function readinessItem(ok = false, error?: string, skipped = false): ReadinessCheckItem {
  return {
    ok,
    skipped: skipped || undefined,
    error,
    checkedAt: new Date().toISOString()
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
    throw new Error(`failed reading MoltenHub plugin config file (${absolutePath}): ${String(error)}`);
  }

  try {
    const parsed = JSON.parse(rawContent.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config file must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid MoltenHub plugin config file (${absolutePath}): ${String(error)}`);
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

function normalizePullTimeout(raw: number): number {
  if (!Number.isFinite(raw)) {
    return defaultPullTimeoutMs;
  }
  if (raw < 0 || raw > 30_000) {
    throw new Error("timeoutMs must be between 0 and 30000");
  }
  return Math.trunc(raw);
}

function normalizeBoundedNumber(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  const normalized = Math.trunc(raw);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

function normalizePluginMetadataKey(pluginID: string): string {
  let key = trimOrEmpty(pluginID).toLowerCase();
  if (!key) {
    key = "moltenhub-openclaw";
  }
  key = key.replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!key) {
    return "moltenhub_openclaw";
  }
  return key;
}

function trimOrEmpty(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function trimOptional(value: unknown): string | undefined {
  const trimmed = trimOrEmpty(value);
  return trimmed || undefined;
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

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function deepMergeRecords(...records: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      const existing = out[key];
      if (isRecord(existing) && isRecord(value)) {
        out[key] = deepMergeRecords(existing, value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => trimOrEmpty(entry))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return splitCommaSeparated(value);
  }
  return [];
}

function splitCommaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeLocalPrompts(value: unknown, fieldPath: string): LocalServicePrompt[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  let parsed: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    parsed = tryParseJSON(trimmed);
    if (parsed === undefined) {
      throw new Error(`MoltenHub plugin configuration ${fieldPath} must be valid JSON`);
    }
  }

  const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : [];
  if (entries.length === 0) {
    throw new Error(`MoltenHub plugin configuration ${fieldPath} must be an object or an array of objects`);
  }

  return entries.map((entry, index) => normalizeLocalPromptEntry(entry, `${fieldPath}[${index}]`));
}

function normalizeLocalPromptEntry(value: unknown, fieldPath: string): LocalServicePrompt {
  if (!isRecord(value)) {
    throw new Error(`MoltenHub plugin configuration ${fieldPath} must be an object`);
  }

  const repo = trimOrEmpty(value.repo);
  const baseBranch = trimOrEmpty(value.base_branch ?? value.baseBranch);
  const targetSubdir = trimOrEmpty(value.target_subdir ?? value.targetSubdir);
  const prompt = asString(value.prompt);

  if (!repo || !baseBranch || !targetSubdir || !prompt.trim()) {
    throw new Error(
      `MoltenHub plugin configuration ${fieldPath} requires non-empty repo, base_branch, target_subdir, and prompt`
    );
  }

  return {
    repo,
    base_branch: baseBranch,
    target_subdir: targetSubdir,
    prompt
  };
}

function normalizeSecretMarkers(customMarkers: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const marker of [...defaultSecretMarkers, ...customMarkers]) {
    const normalized = marker.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function collectSecretWarnings(payload: unknown, markers: string[], rootPath: string): SecretWarning[] {
  const warnings: SecretWarning[] = [];
  walkPayload(payload, rootPath, markers, warnings);
  return warnings;
}

function walkPayload(
  value: unknown,
  path: string,
  markers: string[],
  warnings: SecretWarning[],
  maxWarnings = 20
): void {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    for (const marker of markers) {
      if (normalized.includes(marker)) {
        warnings.push({
          fieldPath: path,
          marker,
          message: `Potential secret marker detected at ${path}`
        });
        return;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (warnings.length >= maxWarnings) {
        return;
      }
      walkPayload(item, `${path}[${index}]`, markers, warnings, maxWarnings);
    });
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (warnings.length >= maxWarnings) {
      return;
    }
    walkPayload(child, `${path}.${key}`, markers, warnings, maxWarnings);
  }
}

function parseRuntimeError(status: number, bodyText: string): MoltenHubAPIError {
  const fallbackCode = "http_error";
  const fallbackMessage = bodyText || `request failed with status ${status}`;
  const parsed = tryParseJSON(bodyText);

  if (!isRecord(parsed)) {
    return new MoltenHubAPIError(fallbackMessage, status, fallbackCode);
  }

  const topLevelCode = trimOrEmpty(parsed.error);
  const topLevelMessage = trimOrEmpty(parsed.message);
  const topLevelRetryable = readBoolean(parsed.retryable) ?? false;
  const topLevelNextAction = trimOrEmpty(parsed.next_action);

  const nestedError = readObject(parsed.error);
  const nestedCode = trimOrEmpty(nestedError.code);
  const nestedMessage = trimOrEmpty(nestedError.message);

  const code = nestedCode || topLevelCode || fallbackCode;
  const message = nestedMessage || topLevelMessage || fallbackMessage;

  return new MoltenHubAPIError(message, status, code, topLevelRetryable, topLevelNextAction);
}

function tryParseJSON(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
