# MCP prerequisite review — 2026-09-25

Status: source inspection, authenticated discovery/read checks, and bounded private training with `pi-mcp-adapter@2.37.0`; **not certification of other adapters or all account entitlements**. This records the initial P0 investigation and later live evidence from [release evidence](./release-evidence.md).

## Candidates and adoption

Sources: npm search (`pi mcp adapter`), npm registry version metadata, and `https://api.npmjs.org/downloads/point/last-month/<package>`. The download API returned the period **2026-08-23 through 2026-09-21**. Counts are downloads, not unique users; forks are not independent implementation evidence.

| Package | Published source version inspected | Downloads in returned period |
| --- | --- | ---: |
| `pi-mcp-adapter` | `2.37.0` | 1,013,749 |
| `@nklisch/pi-mcp-adapter` | `2.21.0-nklisch.4` | 1,887 |
| `@icefairy/pi-mcp-adapter` | `2.29.3` | 831 |
| `@pixu1980/pi-mcp` | `0.1.17` | 695 |
| `@diegopetrucci/pi-mcp-adapter` | `2.36.0` | 377 |
| `@piarium/pi-mcp-adapter` | `2.29.0-piarium.1` | 182 |
| `@fitchmultz/pi-mcp-adapter` | `6.0.0` | 150 |
| `pi-tidy-mcp-adapter` | `0.1.31` | 96 |

A final 2026-09-26 registry check found `pi-mcp-adapter@2.38.0`; this implementation remains pinned to the fully inspected/tested `2.37.0` rather than silently moving its baseline. Revalidate before upgrading.

Downloaded published tarballs for the four highest-count candidates to temporary directories for documentation/source inspection. Initially no adapter was installed. With subsequent user authorization, installed `pi-mcp-adapter@2.37.0` globally and added the credential-free project configuration `.pi/mcp.json`. Download counts strongly favor starting validation with `pi-mcp-adapter`; repository popularity is not needed to break a tie here. This is a candidate sample, not an exhaustive ecosystem census.

## Compatibility findings

| Surface | `pi-mcp-adapter` 2.37.0 | Other three inspected candidates |
| --- | --- | --- |
| Direct names | Configurable `directTools` and `toolPrefix: "none"` | All document these controls; not runtime-tested |
| Generic proxy | Default; unsuitable as the only model-visible tool for upstream prompts | Similar proxy/direct split; not interchangeable with upstream names by default |
| Nested input | Direct executor forwards arguments to the original MCP tool; schema-backed preparation supports nested object/array values | No authenticated HF nested-`args` test performed |
| Schema identity | Not byte-identical: `normalizeDirectToolInputSchema` removes root `$schema` and `additionalProperties`; preparation validates against the original schema | Must compare actual exposed schemas rather than assume fork equivalence |
| Errors | Executor returns error details; adapter's `tool_result` hook converts these to Pi `isError` | Error-hook behavior must be tested for each version; copying only executor functions is unsafe |
| Results | Content conversion and output guarding; optional bounded raw-result details | No universal raw MCP result contract established |
| Discovery | Cache-backed direct registration, live refresh/hot-loading; first connection can add tools | Lifecycle differs by version; require tests on cold start and resume |
| Cancellation | Direct executor passes/composes abort signals | In-process isolated-child abort and explicit live remote Jobs cancellation passed; aborting an in-flight MCP transport request remains unverified |
| Delegates | Child must load/initialize the adapter, including result hooks and authentication | Neither automatic inheritance nor execution access follows from MCP standardization |

**Conclusion:** all four reviewed candidates advertise the naming/direct-exposure configuration needed for the input surface. There is insufficient evidence to say all or most preserve the complete HF input/output and delegate contract. Do not build a generic adapter layer or fork a client based on this inspection.

