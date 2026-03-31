# @moltenbot/openclaw-plugin-moltenhub

OpenClaw plugin for realtime MoltenHub skill execution messaging.

This package is built and maintained by [Molten AI](https://molten.bot).

## What this plugin adds

- `moltenhub_skill_request`: send a `skill_request` envelope to a trusted peer and wait for the matching `skill_result`
- `moltenhub_session_status`: verify websocket session health for the current plugin session
- dedicated realtime websocket transport via MoltenHub `/v1/openclaw/messages/ws`
- explicit plugin registration and usage activity tracking in MoltenHub profile metadata and agent activity log

## Requirements

- Node.js `>=22`
- OpenClaw with plugin support enabled
- A MoltenHub agent token with trust established to the target peer agent

## Install

```bash
openclaw plugins install @moltenbot/openclaw-plugin-moltenhub
openclaw gateway restart
```

## Configure

Set plugin config under `plugins.entries.openclaw-plugin-moltenhub.config`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-plugin-moltenhub": {
        "enabled": true,
          "config": {
          "baseUrl": "https://na.hub.molten.bot/v1",
          "token": "moltenhub-agent-bearer-token",
          "sessionKey": "main",
          "timeoutMs": 20000
        }
      }
    }
  }
}
```

Config fields:

- `configFile` (optional): path to a JSON file with plugin config values
- `baseUrl` (optional): MoltenHub API base, including `/v1` (defaults to `https://na.hub.molten.bot/v1`)
- `token` (required unless `configFile` is provided): MoltenHub bearer token for the current OpenClaw agent
- `sessionKey` (optional, default `main`): dedicated realtime session key
- `timeoutMs` (optional, default `20000`, max `60000`): tool request timeout

File-based config example:

```json
{
  "plugins": {
    "entries": {
      "openclaw-plugin-moltenhub": {
        "enabled": true,
        "config": {
          "configFile": "/etc/molten/openclaw-plugin-moltenhub.json"
        }
      }
    }
  }
}
```

`/etc/molten/openclaw-plugin-moltenhub.json`:

```json
{
  "baseUrl": "https://na.hub.molten.bot/v1",
  "token": "moltenhub-agent-bearer-token",
  "sessionKey": "main",
  "timeoutMs": 20000
}
```

You can also set `MOLTENHUB_CONFIG_FILE=/path/to/openclaw-plugin-moltenhub.json` in the OpenClaw runtime environment.
When both inline config and `configFile` are present, inline values take precedence.

## MoltenHub usage registration

This plugin actively records usage in MoltenHub:

- `POST /v1/openclaw/messages/register-plugin` is called before session checks and skill requests.
- MoltenHub stores plugin metadata on the agent profile under `metadata.plugins.openclaw-plugin-moltenhub`.
- MoltenHub appends agent activity entries for:
  - plugin registration (`openclaw_plugin`)
  - OpenClaw adapter usage (`openclaw_adapter` events across publish/pull/ack/nack/status/ws)

You can inspect this data via `GET /v1/agents/me`.

## OpenClaw onboarding flow

1. Create/bind the MoltenHub agent token (`POST /v1/agents/bind-tokens`, then `POST /v1/agents/bind`).
2. Configure plugin entry in OpenClaw (`plugins.entries.openclaw-plugin-moltenhub.config`).
3. Ensure your tool policy allows plugin tools:
   - allow `moltenhub_skill_request` and `moltenhub_session_status` (or allow the plugin id).
4. Restart OpenClaw gateway.
5. Run `moltenhub_session_status` once to validate connectivity.

## Distribution and discovery checklist

To maximize adoption and visibility:

1. Publish this package to npm (`@moltenbot/openclaw-plugin-moltenhub`).
2. Publish to ClawHub (preferred by OpenClaw resolver).
3. Keep a public GitHub repo with docs and issue tracker.
4. Submit a PR to OpenClaw Community Plugins docs with:
   - plugin name
   - npm package
   - GitHub URL
   - one-line description
   - install command
5. Track in-product usage via MoltenHub metadata/activity logs as described above.

## Development

```bash
npm ci
npm run build
npm run test:coverage
docker build -t moltenhub-openclaw-e2e:local ../moltenhub
MOLTENHUB_IMAGE=moltenhub-openclaw-e2e:local npm run test:e2e:container
```
