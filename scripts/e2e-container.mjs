#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { MoltenHubClient } from "../dist/index.js";

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

function runtimeResult(payload, routeName) {
  if (!payload || payload.ok !== true || !payload.result) {
    throw new Error(`${routeName} did not return runtime success envelope: ${JSON.stringify(payload)}`);
  }
  return payload.result;
}

function unwrapResult(payload) {
  if (payload && payload.ok === true && payload.result && typeof payload.result === "object") {
    return payload.result;
  }
  return payload;
}

async function responderLoop(agentBToken, agentAUUID) {
  const deadlineMs = Date.now() + 45_000;
  let deliveryID;
  let requestID;
  let lastPullPayload = null;
  while (Date.now() < deadlineMs) {
    const pullPayload = await httpJSON(
      "GET",
      "/v1/openclaw/messages/pull?timeout_ms=10000",
      undefined,
      runtimeHeaders(agentBToken)
    );
    lastPullPayload = pullPayload;
    const pullResult = unwrapResult(pullPayload);
    deliveryID = pullResult?.delivery?.delivery_id;
    requestID = pullResult?.openclaw_message?.request_id;
    if (deliveryID && requestID) {
      break;
    }
  }
  assert.ok(deliveryID, `missing delivery_id from responder pull: ${JSON.stringify(lastPullPayload)}`);
  assert.ok(requestID, `missing request_id from responder pull: ${JSON.stringify(lastPullPayload)}`);

  await httpJSON(
    "POST",
    "/v1/openclaw/messages/ack",
    { delivery_id: deliveryID },
    runtimeHeaders(agentBToken)
  );

  await httpJSON(
    "POST",
    "/v1/openclaw/messages/publish",
    {
      to_agent_uuid: agentAUUID,
      message: {
        kind: "skill_result",
        request_id: requestID,
        skill_name: "echo_skill",
        status: "ok",
        output: {
          reply: "pong"
        }
      }
    },
    runtimeHeaders(agentBToken)
  );
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

  const client = new MoltenHubClient({
    baseUrl: apiBase,
    token: agentA.token,
    sessionKey: "e2e-main",
    timeoutMs: 45000,
    pluginId: "openclaw-plugin-moltenhub",
    pluginPackage: "@moltenbot/openclaw-plugin-moltenhub",
    pluginVersion: "0.1.4"
  });

  const requestPromise = client.requestSkillExecution({
    toAgentUUID: agentB.agentUUID,
    skillName: "echo_skill",
    input: { message: "ping" },
    requestId: "req-e2e-1",
    timeoutMs: 45000
  });

  const responderPromise = responderLoop(agentB.token, agentA.agentUUID);

  const [result] = await Promise.all([requestPromise, responderPromise]);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, { reply: "pong" });

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
