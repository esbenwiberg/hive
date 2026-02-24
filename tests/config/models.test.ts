/**
 * tests/config/models.test.ts
 *
 * Unit tests for src/config/models.ts  — resolveModelConfig()
 *
 * We mock `getAutonomousConfig` so tests never touch the filesystem.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the autonomous-config module ────────────────────────────────────────
// Must be declared before any import that transitively depends on it.

vi.mock("../../src/domain/autonomous-config.js", () => ({
  getAutonomousConfig: vi.fn(),
}));

import { getAutonomousConfig } from "../../src/domain/autonomous-config.js";
import { resolveModelConfig } from "../../src/config/models.js";
import type { AutonomousConfig } from "../../src/domain/autonomous-config.js";
import type { ComponentModelConfig } from "../../src/domain/types.js";

// ── Helper ───────────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<AutonomousConfig["models"]> = {},
): AutonomousConfig {
  return {
    classification: { defaultType: "improvement", defaultSize: "medium" },
    gate: { mode: "human" },
    budget: { dailyDefault: 100, perTaskMax: 25 },
    models: {
      default: "claude-sonnet-4-6",
      inputCostPerM: 3,
      outputCostPerM: 15,
      components: {},
      componentProviders: {},
      ...overrides,
    },
    enrichers: [],
    clarification: { mode: "human" },
    preview: {
      enabled: true,
      max_concurrent: 3,
      cleanup_timeout_minutes: 30,
      docker_host: {
        ip: "",
        port: 2376,
        tls_cert_vault_secret: "docker-tls-cert",
        tls_key_vault_secret: "docker-tls-key",
        tls_ca_vault_secret: "docker-tls-ca",
        ssh_key_vault_secret: "docker-ssh-key",
        ssh_user: "azureuser",
      },
      port_range: [4001, 4099],
      compose_up_timeout_seconds: 300,
      validation_max_turns: 20,
    },
    concurrency: { maxConcurrent: 5, maxPerUser: 2 },
  };
}

const mockGetConfig = getAutonomousConfig as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveModelConfig", () => {
  // ── Default fallback ──────────────────────────────────────────────────────

  describe("default fallback (no overrides)", () => {
    it("returns anthropic provider with the global default model", () => {
      mockGetConfig.mockReturnValue(makeConfig());

      const result = resolveModelConfig("worker");

      expect(result).toEqual({ type: "anthropic", model: "claude-sonnet-4-6" });
    });

    it("returns the same default for every component name when nothing is configured", () => {
      mockGetConfig.mockReturnValue(makeConfig());

      const components = [
        "router",
        "gate",
        "decomposer",
        "enricher",
        "worker",
        "review-gate",
        "milestone-review",
        "producer",
      ] as const;

      for (const c of components) {
        const result = resolveModelConfig(c);
        expect(result.type).toBe("anthropic");
        expect((result as { model?: string }).model).toBe("claude-sonnet-4-6");
      }
    });

    it("uses a component-level string model before the global default", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({
          components: { router: "claude-haiku-4-5-20251001" },
        }),
      );

      const result = resolveModelConfig("router");

      expect(result).toEqual({
        type: "anthropic",
        model: "claude-haiku-4-5-20251001",
      });
    });

    it("falls through to global default for an un-configured component", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({
          components: { router: "claude-haiku-4-5-20251001" },
        }),
      );

      // "worker" has no per-component entry → should use global default
      const result = resolveModelConfig("worker");
      expect(result).toEqual({ type: "anthropic", model: "claude-sonnet-4-6" });
    });

    it("falls back to hard-coded default when models.default is empty", () => {
      const cfg = makeConfig();
      // @ts-expect-error intentionally clearing the default
      cfg.models.default = "";
      mockGetConfig.mockReturnValue(cfg);

      const result = resolveModelConfig("worker");
      expect(result).toEqual({ type: "anthropic", model: "claude-sonnet-4-6" });
    });
  });

  // ── Anthropic provider override ───────────────────────────────────────────

  describe("anthropic componentProvider override", () => {
    it("returns the overridden anthropic model", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({
          componentProviders: {
            "review-gate": {
              type: "anthropic",
              model: "claude-haiku-4-5-20251001",
            } satisfies ComponentModelConfig,
          },
        }),
      );

      const result = resolveModelConfig("review-gate");

      expect(result).toEqual({
        type: "anthropic",
        model: "claude-haiku-4-5-20251001",
      });
    });

    it("includes apiKey when provided for anthropic type", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({
          componentProviders: {
            gate: {
              type: "anthropic",
              model: "claude-sonnet-4-6",
              apiKey: "sk-ant-test-key",
            } satisfies ComponentModelConfig,
          },
        }),
      );

      const result = resolveModelConfig("gate") as { apiKey?: string };

      expect(result.apiKey).toBe("sk-ant-test-key");
    });

    it("omits apiKey field when not specified for anthropic type", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({
          componentProviders: {
            gate: {
              type: "anthropic",
              model: "claude-sonnet-4-6",
            } satisfies ComponentModelConfig,
          },
        }),
      );

      const result = resolveModelConfig("gate") as Record<string, unknown>;

      expect("apiKey" in result).toBe(false);
    });

    it("componentProvider takes precedence over simple components string", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({
          components: { worker: "claude-haiku-4-5-20251001" },
          componentProviders: {
            worker: {
              type: "anthropic",
              model: "claude-opus-4-6",
            } satisfies ComponentModelConfig,
          },
        }),
      );

      const result = resolveModelConfig("worker");
      expect(result).toEqual({ type: "anthropic", model: "claude-opus-4-6" });
    });
  });

  // ── azure-openai provider override ───────────────────────────────────────

  describe("azure-openai componentProvider override", () => {
    const validAzureOpenAI: ComponentModelConfig = {
      type: "azure-openai",
      endpoint: "https://my-resource.openai.azure.com",
      deploymentName: "gpt-4o-deployment",
      apiKey: "azure-key-abc123",
      model: "gpt-4o",
    };

    it("returns a valid azure-openai provider config", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { worker: validAzureOpenAI } }),
      );

      const result = resolveModelConfig("worker");

      expect(result).toEqual({
        type: "azure-openai",
        endpoint: "https://my-resource.openai.azure.com",
        deploymentName: "gpt-4o-deployment",
        apiKey: "azure-key-abc123",
        model: "gpt-4o",
      });
    });

    it("throws when endpoint is missing", () => {
      const bad: ComponentModelConfig = {
        ...validAzureOpenAI,
        endpoint: "",
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { worker: bad } }),
      );

      expect(() => resolveModelConfig("worker")).toThrow(/endpoint/);
      expect(() => resolveModelConfig("worker")).toThrow(/worker/);
    });

    it("throws when deploymentName is missing", () => {
      const bad: ComponentModelConfig = {
        ...validAzureOpenAI,
        deploymentName: "",
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { worker: bad } }),
      );

      expect(() => resolveModelConfig("worker")).toThrow(/deploymentName/);
    });

    it("throws when apiKey is missing", () => {
      const bad: ComponentModelConfig = {
        ...validAzureOpenAI,
        apiKey: "",
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { worker: bad } }),
      );

      expect(() => resolveModelConfig("worker")).toThrow(/apiKey/);
    });

    it("throws when multiple required fields are missing", () => {
      const bad: ComponentModelConfig = {
        type: "azure-openai",
        deploymentName: "some-deployment",
        // endpoint and apiKey both missing
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { router: bad } }),
      );

      expect(() => resolveModelConfig("router")).toThrow(/endpoint/);
      expect(() => resolveModelConfig("router")).toThrow(/apiKey/);
    });

    it("throws a descriptive error mentioning the component and provider type", () => {
      const bad: ComponentModelConfig = {
        type: "azure-openai",
        endpoint: "",
        deploymentName: "dep",
        apiKey: "key",
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { decomposer: bad } }),
      );

      expect(() => resolveModelConfig("decomposer")).toThrow(
        /Component "decomposer" uses provider type "azure-openai"/,
      );
    });
  });

  // ── azure-anthropic provider override ────────────────────────────────────

  describe("azure-anthropic componentProvider override", () => {
    const validAzureAnthropic: ComponentModelConfig = {
      type: "azure-anthropic",
      endpoint: "https://my-foundry.services.ai.azure.com",
      deploymentName: "claude-haiku-foundry",
      apiKey: "foundry-key-xyz",
      model: "claude-haiku-4-5-20251001",
    };

    it("returns a valid azure-anthropic provider config", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({
          componentProviders: { "review-gate": validAzureAnthropic },
        }),
      );

      const result = resolveModelConfig("review-gate");

      expect(result).toEqual({
        type: "azure-anthropic",
        endpoint: "https://my-foundry.services.ai.azure.com",
        deploymentName: "claude-haiku-foundry",
        apiKey: "foundry-key-xyz",
        model: "claude-haiku-4-5-20251001",
      });
    });

    it("throws when endpoint is missing for azure-anthropic", () => {
      const bad: ComponentModelConfig = {
        ...validAzureAnthropic,
        endpoint: undefined,
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { producer: bad } }),
      );

      expect(() => resolveModelConfig("producer")).toThrow(/endpoint/);
    });

    it("throws when deploymentName is missing for azure-anthropic", () => {
      const bad: ComponentModelConfig = {
        ...validAzureAnthropic,
        deploymentName: undefined,
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { producer: bad } }),
      );

      expect(() => resolveModelConfig("producer")).toThrow(/deploymentName/);
    });

    it("throws when apiKey is missing for azure-anthropic", () => {
      const bad: ComponentModelConfig = {
        ...validAzureAnthropic,
        apiKey: undefined,
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { producer: bad } }),
      );

      expect(() => resolveModelConfig("producer")).toThrow(/apiKey/);
    });

    it("throws a descriptive error mentioning the component and provider type", () => {
      const bad: ComponentModelConfig = {
        type: "azure-anthropic",
        endpoint: "https://my-foundry.services.ai.azure.com",
        deploymentName: "",
        apiKey: "some-key",
      };
      mockGetConfig.mockReturnValue(
        makeConfig({ componentProviders: { "milestone-review": bad } }),
      );

      expect(() => resolveModelConfig("milestone-review")).toThrow(
        /Component "milestone-review" uses provider type "azure-anthropic"/,
      );
    });
  });

  // ── Mixed configuration ───────────────────────────────────────────────────

  describe("mixed configuration (different providers per component)", () => {
    it("resolves each component independently", () => {
      mockGetConfig.mockReturnValue(
        makeConfig({
          components: {
            router: "claude-haiku-4-5-20251001",
          },
          componentProviders: {
            worker: {
              type: "azure-openai",
              endpoint: "https://res.openai.azure.com",
              deploymentName: "gpt-4o",
              apiKey: "key1",
              model: "gpt-4o",
            } satisfies ComponentModelConfig,
            "review-gate": {
              type: "azure-anthropic",
              endpoint: "https://foundry.azure.com",
              deploymentName: "haiku-dep",
              apiKey: "key2",
              model: "claude-haiku-4-5-20251001",
            } satisfies ComponentModelConfig,
          },
        }),
      );

      // router uses simple string form → anthropic
      expect(resolveModelConfig("router")).toEqual({
        type: "anthropic",
        model: "claude-haiku-4-5-20251001",
      });

      // worker uses azure-openai provider block
      expect(resolveModelConfig("worker")).toMatchObject({
        type: "azure-openai",
        deploymentName: "gpt-4o",
      });

      // review-gate uses azure-anthropic provider block
      expect(resolveModelConfig("review-gate")).toMatchObject({
        type: "azure-anthropic",
        deploymentName: "haiku-dep",
      });

      // decomposer not configured → falls back to global default
      expect(resolveModelConfig("decomposer")).toEqual({
        type: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });
  });
});
