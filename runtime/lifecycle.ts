import { jobLabelValue, structured } from './contracts';
import type { State, SubmissionAttempt } from './state';

export type LifecycleDelta = {references: string[]; terminal: string[]};

const JOB_TERMINAL = new Set(['COMPLETED','CANCELED','CANCELLED','ERROR','FAILED','DELETED','TERMINATED']);
const SANDBOX_TERMINAL = new Set(['COMPLETED','CANCELED','CANCELLED','TERMINATED','ERROR','FAILED','DELETED']);

function unique(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function textOf(content: {type: string; text?: string}[]): string {
  return content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
}

function jobReference(id: unknown, namespace: unknown): string | undefined {
  if (typeof id !== 'string') return;
  if(id.startsWith('https://huggingface.co/jobs/'))return id;
  return typeof namespace === 'string' && namespace
    ? `https://huggingface.co/jobs/${namespace}/${id}`
    : id;
}

function jobTextReference(text:string,namespace?:unknown):string|undefined {
  const url=text.match(/https:\/\/huggingface\.co\/jobs\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*/)?.[0];
  if(url)return url;
  const id=text.match(/\b[0-9a-f]{24}\b/)?.[0];
  return jobReference(id,namespace);
}

/** Parse only lifecycle-bearing operations. ps/log output is observational and must not register historical jobs as pending. */
export function observeLifecycle(toolName: string, input: Record<string, any>, content: {type: string; text?: string}[]): LifecycleDelta {
  const data = structured(content);
  const text=textOf(content);
  const references: unknown[] = [];
  const terminal: unknown[] = [];

  if (toolName === 'hf_jobs') {
    if (['run', 'uv'].includes(input.operation)) {
      const job=data?.outcome?.job??data?.job;
      references.push(
        jobReference(job?.id??data?.job_id,job?.owner?.name??data?.namespace??input.args?.namespace),
        jobTextReference(text,input.args?.namespace),
      );
    } else if (input.operation === 'inspect') {
      const inspections=Array.isArray(data?.outcome?.inspections)?data.outcome.inspections:[];
      for (const inspected of inspections) {
        const job=inspected?.job??{};
        const id=job.id??inspected?.job_id;
        const ref=jobReference(id,job.owner?.name??inspected?.namespace??input.args?.namespace);
        references.push(ref);
        const stage=String(job.status?.stage??inspected?.status?.stage??inspected?.stage??'').toUpperCase();
        if(JOB_TERMINAL.has(stage))terminal.push(id,ref);
      }
    } else if (input.operation === 'cancel') {
      terminal.push(input.args?.job_id);
    }
  }

  if (toolName === 'hf_sandbox') {
    if (input.cmd === 'create') {
      const namespaceIndex=Array.isArray(input.args)?input.args.indexOf('--namespace'):-1;
      const namespace=data?.namespace??(namespaceIndex>=0?input.args[namespaceIndex+1]:undefined);
      references.push(data?.handle);
      if(data?.job_id&&namespace)references.push(`hfsb2:${namespace}:${data.job_id}`);
      references.push(...(text.match(/\bhfsb2:[\w.-]+:[A-Za-z0-9][\w.-]*\b/g)??[]));
    } else if (input.cmd === 'terminate') {
      terminal.push(input.args?.[1]);
    } else if (input.cmd === 'status') {
      const handle=data?.handle??input.args?.[1];
      const stage=String(data?.status?.stage??data?.status??data?.stage??'').toUpperCase();
      if(handle)references.push(handle);
      if(SANDBOX_TERMINAL.has(stage))terminal.push(handle);
    }
  }

  return {references: unique(references), terminal: unique(terminal)};
}

export function applyLifecycle(state: State, delta: LifecycleDelta): void {
  state.jobs = unique([...state.jobs, ...delta.references]);
  const matches = (ref: string, value: string) => ref === value || ref.endsWith('/' + value) || ref.endsWith(':' + value) || value.endsWith('/' + ref) || value.endsWith(':' + ref);
  const finished = state.jobs.filter(ref => delta.terminal.some(value => matches(ref, value)));
  state.finished = unique([...state.finished, ...finished]);
}

type NamedReference = {name:string; id:string; namespace?:string; labels?:Record<string,string>};

function namedReferences(value:unknown,found:NamedReference[]=[]):NamedReference[] {
  if(Array.isArray(value)){for(const item of value)namedReferences(item,found);return found;}
  if(!value||typeof value!=='object')return found;
  const record=value as Record<string,any>;
  const job=record.job&&typeof record.job==='object'?record.job:record;
  const name=[job.name,job.job_name,job.display_name,record.name,record.job_name,record.display_name].find(v=>typeof v==='string');
  const id=[job.id,job.job_id,record.job_id,record.id].find(v=>typeof v==='string');
  const namespace=[job.owner?.name,job.namespace,record.namespace,record.owner?.name].find(v=>typeof v==='string');
  const labels=job.labels&&typeof job.labels==='object'&&!Array.isArray(job.labels)?job.labels:undefined;
  if(name&&id)found.push({name,id,namespace,labels});
  for(const child of Object.values(record))namedReferences(child,found);
  return found;
}

function referenceFor(attempt:SubmissionAttempt,id:string,namespace?:string):string|undefined {
  if(attempt.kind==='job')return jobReference(id,namespace??attempt.namespace);
  if(id.startsWith('hfsb2:'))return id;
  const url=id.match(/^https:\/\/huggingface\.co\/jobs\/([^/]+)\/([^/]+)$/);
  const owner=url?.[1]??namespace??attempt.namespace;
  const jobId=url?.[2]??id;
  return owner?`hfsb2:${owner}:${jobId}`:undefined;
}

/** Bind only exact-name, same-session submissions; never register unrelated or historical ps results. */
export function reconcileNamedAttempts(state:State,content:{type:string;text?:string}[]):void {
  if(!state.attempts.length)return;
  const available=namedReferences(structured(content)).filter(item=>item.labels?.['ml-intern-session']===jobLabelValue(state.sessionId))
    .filter((item,index,all)=>all.findIndex(other=>other.name===item.name&&other.id===item.id&&other.namespace===item.namespace)===index);
  const resolved=new Set<string>();
  for(const attempt of state.attempts) {
    const index=available.findIndex(item=>item.name===attempt.name);
    if(index<0)continue;
    const [observation]=available.splice(index,1);
    const reference=referenceFor(attempt,observation.id,observation.namespace);
    if(!reference)continue;
    state.jobs=unique([...state.jobs,reference]);resolved.add(attempt.id);
  }
  state.attempts=state.attempts.filter(attempt=>!resolved.has(attempt.id));
}
