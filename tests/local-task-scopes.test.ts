import { describe, it, expect } from "vitest";
import { filterScopes, SUPPORTED_SCOPES } from "../src/auth/store.js";

describe("local task OAuth scope boundary", () => {
  it("supports explicit local task read and write scopes", () => {
    expect(SUPPORTED_SCOPES).toContain("codex.local.read");
    expect(SUPPORTED_SCOPES).toContain("codex.local.write");
    expect(filterScopes("codex.local.write")).toEqual(["codex.local.write"]);
  });
  it("keeps omitted and unrecognized scope requests read-only", () => {
    for (const requested of [undefined, "", "unknown.scope"]) {
      expect(filterScopes(requested)).toEqual([
        "workspace.read", "workspace.search", "git.read", "execution.read", "offline_access",
      ]);
      expect(filterScopes(requested)).not.toContain("codex.local.write");
    }
  });
});
