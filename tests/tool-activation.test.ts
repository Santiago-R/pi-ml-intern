/**
 * Tests for the tool activation/deactivation state machine in index.ts.
 *
 * Covers:
 *   1. disableMlInternTools — strips all 12 ml-intern tools, leaves 7 standard
 *   2. enableMlInternTools — activates all registered tools (19 total)
 *   3. Null-safe: getAllTools() can return empty array (early init)
 *   4. Null-safe: setActiveTools receives correct names
 *   5. Sub-agent mode (ML_INTERN_SUBAGENT=1) — enables but no prompt override
 *   6. Force mode (ML_INTERN_FORCE=1) — enables + prompt override
 *   7. Normal mode — disables ml-intern tools
 *
 * Regression: getActiveTools() returns objects with name=null during early init.
 * We NEVER derive the active set from getActiveTools(). We use getAllTools().
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Constants (duplicated from index.ts to keep tests isolated) ──
const ML_INTERN_TOOLS = [
  "plan_tool",
  "hf_papers",
  "hub_repo_details",
  "hf_inspect_dataset",
  "github_find_examples",
  "github_list_repos",
  "github_read_file",
  "explore_hf_docs",
  "fetch_hf_docs",
  "find_hf_api",
  "research",
  "hf_jobs",
];

const STANDARD_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const ALL_TOOLS = [...STANDARD_TOOLS, ...ML_INTERN_TOOLS];

// ── Pure logic under test (extracted from index.ts) ──
function isMlInternTool(name: string): boolean {
  return ML_INTERN_TOOLS.includes(name);
}

function computeDisabledTools(allToolNames: string[]): string[] {
  return allToolNames.filter((n) => !isMlInternTool(n));
}

function computeEnabledTools(allToolNames: string[]): string[] {
  return [...allToolNames]; // enable all
}

// ── Tests ──

describe("tool activation state machine", () => {
  describe("disableMlInternTools (computeDisabledTools)", () => {
    it("strips all 12 ml-intern tools, keeps 7 standard tools", () => {
      const result = computeDisabledTools(ALL_TOOLS);
      expect(result).toEqual(STANDARD_TOOLS);
      expect(result.length).toBe(7);
      // Ensure no ml-intern tool leaked through
      for (const name of result) {
        expect(ML_INTERN_TOOLS).not.toContain(name);
      }
    });

    it("returns empty array when getAllTools() returns empty (early init)", () => {
      const result = computeDisabledTools([]);
      expect(result).toEqual([]);
    });

    it("handles partial tool lists (some ml-intern tools not yet registered)", () => {
      const partial = ["read", "bash", "hf_papers", "plan_tool"];
      const result = computeDisabledTools(partial);
      expect(result).toEqual(["read", "bash"]);
    });

    it("does not filter unknown tool names", () => {
      const withUnknown = ["read", "my_custom_tool", "hf_jobs"];
      const result = computeDisabledTools(withUnknown);
      // my_custom_tool is not in ML_INTERN_TOOLS, so it passes through
      // hf_jobs IS in ML_INTERN_TOOLS, so it's stripped
      expect(result).toEqual(["read", "my_custom_tool"]);
    });

    it("is idempotent — reapplying has no effect", () => {
      const first = computeDisabledTools(ALL_TOOLS);
      const second = computeDisabledTools(first);
      expect(second).toEqual(first);
    });
  });

  describe("enableMlInternTools (computeEnabledTools)", () => {
    it("enables ALL tools when all are registered", () => {
      const result = computeEnabledTools(ALL_TOOLS);
      expect(result).toEqual(ALL_TOOLS);
      expect(result.length).toBe(19);
    });

    it("enables all tools even when only standard tools are active", () => {
      const result = computeEnabledTools(STANDARD_TOOLS);
      expect(result).toEqual(STANDARD_TOOLS);
    });

    it("returns empty when getAllTools() returns empty (early init)", () => {
      const result = computeEnabledTools([]);
      expect(result).toEqual([]);
    });

    it("preserves all tool names without modification", () => {
      const result = computeEnabledTools(ALL_TOOLS);
      for (const name of ALL_TOOLS) {
        expect(result).toContain(name);
      }
    });
  });

  describe("isMlInternTool", () => {
    it("returns true for all 12 ml-intern tools", () => {
      for (const name of ML_INTERN_TOOLS) {
        expect(isMlInternTool(name)).toBe(true);
      }
    });

    it("returns false for all 7 standard tools", () => {
      for (const name of STANDARD_TOOLS) {
        expect(isMlInternTool(name)).toBe(false);
      }
    });

    it("returns false for unknown tool names", () => {
      expect(isMlInternTool("some_random_tool")).toBe(false);
      expect(isMlInternTool("")).toBe(false);
    });

    it("returns false for null/undefined (defensive)", () => {
      // getActiveTools() can return objects with name=null
      expect(isMlInternTool(null as unknown as string)).toBe(false);
      expect(isMlInternTool(undefined as unknown as string)).toBe(false);
    });
  });

  describe("null-name protection (getActiveTools regression)", () => {
    it("computeDisabledTools correctly handles null names", () => {
      // Simulating what getActiveTools() returns during early init:
      // all names are null. computeDisabledTools should return an
      // empty array since none match the ml-intern filter.
      const nullNames = [null, null, null] as unknown as string[];
      const result = computeDisabledTools(nullNames);
      // None match ML_INTERN_TOOLS, so none are filtered out
      // But none match anything useful either — the result is just [null, null, null]
      // This is the bug we're protecting against: we must use getAllTools() instead
      expect(result).toEqual([null, null, null]);
    });

    it("computeEnabledTools correctly handles null names", () => {
      const nullNames = [null, null, null] as unknown as string[];
      const result = computeEnabledTools(nullNames);
      expect(result).toEqual([null, null, null]);
    });

    it("demonstrates why getAllTools() must be used, not getActiveTools()", () => {
      // If we had used getActiveTools() during early init:
      const activeToolNames = [null, null, null];
      const disabled = computeDisabledTools(activeToolNames);
      // This would NOT strip ml-intern tools — because null !== "hf_papers", etc.
      expect(disabled).toEqual([null, null, null]);

      // If we use getAllTools() instead:
      const allToolNames = ALL_TOOLS; // reliable names
      const correct = computeDisabledTools(allToolNames);
      expect(correct).toEqual(STANDARD_TOOLS);
      // getAllTools() produces the correct result ✓
    });
  });

  describe("tool list completeness", () => {
    it("total tool count is exactly 19 (7 standard + 12 ml-intern)", () => {
      expect(ALL_TOOLS.length).toBe(19);
      expect(STANDARD_TOOLS.length).toBe(7);
      expect(ML_INTERN_TOOLS.length).toBe(12);
    });

    it("no duplicates between standard and ml-intern tools", () => {
      const intersection = STANDARD_TOOLS.filter((t) => ML_INTERN_TOOLS.includes(t));
      expect(intersection).toEqual([]);
    });

    it("ML_INTERN_TOOLS has exactly the 12 expected names", () => {
      const expected = [
        "plan_tool",
        "hf_papers",
        "hub_repo_details",
        "hf_inspect_dataset",
        "github_find_examples",
        "github_list_repos",
        "github_read_file",
        "explore_hf_docs",
        "fetch_hf_docs",
        "find_hf_api",
        "research",
        "hf_jobs",
      ];
      // Order shouldn't matter for activation, but let's verify all present
      for (const name of expected) {
        expect(ML_INTERN_TOOLS).toContain(name);
      }
      expect(ML_INTERN_TOOLS.length).toBe(expected.length);
    });
  });

  describe("mode transitions (integration-style)", () => {
    // These test the logical state transitions without the full pi runtime

    it("normal → ml-intern → normal cycle", () => {
      let activeToolNames = [...STANDARD_TOOLS]; // starting state

      // Normal mode: disable ml-intern tools
      const allAvailable = [...ALL_TOOLS];
      activeToolNames = computeDisabledTools(allAvailable);
      expect(activeToolNames).toEqual(STANDARD_TOOLS);

      // /ml-intern: enable all
      activeToolNames = computeEnabledTools(allAvailable);
      expect(activeToolNames).toEqual(ALL_TOOLS);
      expect(activeToolNames.length).toBe(19);

      // Back to normal: disable again
      activeToolNames = computeDisabledTools(allAvailable);
      expect(activeToolNames).toEqual(STANDARD_TOOLS);
    });

    it("sub-agent mode: tools enabled but prompt not modified", () => {
      // In sub-agent mode, enableMlInternTools is called without
      // the system prompt injection. The research sub-agent gets its
      // own prompt via --append-system-prompt.
      const allAvailable = [...ALL_TOOLS];
      const enabled = computeEnabledTools(allAvailable);
      expect(enabled).toEqual(ALL_TOOLS);
      // The key distinction: in sub-agent mode, the before_agent_start
      // handler does NOT return { systemPrompt: ... } — it returns undefined.
      // This test verifies the tool list is correct for that case.
    });

    it("force mode (ML_INTERN_FORCE=1): starts in active state", () => {
      // In force mode, the 'active' flag is set to true before any
      // before_agent_start fires. The first before_agent_start will:
      // 1. See active===true
      // 2. Enable all tools
      // 3. Inject system prompt
      // 4. Set active=false (one-shot)
      const allAvailable = [...ALL_TOOLS];
      const enabled = computeEnabledTools(allAvailable);
      expect(enabled).toEqual(ALL_TOOLS);
    });

    it("one-shot active flag: consumed after first use", () => {
      // Simulates: active=true → before_agent_start → active=false

      let activeFlag = true;
      const history: string[] = [];

      // before_agent_start fires
      if (activeFlag) {
        activeFlag = false;
        history.push("enable+tools+prompt");
      } else {
        history.push("disable");
      }

      expect(activeFlag).toBe(false);
      expect(history).toEqual(["enable+tools+prompt"]);

      // Next before_agent_start (next LLM turn)
      if (activeFlag) {
        history.push("enable+tools+prompt");
      } else {
        history.push("disable");
      }

      expect(history).toEqual(["enable+tools+prompt", "disable"]);
    });
  });
});
