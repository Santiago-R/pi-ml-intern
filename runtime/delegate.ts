import { resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionToolContext, type AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import { delegatePrompt } from './prompts';
import { logicalName, nativeName } from './contracts';
import { sandboxGrammarError } from './policy';
import * as research from '../upstream/prompts/researchPrompt';
import * as sandbox from '../upstream/prompts/sandboxPrompt';
import * as check from '../upstream/prompts/jobCheckPrompt';

const roles={
  research:{tools:['hf_fs','hub_repo_details','hub_repo_search','github_find_examples','github_read_file','github_list_repos','web_search_exa','get_code_context_exa','crawling_exa'],iterations:60,head:4800,tail:3200,stop:[research.RESEARCH_CONTEXT_WARN_PROMPT,research.RESEARCH_CONTEXT_MAX_PROMPT,research.RESEARCH_ITERATION_LIMIT_PROMPT,research.RESEARCH_REPETITION_PROMPT]},
  sandbox_task:{tools:['hf_sandbox_exec','hf_sandbox_fs'],iterations:30,head:1800,tail:4200,stop:[sandbox.SANDBOX_CONTEXT_WARN_PROMPT,sandbox.SANDBOX_CONTEXT_MAX_PROMPT,sandbox.SANDBOX_ITERATION_LIMIT_PROMPT,sandbox.SANDBOX_REPETITION_PROMPT]},
  check_job:{tools:['hf_jobs','read'],iterations:8,head:1200,tail:4800,stop:[check.JOB_CHECK_CONTEXT_WARN_PROMPT,check.JOB_CHECK_CONTEXT_MAX_PROMPT,check.JOB_CHECK_ITERATION_LIMIT_PROMPT,check.JOB_CHECK_REPETITION_PROMPT]},
};
type Role=keyof typeof roles;
export function roleError(role:Role,name:string,input:Record<string,any>,handle?:string,scriptPath?:string,cwd=process.cwd()) {
  name=logicalName(name);
  if(!roles[role].tools.includes(name))return `Tool ${name} is unavailable to ${role}. Report what you have; the parent owns lifecycle decisions.`;
  if(role==='check_job'&&name==='hf_jobs'&&!['ps','inspect','logs'].includes(input.operation))return 'check_job may only ps, inspect or logs; the parent submits/cancels/waits.';
  if(role==='check_job'&&name==='read'&&(!scriptPath||typeof input.path!=='string'||resolve(cwd,input.path)!==resolve(cwd,scriptPath)))return 'check_job may read only the immutable script_path supplied by its parent.';
  if(role==='sandbox_task'&&name.startsWith('hf_sandbox_'))return sandboxGrammarError(name,input,handle);
}
export function truncate(text:string,head:number,tail:number) {
  return text.length<=head+tail?text:(text.slice(0,head)+'\n...(truncated)...\n'+text.slice(-tail)).toWellFormed();
}
export function truncateContent(content:{type:string;text?:string}[],head:number,tail:number) {
  const text=content.filter(part=>part.type==='text').map(part=>part.text??'').join('\n');
  const other=content.filter(part=>part.type!=='text');
  return [...(text?[{type:'text',text:truncate(text,head,tail)}]:[]),...other];
}

export async function delegate(pi:ExtensionAPI,role:Role,args:Record<string,any>,ctx:ExtensionToolContext,signal:AbortSignal|undefined,onUpdate?:AgentToolUpdateCallback) {
  if(!args.task?.trim())throw Error('Supply a specific task.');
  if(role==='sandbox_task'&&!args.handle?.trim())throw Error('Supply an existing sandbox handle.');
  if(role==='check_job'&&!args.job_id?.trim())throw Error('Supply a submitted job ID.');
  if(!ctx.model)throw Error('Select a Pi model before delegating.');
  const spec=roles[role];
  const active=new Set(pi.getActiveTools());
  const offered=pi.getAllTools().filter(t=>{
    const name=logicalName(t.name);
    const canonical=!(name.startsWith('hf_')||name.startsWith('hub_'))||t.name===nativeName(name);
    return t.exposure==='direct'&&active.has(t.name)&&canonical&&spec.tools.includes(name)&&!(role==='check_job'&&t.name==='read'&&!args.script_path);
  });
  const needed=role==='check_job'?['hf_jobs']:role==='research'?['hf_fs','hub_repo_details']:['hf_sandbox_exec','hf_sandbox_fs'];
  if(needed.some(name=>!offered.some(tool=>logicalName(tool.name)===name)))throw Error(`Missing active native MCP tools for ${role}. Reconnect hf-intern and retry /ml-intern.`);
  let turns=0,warned=false,forced=false,nudged=false,lengthRetries=0,completionReserve=0;
  const counts=new Map<string,number>();
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:true,maxRetries:2}});
  const loader=new DefaultResourceLoader({cwd:ctx.cwd,agentDir:getAgentDir(),settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    systemPromptOverride:()=>delegatePrompt(role,offered.map(t=>t.name)),
    extensionFactories:[child=>{
      // All tools reuse the parent's implementations and permission pipeline.
      // No extension files or unrelated MCP servers are loaded in the child.
      for(const tool of offered) {
        child.registerTool({name:tool.name,label:logicalName(tool.name),description:tool.description,parameters:tool.parameters as any,
          async execute(_id,input,childSignal,onUpdate) {
            const error=roleError(role,tool.name,input as Record<string,any>,args.handle,args.script_path,ctx.cwd);
            if(error)throw Error(error);
            const outcome=await ctx.executeTool(tool.name,input,{signal:childSignal,onUpdate});
            // Nested inference usage is accounted for by the parent's pipeline.
            return {...outcome.result,usage:undefined,isError:outcome.isError};
          }});
      }
      child.on('before_agent_start',()=>child.setActiveTools(offered.map(t=>t.name)));
      child.on('tool_call',event=>{
        const input=event.input as Record<string,any>;
        const error=forced?'Tool budget exhausted; summarize now.':roleError(role,event.toolName,input,args.handle,args.script_path,ctx.cwd);
        if(error)return {block:true,reason:error};
        const key=event.toolName+JSON.stringify(input,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
        const n=(counts.get(key)??0)+1;counts.set(key,n);
        if(n>=3&&!nudged){nudged=true;child.sendMessage({customType:'ml-delegate-nudge',content:spec.stop[3],display:false},{deliverAs:'steer'});}
      });
      child.on('tool_result',event=>({content:truncateContent(event.content,spec.head,spec.tail) as typeof event.content}));
      child.on('turn_end',(event,c)=>{
        turns++;
        onUpdate?.({content:[{type:'text',text:`${role}: ${turns}/${spec.iterations}`}],details:undefined});
        if(event.message.role!=='assistant'||!['toolUse','length'].includes(event.message.stopReason))return;
        const usage=c.getContextUsage();
        const usable=usage?Math.max(usage.contextWindow-completionReserve,usage.contextWindow/4):1;
        const percent=usage?.tokens==null?0:100*usage.tokens/usable;
        if(turns>spec.iterations+1){c.abort();return;}
        let prompt;
        if(!forced&&(percent>=95||turns>=spec.iterations)) {
          forced=true;child.setActiveTools([]);prompt=percent>=95?spec.stop[1]:spec.stop[2];
        } else if(!warned&&percent>=85){warned=true;prompt=spec.stop[0];}
        if(event.message.role==='assistant'&&event.message.stopReason==='length'&&lengthRetries++<2)prompt='Your response hit the output limit. Finish the summary now with minimal further reasoning.';
        if(prompt)child.sendMessage({customType:'ml-delegate-limit',content:prompt,display:false},{deliverAs:'steer'});
      });
    }],
  });
  await loader.reload();
  if(loader.getExtensions().errors.length)throw Error('Delegate extension loading failed. Fix the configured tools before retrying.');
  const {session}=await createAgentSession({cwd:ctx.cwd,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(ctx.cwd),model:ctx.model,thinkingLevel:pi.getThinkingLevel(),tools:offered.map(t=>t.name)});
  // Reuse the parent's configured provider/auth, not a second inference implementation.
  const provider=ctx.modelRegistry.getProvider(ctx.model.provider);
  if(provider)session.modelRuntime.registerNativeProvider(provider);
  session.agent.streamFunction=(model,context,options)=>{
    completionReserve=options?.maxTokens??0;
    return ctx.modelRegistry.streamSimple(model,context,{...options,signal:AbortSignal.any([AbortSignal.timeout(120000),...(options?.signal?[options.signal]:[]),...(signal?[signal]:[])])});
  };
  const abort=()=>{void session.abort();};signal?.addEventListener('abort',abort,{once:true});
  try {
    signal?.throwIfAborted();
    await session.bindExtensions({mode:'print'});
    await session.prompt([args.context&&`Context: ${args.context}`,args.handle&&`Sandbox handle: ${args.handle}`,args.job_id&&`Job id: ${args.job_id}`,args.script_path&&`Immutable script path: ${args.script_path}`,`Task: ${args.task}`].filter(Boolean).join('\n\n'));
    signal?.throwIfAborted();
    const last=session.messages.findLast(m=>m.role==='assistant');
    if(last?.role!=='assistant'||['error','aborted','length'].includes(last.stopReason))throw Error(`${role} failed: ${last?.role==='assistant'?last.errorMessage||last.stopReason:'no summary'}. Narrow the task and retry.`);
    const text=session.getLastAssistantText();
    if(!text?.trim())throw Error(`${role} produced no summary. Narrow the task and retry.`);
    const usage=session.messages.filter(m=>m.role==='assistant').reduce((total,m)=>{
      if(m.role==='assistant')for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'] as const)total[key]+=m.usage[key];
      if(m.role==='assistant')for(const key of ['input','output','cacheRead','cacheWrite','total'] as const)total.cost[key]+=m.usage.cost[key];
      return total;
    },{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
    return {content:[{type:'text' as const,text}],details:{role,turns},usage};
  } finally {
    signal?.removeEventListener('abort',abort);
    try {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});} finally {session.dispose();}
  }
}
