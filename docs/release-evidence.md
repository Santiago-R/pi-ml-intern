# Runtime contract and validation

This document describes the current implementation and its bounded validation. It does not claim complete Hugging Face Chat UI parity or certify every account or model.

## Runtime contract

### Hugging Face MCP and activation

Pi supplies the MCP transport. The extension registers the canonical Hugging Face `hf-intern` endpoint with direct tool exposure and OAuth authentication. A user or project `mcp.json` entry with the same name can provide `headers.Authorization = "Bearer ${HF_TOKEN}"`, but activation verifies that any such override still uses HTTPS, `huggingface.co/mcp`, and the `intern` bouquet. A same-named stdio or non-Hugging-Face URL is rejected before workflow calls can run.

OAuth users sign in with `/mcp login hf-intern`; Pi stores and refreshes the credential. Token users set `HF_TOKEN` in the process environment or in the trusted project's `.env`, which the extension loads at startup.

Hugging Face operations are registered as `mcp__hf_intern__<operation>`. Pi owns connection startup and retries. ML Intern validates the required tools and schemas before enabling the workflow. Saved ML-mode intent remains active while discovery completes, but workflow calls stay blocked until validation succeeds.

Mode state persists in the Pi session branch until `/ml-intern off`. New sessions start in normal mode unless invoked with `--ml-intern` or `ML_INTERN_FORCE=1`. The extension enables its workflow and required Hugging Face tools without enabling unrelated disabled tools.

### Delegates and tools

Research, sandbox, and job checks run in isolated Pi SDK loops. Their tool calls pass through the parent session's `ctx.executeTool()`, preserving the parent implementations, MCP connection, permission hooks, billing policy, and local-file expansion.

- Research: up to 60 iterations and an attributed recipe summary. Active optional `hub_repo_search`, Exa, and GitHub tools are forwarded when available.
- Sandbox: up to 30 iterations, limited to an existing sandbox's execution and filesystem tools.
- Job check: up to 8 iterations, limited to Jobs status/log operations. When the caller supplies `script_path`, its nested `read` tool is structurally restricted to that one path.
- Model requests: 120-second timeout each.
- Context handling: warning at 85%, stop at 95%, one repetition nudge after three identical calls, and one tool-free final-summary attempt.

Delegates inherit Pi's selected model, provider, reasoning level, and cancellation signal. Their restricted context is not a security boundary.

`ask_user_question` uses Pi controls interactively, requires at least one multi-select choice, and offers a typed “Other” answer. In headless mode it saves the question and stops. A later message clears the pending decision only when it selects an offered label; unrelated text leaves it pending so the model must ask again. `wait` is cancellable, lasts 15–1800 seconds, and cannot wake a closed Pi process.

### Files, destinations, and publication

The extension uses Pi's `read`, `write`, and `edit` tools. A whole-value `file://` reference expands in these positions:

- Jobs `uv` → `args.script`
- Hub filesystem write → `content`
- sandbox filesystem write → the token after `--text`

Paths resolve from the project directory; absolute paths also work. Submitted scripts should use immutable filenames.

`create_repo` defaults to `private: true`. Public creation requires authorization for the exact `hf://` URI. Because MCP metadata does not expose destination visibility, writes require a creation receipt from the current process and session branch. Restarting Pi or switching branches invalidates those receipts.

Generated training guidance uses private destinations and `hub_private_repo=True`. Arbitrary executed code can bypass prompt-level policy, so this extension is not an execution or confidentiality sandbox.

### Spending authorization and remote lifecycle

Payment and publication authority comes only from:

- `/ml-intern allow <scope>`
- `/ml-intern publish <exact hf:// URI>`
- the Pi confirmation shown by `request_authorization`

Chat text is not authorization. Successful `/ml-intern allow` and `/ml-intern publish` commands trigger a continuation so paused work resumes without another user message. A compute confirmation covers the named experiment's checks, smoke tests, retries, and main run, but it is not a hard spending cap. Provider quotas remain authoritative.

Before dispatching paid compute, the extension requires a fresh authenticated username from `hf_whoami` unless `HF_BILL_TO` is configured, and pins that namespace on Jobs and sandbox submissions. It persists the exact resource name before dispatch. Ambiguous transport or service failures remain unresolved and are never replayed automatically.

