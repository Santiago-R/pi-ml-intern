import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { applyBilling, checkCapabilities, dispatchOutcome, expandFiles, hubRepoRoot, isHfProxyCall, OPTIONAL, REQUIRED, structured, whoamiNamespaces } from './runtime/contracts';
import { modePrompt } from './runtime/prompts';
import { activeOwned, OWNED, registerTools } from './runtime/tools';
import registerGithub from './runtime/github';
import { emptyState, renderPlan, restore, runningWarning, STATE } from './runtime/state';
import { allowanceSlug, matchesAllowance, paidOperation, paidResourceName, recordAuthorization, sandboxGrammarError } from './runtime/policy';
import { applyLifecycle, observeLifecycle, type LifecycleDelta } from './runtime/lifecycle';

export default function mlIntern(pi:ExtensionAPI) {
  try {loadEnvFile(resolve('.env'));} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  let state=emptyState();
  const save=()=>pi.appendEntry(STATE,structuredClone(state));
  const report=(ctx:ExtensionContext,text:string,level:'info'|'warning'|'error'='info')=>{
    if(ctx.hasUI)ctx.ui.notify(text,level);else console.error(text);
  };
  const owned=(name:string)=>OWNED.includes(name);
  const disable=()=>pi.setActiveTools(pi.getActiveTools().filter(n=>!owned(n)&&!state.added.includes(n)));
  const enable=()=>{
    const tools=pi.getAllTools();checkCapabilities(tools);
    const active=pi.getActiveTools();
    // Optional MCP tools disabled by the user stay disabled.
    const selected=[...activeOwned(active),...REQUIRED,...OPTIONAL.filter(n=>active.includes(n))].filter(n=>tools.some(t=>t.name===n));
    state.added=[...new Set([...state.added,...selected.filter(n=>!active.includes(n))])];
    pi.setActiveTools([...new Set([...active,...selected])]);state.active=true;save();
  };
  const warn=(ctx:ExtensionContext)=>{
    const text=runningWarning(state);
    if(text)report(ctx,text,'warning');
  };
  registerTools(pi,()=>state,save);
  registerGithub(pi);
  pi.registerFlag('ml-intern',{description:'Enter persistent ML mode in this session',type:'boolean',default:false});
  pi.registerCommand('ml-intern',{description:'Enter ML mode; /ml-intern off exits without cancelling remote jobs',handler:async(args,ctx)=>{
    if(!ctx.isIdle()){report(ctx,'Wait for the current run or abort it first.','warning');return;}
    const command=args.trim();
    if(command==='off') {
      disable();state.active=false;state.added=[];state.allowance=undefined;state.publications=[];state.question=undefined;state.namespaces=[];save();warn(ctx);report(ctx,'ML mode off.');return;
    }
    if(command.startsWith('allow ')||command.startsWith('publish ')) {
      if(!state.active){report(ctx,'Enter /ml-intern first.','warning');return;}
      const [action,...parts]=command.split(' '),scope=parts.join(' ').trim();
      try {recordAuthorization(state,action==='allow'?'compute':'publish',scope);}
      catch(e){report(ctx,String(e),'error');return;}
      save();report(ctx,`Recorded ${action} authorization for ${scope}; no hard spending cap is enforced.`);return;
    }
    try {enable();}catch(e){report(ctx,String(e),'error');return;}
    report(ctx,'ML mode on (private persisted Trackio; no hosted live dashboard on free accounts).');
    if(args.trim())pi.sendUserMessage(args.trim());
  }});
  pi.on('session_start',(_event,ctx)=>{
    state=restore(ctx);
    // Credentials can change across resumes; never reuse a persisted account identity.
    state.namespaces=[];
    // Hub visibility is not available through MCP metadata. A previous process's
    // creation receipt cannot prove visibility under today's credentials.
    state.destinations={};
    // Touch extension-owned membership only; never enable unrelated disabled tools.
    pi.setActiveTools(pi.getActiveTools().filter(n=>!owned(n)));
    if(state.active||pi.getFlag('ml-intern')===true||process.env.ML_INTERN_FORCE==='1') {
      try {enable();}catch(e){state.active=false;save();report(ctx,String(e),'error');}
    }
    if(state.active)warn(ctx);
  });
  pi.on('session_tree',(_event,ctx)=>{
    disable();state=restore(ctx);state.namespaces=[];state.destinations={};
    if(state.active)try {enable();} catch(e) {state.active=false;save();report(ctx,String(e),'error');}
  });
  pi.on('session_shutdown',(_event,ctx)=>warn(ctx));
  pi.on('input',event=>{
    if(!state.active||!state.question||event.source==='extension')return;
    // The earlier tool result already contains the question. Preserve the new
    // user message verbatim so assistant-authored options never become user text.
    state.question=undefined;save();
  });
  pi.on('before_agent_start',(event)=>{
    if(!state.active)return;
    try {checkCapabilities(pi.getAllTools());}catch(e){disable();state.active=false;save();throw e;}
    const context=modePrompt(pi.getActiveTools(),{username:state.namespaces[0],billTo:process.env.HF_BILL_TO,billingResourceGroup:process.env.HF_BILLING_RESOURCE_GROUP});
    return {systemPrompt:event.systemPrompt+'\n\n'+context};
  });
  pi.on('context',event=>{
    if(!state.active)return;
    const pending=state.jobs.filter(ref=>!state.finished.includes(ref));
    const block=[state.plan&&renderPlan(state.plan),state.allowance&&`Recorded allowance scope (not a hard cap): ${state.allowance}. Ask before using it for a new experiment or uncertain costs.`,state.question&&`Unanswered question: ${JSON.stringify(state.question)}. Stop until the user responds.`,pending.length&&`Previously observed job references (NOT current status; inspect on resume):\n${pending.join('\n')}`].filter(Boolean).join('\n\n');
    if(!block)return;
    const messages=[...event.messages];const i=messages.findLastIndex(m=>m.role==='user');
    const m=messages[i];if(m?.role!=='user')return;
    messages[i]={...m,content:typeof m.content==='string'?m.content+'\n\n'+block:[...m.content,{type:'text',text:block}]};
    return {messages};
  });
  pi.on('tool_call',async(event,ctx)=>{
    if(!state.active){if(owned(event.toolName))return {block:true,reason:'Enter /ml-intern first.'};return;}
    if(state.question)return {block:true,reason:'Waiting for the user decision. Stop and resume this session with an answer.'};
    const input=event.input as Record<string,any>;
    if(isHfProxyCall(event.toolName,input))return {block:true,reason:'Use the direct HF tools in ML mode. Generic MCP proxy calls bypass privacy, billing and job tracking.'};
    if(event.toolName==='hf_whoami'){state.namespaces=[];save();}
    const sandboxError=sandboxGrammarError(event.toolName,input);
    if(sandboxError)return {block:true,reason:sandboxError};
    if(event.toolName==='create_repo') {
      if(input.private===undefined)input.private=true;
      if(input.private===false&&!state.publications.includes(input.uri))return {block:true,reason:'Public creation needs artifact-scoped user permission. Use request_authorization for a Pi confirmation button, or ask the user to run /ml-intern publish <exact hf:// URI>.'};
    }
    if(event.toolName==='hf_jobs'&&String(input.operation).startsWith('scheduled'))return {block:true,reason:'Use ordinary run/uv and parent-owned waits in ML mode.'};
    const paid=paidOperation(event.toolName,input);
    if(paid&&!state.allowance)return {block:true,reason:'New paid compute/hosting needs explicit user authorization. Use request_authorization to present a Pi confirmation button, or ask the user to run /ml-intern allow <scope>. Chat text is never interpreted as authorization; no hard spending cap is enforced.'};
    if(paid&&!matchesAllowance(state.allowance!,paidResourceName(event.toolName,input)))return {block:true,reason:`Paid resource name must begin with the authorized experiment slug (${allowanceSlug(state.allowance!)}-), or obtain a new task allowance. Include args.name for Jobs, --name for sandboxes, or a matching Space/bucket repo name. An explicitly granted 'standing' allowance is exempt.`};
    if(event.toolName==='hf_fs_write') {
      const uri=input.args?.find((a:unknown)=>typeof a==='string'&&a.startsWith('hf://'));
      const root=hubRepoRoot(uri);
      if(!root||!(root in state.destinations))return {block:true,reason:'Destination visibility is unverified. The current MCP metadata omits visibility. Create a new private destination with create_repo before writing; do not assume an existing repo is private.'};
      if(!state.destinations[root]&&!state.publications.includes(root))return {block:true,reason:'Destination is recorded as public. Obtain artifact-scoped user publication permission before uploading.'};
    }
    applyBilling(event.toolName,input);
    await expandFiles(event.toolName,input,ctx.cwd);
  });
  pi.on('tool_result',event=>{
    if(!state.active)return;
    const input=event.input as Record<string,any>;
    const submitting=event.toolName==='hf_jobs'?['run','uv'].includes(input.operation):event.toolName==='hf_sandbox'&&input.cmd==='create';
    const outcome=dispatchOutcome(event.details,event.isError);
    if(outcome!=='ok') {
      if(outcome==='uncertain'&&submitting) {
        const name=paidResourceName(event.toolName,input);
        state.jobs=[...new Set([...state.jobs,`Submission outcome unknown${name?` for ${name}`:''}: inspect jobs by name before retrying.`])];
        save();
        return {content:[...event.content,{type:'text',text:'Submission may have succeeded despite the tool error. Inspect jobs by name before retrying; do not automatically replay this billable call.'}]};
      }
      return;
    }
    const data=structured(event.content);
    if(event.toolName==='hf_whoami')state.namespaces=whoamiNamespaces(data);
    if(event.toolName==='create_repo'&&typeof input.uri==='string') {
      if(data?.action!=='created')return {isError:true,content:[...event.content,{type:'text',text:'Existing destination visibility is unknown. Do not write; choose a new private repo ID or verify visibility outside MCP.'}]};
      const root=hubRepoRoot(input.uri);if(root)state.destinations[root]=input.private!==false;
    }
    if(event.toolName==='hf_jobs'&&data?.outcome?.kind==='help')return {isError:true,content:[{type:'text',text:'hf_jobs returned usage help; nothing was submitted. Supply an explicit operation and nested args.'}]};
    if(event.toolName==='hf_jobs'||event.toolName==='hf_sandbox') {
      const lifecycle=observeLifecycle(event.toolName,input,event.content);
      if(submitting&&!lifecycle.references.length) {
        const nameIndex=Array.isArray(input.args)?input.args.indexOf('--name'):-1;
        const sandboxName=nameIndex>=0?input.args[nameIndex+1]:undefined;
        const name=input.args?.name??sandboxName;
        state.jobs=[...new Set([...state.jobs,`Submission outcome unknown${name?` for ${name}`:''}: inspect jobs by name before retrying.`])];save();
        return {isError:true,content:[...event.content,{type:'text',text:'No job or sandbox ID was returned. Submission outcome unknown; inspect by name before retrying. Do not automatically replay this billable call.'}]};
      }
      applyLifecycle(state,lifecycle);
    }
    if(event.toolName==='check_job') {
      const lifecycle=(event.details as {lifecycle?:LifecycleDelta}|undefined)?.lifecycle;
      if(lifecycle)applyLifecycle(state,lifecycle);
    }
    save();
  });
}
