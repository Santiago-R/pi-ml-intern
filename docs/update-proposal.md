# Update proposal: closely reproduce HuggingChat's ML Intern in Pi

**Status:** direction approved after design review; documentation only. Runtime migration and private defaults are not implemented yet.  
**Local baseline:** `df729fa`, version `0.2.0`.  
**Authoritative upstream:** [huggingface/chat-ui](https://github.com/huggingface/chat-ui), ML Intern / ML Assistant mode.  
**Verified upstream HEAD:** `80f4edaea2cc79ff743c09f766685cd53fa8cd53`, 2026-09-23, “Pin GitHub Actions to commit SHAs (#2605).”

## 1. Decision and precedence

Closely reproduce the newest reviewed Chat UI ML Intern workflow, prompts, tool contracts, and delegation behavior. **Trust upstream's prompt testing: do not shorten, soften, deduplicate, or replace its rules merely because a newer model might need less guidance.** The primary intentional product difference is **private artifacts by default**. Pi-specific adaptations must be narrowly scoped, explicit, and justified.

This document supersedes the earlier proposal based on the retired `huggingface/ml-intern` repository. That repository remains historical provenance only (last reviewed commit `3555becf822ab9b71be9678b2332f542a9fde0b5`). In particular, the earlier recommendations to shorten repeated instructions, retain the old tool surface by default, rebuild Semantic Scholar research, and defer Hub filesystem tools are withdrawn.

Source precedence:

1. Explicit user requirements: private defaults, Pi as the harness, simple implementation, infrastructure-owned execution security.
2. The reviewed Chat UI commit's assembled mode prompts, tools, and tests—not just its main prompt file.
3. Live Hub MCP schemas and maintained API documentation for external service contracts.
4. The deviation register below, for named adaptations; unresolved differences are not permission to improvise.

Upstream describes trace-driven refinements, and its tests protect them. We preserve this work without claiming its performance automatically transfers to every Pi model/provider. HF remains the default ecosystem. Provider-neutral changes are a later discussion, not part of this fidelity update.

### Approved operating decisions

- Preserve substantive upstream workflow even when it requires more implementation. Simplify the implementation underneath it, not the tested behavior.
- Require a separately installed/configured MCP adapter and the HF service for the full workflow. No bundled/forked MCP client, automatic installation, or alternative service fallback.
- `/ml-intern` enters session-persistent mode until explicit exit. Resuming that session restores its mode; a new session starts normally unless explicitly launched in ML mode.
- Model/provider selection is completely unrestricted and inherited by delegates. No curated recommendation list, hard model restriction, or silent model switch.
- Require task-level allowance or explicit standing authorization for new rented compute and paid hosting/storage. Ordinary cheap lookups, local compute, and existing Pi parent/delegate inference do not need additional authorization. Accounting is best-effort, not enforcement.
- Exit and process shutdown do not cancel remote jobs. Preserve references, warn about continued charges, and require explicit cancellation. No background monitoring daemon.
- Make breaking changes without legacy compatibility shims. Follow the reference workflow rather than retaining old features by inertia.
- Require a small, explicitly funded live end-to-end validation before claiming reliable training support. Other capabilities may ship with clearly documented training limitations.

## 2. Source map and update procedure

All paths below are relative to [the pinned Chat UI tree](https://github.com/huggingface/chat-ui/tree/80f4edaea2cc79ff743c09f766685cd53fa8cd53). This review inspected the main prompt and its tests, mode configuration, builtin registry, research/delegation prompts, and relevant tool/runtime code. No authenticated MCP session or live compute/privacy validation was performed.

| Source | What must be carried over or compared |
| --- | --- |
| `src/lib/server/mlAssistantPrompt.ts` | Ordered main sections, tool-keyed doctrine, session identity/payer context, conditional budget rules. |
| `src/lib/server/mlAssistantPrompt.spec.ts` | Tested named failures, intentional repetition, smoke-test shape, pinned dependencies, monitoring, pricing, tool gating, and prompt composition. |
| `src/lib/server/mlAssistant.ts` | Mode selection, Hub `intern` bouquet, authentication configuration, payer versus output namespace. |
| `src/lib/server/textGeneration/utils/toolPrompt.ts` | Assembly of mode doctrine with each builtin's guidance; compare during implementation, not just the exported preprompt. |
| `src/lib/server/textGeneration/builtinTools/index.ts` | Enabled tools: questions, plan, wait, GitHub grounding, research, sandbox delegation, job checks, Trackio reservation. |
| `.../builtinTools/researchPrompt.ts`, `researchTool.ts` | Literature-first delegation, bibliography/search-based successor discovery, available-tool-conditioned instructions, recipe summaries. |
| `.../builtinTools/sandboxPrompt.ts`, `sandboxTool.ts` | CPU-only debugging delegate, exact file/command/name summary, parent-owned creation and submission. |
| `.../builtinTools/jobCheckPrompt.ts`, `jobCheckTool.ts`, `readOnlyJobsGuard.ts` | Read-only one-pass job inspection; parent waits, submits, and cancels. |
| `.../builtinTools/nestedAgent.ts` | Shared isolated contexts, inherited model settings, output limits, repetition/context/iteration stops. |
| `.../builtinTools/createTrackioTool.ts`, `src/lib/server/trackioSpace.ts` | Reserve an exact dashboard ID; Trackio's own deployment creates the Space during init. |
| `.../builtinTools/askUserQuestion.ts`, `planTool.ts`, `waitTool.ts`, `githubGrounding.ts` and adjacent tests | User decisions, planning, waits/resumption, GitHub tool availability and behavior. |
| `src/lib/server/mlAssistantModels.ts` | Upstream's tested model/provider restrictions; changing these is a deviation. |
| `src/lib/server/mcp/`, `src/lib/server/textGeneration/artifacts.ts` | Service schema/auth/billing integration and web artifact behavior; inspect applicable paths before implementation. |

The mode uses `https://huggingface.co/mcp?login&bouquet=intern`. The bouquet includes filesystem read/write, sandboxes, jobs, repo details, creation, and identity tools. **These remote schemas can change without a Chat UI commit.** Capture the authenticated tool list/schema fixture and retrieval date used for each release. The public Chat UI source is not a complete local implementation of every hosted dependency.

For each update:

1. Fetch current Chat UI `main`; record the exact SHA/date and review changes since the previous baseline, including relevant tests. Recheck HEAD before implementing this proposal.
2. Keep an attributed, verbatim upstream prompt snapshot plus a small, reviewable adaptation patch/manifest. Do not fetch prompts dynamically at runtime.
3. Import/adapt upstream tests where practical. Snapshot the **assembled** Pi mode prompt, including builtin doctrine and session context; every semantic diff must cite a deviation ID.
4. Record source path/symbol, old and new text/behavior, rationale, status, and verification for each difference. Pure import/type changes can be grouped as mechanical porting, but no behavioral change can hide in that group.
5. Refresh service schema fixtures deliberately and record tested adapter versions/configurations. Prompts stay pinned per release, while tool discovery uses the live service schema. If a schema contradicts a prompt example, report the incompatibility and reconcile it in a reviewed update; do not silently rewrite prompts, teach two incompatible contracts, or switch providers.
6. Preserve Apache-2.0 attribution and any applicable notices when copying source or tests.

## 3. Fidelity target

### Prompt behavior: preserve, not redesign

Keep the ordered identity, knowledge-freshness, paper-reproduction, named-failure, pre-run, data-audit, runnable-code, job-submission, artifact-versus-payload, recovery, and finishing sections. Preserve their strength and deliberate repetition, including:

- Research-shaped work starts with `research`; single already-named facts may be checked directly. Keep the sub-agent's literature-first recipe table and attribution requirements.
- Read papers through `hf_fs` under `hf://papers`, including paged methodology, appendices, and bibliography. Successor discovery is search-based, **not an exhaustive citation graph**.
- Ground actionable IDs, data schemas, APIs, and config arguments. Keep explicit dataset inspection and no silent substitution.
- Resolve current dependency versions and pin the actual compatible set. Do not copy the retired prompt's unpinned-latest advice.
- Print the preflight, name jobs, pass tokens as secrets, specify hardware and timeout, persist outputs, and include metrics. Submission is not completion.
- Separate cheap script checks from a GPU smoke job on the **same flavor, batch size, and sequence length** as the real run. Shrink steps, not shapes. Measure throughput and memory before sizing real compute.
- Use current pricing, optimize cost-to-finish, and retain upstream's user choice over consequential speed/cost trade-offs. Preserve the queue-risk guidance and its caveat rather than rewriting it as guaranteed live statistics.
- Reserve Trackio before training, use the exact returned ID, verify metrics actually land, check early for startup failures, then lengthen waits.
- Preserve the OOM recovery ladder and user ownership of scope changes.
- Keep artifact-versus-payload intent: a request for a script does not authorize executing it.

Do not introduce a blanket “never ask questions” rule in the name of YOLO. Upstream's scientific, scope, and cost preference questions are useful workflow decisions, not security approval paranoia.

### Tools and delegation

Use a **user-installed MCP adapter** to access the same Hub MCP bouquet, keeping model-visible names, argument shapes, descriptions, and returned semantics. Pi does not ship MCP support; installation and configuration of a compatible adapter are explicit prerequisites, not dependencies bundled into pi-ml-intern. Do not build/fork a client, auto-install one, or bypass it with a second transport.

MCP standardizes discovery, schemas, calls and results; adapters can differ in Pi-facing names, direct versus proxy exposure, result wrapping, loading lifecycle and delegate integration. Research popular adapters first (P0 below). Document one tested adapter/version/configuration using direct tools and upstream names; accept alternatives that meet the same capability contract without claiming universal compatibility. Validate required tools before activating ML mode; report missing setup clearly while leaving ordinary Pi available. Optional tools remain conditional as upstream intends.

Provide copyable configuration and diagnostics, but never silently rewrite global/project adapter settings. Small hooks for mode activation, privacy defaults and delegate tool selection are allowed; prefer supported interfaces over adapter internals. Authentication stays with the user's adapter setup; no Chat UI browser OAuth stack here. A failed required HF capability is a visible blocker, not a trigger for a parallel REST/offline stack.

Most importantly, the current local `hf_jobs` flat schema is not the target. Upstream uses `{"operation":"uv","args":{"script":"...","with_deps":[...],"flavor":"...","timeout":"..."}}`; Docker uses `run` with `image` and `command`. Reads also take an `args` object. Preserve that distinction and the sandbox tools' different token-array grammar.

Port/adapt `research`, `sandbox_task`, `check_job`, `create_trackio`, `update_plan`, `wait`, `ask_user_question`, and GitHub grounding. Keep upstream's available-tool gating, including optional Exa capabilities and token-dependent GitHub tools. Supply `hf_whoami` and real session context, including `User=unknown` on failed resolution; never fabricate identity, payer, or budget.

Research should not receive the current unrestricted Pi shell/write/job tool set. Match upstream's lookup subset. Sandbox delegation receives existing-handle execution/filesystem tools, not creation or submission. `check_job` permits only `ps`, `inspect`, and `logs`, and cannot wait. Tool scoping preserves roles and context economy; it is not claimed to sandbox arbitrary execution.

Initial nested-agent target: upstream's 60 research / 30 sandbox / 8 job-check iteration limits, 85% context warning / 95% stop thresholds, repetition nudges, summary formats, and per-role output truncation. Upstream inherits the parent model/provider settings. Its 120-second nested model-call timeout is **not** equivalent to the current local three-minute deadline for the entire research task. Any necessary Pi-runtime limit adaptation goes through D04.

### Spending authorization and session lifecycle (D02, D03, D05, D06)

Classify spending by operation rather than inventing a universal dollar threshold:

- **No extra allowance:** local compute, normal Pi parent/delegate model inference under the user's provider arrangement, and ordinary cheap search/lookup calls. An unusually large paid batch still warrants a question.
- **Explicit allowance or standing authorization:** remote training, all newly rented compute (including GPU smoke jobs and paid CPU sandboxes), and newly provisioned paid hosting/storage. Stating a preflight and immediately continuing is not consent.
- An allowance covers the whole experiment: checks, smoke tests, failed attempts, retries and the real run. Do not reset it after failure or silently reuse it for a new experiment. Session-wide authority is valid only when explicitly granted.
- Keep estimates and observed charges when available in the plan/session, together with allowance scope and pending resource IDs. Ask before exceeding the allowance, undertaking unpriced expensive work, or proceeding when remaining authorization is uncertain. No reservation/settlement ledger or hard-cap claim; provider quotas and infrastructure enforce actual limits.
- Preserve upstream questions about material scientific/scope/cost choices. Interactive mode asks normally. Headless mode honors explicit task defaults; otherwise stop cleanly with the blocking question, state and resumption instructions rather than wait forever or guess.
- Persist ML mode and job references in the Pi session. New sessions start normal unless launched in ML mode; resumed sessions retain explicit entry/exit state. Keep mode active through user follow-ups and internal continuations, not just one task.
- Explicit mode exit restores normal Pi behavior without cancelling remote work. Warn with outstanding IDs/URLs that charges continue; cancellation is separate. On orderly shutdown provide the same information. Persist references early enough to survive abrupt process loss, where no final warning can be guaranteed.
- Use cancellable in-process waits. After a user reopens the session, inspect pending jobs anew; do not pretend a wait or monitoring loop ran while Pi was closed. No autonomous wakeup, scheduler or background daemon.

## 4. Private artifact policy (D01)

Private defaults cover models/checkpoints, datasets, source/script repos, Spaces/demos, Trackio dashboards and backing storage, reports/plots/evaluation outputs, collections, and any uploaded logs/traces. Local artifacts remain local unless the task requires upload. No new automatic telemetry or session uploader.

- Explicitly request private creation through supported service arguments. Generated training code uses private Hub destinations and `hub_private_repo=True` where applicable; dataset, Space, bucket, and collection creation must also set their own visibility. Do not assume one model flag protects everything.
- Use the existing upstream `create_repo`/filesystem capabilities rather than inventing a parallel artifact management suite. Inspect an existing destination before writing. `exist_ok=True` does not turn a public repo private.
- If a destination is public without explicit publication intent, stop that upload and suggest a new private destination. Do not silently change existing visibility. Public input data does not authorize public outputs.
- Publication is an explicit user-requested, artifact-scoped exception. A clear request needs no redundant confirmation loop.
- Keep `create_trackio`'s reservation and exact-ID behavior. Do **not** resurrect the earlier proposal to hand-build a generic dashboard Space: upstream documents failed writes from incompatible manual provisioning. Validate a supported private deployment path with the pinned Trackio version, including private backing storage and authenticated writes/reads. Request private creation from the outset, not after uploading public data.
- If private monitoring cannot work, stop before training and offer private persisted metrics as an explicitly accepted alternative. Do not silently remove monitoring, publish metrics, or claim success from `init()` alone. This user-approved task deviation is not an automatic service fallback. Other capabilities may ship while this training limitation is documented; do not claim default training parity until private Trackio works and is validated.
- Report IDs/URLs and observed visibility. Do not invent a job-level `private` flag; job access is distinct from output visibility. No public service/port exposure by default.

Privacy modifies the relevant main prompt, tool doctrine, creation defaults, and generated examples together. It is a product guarantee for extension-owned paths and guidance, not proof that arbitrary agent-written code cannot publish. Infrastructure owns stronger enforcement.

## 5. Deviation register

**Required** entries implement explicit user requirements. **Approved** entries were agreed during design review; they authorize the stated adaptation, not arbitrary further divergence. **Deferred** entries are not part of this update. Every additional deviation needs its own reviewed entry before implementation; unresolved behavior blocks claiming equivalence.

| ID / status | Upstream behavior | Agreed difference and justification | Verification / cost |
| --- | --- | --- | --- |
| **D01 — Required: private artifacts** | Prompt examples and Trackio reservation do not establish universal private output creation. | Apply §4 across prompts and creation paths. Explicit publication remains possible. User requirement overrides upstream defaults. | Test omitted/explicit visibility, existing-public destinations, private Trackio and backing storage. Live authenticated inspection plus anonymous denial; possible hosting capability blocker. |
| **D02 — Approved: Pi harness and persistent mode** | Chat UI mode persists per conversation and replaces its per-model custom prompt. | Keep Pi's harness instructions and add the mode prompt without contradictory workflow instructions. `/ml-intern` enables the current session until explicit exit; restore that state on resume, but not in unrelated new sessions. Support explicit force/flag entry. | Test follow-ups, continuations, exit, resume and new-session isolation. Preserve unrelated active/disabled tools. Exiting mode does not cancel jobs. |
| **D03 — Approved: simple spending authorization** | Hosted mode enforces a compute grant, reservation/settlement ledger and question-driven budget raises. | Replace enforced-budget doctrine with the operation-based allowance policy in §3. Require permission for new rented compute/paid hosting, not ordinary cheap calls, local compute or existing Pi inference. Track estimates in session state; no ledger or `setBudgetUsd` UI. | Significant deviation justified by the requested scope. Smoke tests/failures/retries count toward the allowance; ask when insufficient or uncertain. Test that no hard-cap/enforced-budget claim is made. |
| **D04 — Approved: Pi nested runtime** | Shared Chat UI nested model/tool loop with role limits, inherited settings, and summary-only parent results. | Use Pi execution/session facilities for isolated delegates instead of porting a second provider loop. Preserve prompts, role tool sets, settings, stop conditions, and summaries. Remove the fixed three-minute whole-task deadline. | Demonstrate iteration/context/cancellation behavior in the chosen Pi interface. If a limit cannot be reproduced, review and document the exact replacement before shipping; do not claim parity. |
| **D05 — Approved: questions and artifacts UI** | Structured question widgets and browser-rendered artifacts. | Retain question semantics using Pi UI. Headless runs use explicit task defaults or stop with the blocking question, state and resumption instructions. Map deliverable artifacts to local files or explicitly requested private hosted outputs, preserving no-execution intent. | No silent material guesses or indefinite headless input waits; script-only requests launch no job. No fabricated browser widgets/links. |
| **D06 — Approved: waits and remote-job lifecycle** | `wait` parks/persists the turn and resumes through hosted scheduling. | Keep the contract, bounds and parent-owned waits using cancellable in-process waits. Preserve job references for user-resumed inspection; no background scheduler. Exit/shutdown leaves remote work running unless explicitly cancelled. | No automatic wake after process exit. Test reference persistence, exit warnings, cancellation and fresh status checks on resume; never claim closed-Pi monitoring continued. |
| **D07 — Approved: unrestricted model/provider selection** | Mode restricts models to configured, provider-pinned entries tested for long tool loops. | Use any model/provider the user selects in Pi, inherited by delegates. No curated recommendation list, restrictions or silent rerouting. | This does not preserve upstream's tested performance envelope. Record the model/provider used for validation without turning that record into a supported-model gate. |
| **D08 — Approved: external MCP adapter and local presentation** | Chat UI owns its MCP integration, web login, billing settings, hosted dashboards and permission-scoped Hub access. | Users install/configure a compatible Pi MCP adapter. Require upstream-shaped direct tools, not a particular adapter brand; provide diagnostics and copyable configuration, not silent config rewrites. Use explicit payer/resource-group settings and Hub URLs. | Compare popular adapters first. Validate auth, parent/delegate I/O and lifecycle. No embedded/forked client or bypass transport. Preserve User versus BillTo; adapt permission-scope claims to actual credentials, retain create-before-write/concurrency checks. |
| **D09 — Approved: clean tool migration** | Current authority uses `hf_fs`, `hub_repo_details`, `update_plan`, and MCP Jobs rather than this repo's old 12-tool surface. | Replace obsolete paper/docs/dataset/Jobs wrappers and schemas outright; no compatibility shims or fallback stack. Preserve the `/ml-intern` entry point. | Breaking migration note and schema fixtures. No conflicting `hf_jobs` tool or legacy Semantic Scholar citation-graph doctrine in the default research prompt. |
| **D10 — Approved: simple integration error handling** | Chat UI has service/client-pool/schema-repair and hosted recovery plumbing. | Let the external adapter own MCP transport. Use supported hooks for basic validation, short errors and cancellation. Avoid stacked retry loops; at most two transient-read retries in the tested path. Never auto-replay an ambiguous billable submission. | Verify actual adapter behavior and error/result mapping. No cooldown registry, generalized recovery system or alternative service fallback. More polished hosted recovery is intentionally not reproduced. |
| **D11 — Deferred: reduce HF bias** | HF-first discovery, storage, jobs, sandbox and monitoring, with optional external search/GitHub. | No default change now. Later evaluate opt-in local/other-cloud compute, storage, and monitoring, retaining the same research/validation/persistence criteria. | Needs a separate source-to-behavior mapping, privacy contract and comparison tasks. Do not build provider abstractions speculatively. |

Remote `hf_sandbox` is **not excluded** by infrastructure-owned security. Reuse it as upstream's optional compute service; do not build a sandbox manager here. Preserve its CPU limitations and upstream's one-failure fallback to a small HF job. A future preference for local Pi execution instead of this path would be another deviation, not a free simplification.

## 6. Implementation plan

### P0 — Research and validate external MCP adapters

Before implementing adapter-dependent hooks, compare the most popular/actively used Pi MCP adapters. Determine candidates from current usage signals (npm downloads, repository adoption and maintenance), recording dates and versions rather than assuming forks are independent popular implementations. Preliminary documentation review found `pi-mcp-adapter` supports direct tools and configurable prefixes; authenticated HF compatibility has not been tested.

Produce a short compatibility matrix and answer whether the required I/O contract works across all or most candidates:

- **Inputs:** original tool names or configurable prefixes; direct tools versus a generic proxy; preservation of nested objects, arrays and arbitrary `args` maps; no schema reshaping that contradicts upstream examples.
- **Outputs:** text/structured content, images, error signaling, truncation/continuation and cancellation. Verify meaningful results are not flattened into success or discarded by output guards.
- **Lifecycle:** initial discovery, refresh, mode entry/exit, preserving unrelated tools, session resume, and availability/authentication in isolated delegates.
- **Integration:** supported hooks for private defaults, role/operation selection and schema inspection; retry behavior for reads versus billable side effects. Avoid private adapter internals and extra transports.
- **HF connection:** real authenticated discovery of the `intern` bouquet and representative non-billable calls, followed by the separately authorized live acceptance run. A matching config example alone is not evidence of compatibility.

Document one tested adapter/version and copyable user configuration, plus the generic capability contract and known differences. Accept other adapters meeting that contract without package-name checks. Do not build a multi-adapter abstraction speculatively: if a concrete blocker prevents the agreed contract, report it for a design decision rather than quietly embedding a client. Missing prerequisites prevent ML-mode activation, not ordinary Pi use. Optional upstream tools remain optional.

### P0 — Source-backed prompts and service contracts

- Add upstream snapshots/provenance and a reviewable adaptation layer for D01–D08. Preserve all non-adapted prompt sections and intentional repeated rules; no general prompt cleanup pass.
- Assemble mode, tool-keyed, builtin and sub-agent doctrine based on the actual offered capabilities. Keep the session context at the intended final position.
- Establish authenticated MCP discovery and the `intern` bouquet before teaching its tools. Check current returned schemas against source examples. If token access fails, return a precise setup error, not invented capabilities.
- Migrate to the upstream-shaped Jobs interface, filesystem, repository creation/identity and metadata tools. Implement private defaults in tool paths **and** job-generated uploads, not a prompt-only promise.
- Validate private Trackio deployment early. If unavailable, implement the explicit private-metrics alternative decision in §4 and document the limitation; other capabilities need not be withheld, but default training parity cannot be claimed.

### P0 — Pi integration correctness

- Fix `index.ts` tool selection: it currently enables all registered tools, including unrelated deliberately disabled tools. Change only extension-owned membership and preserve the rest.
- Wire the registered `--ml-intern` flag into activation; test the imported extension and actual registered handlers rather than duplicate logic.
- Use supported Pi declarations. The installed `getActiveTools()` returns `string[]`; do not preserve the undocumented null-name-object workaround as a contract.
- Replace runtime `require()` with normal Node imports. Missing `.env` is ordinary; report real loading failures briefly, and retain exported-environment precedence.
- Replace inaccurate ambient type shadows with supported development types where practical. Use the supported Pi tool-error contract: `details.isError` alone is not a dependable execution failure marker.
- Replace one-shot activation with persisted session mode and explicit exit. Preserve it through follow-ups, internal continuations and delegate completion; restore on resume and keep unrelated new sessions normal. Declare/test a supported Pi version.
- Persist spending authorization scope, estimates and pending job references in the plan/session. Implement explicit exit and orderly-shutdown warnings without cancelling remote jobs; resume by inspecting current status. Do not add a scheduler or budget ledger.

### P1 — Builtins and isolated work

- Port/adapt all mode builtins listed in §3, not only `research`. `check_job`, `sandbox_task` and `create_trackio` are core fidelity work.
- Scope plan state to the Pi session/branch as appropriate; reproduce the upstream plan schema and normalization behavior instead of retaining a module-global `plan_tool` by inertia.
- Implement role-limited delegates with inherited settings, contextual prompts and summary contracts. Propagate aborts, bound output, clean temporary resources in `finally`, and return real failure on nonzero exit even with partial output.
- Add Pi question/artifact/wait behavior with D05/D06 limitations visible. No new web UI, ledger, telemetry, or session service.
- Port current GitHub behavior and optional web-tool gating; do not assume anonymous tools or a configured Exa server exist.

### P1 — Remove redundant wrappers, keep honest errors

Delete wrappers superseded by MCP rather than maintaining duplicate stacks. The earlier review found concrete reasons not to preserve the old implementation:

- Local Jobs uses wrong namespace paths/payload keys for the reviewed REST API, a flat scheduled payload, JSON-array log assumptions, and unchecked DELETE success; it also treats local paths as remote paths and retries uncertain submissions.
- Dataset inspection assumes `dataset_info.configs[]`, silently substitutes an unknown config, and can label metadata-only fallback as successful inspection.
- Papers flatten nested citation entries, substitute abstract search for snippets, and parse sections unreliably. Docs search ignores `tag` and blindly rewrites URLs.

Do not spend the fidelity update rebuilding those legacy behaviors. Ship a clean, documented breaking migration with no compatibility shim or fallback stack. Report missing, partial and failed service results honestly; do not silently route them through another provider.

## 7. Validation and release criteria

Initial local review baseline (not a claim about future migration): `npm test` passed **52 tests in 2 files**; `npx tsc --noEmit` failed on local declarations for `registerFlag` and `Type.Unsafe`. Activation tests duplicate production logic, so they are insufficient evidence of runtime correctness. The old review and session reports have been removed; useful regression scenarios are preserved in [legacy-failure-lessons.md](./legacy-failure-lessons.md), explicitly labeled as obsolete-version observations rather than verified current diagnoses.

Required validation:

1. **Prompt fidelity:** source snapshot + narrowly scoped patch; preserve headings, named failures, repeated persistence instructions, current-version pinning, same-shape GPU smoke checks, early monitoring and role delegation. Compare upstream tests and assembled prompts, including absent-tool cases. Every intentional mismatch cites D01–D11 or a newly reviewed entry.
2. **Tool contracts:** authenticated schema fixture, upstream-shaped `uv`/`run`/read calls, correct secrets/payer handling, no unrequested namespace switch, actual job IDs/URLs, cancellation and clear error outcomes. No ambiguous submission auto-retry.
3. **Delegation:** research recipes and attribution; sandbox summary with paths/commands; read-only job reports and parent-only waits. Test settings inheritance, stops, missing tools and partial-output failure.
4. **Privacy:** explicit private model/dataset/Space/bucket/collection destinations as applicable, existing-public rejection, explicit-public exception, and real Trackio writes to private storage. Check service visibility and anonymous access; init success alone is not enough.
5. **Pi lifecycle and authorization:** import/register real handlers; verify command/flag/force entry, persistent follow-ups, explicit exit, session resume, unrelated-new-session isolation, questions and headless blocking, waits and cancellation. Check allowance scope includes smoke tests/failures/retries, cheap calls need no extra approval, and pending job IDs survive exit/restart without automatic cancellation. Preserve unrelated tools and session-scoped plans.
6. **Required live acceptance before claiming reliable training:** in disposable infrastructure with explicit credentials and compute allowance, research a recipe, inspect data, perform cheap checks and a tiny same-shape GPU smoke run, monitor through `check_job`, persist private outputs, verify results/visibility and clean up compute. Record the adapter/configuration, model/provider and service schemas used. Mock tests alone do not establish authenticated training or private Trackio support. Unit tests stay free/offline; never launch billable tests automatically. Until the live path passes, label training experimental/unverified; a user-accepted alternative does not establish default Trackio parity.
7. **Release:** tests/type-checking pass; docs state the supported Pi version, user-installed adapter capability contract, service prerequisites, unrestricted model policy and deviations; `npm pack --dry-run` contains no credentials, sessions or review artifacts. No automatic publishing.

Before claiming “closely reproduces,” complete a source-to-local parity checklist covering prompts, schemas, delegation, limits, identity/payer, questions, monitoring and artifacts. A missing core capability is a documented blocker, not parity because the prompt mentions it.

## 8. Documentation and future direction

README and design docs now identify Chat UI as the authoritative target and the retired repo as historical provenance. Their description of the current v0.2.0 runtime must remain distinct from planned features; do not claim MCP/private defaults already work. When implementing, replace obsolete architecture claims and publish a migration note for removed/renamed tools and parameter changes.

Every release records the Chat UI SHA, service-schema retrieval date, tested external adapter versions/configurations, prompt adaptations, and explicit deviation list. Preserve attribution to both upstream generations. Keep the package allowlist and warnings about billable compute, ephemeral disks, local arbitrary execution, and infrastructure isolation.

**Future discussion, not this update:** HF is a strong default for open-source ML. Less ecosystem bias could mean accepting a user's existing storage/compute stack without changing the scientific workflow. First establish upstream parity; then evaluate each opt-in alternative with explicit mappings and measurements. Likewise, lighter prompting would be a separately tested experiment, not an assumed improvement or a reason to remove HF's tested rules now.
