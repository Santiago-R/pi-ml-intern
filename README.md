# pi-ml-intern

ML Intern extension for [Pi](https://github.com/earendil-works/pi-mono) — autonomous ML research & implementation with literature-backed recipes. Heavily inspired by [Hugging Face's ml-intern](https://github.com/huggingface/ml-intern).

[![npm](https://img.shields.io/npm/v/@santiago-r/pi-ml-intern)](https://www.npmjs.com/package/@santiago-r/pi-ml-intern) [![GitHub](https://img.shields.io/badge/github-Santiago--R%2Fpi--ml--intern-blue)](https://github.com/Santiago-R/pi-ml-intern)

Only activates when you explicitly invoke `/ml-intern`, with no impact on Pi's default behavior.

> **⚠️ EXPERIMENTAL** — This extension is under active development (v0.1.6). There may be bugs and performance may lag bahind the original project. Feedback and contributions welcome.

## Quick Start

### Install

```bash
pi install npm:@santiago-r/pi-ml-intern
```

Or manually: copy this directory to `~/.pi/agent/extensions/ml-intern/` (global) or `.pi/extensions/ml-intern/` (project-local).

### Usage example

```
/ml-intern Generate a state-of-the-art cardiac event classifier (multi-label) from publicly available ECG datasets. Emphasize optimization of low-level signal pre-processing. Emphasize explainability, output SHAP values alongside predictions. Evaluate on arrythmia detection ROC-AUC for a held-out test split.
```

Type `/ml-intern` followed by your ML task. Include concrete file paths, dataset formats, evaluation criteria, and any constraints. The more specific you are, the better the result.

## Requirements

- **Pi** (coding agent harness)

### Recommended access tokens

Set these for full capability. Without them, HF Hub lookups and GitHub code searches are rate-limited to public repos only, and HF Jobs is unavailable.

- `HF_TOKEN` — enables gated/private datasets, model downloads, and HF Jobs GPU training. [Get one here](https://huggingface.co/settings/tokens).
- `GITHUB_TOKEN` — lifts GitHub API rate limits. [Get one here](https://github.com/settings/tokens).

Tokens are auto-loaded from `.env` in the working directory. No manual `export` needed.

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

## Running headless (no TUI)

Prefer the CLI? Set `ML_INTERN_FORCE=1` for print mode:

```bash
ML_INTERN_FORCE=1 pi -p "Train a small GPT on input_data/my_data.jsonl"
```

This activates all 12 research tools and the ml-intern system prompt for the duration of the command, then exits. Works in shell scripts, CI, cron jobs, or even in agent subtasks if you are crazy enough.

## Attribution

Heavily inspired by [Hugging Face's ml-intern](https://github.com/huggingface/ml-intern) (Apache 2.0). All original TypeScript code is Apache 2.0-licensed.

## License

Apache 2.0 — see [LICENSE](./LICENSE).