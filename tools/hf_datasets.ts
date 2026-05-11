/**
 * hf_inspect_dataset + hub_repo_details — Dataset inspection and Hub repo details.
 * Native fetch() to HF datasets-server + Hub API.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { fetchWithRetry, ok, err, hfHeaders } from "../utils/api";

const DS_SERVER = "https://datasets-server.huggingface.co";
const HF_API = "https://huggingface.co/api";

export function registerHfDataTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "hf_inspect_dataset",
    label: "Inspect Dataset",
    description:
      "Inspect a HF dataset in one call: status, configs/splits, schema, sample rows, parquet info.\n\n" +
      "REQUIRED before any training job to verify dataset format matches training method:\n" +
      "  SFT: needs 'messages', 'text', or 'prompt'/'completion'\n" +
      "  DPO: needs 'prompt', 'chosen', 'rejected'\n" +
      "  GRPO: needs 'prompt'\n" +
      "All datasets used for training have to be in conversational ChatML format to be compatible with HF libraries.\n" +
      "Training will fail with KeyError if columns don't match.\n\n" +
      "Also use to get example datapoints, understand column names, data types, and available splits " +
      "before writing any data loading code. Supports private/gated datasets when HF_TOKEN is set.",
    promptSnippet: "Inspect HF dataset schema, splits, and sample rows",
    promptGuidelines: [
      "Use hf_inspect_dataset before any training to verify dataset columns match the training method format requirements.",
    ],
    parameters: Type.Object({
      dataset: Type.String({ description: "Dataset ID in 'org/name' format" }),
      config: Type.Optional(Type.String()),
      split: Type.Optional(Type.String()),
      sample_rows: Type.Optional(Type.Number({ description: "Default: 3, max: 10" })),
    }),
    async execute(_id, params) {
      try {
        const ds = params.dataset as string;
        const cfg = (params.config as string) || "";
        const spl = (params.split as string) || "";
        const rows = Math.min((params.sample_rows as number) || 3, 10);
        const headers = hfHeaders();

        // Try datasets-server first
        let info: Record<string, unknown> | null = null;
        try {
          const res = await fetchWithRetry(`${DS_SERVER}/info?dataset=${encodeURIComponent(ds)}`, { headers, timeoutMs: 15_000 });
          if (res.ok) info = await res.json();
        } catch { /* fall through to Hub API */ }

        if (!info || info.error) {
          // Fall back to Hub API for basic info
          try {
            const res = await fetchWithRetry(`${HF_API}/datasets/${encodeURIComponent(ds)}`, { headers, timeoutMs: 15_000 });
            if (res.ok) {
              const hub = await res.json();
              return ok(
                `Dataset: ${hub.id ?? ds}\n` +
                  `Description: ${(hub.description ?? "N/A").slice(0, 300)}\n` +
                  `Tags: ${JSON.stringify(hub.tags ?? [])}\n` +
                  `Downloads: ${hub.downloads ?? 0}\n\n` +
                  `To inspect locally: pip install datasets && python3 -c ` +
                  `"from datasets import load_dataset; print(load_dataset('${ds}'))"`,
                { source: "hub_api" },
              );
            }
          } catch { /* both failed */ }
          return err(`Dataset '${ds}' not found or not accessible.`);
        }

        // Build output from datasets-server response
        const di = (info.dataset_info || {}) as Record<string, unknown>;
        const lines = [
          `Dataset: ${ds}`,
          `Description: ${(di.description as string ?? "N/A").slice(0, 300)}`,
          `License: ${di.license ?? "N/A"}`,
        ];

        const configs = (di.configs || []) as Array<Record<string, unknown>>;
        if (!configs.length) {
          lines.push("\nNo configs found. Try locally with datasets library.");
          return ok(lines.join("\n"));
        }

        const ac = cfg ? configs.find((c) => c.config === cfg) ?? configs[0] : configs[0];
        lines.push(`\nConfig: ${ac.config}`);
        const splits = (ac.splits || []) as Array<Record<string, unknown>>;
        for (const s of splits) {
          lines.push(`  ${s.split}: ${s.num_examples ?? "?"} rows`);
        }

        const features = ac.features as Record<string, unknown> | undefined;
        if (features) {
          lines.push("Features:");
          for (const [n, t] of Object.entries(features)) {
            const dtype = typeof t === "object" && t ? (t as Record<string, unknown>).dtype ?? t : t;
            lines.push(`  ${n}: ${dtype}`);
          }
        }

        // Fetch sample rows
        const useSplit = spl || (splits[0]?.split as string);
        if (useSplit) {
          try {
            const rowsUrl = `${DS_SERVER}/rows?dataset=${encodeURIComponent(ds)}&config=${ac.config}&split=${useSplit}&offset=0&length=${rows}`;
            const rr = await fetchWithRetry(rowsUrl, { headers, timeoutMs: 15_000 });
            if (rr.ok) {
              const rd = await rr.json();
              lines.push(`\nSample rows (${useSplit}, first ${rows}):`);
              for (let i = 0; i < ((rd.rows || []) as Array<Record<string, unknown>>).length; i++) {
                const rw = rd.rows[i];
                const row = rw.row ?? rw;
                lines.push(`  [${i}] ${JSON.stringify(row).slice(0, 500)}`);
              }
            }
          } catch { /* rows unavailable */ }
        }

        // Format compatibility check
        const text = lines.join("\n");
        const lo = text.toLowerCase();
        let analysis = "";
        if (lo.includes('"messages"')) analysis = "\nFormat check: 'messages' column — compatible with SFT/chat training.";
        else if (lo.includes('"prompt"') && (lo.includes('"completion"') || lo.includes('"chosen"'))) analysis = "\nFormat check: prompt+completion/chosen — may work with DPO/SFT.";
        else if (lo.includes('"text"')) analysis = "\nFormat check: 'text' column — OK for LM pretraining or single-column SFT. Not conversational.";
        else if (lo.includes('"label"')) analysis = "\nFormat check: label column — classification dataset, not conversational.";

        return ok(text + analysis, { dataset: ds, config: ac.config });
      } catch (e) {
        return err(String(e));
      }
    },
  });

  pi.registerTool({
    name: "hub_repo_details",
    label: "Hub Repo Details",
    description:
      "Get comprehensive details about any Hugging Face Hub repository (model, dataset, or space).\n\n" +
      "Use this to:\n" +
      "- Validate models before training: check architecture, size, license, tokenizer\n" +
      "- Validate datasets: check format, size, splits before training\n" +
      "- Search for models/datasets by query, filtered by type and sorted\n" +
      "- Inspect Spaces for demos and deployed applications\n\n" +
      "Examples:\n" +
      "  {repo_ids: ['meta-llama/Llama-3.2-1B']} — get model details\n" +
      "  {repo_ids: ['HuggingFaceH4/ultrachat_200k']} — get dataset details\n" +
      "  {search: 'qwen3 instruct', type: 'model', sort: 'downloads', limit: 5} — search models",
    promptSnippet: "Get HF Hub repo details or search for models/datasets/spaces",
    promptGuidelines: [
      "Use hub_repo_details to validate models and datasets before training. Verify architecture, size, format, and license before proceeding.",
    ],
    parameters: Type.Object({
      repo_ids: Type.Optional(Type.Array(Type.String(), {
        description: "List of HF repo IDs to get details for. Format: 'owner/name'.",
      })),
      search: Type.Optional(Type.String({ description: "Search query for discovering repos." })),
      type: Type.Optional(StringEnum(["model", "dataset", "space"] as const)),
      sort: Type.Optional(StringEnum(["downloads", "likes", "created", "lastModified"] as const)),
      limit: Type.Optional(Type.Number({ description: "Max results. Default: 5." })),
    }),
    async execute(_id, params) {
      try {
        const repoIds = params.repo_ids as string[] | undefined;
        const search = (params.search as string) || "";
        const repoType = (params.type as string) || "model";
        const sort = (params.sort as string) || "downloads";
        const limit = Math.min((params.limit as number) || 5, 25);

        // ── Lookup specific repos ──
        if (repoIds && repoIds.length > 0) {
          const endpoint = repoType === "dataset" ? "datasets" : repoType === "space" ? "spaces" : "models";
          const results: string[] = [];
          for (const rid of repoIds) {
            try {
              const res = await fetchWithRetry(`${HF_API}/${endpoint}/${encodeURIComponent(rid)}`, { timeoutMs: 15_000 });
              if (res.ok) {
                const d = await res.json();
                results.push(`=== ${rid} ===\n${JSON.stringify(d, null, 2).slice(0, 2000)}\n`);
              } else {
                results.push(`=== ${rid} ===\nNot found (HTTP ${res.status})\n`);
              }
            } catch (e) {
              results.push(`=== ${rid} ===\nError: ${e}\n`);
            }
          }
          return ok(results.join("\n"), { repos: repoIds });
        }

        // ── Search ──
        if (search) {
          const endpoint = repoType === "dataset" ? "datasets" : repoType === "space" ? "spaces" : "models";
          const url = `${HF_API}/${endpoint}?search=${encodeURIComponent(search)}&sort=${sort}&limit=${limit}&full=true`;
          const res = await fetchWithRetry(url, { timeoutMs: 15_000 });
          if (!res.ok) return err(`Search failed: HTTP ${res.status}`);
          const results = await res.json();
          if (!Array.isArray(results)) return err("Unexpected API response");

          const lines = results.map((x: Record<string, unknown>, i: number) =>
            `${i + 1}. ${x.id}\n   Downloads: ${(x.downloads as number ?? 0).toLocaleString()}  ` +
              `Likes: ${(x.likes as number ?? 0).toLocaleString()}\n   ` +
              `Created: ${String(x.createdAt ?? "?").slice(0, 10)}\n   ${String(x.description ?? "").slice(0, 200)}\n`
          );
          return ok(lines.join("\n"), { search, type: repoType, count: results.length });
        }

        return err("Provide repo_ids or search query.");
      } catch (e) {
        return err(String(e));
      }
    },
  });
}