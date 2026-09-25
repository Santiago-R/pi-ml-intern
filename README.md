# pi-ml-intern

ML Intern extension for [Pi](https://github.com/earendil-works/pi-mono) — autonomous ML research & implementation with literature-backed recipes.

The authoritative upstream for future updates is **[HuggingChat's ML Intern mode in `huggingface/chat-ui`](https://github.com/huggingface/chat-ui)**. The current v0.2.0 implementation derives from the now-retired [Hugging Face ml-intern](https://github.com/huggingface/ml-intern); it has not yet migrated to Chat UI's workflow and tool contracts.

[![npm](https://img.shields.io/npm/v/@santiago-r/pi-ml-intern)](https://www.npmjs.com/package/@santiago-r/pi-ml-intern) [![GitHub](https://img.shields.io/badge/github-Santiago--R%2Fpi--ml--intern-blue)](https://github.com/Santiago-R/pi-ml-intern)

ML-specific behavior is opt-in through `/ml-intern` or headless force mode. The migration will make ML mode persist for the session until explicit exit; v0.2.0 still uses one-task activation.

> **⚠️ EXPERIMENTAL** — This extension is under active development (v0.2.0). Performance may lag behind the original project. Feedback and contributions welcome.

> **⚠️ CURRENT PRIVACY LIMITATION** — v0.2.0 does not ensure private artifacts. Visibility depends on the generated upload code and destination settings. Private-by-default outputs are required by the update proposal, but are not implemented yet.

## Update direction

See [the update proposal](./docs/update-proposal.md) for the source map, implementation plan, and explicit deviation register. The reviewed Chat UI baseline is [`80f4eda`](https://github.com/huggingface/chat-ui/tree/80f4edaea2cc79ff743c09f766685cd53fa8cd53) (2026-09-23).

- Closely reproduce upstream's tested prompts, tool contracts, and delegated workflows—including intentional repeated rules.
- Make all outputs private by default, with explicit user-requested publication as an exception. If private live monitoring is unavailable, stop and offer private persisted metrics only with the user's explicit agreement.
- Require users to install/configure a compatible **external Pi MCP adapter**. No bundled client, automatic installation, silent configuration rewrites, or service fallback. The plan includes comparing popular adapters' input/output and delegate compatibility, then documenting a tested setup and capability checks.
- Keep ML mode active until explicit exit, restore it when that session is resumed, and leave new sessions normal unless explicitly launched in ML mode. Exiting does not cancel remote jobs; monitoring resumes only when the user reopens Pi.
- Allow any Pi model/provider, inherited by delegates—no curated model list or restrictions.
- Ask for a task allowance or standing authorization before newly rented compute (including smoke jobs/paid sandboxes) and paid hosting/storage. Ordinary cheap lookups, local compute, and existing Pi inference need no additional allowance. Costs are tracked best-effort; infrastructure enforces hard limits.
- Preserve material user questions. Headless runs stop with resumption instructions when an unanswered decision blocks work rather than guessing or waiting indefinitely.
- Make a clean breaking migration without legacy compatibility shims. Require funded live validation before claiming reliable training support; until then, label it unverified.
- Document and justify every behavioral deviation, including necessary Pi adaptations. HF remains the default; broader provider support is a future discussion.
- Execution isolation and enforced spending limits belong to the VM/sandbox/provider infrastructure. This extension is not a security boundary; tools can execute arbitrary code and launch billable compute.

The usage and tools below describe the **current implementation**, not the proposed migration.

## Quick Start

### Install

```
pi install npm:@santiago-r/pi-ml-intern
```

Or manually: copy this directory to `~/.pi/agent/extensions/ml-intern/` (global) or `.pi/extensions/ml-intern/` (project-local).

### Usage example

```
/ml-intern Generate a state-of-the-art cardiac event classifier (multi-label) from publicly available ECG datasets. Emphasize optimization of low-level signal pre-processing. Emphasize explainability, output SHAP values alongside predictions. Evaluate on arrythmia detection ROC-AUC for a held-out test split.
```

Type `/ml-intern` followed by your ML task. Include concrete and relevant details, instructions, constraints, and evaluation criteria.

## Requirements

*   **Pi** (coding agent harness)

### Recommended access tokens

Set these for full capability. Without them, HF Hub lookups and GitHub code searches are rate-limited to public repos only, and HF Jobs is unavailable.

*   `HF_TOKEN` — enables gated/private datasets, model downloads, and HF Jobs GPU training. [Get one here](https://huggingface.co/settings/tokens).
*   `GITHUB_TOKEN` — lifts GitHub API rate limits. [Get one here](https://github.com/settings/tokens).

Tokens are auto-loaded from `.env` in the working directory. No manual `export` needed.

## What it does

When you use `/ml-intern`, the agent:

1.  **Researches first** — finds landmark papers, crawls citation graphs, reads methodology sections
2.  **Validates resources** — checks dataset schemas, model architectures, API compatibility
3.  **Implements** — includes instructions against hallucinated imports, wrong arguments, and silent substitutions
4.  **Tracks progress** — uses `plan_tool` for tasks with 3+ steps

## Tools included

| Tool | Description |
| --- | --- |
| `plan_tool` | Track ML task progress (pending/in\_progress/completed) |
| `hf_papers` | Paper search, citation graphs, methodology section reading |
| `hf_jobs` | Submit & manage remote GPU/CPU compute jobs on HF Cloud |
| `hub_repo_details` | HF Hub model/dataset/space details and search |
| `hf_inspect_dataset` | Dataset schema, splits, and sample inspection |
| `github_find_examples` | Find working ML example scripts in GitHub repos |
| `github_list_repos` | Discover repos for GitHub orgs/users |
| `github_read_file` | Read file contents from GitHub repos |
| `explore_hf_docs` | Browse HF documentation structure |
| `fetch_hf_docs` | Fetch full HF documentation pages |
| `find_hf_api` | Search HF REST API endpoints |
| `research` | Spawn isolated sub-agent for deep literature research |

## Running headless (no TUI)

Prefer the CLI? Set `ML_INTERN_FORCE=1` for print mode:

```bash
ML_INTERN_FORCE=1 pi -p "Train a small GPT on input_data/my_data.jsonl"
```

This activates all 12 research tools and the ml-intern system prompt for the duration of the command, then exits. Works in shell scripts, CI, cron jobs, or even in agent subtasks if you are crazy enough.

## Attribution

Current implementation historically derives from [Hugging Face's retired ml-intern](https://github.com/huggingface/ml-intern). The authoritative update reference is [HuggingChat / Chat UI's ML Intern mode](https://github.com/huggingface/chat-ui), including its [workflow prompt](https://github.com/huggingface/chat-ui/blob/80f4edaea2cc79ff743c09f766685cd53fa8cd53/src/lib/server/mlAssistantPrompt.ts). Both upstream repositories are Apache 2.0-licensed. Original TypeScript code here is also Apache 2.0-licensed.

## License

Apache 2.0 — see [LICENSE](./LICENSE).