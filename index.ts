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

export default function mlIntern(pi: ExtensionAPI) {
  // ── Register all ml-intern tools ──
  registerPlanTool(pi);
  registerHfPapersTool(pi);
  registerHfDataTools(pi);
  registerGithubTools(pi);
  registerDocsTools(pi);
  registerResearchTool(pi);

  // One-shot flag
  let active = false;

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

  // ── Inject system prompt on /ml-intern ──
  pi.on("before_agent_start", async (event) => {
    if (!active) return undefined;
    active = false;
    const prompt = SYSTEM_PROMPT.replace("[num_tools]", String(pi.getActiveTools().length));
    return { systemPrompt: event.systemPrompt + prompt };
  });

  // ── Notify on startup ──
  pi.on("session_start", async (_e, ctx) => {
    const plan = getCurrentPlan();
    const msg = plan.length > 0
      ? `ML Intern: plan_tool (${plan.length} items), hf_papers, hf_datasets, github_*, hf_docs, research`
      : "ML Intern: plan_tool, hf_papers, hub_repo_details, hf_inspect_dataset, github_*, explore/fetch_hf_docs, find_hf_api, research";
    ctx.ui.notify(msg, "info");
  });
}