Primary source references in the published `pi-mcp-adapter` package: `README.md` (direct tools, configuration, lifecycle), `direct-tool-surface.ts` (`prepareDirectToolArguments`), `utils.ts` (`normalizeDirectToolInputSchema`), `direct-tools.ts` (execution/result handling), `error-signal.ts`, and the `tool_result` registration in `index.ts`. Equivalent candidate documentation comes from their published README files, not assumed repository HEAD behavior.

## Pi boundary

The installed Pi extension API exposes tool metadata through `getAllTools()` and active names through `getActiveTools()`. It does not expose a generic executor alongside that metadata. Do not fabricate `pi.executeTool`, reach into an adapter's private client, or invoke its executor without its lifecycle/error hooks.

Implemented delegates using Pi's SDK/session/resource loader, loading the source extensions of selected tools and the user's adapter configuration. SDK tool allowlists plus per-call role guards prevent delegate lifecycle operations. Tests use the actual Pi loop, inherited provider/auth/reasoning and adapter error hooks rather than copying executors. A live child Jobs read and a missing-job error passed with scripted inference; cancellation state reconciliation and isolated-child abort pass offline. A later authorized disposable run passed forced authenticated reconnect, post-reconnect role-restricted child inspection, explicit remote Jobs cancellation and terminal confirmation. Aborting an in-flight MCP transport request remains outside the bounded release evidence.

## User-owned setup required

Initial inspection found no configured credentials/adapter. The user subsequently supplied `.env` with `HF_TOKEN` and authorized installation. `.env` remains Git-ignored; the probe loaded it explicitly without printing credentials. Existing terminal/Pi processes do not automatically inherit newly created `.env` files. The VS Code Python terminal-injection setting is not required: from the project, launch Pi with `node --env-file=.env "$(command -v pi)"`.

Tested adapter installation (other adapter versions remain unverified):

```sh
pi install npm:pi-mcp-adapter@2.37.0
```

Add this server to your Pi MCP configuration (merge with existing configuration; do not replace other servers). Supply `HF_TOKEN` through your environment, not committed JSON or chat:

```json
{
  "mcpServers": {
    "hf-intern": {
      "url": "https://huggingface.co/mcp?login&bouquet=intern",
      "auth": "bearer",
      "bearerTokenEnv": "HF_TOKEN",
      "directTools": ["hf_whoami", "create_repo", "hub_repo_details", "hf_fs", "hf_fs_write", "hf_jobs", "hf_sandbox", "hf_sandbox_exec", "hf_sandbox_fs"],
      "toolPrefix": "none",
      "lifecycle": "eager"
    }
  }
}
```

Reconnect using the adapter's `/mcp reconnect hf-intern` command after loading it. Validate initially in a Pi session **without the legacy pi-ml-intern extension**, whose local `hf_jobs` and `hub_repo_details` names can collide with the real service. This configuration passed authenticated discovery, private dataset/model creation, Jobs submissions and private Trackio snapshot readback on the tested account. A failure should be reported, not bypassed with another transport.

Prerequisite checklist (1–3 and result-error/in-process-abort portions of 4 passed without remote compute; creation/privacy in 5 and live reconnect/remote cancellation subsequently passed in separately authorized bounded runs):

1. Discover the authenticated bouquet and save a credential-free schema fixture with date/adapter version.
2. Run `hf_whoami` and representative read-only lookups through the adapter; record actual identity and error/result shapes.
3. Exercise upstream nested Jobs read arguments without submitting any job.
4. Repeat discovery/read calls in a role-restricted Pi SDK child; test cancellation and result-error propagation.
5. Use the captured creation schemas to implement private defaults; separately investigate Trackio's supported private deployment/storage API. Do not create paid resources as a discovery test.

The user subsequently granted a bounded total task allowance. The D13 no-subscription test ran two bounded T4-small smoke Jobs, one bounded ten-step training Job, and a further user-approved agent-led two-step Job via `pi-mcp-adapter@2.37.0`; all completed, with private metrics/model readback. See [release evidence](./release-evidence.md).

## Upstream changed during prerequisite review

