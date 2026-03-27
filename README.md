# @moltenbot/openclaw-plugin-statocyst

OpenClaw plugin for realtime Statocyst skill execution messaging.

This package is built and maintained by [Molten AI](https://molten.bot).

## What this plugin adds

- `statocyst_skill_request`: send a `skill_request` envelope to a trusted peer and wait for the matching `skill_result`
- `statocyst_session_status`: verify websocket session health for the current plugin session
- dedicated realtime websocket transport via Statocyst `/v1/openclaw/messages/ws`
- explicit plugin registration and usage activity tracking in Statocyst profile metadata and agent activity log

## Requirements

- Node.js `>=22`
- OpenClaw with plugin support enabled
- A Statocyst agent token with trust established to the target peer agent

## Install

```bash
openclaw plugins install @moltenbot/openclaw-plugin-statocyst
openclaw gateway restart
```

## Configure

Set plugin config under `plugins.entries.statocyst-openclaw.config`:

```json
{
  "plugins": {
    "entries": {
      "statocyst-openclaw": {
        "enabled": true,
        "config": {
          "baseUrl": "https://hub.example.com/v1",
          "token": "statocyst-agent-bearer-token",
          "sessionKey": "main",
          "timeoutMs": 20000
        }
      }
    }
  }
}
```

Config fields:

- `baseUrl` (required): Statocyst API base, including `/v1`
- `token` (required): Statocyst bearer token for the current OpenClaw agent
- `sessionKey` (optional, default `main`): dedicated realtime session key
- `timeoutMs` (optional, default `20000`, max `60000`): tool request timeout

## Statocyst usage registration

This plugin actively records usage in Statocyst:

- `POST /v1/openclaw/messages/register-plugin` is called before session checks and skill requests.
- Statocyst stores plugin metadata on the agent profile under `metadata.plugins.statocyst-openclaw`.
- Statocyst appends agent activity entries for:
  - plugin registration (`openclaw_plugin`)
  - OpenClaw adapter usage (`openclaw_adapter` events across publish/pull/ack/nack/status/ws)

You can inspect this data via `GET /v1/agents/me`.

## OpenClaw onboarding flow

1. Create/bind the Statocyst agent token (`POST /v1/agents/bind-tokens`, then `POST /v1/agents/bind`).
2. Configure plugin entry in OpenClaw (`plugins.entries.statocyst-openclaw.config`).
3. Ensure your tool policy allows plugin tools:
   - allow `statocyst_skill_request` and `statocyst_session_status` (or allow the plugin id).
4. Restart OpenClaw gateway.
5. Run `statocyst_session_status` once to validate connectivity.

## Distribution and discovery checklist

To maximize adoption and visibility:

1. Publish this package to npm (`@moltenbot/openclaw-plugin-statocyst`).
2. Publish to ClawHub (preferred by OpenClaw resolver).
3. Keep a public GitHub repo with docs and issue tracker.
4. Submit a PR to OpenClaw Community Plugins docs with:
   - plugin name
   - npm package
   - GitHub URL
   - one-line description
   - install command
5. Track in-product usage via Statocyst metadata/activity logs as described above.

## Development

```bash
npm ci
npm run build
npm run test:coverage
docker build -t statocyst-openclaw-e2e:local ../statocyst
STATOCYST_IMAGE=statocyst-openclaw-e2e:local npm run test:e2e:container
```
