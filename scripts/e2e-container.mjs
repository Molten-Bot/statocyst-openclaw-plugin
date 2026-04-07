#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { createMoltenHubOpenClawPlugin, NATIVE_TOOL_NAMES } from "../dist/index.js";

const moltenhubImage = process.env.MOLTENHUB_IMAGE || "moltenbot/moltenhub:latest";
const moltenhubPort = Number.parseInt(process.env.MOLTENHUB_PORT || "18082", 10);
const containerName = `moltenhub-openclaw-plugin-e2e-${moltenhubPort}`;
const baseURL = `http://127.0.0.1:${moltenhubPort}`;
const apiBase = `${baseURL}/v1`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.silent ? "pipe" : "inherit"
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }
  return result;
}

async function httpJSON(method, path, body, headers = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const raw = await response.text();
  const json = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${raw}`);
  }
  return json;
}

function humanHeaders(humanID, email) {
  return {
    "X-Human-Id": humanID,
    "X-Human-Email": email
  };
}

function runtimeHeaders(token) {
  return {
    Authorization: `Bearer ${token}`
  };
}

async function ensureHandleConfirmed(humanID, email) {
  await httpJSON("PATCH", "/v1/me", { handle: humanID }, humanHeaders(humanID, email));
}

async function createOrg(humanID, email, handle, displayName) {
  const payload = await httpJSON(
    "POST",
    "/v1/orgs",
    {
      handle,
      display_name: displayName
    },
    humanHeaders(humanID, email)
  );
  const orgID = payload?.organization?.org_id;
  assert.ok(orgID, "missing org_id");
  return orgID;
}

async function registerAgent(humanID, email, orgID, handle) {
  const tokenPayload = await httpJSON(
    "POST",
    "/v1/agents/bind-tokens",
    { org_id: orgID },
    humanHeaders(humanID, email)
  );
  const bindToken = tokenPayload?.bind_token;
  assert.ok(bindToken, "missing bind_token");

  const redeemPayload = await httpJSON("POST", "/v1/agents/bind", { bind_token: bindToken, handle });
  const redeemResult = unwrapResult(redeemPayload);
  const token = redeemResult?.token ?? redeemPayload?.token;
  assert.ok(token, "missing agent token");

  const mePayload = await httpJSON("GET", "/v1/agents/me", undefined, runtimeHeaders(token));
  const meResult = unwrapResult(mePayload);
  const agent = meResult?.agent ?? mePayload?.agent;
  const agentUUID = agent?.agent_uuid;
  assert.ok(agentUUID, "missing agent_uuid");

  return { token, agentUUID };
}

async function createAndApproveTrust(alice, bob, orgA, orgB, agentAUUID, agentBUUID) {
  const orgTrustCreate = await httpJSON(
    "POST",
    "/v1/org-trusts",
    {
      org_id: orgA,
      peer_org_id: orgB
    },
    humanHeaders(alice.id, alice.email)
  );
  const orgTrustID = orgTrustCreate?.trust?.edge_id;
  assert.ok(orgTrustID, "missing org trust edge_id");

  await httpJSON("POST", `/v1/org-trusts/${orgTrustID}/approve`, undefined, humanHeaders(bob.id, bob.email));

  const agentTrustCreate = await httpJSON(
    "POST",
    "/v1/agent-trusts",
    {
      org_id: orgA,
      agent_uuid: agentAUUID,
      peer_agent_uuid: agentBUUID
    },
    humanHeaders(alice.id, alice.email)
  );
  const agentTrustID = agentTrustCreate?.trust?.edge_id;
  assert.ok(agentTrustID, "missing agent trust edge_id");

  await httpJSON("POST", `/v1/agent-trusts/${agentTrustID}/approve`, undefined, humanHeaders(bob.id, bob.email));
}

function unwrapResult(payload) {
  if (payload && payload.ok === true && payload.result && typeof payload.result === "object") {
    return payload.result;
  }
  return payload;
}

function unwrapToolResult(payload) {
  if (payload && typeof payload === "object" && payload.data !== undefined) {
    return payload.data;
  }
  const content = payload?.content;
  if (Array.isArray(content) && content.length > 0 && typeof content[0]?.text === "string") {
    return JSON.parse(content[0].text);
  }
  return payload;
}

function registerTools(config) {
  const plugin = createMoltenHubOpenClawPlugin();
  const tools = new Map();

  plugin.register({
    pluginConfig: config,
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    }
  });

  for (const toolName of NATIVE_TOOL_NAMES) {
    assert.ok(tools.has(toolName), `missing expected native tool registration: ${toolName}`);
  }

  return async function callTool(name, params = {}) {
    const tool = tools.get(name);
    assert.ok(tool, `tool not found: ${name}`);
    const result = await tool.execute(`call-${name}-${Date.now()}`, params);
    return unwrapToolResult(result);
  };
}

function buildPluginConfig(token, sessionKey) {
  return {
    baseUrl: apiBase,
    token,
    sessionKey,
    timeoutMs: 45_000,
    pluginId: "openclaw-plugin-moltenhub",
    pluginPackage: "@moltenbot/openclaw-plugin-moltenhub",
    pluginVersion: "0.1.6",
    profile: {
      enabled: true,
      syncIntervalMs: 1_000,
      metadata: {
        llm: "openai/gpt-5.4@2026-03-01",
        harness: "openclaw@latest"
      }
    },
    connection: {
      healthcheckTtlMs: 500
    },
    safety: {
      blockMetadataSecrets: true,
      warnMessageSecrets: true,
      secretMarkers: ["x-api-key"]
    }
  };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.status === "ok" && payload?.boot_status !== "starting") {
          return;
        }
      }
    } catch {
      // ignore and retry
    }
    await delay(1000);
  }
  throw new Error(`moltenhub container did not become healthy at ${baseURL}/health`);
}

async function ensureOpenClawRealtimeRoutes() {
  const wsResponse = await fetch(`${baseURL}/v1/openclaw/messages/ws`);
  if (wsResponse.status !== 404) {
    return;
  }
  throw new Error(
    `moltenhub image "${moltenhubImage}" does not expose /v1/openclaw/messages/ws; set MOLTENHUB_IMAGE to a build containing realtime OpenClaw routes`
  );
}

function cleanup() {
  run("docker", ["rm", "-f", containerName], { allowFailure: true, silent: true });
}

async function main() {
  cleanup();

  run("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    `127.0.0.1:${moltenhubPort}:8080`,
    "-e",
    "HUMAN_AUTH_PROVIDER=dev",
    "-e",
    `MOLTENHUB_CANONICAL_BASE_URL=${baseURL}`,
    moltenhubImage
  ]);

  await waitForHealth();
  await ensureOpenClawRealtimeRoutes();

  const alice = { id: "alice", email: "alice@e2e.test" };
  const bob = { id: "bob", email: "bob@e2e.test" };

  await ensureHandleConfirmed(alice.id, alice.email);
  await ensureHandleConfirmed(bob.id, bob.email);

  const orgA = await createOrg(alice.id, alice.email, "org-a", "Org A");
  const orgB = await createOrg(bob.id, bob.email, "org-b", "Org B");

  const agentA = await registerAgent(alice.id, alice.email, orgA, "agent-a");
  const agentB = await registerAgent(bob.id, bob.email, orgB, "agent-b");

  await createAndApproveTrust(alice, bob, orgA, orgB, agentA.agentUUID, agentB.agentUUID);

  const callToolA = registerTools(buildPluginConfig(agentA.token, "e2e-main-a"));
  const callToolB = registerTools(buildPluginConfig(agentB.token, "e2e-main-b"));

  const sessionStatus = await callToolA("moltenhub_session_status");
  assert.equal(sessionStatus.status, "ok");

  const readiness = await callToolA("moltenhub_readiness_check");
  assert.equal(readiness.status, "ok");

  const profileBefore = await callToolA("moltenhub_profile_get");
  assert.ok(profileBefore.agent?.agent_uuid, "missing profile agent uuid");

  const profileUpdate = await callToolA("moltenhub_profile_update", {
    metadata: {
      profile_markdown: "# Agent A\nReady for MoltenHub native tools",
      activities: ["connected to moltenhub"],
      hire_me: true,
      llm: "openai/gpt-5.4@2026-03-01",
      harness: "openclaw@latest",
      skills: [
        {
          name: "echo_skill",
          description: "echoes a short payload"
        }
      ]
    }
  });
  assert.ok(profileUpdate.agent?.metadata, "missing updated metadata");

  const profileAfter = await callToolA("moltenhub_profile_get");
  assert.equal(profileAfter.agent?.metadata?.agent_type, "openclaw");

  const capabilities = await callToolA("moltenhub_capabilities_get");
  assert.ok(capabilities.control_plane, "missing control_plane in capabilities");

  const manifestJSON = await callToolA("moltenhub_manifest_get", { format: "json" });
  assert.ok(manifestJSON.manifest, "missing JSON manifest payload");

  const manifestMarkdown = await callToolA("moltenhub_manifest_get", { format: "markdown" });
  assert.equal(manifestMarkdown.format, "markdown");
  assert.ok(
    typeof manifestMarkdown.content === "string" && manifestMarkdown.content.length > 0,
    "missing manifest markdown content"
  );

  const skillGuideMarkdown = await callToolA("moltenhub_skill_guide_get", { format: "md" });
  assert.equal(skillGuideMarkdown.format, "markdown");
  assert.ok(
    typeof skillGuideMarkdown.content === "string" && skillGuideMarkdown.content.includes("Skill Call Contract"),
    "missing skill guide markdown content"
  );

  await assert.rejects(
    () =>
      callToolA("moltenhub_profile_update", {
        metadata: {
          skills: [
            {
              name: "bad_skill",
              description: "contains api key: [redacted]"
            }
          ]
        }
      }),
    /blocked by plugin safety policy/
  );

  const warningPublish = await callToolA("moltenhub_openclaw_publish", {
    toAgentUUID: agentB.agentUUID,
    message: {
      kind: "agent_message",
      text: "token: [redacted]"
    }
  });
  assert.ok(Array.isArray(warningPublish.warnings) && warningPublish.warnings.length > 0, "expected payload warning");

  const publishResult = await callToolA("moltenhub_openclaw_publish", {
    toAgentUUID: agentB.agentUUID,
    message: {
      kind: "node_event",
      session_key: "main",
      text: "build complete",
      data: {
        exit_code: 0
      }
    }
  });
  const messageID = publishResult?.message_id;
  assert.ok(messageID, "missing message_id from openclaw publish");

  const baselinePull = await callToolB("moltenhub_openclaw_pull", { timeoutMs: 1_000 });
  assert.ok(baselinePull && typeof baselinePull === "object", "missing openclaw pull response");

  const statusResult = await callToolA("moltenhub_openclaw_status", { messageId: messageID });
  assert.ok(statusResult.message || statusResult.message_id, "missing message status result");

  const requestID = "req-e2e-1";
  const requestPromise = callToolA("moltenhub_skill_request", {
    toAgentUUID: agentB.agentUUID,
    skillName: "echo_skill",
    input: { message: "ping" },
    awaitResult: true,
    requestId: requestID,
    timeoutMs: 45_000
  });

  await delay(250);
  const syntheticSkillResult = await callToolB("moltenhub_openclaw_publish", {
    toAgentUUID: agentA.agentUUID,
    message: {
      kind: "skill_result",
      request_id: requestID,
      status: "ok",
      output: { reply: "pong" }
    }
  });
  assert.ok(syntheticSkillResult.message_id, "missing message_id from synthetic skill_result publish");

  const skillResult = await requestPromise;
  assert.equal(skillResult.status, "ok");
  assert.deepEqual(skillResult.output, { reply: "pong" });

  console.log("Container e2e passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