Every Job and sandbox submission receives protected session, package-build, prompt-version, and authorization labels. Names and label keys/values are normalized to the Jobs-compatible alphanumeric, underscore, and hyphen format before dispatch. Jobs `ps` is filtered to the normalized current-session label, and exact-name recovery requires the same value, so historical same-named resources cannot satisfy an unresolved submission. Label replacement is disabled in ML mode. Successful results bind structured IDs/handles or documented text fallbacks; terminal Jobs and sandbox stages include completed, cancelled, deleted, failed, errored, and terminated forms.

Closing Pi or running `/ml-intern off` does not cancel remote resources. Outstanding references remain available for warnings and later inspection. Pi performs no background monitoring while closed.

### Private Trackio monitoring

Training logs Trackio metrics locally inside the job and uploads early and final SQLite snapshots to a private dataset. `create_trackio` requires a safe project ID and a namespace returned by the latest successful `hf_whoami` call. It reserves a dataset URI rather than a hosted dashboard.

During training, inspect the job through `check_job`. Afterward, download the private snapshot and open it locally. No private hosted dashboard is promised.

## Reviewing private Trackio metrics

The packaged helper requires explicit `--repo OWNER/NAME`, `--file PATH/TO/SNAPSHOT.sqlite`, and `--project PROJECT` arguments. `--run RUN` filters metrics, and `--dashboard` opens a localhost-only dashboard without a public share URL.

Create a dedicated environment:

```sh
python3 -m venv /path/to/trackio-review-env
/path/to/trackio-review-env/bin/python -m pip install \
  'trackio==0.39.0' 'huggingface-hub==1.33.0'
```

For a standard npm installation under `~/.pi/agent`:

```sh
ML_TRACKIO_PYTHON=/path/to/trackio-review-env/bin/python node --env-file=.env \
  ~/.pi/agent/npm/node_modules/@santiago-r/pi-ml-intern/scripts/review-private-trackio.mjs \
  --repo OWNER/PRIVATE_METRICS_DATASET --file PATH/TO/SNAPSHOT.sqlite \
  --project PROJECT --run RUN --dashboard
```

Use the actual installation path if Pi uses another agent directory. In a source checkout, run `scripts/review-private-trackio.mjs`. If `HF_TOKEN` is exported, omit `--env-file=.env`; never put the token on the command line.

The helper refuses non-private datasets, suppresses Trackio's local write-token output, deletes its temporary download on exit, and closes on Ctrl-C.

## Validation

The reproducible offline suite covers:

- OAuth-ready MCP registration and token-config overrides;
- delayed discovery and schema validation;
- mode activation, exit, persistence, and tool ownership;
- privacy, publication, billing, and direct-control authorization;
- native MCP provenance, errors, structured results, and role-limited forwarding;
- billing pinning, protected session labels, submission fallbacks, and isolated exact-name reconciliation;
- scoped job-check file reads, combined-result truncation, delegate cancellation, and context limits;
- optional research and sandbox activation;
- retained upstream tool schemas, interactive/headless question behavior, prompt assembly, and file expansion; and
- persisted build, prompt, feature, session, and selected-model stamps.

`npm test` runs offline and spends no credits. Optional tests for the pinned GitHub grounding adaptation run with:

```sh
node scripts/sync-upstream.mjs /path/to/pinned/chat-ui
npm run test:upstream
```

The sync script rejects other source revisions and regenerates the retained prompt modules, builtin definitions/doctrine, license, and GitHub grounding implementation. `npm run test:upstream` covers both regenerated prompt/tool artifacts and the optional upstream GitHub tests. Current checks include TypeScript, the repository test suite, optional upstream tests, `git diff --check`, and `npm pack --dry-run`.

Native MCP transport and policy hooks are validated offline against a real stdio MCP protocol fixture. Earlier authenticated adapter-based 0.3.0 acceptance completed bounded T4 smoke/training runs, private model and Trackio snapshot readback, anonymous-access denial, resume/reconnect, and explicit cancellation. That historical service evidence does not certify the newer native transport path; authenticated native OAuth/token and paid-compute validation remain separate, explicit user-authorized checks.
