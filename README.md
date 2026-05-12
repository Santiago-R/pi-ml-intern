# pi-ml-intern

ML Intern extension for [Pi](https://github.com/earendil-works/pi-mono) — autonomous ML research & implementation with literature-backed recipes. Heavily inspired by [Hugging Face's ml-intern](https://github.com/huggingface/ml-intern).

[![npm](https://img.shields.io/npm/v/@santiago-r/pi-ml-intern)](https://www.npmjs.com/package/@santiago-r/pi-ml-intern) [![GitHub](https://img.shields.io/badge/github-Santiago--R%2Fpi--ml--intern-blue)](https://github.com/Santiago-R/pi-ml-intern)

Only activates when you explicitly invoke `/ml-intern`, with no impact on Pi's default behavior.

> **⚠️ EXPERIMENTAL** — This extension is under active development (v0.1.3). APIs, tools, and behavior may change without notice. Use at your own risk. Feedback and contributions welcome.

## Quick Start

### Install

```bash
pi install npm:@santiago-r/pi-ml-intern
```

Or manually: copy this directory to `~/.pi/agent/extensions/ml-intern/` (global) or `.pi/extensions/ml-intern/` (project-local).

### Usage examples

```
/ml-intern fine-tune Qwen2.5 on my instruction dataset
/ml-intern implement DPO training with the Anthropic HH dataset
/ml-intern research the best LoRA recipe for code generation
```

Type `/ml-intern` followed by your ML task. The extension uses ml-intern's tools and system prompt for that turn, then returns to normal Pi behavior.

## What it does

When you use `/ml-intern`, the agent:

1. **Researches first** — finds landmark papers, crawls citation graphs, reads methodology sections
2. **Validates resources** — checks dataset schemas, model architectures, API compatibility
3. **Implements** — includes instructions against hallucinated imports, wrong arguments, and silent substitutions
4. **Tracks progress** — uses `plan_tool` for tasks with 3+ steps

## Tools included

| Tool | Description |
|------|-------------|
| `plan_tool` | Track ML task progress (pending/in_progress/completed) |
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

## How it works

```
User types: /ml-intern fine-tune llama on ultrachat
                     │
                     ▼
         Command handler sends task as user message
         Sets one-shot flag
                     │
                     ▼
         before_agent_start fires
         Injects exact 15.8KB ml-intern v3 system prompt
         Agent now has: literature workflow + anti-pattern guard + tool guidance
                     │
                     ▼
         Next turn: flag resets → Pi back to normal
```

## Requirements

- **Pi** (coding agent harness)
- Optional: `HF_TOKEN` (for private/gated HF Hub datasets)
- Optional: `GITHUB_TOKEN` (for higher GitHub API rate limits)

## Attribution

Heavily inspired by [Hugging Face's ml-intern](https://github.com/huggingface/ml-intern) (Apache 2.0). All original TypeScript code is Apache 2.0-licensed.

## License

Apache 2.0 — see [LICENSE](./LICENSE).