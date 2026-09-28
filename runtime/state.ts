import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const STATE = 'ml-intern-state';
export type Plan = {goal:string; steps:{step:string;label?:string;status:'pending'|'in_progress'|'completed'|'skipped'}[];version:number};
export type State = {active:boolean; added:string[]; plan?:Plan; question?:unknown; namespaces:string[]; jobs:string[]; finished:string[]; allowance?:string; publications:string[]; waits:number; destinations:Record<string,boolean>};
export const emptyState = ():State => ({active:false,added:[],namespaces:[],jobs:[],finished:[],publications:[],waits:0,destinations:{}});
export function restore(ctx: ExtensionContext):State {
  const entry=ctx.sessionManager.getBranch().findLast(e=>e.type==='custom'&&e.customType===STATE);
  return entry?.type==='custom' ? structuredClone(entry.data as State) : emptyState();
}
const cut=(s:string,n:number)=>s.length>n?s.slice(0,n-1)+'…':s;
export function plan(args:Record<string,any>,version:number):Plan {
  if(!args.goal?.trim() || !Array.isArray(args.steps) || !args.steps.length || args.steps.length>20)
    throw Error('Supply a nonempty goal and 1–20 steps. Retry with the full plan.');
  let busy=false;
  const steps=args.steps.map((s:any)=>{
    if(!s.step?.trim()||!['pending','in_progress','completed','skipped'].includes(s.status)) throw Error('Each step needs text and a valid status.');
    let status=s.status;
    if(status==='in_progress') {if(busy)status='pending';busy=true;}
    return {step:cut(s.step.trim(),200),label:s.label?cut(s.label.trim(),24):undefined,status};
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
export function runningWarning(s:State) {
  const pending=s.jobs.filter(ref=>!s.finished.includes(ref));
  return pending.length ? `Remote jobs are NOT cancelled automatically. These are observed references, not current status; inspect them explicitly. Charges may continue for any still running:\n${pending.join('\n')}` : '';
}
