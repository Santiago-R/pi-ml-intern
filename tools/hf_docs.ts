/**
 * HF Docs tools — explore_hf_docs, fetch_hf_docs, find_hf_api.
 * Native fetch() to HF docs llms.txt + .md pages.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchWithRetry, ok, err, hfHeaders, StringEnum } from "../utils/api";

const HF_DOCS = "https://huggingface.co/docs";

const ENDPOINTS = [
  "courses", "hub", "transformers", "diffusers", "datasets", "gradio", "trackio",
  "smolagents", "huggingface_hub", "huggingface.js", "transformers.js",
  "inference-providers", "inference-endpoints", "peft", "accelerate", "optimum",
  "tokenizers", "evaluate", "tasks", "dataset-viewer", "trl", "simulate", "sagemaker",
  "text-generation-inference", "text-embeddings-inference", "lerobot",
] as const;

export function registerDocsTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "explore_hf_docs",
    label: "Explore HF Docs",
    description:
      "Browse HF documentation structure — discover all available documentation with 200-char previews.\n\n" +
      "Use to find relevant documentation and/or examples. Together with github_find_examples and github_read_file.\n\n" +
      "Pattern: explore_hf_docs (find pages) → fetch_hf_docs (get full content).\n" +
      "For training: fetch trainer config docs (SFTConfig, DPOConfig, GRPOConfig) to verify parameter names.",
    promptSnippet: "Browse HF library documentation structure",
    parameters: Type.Object({
      endpoint: StringEnum(ENDPOINTS),
      max_results: Type.Optional(Type.Number({ description: "Default: 20, max: 50." })),
    }),
    async execute(_id, params) {
      try {
        const ep = params.endpoint as string;
        const max = Math.min((params.max_results as number) || 20, 50);
        const headers = { ...hfHeaders(), "User-Agent": "ml-intern-pi" };

        const formats = ["llms.txt", "llms-full.txt"];
        let content = "";

        for (const fmt of formats) {
          try {
            const res = await fetchWithRetry(`${HF_DOCS}/${ep}/${fmt}`, { headers, timeoutMs: 15_000, retries: 1 });
            if (res.ok) {
              content = await res.text();
              break;
            }
          } catch { /* try next format */ }
        }

        if (!content) {
          return ok(`Could not fetch docs for '${ep}'.\nTry browsing directly at: ${HF_DOCS}/${ep}`);
        }

        const lines = [`Docs: ${ep}\nSource: ${HF_DOCS}/${ep}/llms.txt\n`];
        const re = /[-*]?\s*\[([^\]]+)\]\(([^)]+)\)/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          if (!m[2].startsWith("#")) {
            lines.push(`  [${m[1].trim()}](${m[2].trim()})`);
          }
        }

        return ok(lines.slice(0, max + 3).join("\n"), { endpoint: ep, pages: lines.length - 2 });
      } catch (e) {
        return err(String(e));
      }
    },
  });

  pi.registerTool({
    name: "fetch_hf_docs",
    label: "Fetch HF Docs",
    description:
      "Fetch full markdown content of an HF documentation page. Use after explore_hf_docs.\n\n" +
      "Critical for finding current trainer configuration parameters (SFTConfig, DPOConfig, etc.). " +
      "Use for researching solutions before writing training scripts. Your internal knowledge is outdated.\n\n" +
      "Provide the full URL from explore_hf_docs results. .md extension is added automatically.",
    promptSnippet: "Fetch full content of an HF documentation page",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL e.g., 'https://huggingface.co/docs/trl/dpo_trainer'" }),
    }),
    async execute(_id, params) {
      try {
        let url = (params.url as string).trim();
        if (!url.endsWith(".md") && !url.endsWith("/")) url += ".md";
        const res = await fetchWithRetry(url, {
          headers: { ...hfHeaders(), "User-Agent": "ml-intern-pi" },
          timeoutMs: 20_000,
        });
        if (res.status === 429) {
          return err(
            `HTTP 429 (rate limited) after all retries: ${url}. ` +
            `HF docs rate limit exceeded. Wait 60s and retry, or browse directly at the provided URL.`
          );
        }
        if (!res.ok) return err(`HTTP ${res.status}: ${url}`);
        const text = await res.text();
        const truncated = text.slice(0, 15_000);
        const suffix = text.length > 15_000 ? `\n...(truncated: ${text.length} chars)` : "";
        return ok(truncated + suffix, { url, length: text.length });
      } catch (e) {
        return err(String(e));
      }
    },
  });

  pi.registerTool({
    name: "find_hf_api",
    label: "Find HF API",
    description:
      "Search Hugging Face REST API endpoints by keyword or tag. Find the right API for programmatic operations.\n\n" +
      "Use for discovering API endpoints: streaming logs, org management, webhooks, billing, etc.",
    promptSnippet: "Search HF REST API endpoints by keyword or tag",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search term to find relevant API endpoints." })),
      tag: Type.Optional(Type.String({ description: "Filter by API tag/category." })),
    }),
    async execute(_id, params) {
      try {
        const q = (params.query as string) || "";
        if (!q) {
          return ok(
            "Popular HF API categories:\n" +
              "- Models: https://huggingface.co/api/models\n" +
              "- Datasets: https://huggingface.co/api/datasets\n" +
              "- Spaces: https://huggingface.co/api/spaces\n" +
              "- Papers: https://huggingface.co/api/papers\n" +
              "- Collections: https://huggingface.co/api/collections\n\n" +
              "Use a search query to find specific endpoints.",
          );
        }
        const res = await fetchWithRetry(
          `https://huggingface.co/api/search?q=${encodeURIComponent(`api ${q}`)}&type=docs`,
          { headers: { ...hfHeaders(), "User-Agent": "ml-intern-pi" }, timeoutMs: 15_000 },
        );
        if (!res.ok) return err(`Search failed: HTTP ${res.status}`);
        const results = await res.json();
        const lines = [`API endpoints matching '${q}':\n`];
        for (const x of (Array.isArray(results) ? results : []).slice(0, 10)) {
          lines.push(`  ${x.title ?? ""}: ${x.url ?? ""}\n    ${(x.summary ?? "").slice(0, 200)}`);
        }
        return ok(lines.join("\n"), { query: q, count: Array.isArray(results) ? results.length : 0 });
      } catch (e) {
        return err(String(e));
      }
    },
  });
}