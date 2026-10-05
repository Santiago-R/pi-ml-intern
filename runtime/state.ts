import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const STATE = 'ml-intern-state';
export const BUILD_VERSION = '0.3.0';
export const UPSTREAM_COMMIT = '1c9c9bcbd92da1c4bdcc7d4a20354191c747709e';
export const PROMPT_VERSION = UPSTREAM_COMMIT.slice(0,9);
type Plan = {goal:string; steps:{step:string;label:string;status:'pending'|'in_progress'|'completed'|'skipped'}[];version:number};
export type SubmissionAttempt = {id:string; kind:'job'|'sandbox'; name:string; namespace?:string; attemptedAt:string; status:'dispatching'|'unknown'};
type HarnessStamp = {build:string;prompt:string;features:string[];model?:string};
export type State = {active:boolean; sessionId:string; harness:HarnessStamp; plan?:Plan; question?:unknown; namespaces:string[]; jobs:string[]; finished:string[]; attempts:SubmissionAttempt[]; allowance?:string; publications:string[]; waits:number; destinations:Record<string,boolean>};
export const emptyState = ():State => ({active:false,sessionId:randomUUID(),harness:{build:BUILD_VERSION,prompt:PROMPT_VERSION,features:['native-mcp','local-files','private-trackio']},namespaces:[],jobs:[],finished:[],attempts:[],publications:[],waits:0,destinations:{}});
export function restore(ctx: ExtensionContext):State {
  const entry=ctx.sessionManager.getBranch().findLast(e=>e.type==='custom'&&e.customType===STATE);
  if(entry?.type!=='custom')return emptyState();
  const defaults=emptyState(),data=structuredClone(entry.data as Partial<State>&{added?:unknown});
  delete data.added;
  return {...defaults,...data,harness:{...defaults.harness,...data.harness},attempts:Array.isArray(data.attempts)?data.attempts:[]};
}
const cut=(s:string,n:number)=>s.length>n?s.slice(0,n-1)+'…':s;
export function plan(args:Record<string,any>,version:number):Plan {
  if(!args.goal?.trim() || !Array.isArray(args.steps) || !args.steps.length || args.steps.length>20)
    throw Error('Supply a nonempty goal and 1–20 steps. Retry with the full plan.');
  let busy=false;
  const steps=args.steps.map((s:any)=>{
    if(!s.step?.trim()||!s.label?.trim()||!['pending','in_progress','completed','skipped'].includes(s.status)) throw Error('Each step needs text, a label, and a valid status.');
    let status=s.status;
    if(status==='in_progress') {if(busy)status='pending';busy=true;}
    return {step:cut(s.step.trim(),200),label:cut(s.label.trim(),24),status};
  });
  return {goal:cut(args.goal.trim(),1500),steps,version};
}
export function renderPlan(p:Plan) {
  const lines=[`PLAN (v${p.version} — ${p.steps.filter(s=>s.status==='completed').length}/${p.steps.length} done)`,`Goal: ${p.goal}`];
  for(const [i,s] of p.steps.entries()) {
    const line=`${i+1}. ${{pending:'[ ]',in_progress:'[>]',completed:'[x]',skipped:'[-]'}[s.status]} ${s.step}`;
    if(lines.join('\n').length+line.length+1>2000){lines.push(`…and ${p.steps.length-i} more steps (truncated)`);break;}
    lines.push(line);
  }
  return lines.join('\n');
}
export function pendingResources(s:State):string[] {
  const references=s.jobs.filter(ref=>!s.finished.includes(ref));
  const attempts=s.attempts.map(a=>`${a.kind} submission ${a.status} for ${a.name} (${a.attemptedAt}); inspect by name before retrying`);
  return [...references,...attempts];
}
export function runningWarning(s:State) {
  const pending=pendingResources(s);
  return pending.length ? `Remote jobs are NOT cancelled automatically. These are observed references or unresolved submissions, not current status; inspect them explicitly. Charges may continue for any still running:\n${pending.join('\n')}` : '';
}
