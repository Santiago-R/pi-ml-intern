/**
 * research — Spawns a pi subprocess as a research sub-agent with isolated context.
 *
 * This is the ONE tool that legitimately needs a subprocess: it gives the
 * research agent its own independent LLM context, matching how ml-intern
 * uses LiteLLM's acompletion() for the sub-agent.
 */
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RESEARCH_SUBAGENT_PROMPT } from "../prompts";

export function registerResearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "research",
    label: "Research",
    description:
      "Spawn a research sub-agent to explore documentation, codebases, " +
      "or repos WITHOUT polluting the main conversation context. " +
      "The sub-agent gets its own independent context window with standard pi tools " +
      "(read, write, bash, edit) and returns a concise summary of findings.\n\n" +
      "Use this for:\n" +
      "- Researching current API usage before implementing ML tasks\n" +
      "- Exploring HF docs, reading papers, analyzing GitHub repos\n" +
      "- Any research where raw tool outputs would be too verbose\n\n" +
      "The sub-agent uses standard pi file/execution tools plus ml-intern research APIs. " +
      "Just describe what you need researched.",
    promptSnippet: "Spawn a research sub-agent for literature & code research",
    promptGuidelines: [
      "Use the research tool before implementing ML tasks to find working examples, read docs, and validate datasets without polluting the main context.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          "Detailed research task. Be specific: include library names, trainer types, " +
          "dataset names, or doc pages. Example: 'Research current TRL SFTTrainer: find " +
          "working examples, read SFT docs, check SFTConfig params. Validate that dataset " +
          "HuggingFaceH4/ultrachat_200k has the right format for SFT.'",
      }),
      context: Type.Optional(Type.String({
        description: "Optional context from the current conversation for the research agent.",
      })),
    }),
    async execute(_toolCallId, params) {
      const task = (params.task as string).trim();
      const context = (params.context as string) || "";
      if (!task) return error("No research task provided.");

      const userContent = context
        ? `Context: ${context}\n\nResearch task: ${task}`
        : `Research task: ${task}`;

      // Write system prompt to temp file (pi --append-system-prompt reads file contents)
      const promptFile = path.join(os.tmpdir(), `.ml-intern-research-${Date.now()}.txt`);
      await require("node:fs/promises").writeFile(promptFile, RESEARCH_SUBAGENT_PROMPT, "utf-8");

      try {
        const output = await runPiSubprocess(promptFile, userContent);
        await require("node:fs/promises").unlink(promptFile).catch(() => {});

        if (!output) return error("Research sub-agent produced no output.");

        const truncated = output.length > 12_000
          ? output.slice(0, 8000) + `\n...(truncated ${output.length - 12_000} chars)...\n` + output.slice(-4000)
          : output;

        return {
          content: [{ type: "text", text: truncated }],
          details: { task, tool: "research", length: output.length },
        };
      } catch (e) {
        await require("node:fs/promises").unlink(promptFile).catch(() => {});
        return error(`Research sub-agent error: ${e}`);
      }
    },
  });
}

function runPiSubprocess(promptFile: string, userContent: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    // Do NOT use --no-builtin-tools. The sub-agent must have
    // read, write, bash, edit, and other standard pi tools to
    // perform research tasks and return useful results.
    // Additionally, auto-discovered extensions (ml-intern) will provide
    // research-specific tools (hf_papers, github_*, hf_docs, etc.).
    const child = spawn("pi", [
      "-p",                                   // print mode (no TUI)
      "--append-system-prompt", promptFile,   // file path → pi reads contents
      userContent,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ML_INTERN_SUBAGENT: "1" },  // sub-agent mode
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,  // 3 minutes for research tasks
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        resolve(`Research sub-agent failed (exit ${code}): ${stderr.slice(0, 2000)}`);
        return;
      }
      resolve(stdout.trim() || null);
    });
    child.on("error", reject);
  });
}

function error(msg: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return {
    content: [{ type: "text" as const, text: msg }],
    details: { isError: true },
  };
}