# pi-ml-intern

`pi-ml-intern` is an opt-in [Pi](https://github.com/earendil-works/pi-mono) extension for ML research and implementation. It gives the agent an ML-specific workflow, isolated research and job-check delegates, Hugging Face Jobs and Hub tools, private output defaults, and explicit controls for paid compute and publication.

Enter ML mode and describe the task:

```text
/ml-intern Build and evaluate a text classifier for my dataset. Research suitable baselines first.
```

The extension can research, plan, write code, launch authorized remote jobs, monitor them while Pi is open, and persist private Trackio metrics for later local review. It does not affect ordinary Pi sessions unless enabled.

[![npm](https://img.shields.io/npm/v/@santiago-r/pi-ml-intern)](https://www.npmjs.com/package/@santiago-r/pi-ml-intern) [![GitHub](https://img.shields.io/badge/github-Santiago--R%2Fpi--ml--intern-blue)](https://github.com/Santiago-R/pi-ml-intern)

## Quick start

### Requirements

- Pi `0.87.x`
- Node.js `22.22` or newer
- A Hugging Face token; funded Jobs access is required only for remote training
- Any Pi model/provider you choose

### 1. Install and configure the MCP adapter

Install the tested adapter:

```sh
pi install npm:pi-mcp-adapter@2.37.0
```

Merge this server into `.pi/mcp.json` without replacing your other servers:

```json
{
  "mcpServers": {
    "hf-intern": {
      "url": "https://huggingface.co/mcp?login&bouquet=intern",
      "auth": "bearer",
      "bearerTokenEnv": "HF_TOKEN",
      "directTools": [
        "hf_whoami", "create_repo", "hub_repo_details", "hf_fs", "hf_fs_write",
        "hf_jobs", "hf_sandbox", "hf_sandbox_exec", "hf_sandbox_fs"
      ],
      "toolPrefix": "none",
      "lifecycle": "eager"
    }
  }
}
```

Set `HF_TOKEN` before Pi starts. If it is stored in a project `.env`, start Pi with:

```sh
node --env-file=.env "$(command -v pi)"
```

Optional environment variables:

- `GITHUB_TOKEN` enables GitHub grounding.
- `HF_BILL_TO` selects a compute-paying organization.
- `HF_BILLING_RESOURCE_GROUP` attributes newly created compute.

If MCP discovery has not completed, run `/mcp reconnect hf-intern`, then retry `/ml-intern`.

### 2. Install the extension

```sh
pi install npm:@santiago-r/pi-ml-intern@0.3.0
```

### 3. Use it

```text
/ml-intern
/ml-intern Research and implement a small image classifier, then evaluate it.
/ml-intern off
```

ML mode remains active for follow-up turns and saved-session resumes until `/ml-intern off`. New sessions remain normal unless started with `--ml-intern` or `ML_INTERN_FORCE=1`.

## What it does

When ML mode is active, the agent:

1. researches relevant methods and working examples;
2. plans multi-step work and asks before making material assumptions;
3. writes and validates scripts using Pi's native file tools;
4. requests explicit authorization before paid compute or public artifacts;
5. submits and monitors Hugging Face jobs when authorized;
6. defaults newly created Hub artifacts to private; and
7. records remote work so saved sessions can inspect it later.

Pi does not monitor jobs while it is closed. **Exiting ML mode or closing Pi does not cancel remote jobs.** Reopen the saved session to inspect them, or cancel them explicitly.

## Commands and authorization

```text
/ml-intern <task>                         Enable ML mode and optionally start a task
/ml-intern allow <experiment scope>      Authorize paid work for one named experiment
/ml-intern publish <exact hf:// URI>     Authorize one public artifact
/ml-intern off                            Leave ML mode without cancelling jobs
```

The `request_authorization` tool can also show a Pi confirmation dialog. Chat text alone is never interpreted as spending or publication permission. An allowance covers the named experiment's checks, smoke tests, failures, retries, and main run; it is not a hard spending cap. Provider quotas remain the hard limit.

Ambiguous billable submissions are not automatically retried. Their names are retained so the agent can look for the remote resource before deciding what to do next.

## Internal tools

| Tool | Purpose |
| --- | --- |
| `research` | Isolated literature and implementation research |
| `update_plan` | Session-scoped ML task planning |
| `ask_user_question` | Material decisions without silent guessing |
| `request_authorization` | Direct user approval for compute or publication |
| `check_job` | Isolated status and log inspection |
| `wait` | Cancellable in-process wait before another status check |
| `sandbox_task` | Debugging in an existing optional HF sandbox |
| `create_trackio` | Reserve a private metrics dataset for Trackio snapshots |
| GitHub tools | Example discovery when `GITHUB_TOKEN` is configured |

The external MCP adapter supplies Hub filesystem, repository, identity, Jobs, and optional sandbox tools. Delegates inherit the selected Pi model and reasoning level.

## Files, privacy, and metrics

Use Pi's normal `read`, `write`, and `edit` tools. A whole-value `file://path/to/script.py` is expanded when used as a Jobs script, Hub write body, or sandbox filesystem text value. Use immutable filenames for scripts already submitted to remote compute.

`create_repo` defaults to private. Public creation requires exact user authorization, and writes to existing destinations are refused when the adapter cannot verify their visibility. These guards reduce accidental publication, but arbitrary executed code is not a security boundary.

On accounts without private hosted Trackio, training logs metrics locally inside the job and uploads early and final SQLite snapshots to a private dataset. During training, use job checks; afterward, download the snapshot and open the dashboard locally. The packaged `scripts/review-private-trackio.mjs` helper requires explicit repository, snapshot, and project arguments. Full instructions are in [release evidence](docs/release-evidence.md#reviewing-private-trackio-metrics).

## Headless use

```sh
ML_INTERN_FORCE=1 pi -p "Research and write a training script for my dataset"
```

Headless runs stop when user authorization or a material decision is required; they do not infer approval from the prompt. Use the explicit `/ml-intern allow` or `/ml-intern publish` command in a saved session when needed.

## Upgrading from 0.2.0

v0.3.0 removes the local paper, documentation, dataset, and Jobs wrappers in favor of the external HF MCP tools. `plan_tool` is now `update_plan`; Jobs uses `{ "operation": "uv", "args": { ... } }`; and ML mode now persists for the session. There is no legacy compatibility layer.

## Development

For a source checkout, disable the installed copy and run:

```sh
npm install
node --env-file=.env "$(command -v pi)" -e ./index.ts
```

Reproducible local checks:

```sh
npm test
npm run typecheck
npm pack --dry-run
```

See [release evidence](docs/release-evidence.md) for the tested integration, live validation, and detailed runtime contract.

## Attribution

Upstream: [Hugging Face Chat UI's ML Intern mode](https://github.com/huggingface/chat-ui/tree/1c9c9bcbd92da1c4bdcc7d4a20354191c747709e). The retired [`huggingface/ml-intern`](https://github.com/huggingface/ml-intern) is historical provenance. The [source and adaptation manifest](upstream/README.md) records the pinned source and intentional differences.

## License

Apache-2.0 — see [LICENSE](LICENSE). This package includes attributed Hugging Face Chat UI source and has no automatic telemetry or publishing.
