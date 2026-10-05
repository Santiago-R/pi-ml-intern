import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { applyBilling, applySessionIsolation, checkCapabilities, expandFiles, HF_MCP_URL, HF_SERVER, hubRepoRoot, OPTIONAL, REQUIRED, logicalName, nativeName, resultContent, structured, verifyHfMcpConfig, whoamiNamespaces } from './runtime/contracts';
import { modePrompt } from './runtime/prompts';
import { availableOwned, OWNED, registerTools } from './runtime/tools';
import registerGithub from './runtime/github';
import { emptyState, pendingResources, renderPlan, restore, runningWarning, STATE, type SubmissionAttempt } from './runtime/state';
import { allowanceSlug, matchesAllowance, paidOperation, paidResourceName, recordAuthorization, sandboxGrammarError } from './runtime/policy';
import { applyLifecycle, observeLifecycle, reconcileNamedAttempts } from './runtime/lifecycle';

export default function mlIntern(pi:ExtensionAPI) {
  // Check the user-level override before MCP session-start handlers can connect.
  // Project overrides are considered only after Pi marks that project trusted.
  verifyHfMcpConfig(process.cwd(),false);
  // OAuth-ready default. A same-named file override is accepted only when it keeps
  // this exact Hugging Face endpoint, allowing token auth without changing provenance.
  pi.registerMcpServer(HF_SERVER,{url:HF_MCP_URL,exposure:'direct',description:'Hugging Face Hub and Jobs tools for ML Intern'});
  let state=emptyState();
  // state.active is the user's persisted intent; readiness is process-local.
  let toolsReady=false;
  const addedThisProcess=new Set<string>();
  const save=()=>pi.appendEntry(STATE,structuredClone(state));
  const report=(ctx:ExtensionContext,text:string,level:'info'|'warning'|'error'='info')=>{
    if(ctx.hasUI)ctx.ui.notify(text,level);else console.error(text);
  };
  const owned=(name:string)=>OWNED.includes(name);
  const disable=()=>{
    pi.setActiveTools(pi.getActiveTools().filter(n=>!owned(n)&&!addedThisProcess.has(n)));
    addedThisProcess.clear();toolsReady=false;
  };
  const activateTools=()=>{
    const tools=pi.getAllTools();
    const active=pi.getActiveTools();
    // Optional MCP tools disabled by the user stay disabled.
    const required=REQUIRED.map(nativeName).filter(name=>tools.some(tool=>tool.name===name));
    const local=availableOwned(active.map(logicalName)).filter(name=>tools.some(tool=>tool.name===name));
    const selected=[...local,...required];
    for(const name of selected)if(!active.includes(name))addedThisProcess.add(name);
    pi.setActiveTools([...new Set([...active,...selected])]);
  };
  const enable=(ctx:ExtensionContext)=>{
    verifyHfMcpConfig(ctx.cwd,ctx.isProjectTrusted());checkCapabilities(pi.getAllTools());activateTools();
    state.active=true;toolsReady=true;save();
  };
  const submissionAttempt=(toolCallId:string|undefined,toolName:string,input:Record<string,any>,status:SubmissionAttempt['status']):SubmissionAttempt|undefined=>{
    const kind=toolName==='hf_jobs'&&['run','uv'].includes(input.operation)?'job':toolName==='hf_sandbox'&&input.cmd==='create'?'sandbox':undefined;
    const name=kind&&paidResourceName(toolName,input);
    if(!kind||typeof name!=='string'||!name)return;
    const namespaceIndex=kind==='sandbox'&&Array.isArray(input.args)?input.args.indexOf('--namespace'):-1;
    const namespace=kind==='job'?input.args?.namespace:namespaceIndex>=0?input.args[namespaceIndex+1]:undefined;
    return {id:toolCallId??`${kind}:${name}`,kind,name,namespace:typeof namespace==='string'?namespace:undefined,attemptedAt:new Date().toISOString(),status};
  };
  const clearAttempt=(id:string|undefined)=>{
    const length=state.attempts.length;
    state.attempts=state.attempts.filter(attempt=>attempt.id!==id);
    return state.attempts.length!==length;
  };
  const markUnknown=(toolCallId:string|undefined,toolName:string,input:Record<string,any>)=>{
    const candidate=submissionAttempt(toolCallId,toolName,input,'unknown');
    const id=toolCallId??candidate?.id;
    const existing=state.attempts.find(attempt=>attempt.id===id);
    if(existing){existing.status='unknown';return existing;}
    if(candidate)state.attempts.push(candidate);
    return candidate;
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
      disable();state.active=false;state.allowance=undefined;state.publications=[];state.question=undefined;state.namespaces=[];save();warn(ctx);report(ctx,'ML mode off.');return;
    }
    if(command.startsWith('allow ')||command.startsWith('publish ')) {
      if(!state.active){report(ctx,'Enter /ml-intern first.','warning');return;}
      const [action,...parts]=command.split(' '),scope=parts.join(' ').trim();
      try {recordAuthorization(state,action==='allow'?'compute':'publish',scope);}
      catch(e){report(ctx,String(e),'error');return;}
      save();report(ctx,`Recorded ${action} authorization for ${scope}; no hard spending cap is enforced.`);
      pi.sendMessage({customType:'ml-intern-authorization',content:`Recorded ${action} authorization for ${scope} through /ml-intern.`,display:true},{triggerTurn:true});
      return;
    }
    try {enable(ctx);}catch(e){report(ctx,String(e),'error');return;}
    report(ctx,'ML mode on (private persisted Trackio; no hosted live dashboard on free accounts).');
    if(args.trim())pi.sendUserMessage(args.trim());
  }});
  pi.on('session_start',(_event,ctx)=>{
    if(ctx.isProjectTrusted())try {loadEnvFile(resolve(ctx.cwd,'.env'));} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')report(ctx,`Could not load project .env: ${String(e)}`,'error');}
    state=restore(ctx);
    // Credentials can change across resumes; never reuse a persisted account identity.
    state.namespaces=[];
    // Hub visibility is not available through MCP metadata. A previous process's
    // creation receipt cannot prove visibility under today's credentials.
    state.destinations={};
    // Reset only this extension's current-process activation delta.
    disable();
    state.active=state.active||pi.getFlag('ml-intern')===true||process.env.ML_INTERN_FORCE==='1';
    // Native MCP owns startup waiting; preserve intent while it connects.
    if(state.active)save();
    if(state.active)warn(ctx);
  });
  pi.on('session_tree',(_event,ctx)=>{
    disable();state=restore(ctx);state.namespaces=[];state.destinations={};
    if(state.active)warn(ctx);
  });
  pi.on('session_shutdown',(_event,ctx)=>warn(ctx));
  pi.on('input',event=>{
    if(!state.active||!state.question||event.source==='extension')return;
    const pending=state.question as any;
    const answers=String(event.text??'').split(/[\n,;]/).map(value=>value.trim().toLowerCase()).filter(Boolean);
    const answered=Array.isArray(pending?.questions)&&pending.questions.every((question:any)=>
      Array.isArray(question.options)&&question.options.some((option:any)=>answers.includes(String(option.label??'').trim().toLowerCase())));
    // Keep unrelated replies pending so the model must ask again rather than silently guessing.
    if(answered){state.question=undefined;save();}
  });
  pi.on('before_agent_start',event=>{
    if(!state.active)return;
    // Declare the local workflow before the model starts. Required native names
    // are stable even when MCP's later before_agent_start hook is still connecting.
    activateTools();
    const names=[...new Set([...pi.getActiveTools(),...REQUIRED.map(nativeName)])];
    const context=modePrompt(names,{username:state.namespaces[0],billTo:process.env.HF_BILL_TO,billingResourceGroup:process.env.HF_BILLING_RESOURCE_GROUP});
    return {systemPrompt:event.systemPrompt+'\n\n'+context};
  });
  pi.on('agent_start',(_event,ctx)=>{
    // Runs after every before_agent_start hook, including native MCP's startup wait.
    if(ctx.model) {
      const model=`${ctx.model.provider}/${ctx.model.id}`;
      if(state.harness.model!==model){state.harness.model=model;save();}
    }
    if(state.active&&!toolsReady)try {enable(ctx);}catch(e) {report(ctx,String(e),'error');}
  });
  pi.on('context',event=>{
    if(!state.active)return;
    const pending=pendingResources(state);
    const block=[!toolsReady&&'ML tools are not ready. Stop this ML task; check /mcp, fix the configuration or connection, then retry /ml-intern.',state.plan&&renderPlan(state.plan),state.allowance&&`Recorded allowance scope (not a hard cap): ${state.allowance}. Ask before using it for a new experiment or uncertain costs.`,state.question&&`Pending question: ${JSON.stringify(state.question)}. If the latest user message does not clearly select an offered option, call ask_user_question again; do not guess or use other tools.`,pending.length&&`Previously observed references or unresolved submissions (NOT current status; inspect on resume):\n${pending.join('\n')}`].filter(Boolean).join('\n\n');
    if(!block)return;
    const messages=[...event.messages];const i=messages.findLastIndex(m=>m.role==='user');
    const m=messages[i];if(m?.role!=='user')return;
    messages[i]={...m,content:typeof m.content==='string'?m.content+'\n\n'+block:[...m.content,{type:'text',text:block}]};
    return {messages};
  });
  pi.on('tool_call',async(rawEvent,ctx)=>{
    const event={...rawEvent,toolName:logicalName(rawEvent.toolName)};
    if(!state.active){if(owned(event.toolName))return {block:true,reason:'Enter /ml-intern first.'};return;}
    if(!toolsReady&&(owned(event.toolName)||REQUIRED.includes(event.toolName)||OPTIONAL.includes(event.toolName)))return {block:true,reason:'ML tools are not ready. Reconnect hf-intern and retry /ml-intern.'};
    if(state.question&&event.toolName!=='ask_user_question')return {block:true,reason:'Waiting for the user decision. Ask the question again if the latest reply did not select an offered option.'};
    const input=event.input as Record<string,any>;
    if(event.toolName==='hf_whoami'){state.namespaces=[];save();}
    const sandboxError=sandboxGrammarError(event.toolName,input);
    if(sandboxError)return {block:true,reason:sandboxError};
    if(event.toolName==='create_repo') {
      if(input.private===undefined)input.private=true;
      if(input.private===false&&!state.publications.includes(input.uri))return {block:true,reason:'Public creation needs artifact-scoped user permission. Use request_authorization for a Pi confirmation button, or ask the user to run /ml-intern publish <exact hf:// URI>.'};
    }
    if(event.toolName==='hf_jobs'&&String(input.operation).startsWith('scheduled'))return {block:true,reason:'Use ordinary run/uv and parent-owned waits in ML mode.'};
    if(event.toolName==='hf_jobs'&&input.operation==='update-labels')return {block:true,reason:'ML Intern provenance labels are immutable; label replacement is disabled in ML mode.'};
    const paid=paidOperation(event.toolName,input);
    if(paid&&!state.allowance)return {block:true,reason:'New paid compute/hosting needs explicit user authorization. Use request_authorization to present a Pi confirmation button, or ask the user to run /ml-intern allow <scope>. Chat text is never interpreted as authorization; no hard spending cap is enforced.'};
    if(paid&&!matchesAllowance(state.allowance!,paidResourceName(event.toolName,input)))return {block:true,reason:`Paid resource name must begin with the authorized experiment slug (${allowanceSlug(state.allowance!)}-), or obtain a new task allowance. Include args.name for Jobs, --name for sandboxes, or a matching Space/bucket repo name. An explicitly granted 'standing' allowance is exempt.`};
    if(event.toolName==='hf_fs_write') {
      const uri=input.args?.find((a:unknown)=>typeof a==='string'&&a.startsWith('hf://'));
      const root=hubRepoRoot(uri);
      if(!root||!(root in state.destinations))return {block:true,reason:'Destination visibility is unverified. The current MCP metadata omits visibility. Create a new private destination with create_repo before writing; do not assume an existing repo is private.'};
      if(!state.destinations[root]&&!state.publications.includes(root))return {block:true,reason:'Destination is recorded as public. Obtain artifact-scoped user publication permission before uploading.'};
    }
    const billingNamespace=process.env.HF_BILL_TO?.trim()||state.namespaces[0];
    if(paid&&(event.toolName==='hf_jobs'||event.toolName==='hf_sandbox')&&!billingNamespace)
      return {block:true,reason:'Run hf_whoami before submitting compute so the billing namespace can be pinned to the authenticated user (or configure HF_BILL_TO).'};
    applySessionIsolation(event.toolName,input,state.sessionId,state.allowance&&allowanceSlug(state.allowance));
    applyBilling(event.toolName,input,billingNamespace);
    await expandFiles(event.toolName,input,ctx.cwd);
    const attempt=submissionAttempt(event.toolCallId,event.toolName,input,'dispatching');
    if(attempt){state.attempts=[...state.attempts.filter(item=>item.id!==attempt.id),attempt];save();}
  });
  pi.on('tool_result',rawEvent=>{
    const event={...rawEvent,toolName:logicalName(rawEvent.toolName)};
    if(!state.active)return;
    const input=event.input as Record<string,any>;
    const submitting=event.toolName==='hf_jobs'?['run','uv'].includes(input.operation):event.toolName==='hf_sandbox'&&input.cmd==='create';
    const attemptId=event.toolCallId??submissionAttempt(undefined,event.toolName,input,'dispatching')?.id;
    if(event.isError) {
      if(submitting) {
        markUnknown(event.toolCallId,event.toolName,input);save();
        return {content:[...event.content,{type:'text',text:'Submission may have succeeded despite the tool error. Inspect jobs by name before retrying; do not automatically replay this billable call.'}]};
      }
      if(clearAttempt(attemptId))save();
      return;
    }
    const content=resultContent(event);
    const data=structured(content);
    if(event.toolName==='hf_whoami')state.namespaces=whoamiNamespaces(data);
    if(event.toolName==='create_repo'&&typeof input.uri==='string') {
      if(data?.action!=='created')return {isError:true,content:[...event.content,{type:'text',text:'Existing destination visibility is unknown. Do not write; choose a new private repo ID or verify visibility outside MCP.'}]};
      const root=hubRepoRoot(input.uri);if(root)state.destinations[root]=input.private!==false;
    }
    if(event.toolName==='hf_jobs'&&data?.outcome?.kind==='help') {
      clearAttempt(attemptId);save();
      return {isError:true,content:[{type:'text',text:'hf_jobs returned usage help; nothing was submitted. Supply an explicit operation and nested args.'}]};
    }
    if(event.toolName==='hf_jobs'||event.toolName==='hf_sandbox') {
      const lifecycle=observeLifecycle(event.toolName,input,content);
      if(submitting&&!lifecycle.references.length) {
        markUnknown(event.toolCallId,event.toolName,input);save();
        return {isError:true,content:[...event.content,{type:'text',text:'No job or sandbox ID was returned. Submission outcome unknown; inspect by name before retrying. Do not automatically replay this billable call.'}]};
      }
      applyLifecycle(state,lifecycle);
      if(submitting)clearAttempt(attemptId);
      if(event.toolName==='hf_jobs'&&['ps','inspect'].includes(input.operation))reconcileNamedAttempts(state,content);
    }
    save();
  });
}
