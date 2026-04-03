import { describe, expect, it } from "vitest";

import plugin, {
  MoltenHubClient,
  NATIVE_TOOL_NAMES,
  createMoltenHubOpenClawPlugin,
  resolveConfig
} from "../src/index.js";

describe("index exports", () => {
  it("exports plugin factory symbols and default plugin instance", () => {
    expect(typeof createMoltenHubOpenClawPlugin).toBe("function");
    expect(Array.isArray(NATIVE_TOOL_NAMES)).toBe(true);
    expect(NATIVE_TOOL_NAMES).toContain("moltenhub_skill_request");
    expect(plugin.id).toBe("openclaw-plugin-moltenhub");
    expect(plugin.version).toBe("0.1.8");
  });

  it("re-exports runtime config/client entry points", () => {
    const resolved = resolveConfig({
      config: {
        baseUrl: "https://hub.example.com/v1",
        token: "token-a"
      }
    });

    const client = new MoltenHubClient({
      ...resolved,
      profile: {
        enabled: false,
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
    });

    expect(resolved.token).toBe("token-a");
    expect(client).toBeInstanceOf(MoltenHubClient);
  });
});
