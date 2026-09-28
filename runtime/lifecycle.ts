import { structured } from './contracts';
import type { State } from './state';

export type LifecycleDelta = {references: string[]; terminal: string[]};

const JOB_TERMINAL = new Set(['COMPLETED', 'CANCELED', 'CANCELLED', 'ERROR', 'FAILED', 'DELETED']);
const SANDBOX_TERMINAL = new Set(['TERMINATED', 'CANCELED', 'CANCELLED', 'ERROR', 'FAILED', 'DELETED']);

export const emptyLifecycle = (): LifecycleDelta => ({references: [], terminal: []});

function unique(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function textOf(content: {type: string; text?: string}[]): string {
  return content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
}

function jobReference(id: unknown, namespace: unknown): string | undefined {
  if (typeof id !== 'string') return;
  return typeof namespace === 'string' && namespace
    ? `https://huggingface.co/jobs/${namespace}/${id}`
    : id;
}

/** Parse only lifecycle-bearing operations. ps/log output is observational and must not register historical jobs as pending. */
export function observeLifecycle(toolName: string, input: Record<string, any>, content: {type: string; text?: string}[]): LifecycleDelta {
  const data = structured(content);
  const references: unknown[] = [];
  const terminal: unknown[] = [];

  if (toolName === 'hf_jobs') {
    if (['run', 'uv'].includes(input.operation)) {
      references.push(...(textOf(content).match(/https:\/\/huggingface\.co\/jobs\/[A-Za-z0-9][\w.-]*\/[0-9a-f]{24}/g) ?? []));
      references.push(jobReference(data?.outcome?.job?.id ?? data?.job_id, data?.outcome?.job?.owner?.name ?? data?.namespace));
    } else if (input.operation === 'inspect') {
      const inspections = Array.isArray(data?.outcome?.inspections) ? data.outcome.inspections : [];
      for (const inspected of inspections) {
        const id = inspected?.job?.id ?? inspected?.job_id;
        const ref = jobReference(id, inspected?.job?.owner?.name ?? inspected?.namespace ?? input.args?.namespace);
        references.push(ref);
        if (JOB_TERMINAL.has(String(inspected?.job?.status?.stage ?? inspected?.status?.stage ?? inspected?.stage).toUpperCase())) terminal.push(id, ref);
      }
    } else if (input.operation === 'cancel') {
      terminal.push(input.args?.job_id);
    }
  }

  if (toolName === 'hf_sandbox') {
    if (input.cmd === 'create') {
      references.push(data?.handle, ...(textOf(content).match(/\bhfsb2:[\w.-]+:[0-9a-f]{24}\b/g) ?? []));
    } else if (input.cmd === 'terminate') {
      terminal.push(input.args?.[1]);
    } else if (input.cmd === 'status') {
      const handle = data?.handle ?? input.args?.[1];
      const stage = String(data?.status?.stage ?? data?.status ?? data?.stage).toUpperCase();
      if (handle) references.push(handle);
      if (SANDBOX_TERMINAL.has(stage)) terminal.push(handle);
    }
  }

  return {references: unique(references), terminal: unique(terminal)};
}

export function mergeLifecycle(...deltas: LifecycleDelta[]): LifecycleDelta {
  return {
    references: unique(deltas.flatMap(delta => delta.references)),
    terminal: unique(deltas.flatMap(delta => delta.terminal)),
  };
}

export function applyLifecycle(state: State, delta: LifecycleDelta): void {
  state.jobs = unique([...state.jobs, ...delta.references]);
  const matches = (ref: string, value: string) => ref === value || ref.endsWith('/' + value) || value.endsWith('/' + ref);
  const finished = state.jobs.filter(ref => delta.terminal.some(value => matches(ref, value)));
  state.finished = unique([...state.finished, ...finished]);
}
