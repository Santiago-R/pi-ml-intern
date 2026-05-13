/**
 * GitHub tools — github_find_examples, github_list_repos, github_read_file.
 * Native fetch() to GitHub REST API.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchWithRetry, ok, err, ghHeaders } from "../utils/api";

const GH = "https://api.github.com";

export function registerGithubTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "github_find_examples",
    label: "GitHub Find Examples",
    description:
      "Find working example scripts in GitHub repositories (from predetermined directories " +
      "e.g. examples/, scripts/, tutorials/). Uses keyword matching.\n\n" +
      "MANDATORY before writing any ML training code. Your internal knowledge of library APIs is outdated.\n\n" +
      "Pattern: github_find_examples → github_read_file → implement based on findings.",
    promptSnippet: "Find working ML example scripts in GitHub repos",
    promptGuidelines: [
      "Use github_find_examples to find working example scripts in HF repos before implementing ML training code.",
    ],
    parameters: Type.Object({
      keyword: Type.Optional(Type.String({ description: "Keyword to match file paths (e.g., 'sft', 'grpo')." })),
      repo: Type.String({ description: "Repository name (e.g., 'trl', 'transformers')." }),
      org: Type.Optional(Type.String({ description: "GitHub org. Default: 'huggingface'." })),
      max_results: Type.Optional(Type.Number({ description: "Default: 50." })),
    }),
    async execute(_id, params) {
      try {
        const repo = params.repo as string;
        const org = (params.org as string) || "huggingface";
        const kw = (params.keyword as string) || "";
        const max = (params.max_results as number) || 50;
        const headers = ghHeaders();

        const dirs = ["examples", "scripts", "tutorials", "recipes", "notebooks", "docs/source/en/tutorials"];
        const results: Array<{ path: string; name: string; url: string }> = [];
        let lastError = "";
        let lastStatus = 0;

        for (const d of dirs) {
          try {
            const res = await fetchWithRetry(`${GH}/repos/${org}/${repo}/contents/${d}`, { headers, timeoutMs: 10_000 });
            if (!res.ok) {
              lastStatus = res.status;
              lastError = `GitHub API ${res.status} on ${org}/${repo}/contents/${d}`;
              continue;
            }
            const files = await res.json();
            if (!Array.isArray(files)) continue;
            for (const f of files) {
              if (f.type === "file" && (!kw || f.name.toLowerCase().includes(kw.toLowerCase()))) {
                results.push({ path: f.path, name: f.name, url: f.html_url });
              }
            }
          } catch (e) { lastError = String(e); /* skip unavailable dirs */ }
        }

        if (kw) {
          try {
            const res = await fetchWithRetry(
              `${GH}/search/code?q=${encodeURIComponent(kw)}+repo:${org}/${repo}+path:examples+OR+path:scripts&per_page=20`,
              { headers, timeoutMs: 10_000 },
            );
            if (res.ok) {
              const sd = await res.json();
              for (const i of sd.items || []) results.push({ path: i.path, name: i.name, url: i.html_url });
            } else {
              lastStatus = res.status;
            }
          } catch (e) { lastError = String(e); /* search API can be flaky */ }
        }

        // If ALL calls returned errors (no results at all), report the error
        if (!results.length) {
          if (lastStatus === 403 || lastStatus === 429) {
            return err(
              `GitHub API rate limited (HTTP ${lastStatus}). ` +
              `Set GITHUB_TOKEN in your environment for higher limits, or browse manually:\n` +
              `https://github.com/${org}/${repo}`
            );
          }
          if (lastError && lastStatus >= 400) {
            return err(
              `GitHub API error (HTTP ${lastStatus}): ${lastError}. Browse manually:\n` +
              `https://github.com/${org}/${repo}`
            );
          }
          return ok(
            `No examples found in ${org}/${repo}${kw ? ` for '${kw}'` : ""}\nBrowse: https://github.com/${org}/${repo}`,
          );
        }

        const lines = [`Found ${results.length} example files in ${org}/${repo}${kw ? ` matching '${kw}'` : ""}\n`];
        for (const r of results.slice(0, max)) lines.push(`  ${r.path}\n  -> ${r.url}\n`);
        if (results.length > max) lines.push(`...and ${results.length - max} more`);
        return ok(lines.join("\n"), { repo: `${org}/${repo}`, keyword: kw, count: results.length });
      } catch (e) {
        return err(String(e));
      }
    },
  });

  pi.registerTool({
    name: "github_list_repos",
    label: "GitHub List Repos",
    description:
      "List and discover repos for GitHub orgs/users. Use to explore what libraries exist, " +
      "find popular/active projects, discover alternatives. Sort by stars/forks/updated.",
    promptSnippet: "List and discover GitHub repos for an org/user",
    parameters: Type.Object({
      owner: Type.String({ description: "GitHub org or username." }),
      owner_type: Type.Optional(Type.String({ description: "'org' or 'user'. Default: 'org'." })),
      sort: Type.Optional(Type.String({ description: "'stars', 'forks', 'updated'. Default: 'stars'." })),
      limit: Type.Optional(Type.Number({ description: "Default: 30, max: 100." })),
    }),
    async execute(_id, params) {
      try {
        const owner = params.owner as string;
        const type = (params.owner_type as string) || "org";
        const sort = (params.sort as string) || "stars";
        const limit = Math.min((params.limit as number) || 30, 100);

        const res = await fetchWithRetry(
          `${GH}/${type}s/${owner}/repos?sort=${sort}&per_page=${limit}&type=public`,
          { headers: ghHeaders(), timeoutMs: 15_000 },
        );
        if (!res.ok) return err(`GitHub API error: ${res.status}`);

        const repos = await res.json();
        if (!repos.length) return ok(`No public repos for ${owner}.`);

        const lines = [`Repos for ${owner} (sorted by ${sort}, ${repos.length} shown):\n`];
        for (const r of repos) {
          const lang = r.language || "";
          const stars = r.stargazers_count || 0;
          const desc = (r.description || "").slice(0, 120);
          const topics = (r.topics || []).slice(0, 5).join(", ");
          lines.push(`  ${r.full_name}`);
          if (lang) lines.push(`    ${lang}  Stars: ${stars.toLocaleString()}`);
          if (desc) lines.push(`    ${desc}`);
          if (topics) lines.push(`    Topics: ${topics}`);
          lines.push(`    ${r.html_url}\n`);
        }
        return ok(lines.join("\n"), { owner, count: repos.length });
      } catch (e) {
        return err(String(e));
      }
    },
  });

  pi.registerTool({
    name: "github_read_file",
    label: "GitHub Read File",
    description:
      "Read file contents from GitHub repositories. First 300 lines by default.\n\n" +
      "Use AFTER github_find_examples to study the implementation. Learn current API patterns " +
      "— imports, configs, dataset handling. Use line_start/line_end for large files.",
    promptSnippet: "Read file contents from GitHub repos",
    promptGuidelines: [
      "Use github_read_file after github_find_examples to study working implementation code before writing ML scripts.",
    ],
    parameters: Type.Object({
      repo: Type.String({ description: "Format 'owner/repo' (e.g., 'huggingface/trl')." }),
      path: Type.String({ description: "Path to file (e.g., 'examples/scripts/sft.py')." }),
      ref: Type.Optional(Type.String({ description: "Branch/tag/commit. Default: 'main'." })),
      line_start: Type.Optional(Type.Number()),
      line_end: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      try {
        const repo = params.repo as string;
        const fp = params.path as string;
        const ref = (params.ref as string) || "main";
        const ls = (params.line_start as number) || 0;
        const le = (params.line_end as number) || 0;

        const url = `${GH}/repos/${repo}/contents/${encodeURIComponent(fp)}?ref=${ref}`;
        const res = await fetchWithRetry(url, { headers: ghHeaders(), timeoutMs: 15_000 });
        if (!res.ok) return err(`GitHub API error ${res.status}: ${fp}`);

        const d = await res.json();

        if (Array.isArray(d)) {
          // Directory listing
          const names = d.map((x: { name: string; type: string }) =>
            `  ${x.name}${x.type === "dir" ? "/" : ""}`
          ).join("\n");
          return ok(`Directory: ${repo}/${fp}\n${names}`, { isDir: true });
        }

        if (d.content) {
          const content = Buffer.from(d.content, "base64").toString("utf-8");
          const lines = content.split("\n");
          const total = lines.length;

          let s = 0, e = Math.min(300, total);
          if (ls > 0 || le > 0) {
            s = Math.max(0, ls - 1);
            e = le > 0 ? Math.min(le, total) : Math.min(s + 300, total);
          }

          const sel = lines.slice(s, e).map((l, i) => `${String(s + i + 1).padStart(4)}| ${l}`);
          let out = `File: ${repo}/${fp} (lines ${s + 1}-${Math.min(e, total)} of ${total})\n\n${sel.join("\n")}`;
          if (total > e) out += `\n\n... ${total - e} more lines (use line_start/line_end)`;
          return ok(out, { repo, path: fp, totalLines: total });
        }

        return err(`Unexpected response: ${JSON.stringify(d).slice(0, 500)}`);
      } catch (e) {
        return err(String(e));
      }
    },
  });
}