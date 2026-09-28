# pi-ml-intern

HuggingChat's ML Intern workflow adapted to Pi: research-first engineering, isolated delegates, private output defaults, and user-controlled spending.

**0.3.0 bounded release: private training and persisted Trackio monitoring; no hosted live dashboard on the tested free account.** Private Gradio Trackio creation returned HTTP 402, so the user-approved subscription-free default logs with Trackio inside Jobs and saves early/final SQLite snapshots to a **private** HF dataset for later local review. Bounded GPU training, private metrics/model readback, anonymous-access denial, a scoped real-model Pi submission, and authenticated cancellation/reconnect passed. This is not complete Chat UI parity or a claim about every account's Jobs credit eligibility.

Authoritative source: [`huggingface/chat-ui`](https://github.com/huggingface/chat-ui/tree/1c9c9bcbd92da1c4bdcc7d4a20354191c747709e), reviewed snapshot `1c9c9bc` (2026-09-26). The retired `huggingface/ml-intern` is historical provenance only. See the [source/adaptation manifest](upstream/README.md) and [release evidence](docs/release-evidence.md).

## Setup

Tested with **Pi 0.87.1 and Node 22.22.3**. Use any configured Pi model/provider; delegates inherit the selected model, reasoning level and provider authentication. No curated model list or automatic rerouting.

Install the external adapter yourself (not a bundled dependency):

```sh
pi install npm:pi-mcp-adapter@2.37.0
```

Merge this into `.pi/mcp.json` without replacing other servers:

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

Supply `HF_TOKEN` in your environment or ignored project `.env`. Optional: `GITHUB_TOKEN` enables upstream GitHub grounding, `HF_BILL_TO` selects the compute-paying organization, and `HF_BILLING_RESOURCE_GROUP` attributes newly created compute. Payer settings never change output ownership.

Install this package:

```sh
pi install npm:@santiago-r/pi-ml-intern@0.3.0
```

For source-checkout development instead, disable the installed copy and load `./index.ts`:

```sh
npm install
node --env-file=.env "$(command -v pi)" -e ./index.ts
```

If credentials are already exported, use `pi` (or `pi -e ./index.ts` for the source checkout). **With a project `.env`, start or resume Pi with Node's `--env-file` so `HF_TOKEN` exists before the eager MCP adapter connects:**

```sh
node --env-file=.env "$(command -v pi)" --continue
# Or use --resume to choose a session.
```

Do not rely on the ML extension loading `.env` later to authenticate an already-started adapter. If Pi is already running, restart it; reconnecting cannot supply a token absent from that process's environment. VS Code's `python.terminal.useEnvFile` setting is not required. Never commit credentials or paste them into chat.

On first setup, run `/mcp reconnect hf-intern` if discovery has not finished, then retry `/ml-intern`. Required direct tools must retain upstream names and schemas; a generic `mcp` proxy alone is insufficient. HF-targeting generic proxy calls are refused in ML mode because they bypass privacy, billing, file, and job-tracking hooks; unrelated MCP proxy use remains available. Missing capabilities prevent ML-mode activation, not normal Pi use. Another adapter may work if it meets this contract and exposes loadable extension paths for delegates; only the named candidate has authenticated read evidence. No automatic installation, configuration rewriting or REST fallback.

## Use

```text
/ml-intern
/ml-intern research recipes for my classification task
/ml-intern off
```

Mode stays active across follow-ups and resumes of **saved** sessions until explicit exit. Pi does not write a brand-new command-only session to disk before an assistant reply; send a prompt after `/ml-intern` if you need to resume it. New sessions are normal unless launched with `--ml-intern` or `ML_INTERN_FORCE=1`. Unrelated and optional MCP tools deliberately disabled by the user are not enabled.

Payment and publication authority comes only from a direct user control: `/ml-intern allow <experiment scope>`, `/ml-intern publish <exact hf:// repo URI>`, or the Pi confirmation dialog opened by `request_authorization`. The extension never treats quoted or affirmative chat text as authority. Headless mode stops and requests the command instead of interpreting a reply. A compute confirmation covers the named experiment's checks, smoke tests, failures, retries and real run; it is not a hard spending cap.

**Exiting mode or closing Pi does not cancel remote jobs.** Observed IDs/URLs persist; exit warns that charges may continue. Cancellation is a separate explicit action. Reopen the session and inspect current status to resume monitoring—nothing polls or wakes Pi while it is closed.

### Tools

- External HF tools: filesystem, creation, identity, metadata, nested-`args` Jobs; sandbox capabilities are optional.
- `research`: isolated literature-first lookup context; attributed recipe summary.
- `sandbox_task`: debugging inside an existing CPU sandbox; shown only when both sandbox execution and filesystem tools are enabled; no local Pi file tools, creation, submission or Hub writes.
- `check_job`: one-pass inspection; only `ps`, `inspect`, `logs`, plus local script reading. Parent owns waits/cancellation. Structured terminal observations reconcile the parent session's pending references.
- `update_plan`: session/branch-scoped full-plan updates.
- `request_authorization`: show a Pi confirmation dialog for one paid experiment scope or exact public artifact. It cannot derive authority from conversation text.
- `ask_user_question`: Pi choices; headless runs preserve the blocking question and stop instead of guessing.
- `wait`: cancellable, in-process, 15–1800 seconds per call; at most 100 waits per session branch.
- `create_trackio`: accepts only an account or organization namespace from the latest successful `hf_whoami` call and a safe project ID; reserves a private metrics **dataset URI**, not a Space. Create the private dataset before training; log with Trackio in the job, upload early/final SQLite snapshots and verify metric rows. During training, monitor through job checks. Review the persisted Trackio dashboard locally afterward.
- GitHub grounding: upstream tools, enabled only with `GITHUB_TOKEN`. Exa tools are used only if separately configured.

Delegates use Pi's SDK loop, 60/30/8 iteration limits, context warnings/stops, repetition nudges, truncation, cancellation and a 120-second timeout **per model request**, not a whole-task deadline. They return summaries, not raw logs. Role restrictions conserve context; they are not execution isolation.

### Files, privacy and costs

Use Pi's native `write`, `edit` and `read` tools. A whole-value `file://train.py` expands in Jobs `args.script`, Hub write `content`, or the token after sandbox filesystem `--text`. Paths are relative to the project (absolute paths also work). There is no web file store or `@vN` version syntax: use immutable filenames for submitted versions. Sandbox fixes stay remote until explicitly retrieved; the delegate must report their exact paths.

`create_repo` defaults to `private: true`, including duplication. Explicit public creation is reserved for user-requested publication. The current MCP metadata does not expose destination visibility, so Hub writes to pre-existing/unverified destinations are blocked with instructions to create a new private destination. Only a confirmed *new* creation records requested visibility within the current process and session branch; an existing destination stays unverified and cannot be written through `hf_fs_write`. On restart or branch switch, creation receipts are invalidated because MCP cannot verify whether visibility or credentials changed. Further writes require a new private destination; do not reuse the old one blindly. Uploading to a recorded public destination requires an exact matching artifact-scoped publication authorization. Generated code is instructed to use private destinations and `hub_private_repo=True`; arbitrary code can still publish, so this is **not a security boundary**.

New rented compute—including smoke jobs and paid sandboxes—and paid hosting/storage require a task allowance or explicit standing authorization. Cheap lookups, local compute and existing Pi inference need no additional allowance. The agent records estimates in the plan and explicit permission in session state; smoke tests, failures and retries count together. Paid Job names (`args.name`), sandbox names (`--name`) and new Space/bucket repo names must start with the recorded lowercase hyphenated experiment scope (`smoke test` → `smoke-test-check`). Use `/ml-intern allow standing` only for explicitly granted standing authorization. This naming guard is best effort, not a semantic proof of purpose or an enforced spending ledger/dollar cap: infrastructure/provider quotas own hard limits. Execution errors after dispatch may mean a submission succeeded; the attempted name is retained for inspection, not automatically retried. Authentication, initialization, disabled-server, and other known pre-dispatch failures are safe to retry after fixing their cause. Successful Jobs cancellation, sandbox termination, and terminal `inspect` observations—including those returned through `check_job`—remove matching references from continuing-charge warnings. `ps` and `logs` output never registers unrelated historical jobs as pending.

## Breaking changes from 0.2.0

Removed local paper/docs/dataset/Jobs wrappers and the old research subprocess. Use the external bouquet's tools instead. `plan_tool` becomes `update_plan`; Jobs uses `{ "operation": "uv", "args": { ... } }`, not the old flat schema. Mode is now session-persistent. No compatibility shim or alternative-service stack.

## Review persisted private Trackio metrics

The packaged review helper requires **explicit** `--repo OWNER/NAME`, `--file PATH/TO/SNAPSHOT.sqlite`, and `--project PROJECT`; it never guesses an account, repository or Python environment. `--run RUN` filters metrics and `--dashboard` opens a localhost-only dashboard (no public share URL). Use the exact private dataset URI and snapshot path reported by your training job. For a standard personal Pi npm installation (`~/.pi/agent`), run:

```sh
python3 -m venv /path/to/trackio-review-env
/path/to/trackio-review-env/bin/python -m pip install 'trackio==0.39.0' 'huggingface-hub==1.33.0'
ML_TRACKIO_PYTHON=/path/to/trackio-review-env/bin/python node --env-file=.env \
  ~/.pi/agent/npm/node_modules/@santiago-r/pi-ml-intern/scripts/review-private-trackio.mjs \
  --repo OWNER/PRIVATE_METRICS_DATASET --file PATH/TO/SNAPSHOT.sqlite \
  --project PROJECT --run RUN --dashboard
```

If your Pi agent directory differs from `~/.pi/agent`, use that installation's `scripts/` path. For a source checkout, use `scripts/review-private-trackio.mjs`. If `HF_TOKEN` is already exported, omit `--env-file=.env`; never put the token on the command line. The helper refuses non-private datasets, suppresses Trackio's local write-token output, deletes its temporary download on exit, and closes when you press Ctrl-C. Supply your own private dataset and snapshot paths; this package includes no account-specific examples. Hosting a private live dashboard is **not** part of the free-account default.

## Release evidence

```sh
npm test
npm run typecheck
npm pack --dry-run
```

`npm test` runs the repository's reproducible registered-handler and real Pi SDK delegate-loop tests with scripted inference; it never spends credits. The 118 upstream GitHub tests are **optional** and Git-ignored: in a source checkout, regenerate them from the pinned Chat UI commit with `node scripts/sync-upstream.mjs /path/to/pinned/chat-ui`, then run `npm run test:upstream`. The sync refuses other SHAs; no runtime prompt downloads.

[Release evidence](docs/release-evidence.md) records two T4-small smokes, a ten-step job, one agent-led two-step smoke at batch 8/length 128, and a separately authorized disposable cancellation run. Early/final private Trackio snapshots and a private model were read back, with anonymous reads denied. Real-model Pi research delegation, job monitoring and one explicitly scoped paid submission passed. The lifecycle run persisted a submitted job across shutdown, forced an authenticated adapter reconnect, refreshed a role-restricted `check_job` child, explicitly cancelled the job, and confirmed its terminal state. This proves **those bounded paths**, not hosted Trackio parity, every account's entitlement, transport-request abort behavior, or unconstrained agent quality. The package includes the explicit-argument review helper above; remaining deviations and scope limits are in the [manifest](upstream/README.md). Private resource IDs and billing details are not packaged.

Apache-2.0. Includes attributed Hugging Face Chat UI source and preserves the project's historical ML Intern attribution. No automatic telemetry or publishing.
