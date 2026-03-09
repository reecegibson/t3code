import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_OPTIONS_BY_PROVIDER } from "@t3tools/contracts";

import {
  getDefaultModel,
  getDefaultReasoningEffort,
  getModelOptions,
  getReasoningEffortOptions,
  normalizeModelSlug,
  resolveModelSlug,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER.codex) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });
  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS_BY_PROVIDER.codex);
  });
});

describe("normalizeModelSlug (claude-code)", () => {
  it("maps known claude-code aliases to canonical slugs", () => {
    expect(normalizeModelSlug("sonnet", "claude-code")).toBe("claude-sonnet-4-6");
    expect(normalizeModelSlug("opus", "claude-code")).toBe("claude-opus-4-6");
    expect(normalizeModelSlug("haiku", "claude-code")).toBe("claude-haiku-4-5");
  });

  it("preserves non-aliased claude-code model slugs", () => {
    expect(normalizeModelSlug("claude-sonnet-4-6", "claude-code")).toBe("claude-sonnet-4-6");
    expect(normalizeModelSlug("claude-opus-4-6", "claude-code")).toBe("claude-opus-4-6");
  });
});

describe("resolveModelSlug (claude-code)", () => {
  it("returns claude-code default when the model is missing", () => {
    expect(resolveModelSlug(undefined, "claude-code")).toBe(DEFAULT_MODEL_BY_PROVIDER["claude-code"]);
    expect(resolveModelSlug(null, "claude-code")).toBe(DEFAULT_MODEL_BY_PROVIDER["claude-code"]);
  });

  it("falls back to default for unknown claude-code models", () => {
    expect(resolveModelSlug("unknown-model", "claude-code")).toBe(DEFAULT_MODEL_BY_PROVIDER["claude-code"]);
  });

  it("resolves only supported claude-code model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER["claude-code"]) {
      expect(resolveModelSlug(model.slug, "claude-code")).toBe(model.slug);
    }
  });

  it("returns claude-code defaults for claude-code provider", () => {
    expect(getDefaultModel("claude-code")).toBe(DEFAULT_MODEL_BY_PROVIDER["claude-code"]);
    expect(getModelOptions("claude-code")).toEqual(MODEL_OPTIONS_BY_PROVIDER["claude-code"]);
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("returns empty reasoning options for claude-code", () => {
    expect(getReasoningEffortOptions("claude-code")).toEqual([]);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe("high");
  });

  it("returns null default reasoning effort for claude-code", () => {
    expect(getDefaultReasoningEffort("claude-code")).toBeNull();
  });
});
