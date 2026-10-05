# Source and adaptation manifest

Source: Hugging Face [`chat-ui`](https://github.com/huggingface/chat-ui/tree/1c9c9bcbd92da1c4bdcc7d4a20354191c747709e), Apache-2.0, commit **`1c9c9bcbd92da1c4bdcc7d4a20354191c747709e`**, 2026-09-26. See the accompanying [LICENSE](LICENSE).

The linked immutable commit is the source reference. This repository retains the prompt modules, builtin definitions, and GitHub utilities used by the Pi extension. `scripts/sync-upstream.mjs` accepts only that source revision and regenerates them. Runtime code never downloads prompts.

Regenerate from the pinned checkout:

```sh
node scripts/sync-upstream.mjs /path/to/chat-ui
```

Pi-specific adaptations remain explicit in `runtime/` and `index.ts`; the upstream prompt text is assembled with narrow replacements for Pi files, native MCP names, authorization, and private Trackio persistence.

## Current integration

| Area | Pi implementation |
| --- | --- |
| Assistant prompt and session context | `runtime/prompts.ts` assembles the pinned upstream prompts, applies reviewed Pi-specific replacements, adds privacy and authorization rules, and stamps session context last. Tests cover the assembled prompt and required workflow rules. |
| Hugging Face MCP | Pi provides the MCP transport. The extension registers the OAuth-ready `hf-intern` server with direct exposure. Token-auth file overrides are accepted only when their URL remains the canonical Hugging Face intern endpoint; other same-named overrides are rejected before activation. Tools use Pi's native `mcp__hf_intern__<operation>` names and pass through Pi's permission pipeline. |
| Hub destinations | `create_repo` defaults to private. Public creation and writes require exact artifact authorization. Writes also require a current-process creation receipt because MCP metadata does not expose destination visibility. |
| Jobs and billing | Jobs use the MCP operation/args schema. Paid submissions are pinned to `HF_BILL_TO` or the fresh authenticated username, while output ownership remains unchanged. Jobs and sandboxes receive session/build/prompt/authorization labels; recovery requires the session label and label replacement is blocked. Ambiguous submissions are recorded and never replayed automatically. |
| User authorization | `/ml-intern allow`, `/ml-intern publish`, and Pi confirmation controls record scoped authority. Chat text alone does not authorize compute or publication. |
| Planning and questions | Plans retain the upstream required labels and are stored in Pi branch entries. Interactive decisions include a typed Other path and reject empty multi-selects; unrelated headless replies leave the question pending. |
| Delegates | Research, sandbox, and job-check loops use the Pi SDK, inherit the selected model/provider/reasoning level, and forward tool calls through the parent session. Optional research tools remain conditional. Job-check reads are structurally limited to a caller-supplied immutable path, and text truncation applies to each combined tool result. |
| Files | Pi's native file tools are used directly. Whole-value `file://` references expand for Jobs scripts, Hub writes, and sandbox text writes. Submitted scripts use immutable filenames. |
| Metrics | `create_trackio` reserves a private dataset URI. Jobs upload early and final SQLite snapshots, which can be reviewed with the packaged localhost-only helper. |
| GitHub grounding | The selected upstream GitHub implementation is available when `GITHUB_TOKEN` is configured. Its optional regenerated tests run against the pinned source revision. |
| Session lifecycle | ML mode and build/prompt/feature/model stamps persist in the session branch. Stored job references are explicitly stale until inspected; Pi does not poll or wake while closed. Structured and documented text result forms are parsed, and terminal checks plus successful cancellation or termination reconcile outstanding references. |

## Validation boundaries

Offline tests exercise prompt assembly, retained upstream schemas, extension handlers, native MCP registration/provenance/discovery, Pi SDK delegate loops, scoped reads, policy enforcement, lifecycle reconciliation, cancellation, private defaults, file expansion, and headless decisions. `test:upstream` validates regenerated prompt/tool artifacts as well as the optional upstream GitHub suite.

Authenticated native Hugging Face MCP and paid compute require separate user-authorized validation. The extension does not claim hosted-dashboard parity, unrestricted agent reliability, or destination visibility that the MCP schema does not provide.
