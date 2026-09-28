# 0.3.0 release contract and evidence

This document records the detailed runtime contract and bounded validation for v0.3.0. It does not claim complete Hugging Face Chat UI parity or certify every account, model, or MCP adapter.

## Tested baseline

- Hugging Face Chat UI source: [`1c9c9bcbd92da1c4bdcc7d4a20354191c747709e`](https://github.com/huggingface/chat-ui/tree/1c9c9bcbd92da1c4bdcc7d4a20354191c747709e)
- Pi: `0.87.1`
- Node.js: `22.22.3`
- MCP adapter: user-installed `pi-mcp-adapter@2.37.0`
- HF integration: direct authenticated `intern` bouquet tools
- Trackio: `0.39.0`

Other adapters and Pi models may be compatible but are not certified here. Models and providers are not restricted or silently rerouted; parent and delegate work use the model, reasoning level, and provider authentication selected in Pi.

The complete source-to-behavior mapping, implementation decisions, and intentional differences are in the [source and adaptation manifest](../upstream/README.md).

## Runtime contract

### Adapter and activation

The extension does not bundle an MCP client, install an adapter automatically, rewrite configuration, or fall back to a private REST implementation. A compatible adapter must expose the required HF operations as direct tools with the upstream names and schemas. A generic `mcp` proxy alone is insufficient; HF-targeting generic proxy calls are refused in ML mode because they bypass privacy, billing, file-expansion, and lifecycle hooks. Unrelated MCP proxy use remains available.

The tested adapter connects eagerly. `HF_TOKEN` must therefore exist in the Pi process environment before startup. Loading the extension's project `.env` after the adapter has already connected cannot repair missing adapter authentication; restart Pi with `node --env-file=.env "$(command -v pi)"` when necessary.

Capability checks run when ML mode is enabled or restored. Missing or incompatible direct tools prevent ML-mode activation and produce a setup error; normal Pi use remains available. If a tool disappears after successful activation, ML mode and its guards remain active, and the unavailable operation fails normally rather than silently dropping back to unguarded mode.

Mode state persists in the Pi session branch. Follow-up turns and saved-session resumes retain it until explicit exit. A brand-new session is normal unless started with `--ml-intern` or `ML_INTERN_FORCE=1`. Pi does not persist a new command-only session before an assistant reply, so a prompt must follow `/ml-intern` before that session can be resumed from disk.

Extension-owned tools and required HF tools are enabled for ML mode without enabling unrelated tools that the user disabled. The activation delta is process-local: exit removes tools added by the current process but does not claim ownership of tools already active at process startup. Optional sandbox tools remain optional.

### Delegates and tools

Research, sandbox, and job checks use isolated Pi SDK loops rather than a second provider implementation. Their role tool sets are restricted, but this is context conservation rather than a security boundary.

- Research: 60-iteration limit and attributed recipe summary.
- Sandbox: 30-iteration limit; only existing remote sandbox execution/filesystem tools, with no creation, submission, local Pi file tools, or Hub writes.
- Job check: 8-iteration limit; Jobs `ps`, `inspect`, and `logs`, plus local script reading. The parent owns submission, waits, and cancellation.
- Model request timeout: 120 seconds per request, not per delegated task.
- Delegates inherit Pi's model/provider and reasoning level, propagate aborts, bound returned output, and return summaries rather than raw logs.
- Context handling warns at 85%, stops at 95%, nudges after three repeated identical calls, and permits one tool-free final-summary attempt.

`ask_user_question` uses Pi controls in interactive mode. In headless mode it saves the blocking question, terminates continuation, and waits for a later user turn instead of choosing a default. `wait` is cancellable and in-process only, accepts 15–1800 seconds, and is limited to 100 calls per session branch. It cannot wake a closed Pi process.

### Files, destinations, and publication

The extension uses Pi's native `read`, `write`, and `edit` tools. It has no duplicate web file store or `@vN` version syntax. A whole-value `file://` reference expands in exactly three dispatch positions:

- Jobs `uv` → `args.script`
- Hub filesystem write → `content`
- sandbox filesystem write → the token after `--text`

Paths resolve from the project directory; absolute paths also work. Submitted scripts should use immutable filenames. Sandbox changes remain remote until explicitly retrieved.

`create_repo` defaults to `private: true`, including duplication. Explicit public creation requires artifact-scoped authorization for the exact `hf://` URI. The current MCP metadata does not expose destination visibility, so pre-existing or otherwise unverified destinations are not accepted for writes. Only a confirmed new creation records its requested visibility within the current process and session branch.

Creation receipts are discarded after process restart or branch change because credentials or visibility may have changed and the adapter cannot verify either. A later write must use a newly created private destination rather than assuming the old destination remains private. Uploading to a destination recorded as public requires exact publication authorization.

Generated training guidance uses private destinations and `hub_private_repo=True`, but arbitrary executed code can bypass prompt-level policy. The extension is not an execution or confidentiality sandbox.

### Spending authorization and remote lifecycle

Payment and publication authority comes only from a direct user control:

- `/ml-intern allow <scope>`
- `/ml-intern publish <exact hf:// URI>`
- the Pi confirmation dialog shown by `request_authorization`

Quoted, affirmative, or agent-interpreted chat text is not authority. Headless mode requires the explicit command. A compute confirmation covers the named experiment's checks, smoke tests, failures, retries, and main run. It is not a hard spending cap or settlement ledger; infrastructure and provider quotas enforce hard limits.

Cheap lookups, local compute, and existing Pi inference require no additional allowance. New rented compute, paid sandboxes, and paid hosting/storage do. Job names (`args.name`), sandbox names (`--name`), and new Space/bucket names must begin with the lowercase hyphenated experiment scope (`smoke test` becomes `smoke-test-…`). An explicitly authorized `standing` scope is exempt. This name check is best-effort scoping, not semantic proof of purpose.

For `hf_jobs run`, `hf_jobs uv`, and `hf_sandbox create`, a structured attempt containing the exact resource name is persisted after local validation and file expansion but before adapter dispatch. Known authentication, initialization, disabled-server, approval, and other pre-dispatch failures remove the attempt and may be retried after correction. A lost process or ambiguous result leaves the attempt unresolved and is never automatically replayed.

Successful results bind returned IDs or handles. An exact-name Jobs `ps` or `inspect` observation can bind an unresolved attempt without registering unrelated historical jobs. Sandbox handles can likewise reconcile an exact pending sandbox name. Successful cancellation, sandbox termination, and terminal inspections mark matching references finished. Logs and unrelated `ps` history never create pending references.

Closing Pi or running `/ml-intern off` does not cancel remote resources. Outstanding IDs, handles, and unresolved attempts are retained for warnings and later inspection. No daemon polls or wakes the session while Pi is closed.

### Private Trackio monitoring

Creating a private hosted Trackio Gradio Space on the tested non-PRO account returned HTTP 402. Static Trackio does not support private mode. No Space or bucket was created during that failed path.

The approved subscription-free default is:

1. reserve and create a new private metrics dataset;
2. set `TRACKIO_DIR` before importing Trackio in the training job;
3. log locally inside the job;
4. use SQLite backup to upload an early and final database snapshot;
5. inspect Jobs while training runs; and
6. download the private snapshot and open a localhost-only dashboard afterward.

`create_trackio` accepts only a safe project ID and an account or organization namespace returned by the latest successful `hf_whoami` call. It reserves a dataset URI, not a hosted Space. A process restart invalidates the cached identity and requires another `hf_whoami` call.

No private live dashboard is promised without a subscription. HF Jobs also require a positive credit balance.

## Reviewing private Trackio metrics

The packaged helper requires explicit `--repo OWNER/NAME`, `--file PATH/TO/SNAPSHOT.sqlite`, and `--project PROJECT`. It never guesses an account, repository, snapshot, or Python environment. `--run RUN` filters metrics, and `--dashboard` opens a localhost-only dashboard with no public share URL.

Create a dedicated environment:

```sh
python3 -m venv /path/to/trackio-review-env
/path/to/trackio-review-env/bin/python -m pip install \
  'trackio==0.39.0' 'huggingface-hub==1.33.0'
```

For a standard personal Pi npm installation under `~/.pi/agent`:

```sh
ML_TRACKIO_PYTHON=/path/to/trackio-review-env/bin/python node --env-file=.env \
  ~/.pi/agent/npm/node_modules/@santiago-r/pi-ml-intern/scripts/review-private-trackio.mjs \
  --repo OWNER/PRIVATE_METRICS_DATASET --file PATH/TO/SNAPSHOT.sqlite \
  --project PROJECT --run RUN --dashboard
```

Use the actual installation path if the Pi agent directory differs. In a source checkout, run `scripts/review-private-trackio.mjs`. If `HF_TOKEN` is already exported, omit `--env-file=.env`; never place the token on the command line.

The helper refuses non-private datasets, suppresses Trackio's local write-token output, removes its temporary download on exit, and closes on Ctrl-C. The package contains no account-specific repository or snapshot examples.

## Validation evidence

### Offline and package validation

Initial 0.3.0 validation passed 30 repository tests plus 118 optional tests regenerated from the pinned upstream GitHub source. Pre-publication review added ten offline regressions, bringing the reproducible repository suite to **40 passing tests**. Coverage includes:

- registered extension handlers and real Pi SDK delegate loops;
- mode activation, exit, persistence, and process-local tool ownership;
- capability-loss guard retention;
- privacy, publication, billing, and direct-control authorization;
- adapter-error and crash-gap submission recovery;
- exact-name job and sandbox reconciliation;
- structured child lifecycle and cancellation/termination handling;
- optional sandbox activation and token grammar;
- expired destination creation receipts;
- prompt fidelity, context limits, cancellation, and file expansion.

A fresh checkout's `npm test` runs only reproducible repository tests and spends no credits. The 118 upstream GitHub tests are optional and Git-ignored: regenerate them from the exact pinned Chat UI SHA with:

```sh
node scripts/sync-upstream.mjs /path/to/pinned/chat-ui
npm run test:upstream
```

The sync script rejects other source SHAs. Runtime prompts are never downloaded.

TypeScript, staged/unstaged diff checks, npm audit, and `npm pack --dry-run` passed. The final tarball was installed into an isolated npm prefix: Pi advertised `--ml-intern`, restored disk-backed mode after a model reply, and executed the packaged metrics helper with explicit arguments. The tarball scan found no credentials, session files, private resource identifiers, billing amounts, or disposable training scripts.

### Live training and private artifacts

On a non-PRO personal HF account with Jobs credits, the following explicitly authorized work completed using a small public model and dataset:

- two two-step GPU smoke jobs;
- one ten-step training job; and
- one two-step real-model Pi-agent submission.

Early and final Trackio SQLite snapshots persisted in a private dataset and contained loss rows. Authenticated readback succeeded; unauthenticated requests to the metrics and model artifacts returned HTTP 401. The trained private model reloaded for inference. A downloaded snapshot opened in a localhost-only Trackio dashboard with sharing disabled. All verification jobs were confirmed terminal.

These were bounded task-scoped tests. They are not run by installation or the unit suite and do not establish arbitrary model quality, unrestricted agent reliability, or every account's Jobs eligibility.

### Shutdown, reconnect, and cancellation

A separate authorized lifecycle test used deterministic, zero-cost scripted inference and `pi-mcp-adapter@2.37.0` to create one disposable T4-small sleep job with a ten-minute timeout. Pi retained its reference while the first session shut down without implicit cancellation.

A reopened saved session forced `/mcp reconnect hf-intern`, restored ML mode and tools, and ran a role-restricted `check_job` child against the live job. The parent explicitly cancelled it, and a second isolated check confirmed terminal cancellation.

A malformed pre-dispatch attempt was rejected during adapter argument serialization. A fresh `ps` confirmed that its unique name created no resource before the successful run. Resource IDs, account details, and billing notes remain only in the ignored local verification record. The timeout bounded worst-case T4 runtime below the separately authorized allowance; exact provider settlement is not claimed.
