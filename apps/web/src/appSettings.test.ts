import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultModel } from "@t3tools/shared/model";

import {
  getAppModelOptions,
  getAppSettingsSnapshot,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  resolveAppModelSelection,
} from "./appSettings";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });
});

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      isCustom: true,
    });
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(resolveAppModelSelection("codex", ["galapagos-alpha"], "galapagos-alpha")).toBe(
      "galapagos-alpha",
    );
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", [], "")).toBe("gpt-5.4");
  });
});

describe("getSlashModelOptions", () => {
  it("includes saved custom model slugs for /model command suggestions", () => {
    const options = getSlashModelOptions("codex", ["custom/internal-model"], "", "gpt-5.3-codex");

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions("codex", ["openai/gpt-oss-120b"], "oss", "gpt-5.3-codex");

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("resolveAppServiceTier", () => {
  it("maps automatic to no override", () => {
    expect(resolveAppServiceTier("auto")).toBeNull();
  });

  it("preserves explicit service tier overrides", () => {
    expect(resolveAppServiceTier("fast")).toBe("fast");
    expect(resolveAppServiceTier("flex")).toBe("flex");
  });
});

describe("shouldShowFastTierIcon", () => {
  it("shows the fast-tier icon only for gpt-5.4 on fast tier", () => {
    expect(shouldShowFastTierIcon("gpt-5.4", "fast")).toBe(true);
    expect(shouldShowFastTierIcon("gpt-5.4", "auto")).toBe(false);
    expect(shouldShowFastTierIcon("gpt-5.3-codex", "fast")).toBe(false);
  });
});

function makeLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

function setStoredSettings(
  storage: Storage,
  patch: Record<string, unknown>,
): void {
  const base = {
    codexBinaryPath: "",
    codexHomePath: "",
    confirmThreadDelete: true,
    enableAssistantStreaming: false,
    codexServiceTier: "auto",
    customCodexModels: [],
    customClaudeCodeModels: [],
    lastUsedProvider: null,
    lastUsedModel: null,
  };
  storage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ ...base, ...patch }),
  );
}

describe("lastUsedProvider persistence", () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = makeLocalStorageMock();
    vi.stubGlobal("window", {
      localStorage: mockStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to null when no settings are stored", () => {
    const settings = getAppSettingsSnapshot();
    expect(settings.lastUsedProvider).toBeNull();
  });

  it("round-trips claude-code through localStorage", () => {
    setStoredSettings(mockStorage, { lastUsedProvider: "claude-code" });
    const settings = getAppSettingsSnapshot();
    expect(settings.lastUsedProvider).toBe("claude-code");
  });

  it("round-trips codex through localStorage", () => {
    setStoredSettings(mockStorage, { lastUsedProvider: "codex" });
    const settings = getAppSettingsSnapshot();
    expect(settings.lastUsedProvider).toBe("codex");
  });

  it("falls back to defaults for invalid provider values", () => {
    setStoredSettings(mockStorage, { lastUsedProvider: "invalid-provider" });
    const settings = getAppSettingsSnapshot();
    expect(settings.lastUsedProvider).toBeNull();
  });
});

describe("lastUsedModel persistence", () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = makeLocalStorageMock();
    vi.stubGlobal("window", {
      localStorage: mockStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to null when no settings are stored", () => {
    const settings = getAppSettingsSnapshot();
    expect(settings.lastUsedModel).toBeNull();
  });

  it("round-trips a model slug through localStorage", () => {
    setStoredSettings(mockStorage, { lastUsedModel: "claude-sonnet-4-6" });
    const settings = getAppSettingsSnapshot();
    expect(settings.lastUsedModel).toBe("claude-sonnet-4-6");
  });

  it("persists provider and model together", () => {
    setStoredSettings(mockStorage, {
      lastUsedProvider: "claude-code",
      lastUsedModel: "claude-sonnet-4-6",
    });
    const settings = getAppSettingsSnapshot();
    expect(settings.lastUsedProvider).toBe("claude-code");
    expect(settings.lastUsedModel).toBe("claude-sonnet-4-6");
  });
});

describe("resolveAppModelSelection with lastUsedModel fallback", () => {
  it("resolves a known claude-code model slug", () => {
    const result = resolveAppModelSelection("claude-code", [], "claude-sonnet-4-6");
    expect(result).toBe("claude-sonnet-4-6");
  });

  it("falls back to default model when selectedModel is null", () => {
    const result = resolveAppModelSelection("claude-code", [], null);
    expect(result).toBe(getDefaultModel("claude-code"));
  });

  it("falls back to default model when selectedModel is undefined", () => {
    const result = resolveAppModelSelection("codex", [], undefined);
    expect(result).toBe(getDefaultModel("codex"));
  });
});
