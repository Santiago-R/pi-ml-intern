# Design

Architecture notes for the pi-ml-intern extension.

## Authoritative upstream and migration target

Future updates target **[HuggingChat's ML Intern mode in `huggingface/chat-ui`](https://github.com/huggingface/chat-ui)**, not the retired standalone ml-intern framework. Reviewed baseline: [`80f4edaea2cc79ff743c09f766685cd53fa8cd53`](https://github.com/huggingface/chat-ui/tree/80f4edaea2cc79ff743c09f766685cd53fa8cd53), 2026-09-23.

The [update proposal](./docs/update-proposal.md) is the authoritative migration design and deviation register. It requires close reproduction of upstream's assembled prompts, intentional repetition, MCP tool contracts, research/sandbox/job-check delegation, Trackio monitoring, and workflow tests. Private artifact defaults are the required product difference; Pi runtime adaptations must be explicit and justified. HF remains the default ecosystem. Prompt simplification and provider-neutral redesign are not part of this migration.

Primary references: Chat UI's `src/lib/server/mlAssistantPrompt.ts`, `mlAssistantPrompt.spec.ts`, `mlAssistant.ts`, and `src/lib/server/textGeneration/builtinTools/`. The proposal pins these sources and describes how to track remote Hub MCP schemas separately.

**Implementation status:** the sections below describe the legacy v0.2.0 architecture, not implemented Chat UI parity. Some rationales are historical and need correction: the active-tool API workaround, fixed tool counts, claims of exact upstream equivalence, and error signaling are not migration requirements. Private defaults and the MCP migration remain unimplemented. Execution isolation and enforced spending limits belong to infrastructure, not this extension.

## Legacy implementation overview

12 ML research tools scoped to `/ml-intern` mode. Zero impact on default Pi behavior. 7 standard Pi tools (read, bash, edit, write, grep, find, ls) always available. The 12 ml-intern tools activate only in ml-intern mode.

Tool count at full activation: 19 (7 standard + 12 ml-intern).

## Tool scoping state machine

Three modes controlled by a single `before_agent_start` handler in `index.ts`:

| Mode | Trigger | Tools | System prompt |
| --- | --- | --- | --- |
| Normal | Default | Standard only (7) | Unchanged |
| ML Intern | `/ml-intern` command or `ML_INTERN_FORCE=1` | All (19) | Full ml-intern prompt injected |
| Sub-agent | `ML_INTERN_SUBAGENT=1` | All (19) | Kept as-is (sub-agent has own prompt) |

The `active` flag is one-shot: set by `/ml-intern` or `ML_INTERN_FORCE=1`, consumed by the next `before_agent_start`, then cleared.

`disableMlInternTools()` at `session_start` AND `agent_end` provides belt-and-suspenders cleanup — tools are disabled both on session init and after each turn.

### Why `getAllTools()` not `getActiveTools()`

Historical rationale: the implementation assumed `getActiveTools()` returned null-named objects and switched to `getAllTools()`. The installed Pi declaration actually returns `string[]`. This workaround is not an authoritative API contract. Rebuilding the selection from all registered tools can enable unrelated disabled tools; the migration must preserve their selection and test the supported Pi API directly.

### Set, don't filter

`enableMlInternTools()` calls `pi.setActiveTools(allNames)` with the full list. `disableMlInternTools()` calls `pi.setActiveTools(filteredNames)` with only standard tools. Never rely on incremental add/remove APIs.

## Research sub-agent

`tools/research.ts` spawns a child `pi` process via `spawn()`. This is the only tool that uses subprocesses — it gives the research agent an isolated LLM context window, matching ml-intern's use of LiteLLM `acompletion()`.

Key decisions:

*   Uses `pi -p` (print/headless mode) — no TUI.
*   Passes `ML_INTERN_SUBAGENT=1` in child env. Without this, the child's own extension instance would disable ml-intern tools via `before_agent_start`, leaving the sub-agent with zero research tools.
*   No `--no-builtin-tools` flag. The sub-agent must have bash, read, write, edit to perform research.
*   Prompt is written to a temp file and passed via `--append-system-prompt`. Pi reads the file contents.
*   Timeout: 180s (3 minutes).
*   Output truncation: 8K head + 4K tail if >12K characters.
*   Error handling: if child exits non-zero with no stdout, the stderr (first 2K chars) is returned as the result rather than discarded.

## Error handling

### HTTP retry strategy

`fetchWithRetry()` in `utils/api.ts` currently uses this legacy retry policy (not a claim of equivalence to current Chat UI):

| Status | Wait | Retries | Total attempts |
| --- | --- | --- | --- |
| 429 | 60s | Up to `opts.retries` (default 2) | 3 |
| 5xx | 3s | Up to `opts.retries` (default 2) | 3 |
| Network error | 3s | Up to `opts.retries` | 3 |
| 4xx (non-429) | none | 0 | 1 |

After all retries exhausted, `fetchWithRetry` returns the final `Response` (even if error). It does NOT throw on HTTP errors. Tool-level code checks `res.ok` and produces user-facing error messages. Network errors (thrown by `fetch()`) are re-thrown as-is after exhaustion.

### 429 guidance

When all retries are exhausted on a 429, each tool provides actionable guidance:

*   **hf\_papers**: "Wait 60s. Use more specific query or try citation\_graph directly."
*   **github**: "Set GITHUB\_TOKEN for 5,000 req/hr. Current anonymous limit = 60/hr."
*   **hf\_docs**: "Wait 60s and retry, or browse at the provided URL."
*   **hf\_datasets**: "Wait 60s and retry, or browse directly at hf.co."
*   **hf\_jobs**: "Wait 60s before retrying."

`checkRateLimit()` in `utils/api.ts` standardizes the pattern. Returns `null` for OK, actionable string for 429/5xx.

### format compatibility check

`hf_inspect_dataset` auto-detects dataset column format and checks against training method requirements:

*   `"messages"` → compatible with SFT/chat
*   `"prompt"` + `"completion"`/`"chosen"` → may work with DPO/SFT
*   `"text"` → OK for LM pretraining, not conversational
*   `"label"` → classification, not conversational

## hub\_repo\_details cross-type lookup

When `hub_repo_details` looks up a repo with `type="model"` but the repo is actually a dataset, the direct API call (`/api/models/dataset-name`) returns HTTP 400. The fix: try all three endpoints (models→datasets→spaces) in priority order for each repo\_id, with a `/api/repos/` fallback.

Priority order is based on the requested `type` parameter:

*   `type=model` → models, datasets, spaces
*   `type=dataset` → datasets, models, spaces
*   `type=space` → spaces, models, datasets

## Output formatting

Every tool returns `{ content: [{ type: "text", text: "..." }], details: {...} }`. Two formatters in `utils/api.ts`:

*   `ok(text, details)` — success output. Truncates at 12K chars (60/40 split around middle).
*   `err(msg, details)` — error text with `details.isError = true`. This metadata alone does not establish a failed execution result in the current Pi contract; correcting error signaling is migration work.

## Token & auth

*   `HF_TOKEN` — auto-loaded from `.env` at extension load time via `loadEnvFiles()`. Used for HF Hub API calls, gated datasets, and HF Jobs. Injected into job secrets automatically.
*   `GITHUB_TOKEN` — auto-loaded from `.env`. Used for GitHub API rate limit lifting (60→5,000 req/hr).
*   `.env` is read synchronously with `fs.readFileSync` before any API calls.
*   Process env is only set if not already present — explicit exports take precedence.

## GPUs & hardware in hf\_jobs

`hf_jobs` supports CPU, GPU, and TPU flavors. Hardware sizing guidelines embedded in the parameter descriptions:

| Model size | Recommended hardware |
| --- | --- |
| 1-3B params | a10g-largex2 |
| 7-13B params | a100-large |
| 30B+ params | l40sx4 / a100x4 |
| 70B+ params | a100x8 |

Key detail: `a10g-small` and `a10g-large` have the same 24GB GPU. The difference is CPU/RAM. Most 1-3B training should use `a10g-large` (or `a10g-largex2`) not `a10g-small`.

## Data sources

Each tool hits a specific external API:

| Tool | Primary API |
| --- | --- |
| hf\_papers | Semantic Scholar (api.semanticscholar.org) |
| hf\_papers (read\_paper) | ar5iv (ar5iv.labs.arxiv.org) + arxiv.org |
| hf\_inspect\_dataset | HF datasets-server (datasets-server.huggingface.co), fallback to HF Hub API |
| hub\_repo\_details | HF Hub API (huggingface.co/api) |
| github\_\* | GitHub REST API (api.github.com) |
| hf\_docs | HF docs (huggingface.co/docs) via llms.txt / llms-full.txt |
| hf\_jobs | HF Jobs API (huggingface.co/api/jobs) |
| research | Local `pi` subprocess |

All APIs use Node 20's native `fetch()`. No HTTP client libraries. No Python subprocess overhead.

## Prompt architecture

Two prompts in `prompts.ts`:

`**SYSTEM_PROMPT**` (~20KB) — currently injected into main agent context during ml-intern mode. Historically based on the retired ml-intern's `system_prompt_v3.yaml`, with placeholder/escaping changes and removal of autonomous/headless and notify sections. It still contains obsolete sandbox assumptions. It is **not** the current upstream reference: migration will use Chat UI's assembled mode and tool prompts, with only registered, justified adaptations.

`**RESEARCH_SUBAGENT_PROMPT**` — written to temp file and loaded via `--append-system-prompt` by the research sub-agent. Includes tool usage patterns and output format requirements.

The main prompt explicitly instructs the LLM that its internal knowledge of HF libraries is outdated. It must research first (papers→code→docs) before writing any ML code. This is the central behavioral invariant.

## plan\_tool

In-memory task tracking. No persistence to disk. Each call replaces the entire plan. Single module-level variable (`currentPlan`). Exported via `getCurrentPlan()` for `session_start` notification.

## TypeBox & type shims

Tool parameters are defined with TypeBox schemas. `StringEnum()` in `utils/api.ts` wraps `Type.Unsafe()` for string-enum parameters — inlined from `@earendil-works/pi-ai` to avoid extra dependency.

`env.d.ts` provides ambient type declarations for Pi runtime modules (`@earendil-works/pi-coding-agent`, `typebox`, `@earendil-works/pi-ai`). These are for editor support only. Pi's runtime provides the actual modules at execution time.

## Dependency philosophy

Zero runtime dependencies. TypeBox is a devDependency (used at dev time for type-checking, but provided by Pi's runtime). Only Node 20+ standard library APIs used (native `fetch`, `fs`, `child_process`, `os`, `path`).

## File structure

```
index.ts          — Extension entry, tool lifecycle, .env loading, command registration
prompts.ts        — System prompt (main + sub-agent)
env.d.ts          — Pi runtime type shims
utils/api.ts      — fetchWithRetry, ok/err formatters, auth headers, StringEnum, checkRateLimit
tools/plan_tool.ts   — In-memory todo tracking
tools/hf_papers.ts   — Semantic Scholar API + ar5iv paper reading
tools/hf_datasets.ts — HF datasets-server + Hub API repo details
tools/github.ts      — GitHub REST API (find examples, list repos, read files)
tools/hf_docs.ts     — HF docs llms.txt browsing + page fetching
tools/hf_jobs.ts     — HF Jobs API (run, logs, inspect, cancel, scheduled ops)
tools/research.ts    — Sub-agent spawn (child pi process)
tests/               — Vitest test suite (tool activation + API retry)
```