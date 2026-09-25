# Legacy failure lessons

These observations come from debugging **obsolete, pre-migration versions of pi-ml-intern**, primarily the sessions documented around v0.1.5 in May 2026. They are not a description of the current implementation or requirements to preserve its architecture. The planned Chat UI-based migration will change prompts, tools, and execution behavior; see [the update proposal](./update-proposal.md).

The old notes are narrative reports, not independently verified execution traces. Preserve the failure scenarios below as regression-test ideas—not their speculative root causes, claimed fixes, or “all failures resolved” conclusion.

| Reported failure | Durable lesson / regression check |
| --- | --- |
| Main-agent calls failed with “tool not found”; delegates sometimes reported no available tools. | Exercise actual registration, activation, and execution in parent and delegate contexts. Preserve unrelated tool selections. Do not test fixed tool counts or assume every guessed tool name should exist. |
| Research returned shell/Python code blocks instead of executing requested work; repeated calls did not repair the situation. | Distinguish proposed code from executed actions. Verify role-appropriate capabilities and report a missing capability clearly. Research need not execute arbitrary code; delegate implementation work to the appropriate role. |
| Delegates exited with code 143 or returned inconsistent partial results. | Report exit/timeout/cancellation accurately, preserve useful partial findings, and avoid claiming success. An exit code alone does not establish timeout, OOM, or another root cause. |
| Hub lookups returned HTTP 400 but were presented as “not found.” Jobs returned “Cannot POST /api/jobs,” interpreted as a subscription problem. | Validate request contracts before diagnosing resource existence or account permissions. Keep operation, status, and useful response text in errors. Test malformed requests separately from missing resources and authorization failures. |
| GitHub discovery reported no examples although direct file reading found relevant code; paper searches repeatedly hit rate limits. | Separate genuine empty results from failed/incomplete searches. Use bounded retries for transient reads; then report the blocker rather than repeating identical calls or fabricating absence. |
| A reference script contained only a relocation notice; long documentation was truncated before potentially relevant details. | Follow the referenced implementation and read the required sections through pagination/continuation. A successful fetch is not proof that the implementation or full evidence was read. |
| HF Jobs could not see credentials expected by the user. | Test authentication in the environment that actually makes the call, including delegates and remote jobs. Missing credentials, invalid credentials, and insufficient permissions need distinct messages; never print token values to demonstrate loading. |
| A small poetry model trained and saved weights, but the sample was largely gibberish; the report still emphasized successful validation. | Separate infrastructure success from task success. Verify requested quality with actual evaluation—here, rhyme/syllable checks and held-out generation—not merely loss values, a saved checkpoint, or a completed training loop. |

## Do not carry forward

- The claim that `getActiveTools()` returns null-named objects, or the prescription to activate every registered tool. Check the supported Pi API and actual lifecycle instead.
- Unrestricted shell/write/job access as the cure for every research failure. Match the new upstream's role-specific tool sets.
- Blind cross-type endpoint probing as a substitute for correct schemas and error reporting.
- The old report's claims of complete resolution, authenticated Jobs success, or achieved poetry quality. The preserved material does not establish these.

These lessons supplement regression coverage; **Chat UI's reviewed source and tests remain authoritative for the new workflow**. No prompt changes are implied by this historical summary.
