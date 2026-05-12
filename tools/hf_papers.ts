/**
 * hf_papers — Paper search, citation graphs, section reading.
 * Calls Semantic Scholar API + ar5iv (HTML paper rendering).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchWithRetry, ok, err, StringEnum } from "../utils/api";

const S2 = "https://api.semanticscholar.org/graph/v1/paper";
const S2_RECOMMEND = "https://api.semanticscholar.org/recommendations/v1/papers/forpaper";
const AR5IV = "https://ar5iv.labs.arxiv.org/html";

const S2_HEADERS = { "User-Agent": "ml-intern-pi" };

export function registerHfPapersTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "hf_papers",
    label: "HF Papers",
    description:
      "Discover papers, read their contents, and find linked resources. " +
      "Operations: search, paper_details, read_paper, citation_graph, snippet_search, " +
      "recommend, find_datasets, find_all_resources.\n\n" +
      "MANDATORY before any ML implementation. Start from the literature: " +
      "find papers → crawl citations → read methodology → extract recipes → validate datasets.",
    promptSnippet: "Search papers, read methodology sections, crawl citation graphs",
    promptGuidelines: [
      "Use hf_papers to find landmark papers, crawl citation graphs, and read methodology sections before writing any ML code.",
    ],
    parameters: Type.Object({
      operation: StringEnum([
        "search", "paper_details", "read_paper", "citation_graph",
        "snippet_search", "recommend", "find_datasets", "find_all_resources",
      ] as const),
      query: Type.Optional(Type.String()),
      arxiv_id: Type.Optional(Type.String()),
      section: Type.Optional(Type.String()),
      min_citations: Type.Optional(Type.Number()),
      sort_by: Type.Optional(StringEnum(["citationCount", "recency"] as const)),
      date_from: Type.Optional(Type.String()),
      direction: Type.Optional(StringEnum(["citations", "references"] as const)),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      try {
        const op = params.operation as string;
        const aid = (params.arxiv_id as string) || "";
        const q = (params.query as string) || "";
        const sec = (params.section as string) || "";
        const limit = Math.min((params.limit as number) || 10, 50);

        switch (op) {
          // ── search ──
          case "search": {
            let url = `${S2}/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=title,authors,year,citationCount,url,abstract`;
            if (params.sort_by === "citationCount") url += "&sort=citation_count:desc";
            if (params.date_from) url += `&year=${(params.date_from as string).slice(0, 4)}-`;
            const data = await fetchJson(url, S2_HEADERS);
            const lines = (data?.data || []).map((p: Record<string, unknown>) =>
              `- ${p.title ?? "?"} (${p.year ?? "?"}, ${p.citationCount ?? 0} cit)\n  ${p.url ?? ""}\n  ${String(p.abstract ?? "").slice(0, 300)}\n`
            );
            return ok(lines.join("\n") || "(no results)", { operation: "search", query: q });
          }

          // ── paper_details ──
          case "paper_details": {
            const data = await fetchJson(
              `${S2}/ARXIV:${aid}?fields=title,authors,year,citationCount,abstract,url,externalIds,publicationVenue,tldr`,
              S2_HEADERS,
            );
            if (!data || !data.title) return err(`Paper not found: ${aid}`);
            const tldr = (data.tldr as Record<string, string> | null)?.text ?? "N/A";
            return ok(
              `Title: ${data.title}\nYear: ${data.year}\nCitations: ${data.citationCount ?? 0}\n` +
                `Venue: ${(data.publicationVenue as string) || "N/A"}\n` +
                `TLDR: ${tldr}\nURL: ${data.url}\n\nAbstract: ${String(data.abstract ?? "").slice(0, 1500)}`,
              { operation: "paper_details", arxiv_id: aid },
            );
          }

          // ── citation_graph ──
          case "citation_graph": {
            const dir = (params.direction as string) === "references" ? "references" : "citations";
            const data = await fetchJson(
              `${S2}/ARXIV:${aid}/${dir}?limit=${limit}&fields=title,authors,year,citationCount,isInfluential,intents`,
              S2_HEADERS, { timeoutMs: 60_000 },
            );
            const lines = (data?.data || []).map((p: Record<string, unknown>) =>
              `${p.isInfluential ? "[INFLUENTIAL] " : ""}${p.title ?? "Untitled"} ` +
                `(${p.year ?? "?"}, ${p.citationCount ?? 0} cit)\n  intents: ${(p.intents as string[] || []).join(", ")}`
            );
            return ok(lines.join("\n") || "(no results)", { operation: "citation_graph", arxiv_id: aid, direction: dir });
          }

          // ── read_paper ──
          case "read_paper": {
            if (sec) {
              const html = await fetchText(`${AR5IV}/${aid}`, 30_000);
              const re = new RegExp(`<(?:h[1-6]|section)[^>]*id="(?:S|s)${escapeRx(sec)}[^"]*"`, "i");
              const parts = html.slice(0, 500_000).split(re);
              if (parts.length < 2) return err(`Section ${sec} not found. Try reading the TOC first.`);
              const text = stripHtml(parts[1]).slice(0, 8000);
              return ok(text, { operation: "read_paper", section: sec });
            }
            // TOC: abstract from arxiv + sections from ar5iv
            const absHtml = await fetchText(`https://arxiv.org/abs/${aid}`, 20_000);
            const absMatch = absHtml.match(/<blockquote class="abstract[^"]*"[^>]*>(.*?)<\/blockquote>/s);
            const abstract = absMatch ? stripHtml(absMatch[1]).slice(0, 2000) : "N/A";

            const ar5ivHtml = await fetchText(`${AR5IV}/${aid}`, 30_000);
            const sections: string[] = [];
            const secRe = /<(?:h[1-6])[^>]*id="(?:S|s)(\d+(?:\.\d+)*)[^"]*"[^>]*>([^<]+)/gi;
            let m;
            while ((m = secRe.exec(ar5ivHtml.slice(0, 200_000))) !== null) {
              sections.push(`  ${m[1]}: ${m[2].trim()}`);
            }
            return ok(
              `ABSTRACT: ${abstract}\n\nSECTIONS:\n${sections.join("\n") || "  (none found)"}`,
              { operation: "read_paper", toc: true },
            );
          }

          // ── snippet_search ──
          case "snippet_search": {
            const data = await fetchJson(
              `${S2}/search?query=${encodeURIComponent(q)}&limit=10&fields=title,year,abstract`, S2_HEADERS,
            );
            const lines = (data?.data || []).map((p: Record<string, unknown>) =>
              `- ${p.title ?? "?"} (${p.year ?? "?"})\n  ${String(p.abstract ?? "").slice(0, 400)}\n`
            );
            return ok(lines.join("\n") || "(no results)", { operation: "snippet_search", query: q });
          }

          // ── recommend ──
          case "recommend": {
            const data = await fetchJson(
              `${S2_RECOMMEND}/ARXIV:${aid}?limit=10&fields=title,authors,year,citationCount`, S2_HEADERS,
            );
            const papers = data?.recommendedPapers || [];
            const lines = papers.map((p: Record<string, unknown>) =>
              `- ${p.title ?? "?"} (${p.year ?? "?"}, ${p.citationCount ?? 0} cit)`
            );
            return ok(lines.join("\n") || "(no recommendations)", { operation: "recommend", arxiv_id: aid });
          }

          // ── find_datasets / find_all_resources ──
          case "find_datasets":
          case "find_all_resources": {
            const data = await fetchJson(`https://huggingface.co/api/papers/${aid}`);
            const datasets = (data?.datasets || []) as Array<{ id?: string; description?: string }>;
            const models = (data?.models || []) as Array<{ id?: string }>;

            if (op === "find_datasets") {
              const lines = datasets.map((d) =>
                `  ${d.id ?? d}: ${(d.description ?? "").slice(0, 200)}`
              );
              return ok(
                `HF datasets linked to ${aid}:\n${lines.join("\n") || "  None found"}`,
                { operation: "find_datasets", arxiv_id: aid },
              );
            }
            return ok(
              `datasets: ${datasets.map((d) => d.id ?? d) || "none"}\n` +
                `models: ${models.map((m) => m.id ?? m) || "none"}\n` +
                `collections: none`,
              { operation: "find_all_resources", arxiv_id: aid },
            );
          }

          default:
            return err(`Unknown operation: ${op}`);
        }
      } catch (e) {
        return err(String(e));
      }
    },
  });
}

// ── Helpers ──

async function fetchJson(url: string, headers: Record<string, string> = {}, opts: { timeoutMs?: number } = {}) {
  const res = await fetchWithRetry(url, { headers, timeoutMs: opts.timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetchWithRetry(url, { timeoutMs, retries: 1 });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}