Rechecked Chat UI `main`: **`3b15f635f56dea23d6722ea6234bfaba21ca47e7`**, 2026-09-25. The proposal's previously reviewed snapshot is `80f4edaea2cc79ff743c09f766685cd53fa8cd53`.

The diff adds virtual script files (`write_file`, `edit_file`, `read_file`, import handling and `v-file://` reference expansion), changes main/delegate prompts, and adds dashboard recording. `src/lib/server/mlFiles/enabled.ts` enables virtual files by default for ML conversations unless explicitly disabled. The main prompt now has a `virtualFiles` switch.

This is substantive new workflow, not a mechanical prompt refresh. Before implementing the newest snapshot, review the added file tools/expansion and tests. Prefer a narrowly documented Pi-file adaptation using Pi's existing read/edit/write utilities over duplicating a web file store. Do not copy the new reference examples without implementing their expansion, and do not silently disable the upstream default while claiming newest-source parity. The subsequent implementation rechecked `main` at `1c9c9bcbd92da1c4bdcc7d4a20354191c747709e` (2026-09-26). Its exact-SHA source reference, generated prompt modules and explicit Pi-file/registry adaptations are documented in [the implementation manifest](../upstream/README.md). Versioned imports remain a stated fidelity gap.

## Current gate

Authenticated discovery succeeded in an isolated in-memory Pi SDK session loading only the adapter through Pi's resource loader, with explicit `/mcp reconnect hf-intern`. Core adapter-normalized schemas are saved in `tests/fixtures/hf-intern-tools.json`. At that initial read-only stage, direct SDK tool execution succeeded for `hf_whoami`, public model metadata, and `hf_jobs` with `{ "operation": "ps", "args": {} }`; no running jobs were reported and no resources were created. Results include text blocks, with structured MCP content represented as a `structuredContent:` text block. Identity/job response bodies are not committed.

The initial broad `directTools: true` probe also exposed many skill/resource readers (148 direct tools), with collisions among resource basenames. Limit production exposure to the required core tools rather than importing every resource into every delegate. The original running Pi process lacked the newly loaded environment and its proxy connection failed; this does not contradict the credential-loaded SDK checks.

**2026-09-26 continuation:** loaded the migrated extension and adapter together; ML-mode activation and `hf_fs stat` passed. A real isolated `check_job` child using the actual adapter completed Jobs `ps`; a second child inspected a nonexistent job and correctly received Pi `isError` through the adapter's error hook. The model responses were scripted locally, so no inference credits were spent. Both child and parent emitted shutdown and disposed their SDK sessions.

Read-only `hf_fs stat` and `hub_repo_details` do not reveal visibility. Consequently the migration blocks writes to pre-existing/unverified destinations; it does not fabricate a private visibility check. At the time of this read-only probe no resources were created; later a private dataset and model repo were created and independently checked for anonymous denial under the [release evidence](./release-evidence.md). Pre-existing destination visibility remains unavailable.

Inspected `session-recovery.ts`: the adapter retries once for narrowly recognized pre-dispatch expired-session errors; it does not classify generic connection failures or aborts as safe-to-replay session expiry. The extension adds no tool-submission retry loop.

Authenticated creation visibility/anonymous denial and scripted private Trackio persistence + bounded HF Jobs passed under D13. A tightly scoped real-model agent-led paid submission and `check_job` read passed. Offline guards reconcile successful Jobs cancellation, sandbox termination and terminal child observations without treating `ps`/logs history as pending. A fresh authenticated disposable run then persisted a live job across Pi shutdown, forced adapter reconnect, refreshed a role-restricted `check_job` child, explicitly cancelled the job and confirmed its terminal state. Unconstrained agent task quality, in-flight transport-request aborts, other-adapter compatibility, and hosted live dashboard parity (HTTP 402 on the free account) remain outside the bounded claim. No account upgrade or public Space was attempted. See [release evidence](./release-evidence.md).
