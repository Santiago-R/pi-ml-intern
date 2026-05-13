/**
 * ML Intern Extension — Hugging Face ml-intern behavior for Pi.
 *
 * Activates only via /ml-intern command. Zero impact on default Pi behavior.
 *
 * Usage: /ml-intern <your ML task>
 * Example: /ml-intern fine-tune Qwen2.5 on my instruction dataset
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SYSTEM_PROMPT } from "./prompts";
import { registerPlanTool, getCurrentPlan } from "./tools/plan_tool";
import { registerHfPapersTool } from "./tools/hf_papers";
import { registerHfDataTools } from "./tools/hf_datasets";
import { registerGithubTools } from "./tools/github";
import { registerDocsTools } from "./tools/hf_docs";
import { registerResearchTool } from "./tools/research";
import { registerHfJobsTool } from "./tools/hf_jobs";

// ── Auto-load .env files for HF_TOKEN / GITHUB_TOKEN ──
function loadEnvFiles() {
  // Try multiple locations in priority order
  const envPaths = [
    ".env",                          // current directory
    "/home/san/Desktop/ml-intern/.env", // ml-intern project
  ];
  for (const envPath of envPaths) {
    try {
      const fs = require("node:fs");
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            // Strip quotes
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      }
    } catch { /* file not found or not readable */ }
  }
}
loadEnvFiles();

export default function mlIntern(pi: ExtensionAPI) {
  // ── Register all ml-intern tools ──
  registerPlanTool(pi);
  registerHfPapersTool(pi);
  registerHfDataTools(pi);
  registerGithubTools(pi);
  registerDocsTools(pi);
  registerResearchTool(pi);
  registerHfJobsTool(pi);

  // Tool names to scope to ml-intern mode only
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

  function isMlInternTool(name: string): boolean {
    return ML_INTERN_TOOLS.includes(name);
  }

  function disableMlInternTools() {
    const all = pi.getAllTools();
    if (all.length === 0) return;
    // Set active tools to only non-ml-intern tools.
    // We compute from getAllTools() (reliable) not getActiveTools() (null names).
    const names = all
      .map((t: { name: string }) => t.name)
      .filter((n: string) => !isMlInternTool(n));
    pi.setActiveTools(names);
  }

  function enableMlInternTools() {
    const all = pi.getAllTools();
    if (all.length === 0) return;
    // Activate ALL registered tools (both standard + ml-intern)
    const names = all.map((t: { name: string }) => t.name);
    pi.setActiveTools(names);
  }

  // One-shot flag: true after /ml-intern triggers, consumed by before_agent_start
  let active = false;
  // Sub-agent mode: enable tools but don't override the system prompt.
  // Used by the research sub-agent which provides its own prompt via
  // --append-system-prompt.
  const isSubAgent = process.env.ML_INTERN_SUBAGENT === "1";

  // Also support ML_INTERN_FORCE=1 env var for print-mode usage.
  // This makes the very first turn use full ml-intern capabilities.
  if (process.env.ML_INTERN_FORCE === "1") {
    active = true;
  }

  // Register a --ml-intern CLI flag for convenience
  try {
    pi.registerFlag?.("ml-intern", {
      description: "Force ml-intern mode for print-mode sessions",
      type: "boolean",
      default: false,
    });
  } catch { /* registerFlag may not exist in all pi versions */ }

  // ── /ml-intern command ──
  pi.registerCommand("ml-intern", {
    description: "ML Intern mode — autonomous ML research & implementation with literature-backed recipes",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify('Usage: /ml-intern <task>. E.g. /ml-intern "fine-tune Llama on my dataset"', "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy — wait for it to finish.", "warning");
        return;
      }
      active = true;
      pi.sendUserMessage(args);
      ctx.ui.notify("ML Intern mode — researching papers, validating datasets, implementing with zero errors", "info");
    },
  });

  // ── before_agent_start ──
  // Controls tool activation & system prompt injection. Three modes:
  //   1. Sub-agent (ML_INTERN_SUBAGENT=1): enable tools, keep existing prompt
  //   2. /ml-intern or force mode: enable tools + inject ml-intern system prompt
  //   3. Normal mode: disable ml-intern tools
  pi.on("before_agent_start", async (event) => {
    if (isSubAgent) {
      // Research sub-agent: enable all tools but DON'T override the system prompt.
      // The research prompt was already appended via --append-system-prompt.
      enableMlInternTools();
      return undefined;
    }
    if (active) {
      // /ml-intern or force mode: enable research tools and inject system prompt
      active = false;
      enableMlInternTools();
      const toolCount = pi.getActiveTools().length;
      const prompt = SYSTEM_PROMPT.replace("[num_tools]", String(toolCount));
      return { systemPrompt: event.systemPrompt + prompt };
    }
    // Normal mode: ensure ml-intern tools are OFF
    disableMlInternTools();
    return undefined;
  });

  // ── agent_end: belt-and-suspenders cleanup ──
  pi.on("agent_end", async () => {
    disableMlInternTools();
  });

  // ── session_start: notify + initial deactivation ──
  pi.on("session_start", async (_e, ctx) => {
    disableMlInternTools();
    const plan = getCurrentPlan();
    const msg = plan.length > 0
      ? `ML Intern: plan_tool (${plan.length} items), hf_papers, hf_datasets, github_*, hf_docs, hf_jobs, research`
      : "ML Intern: plan_tool, hf_papers, hub_repo_details, hf_inspect_dataset, github_*, explore/fetch_hf_docs, find_hf_api, hf_jobs, research";
    ctx.ui.notify(msg, "info");
  });
}