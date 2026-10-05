import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai';
import {ModelRuntime,ModelRegistry} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import {delegate,truncateContent} from '../runtime/delegate';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'ml-delegate-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
const hf=(name:string)=>`mcp__hf_intern__${name}`;
let toolId=0;
const tool=(name:string,args:any):Partial<AssistantMessage>=>({stopReason:'toolUse',content:[{type:'toolCall',id:`call-${toolId++}`,name,arguments:args}]});
async function setup(reply:(context:any,options:any)=>Partial<AssistantMessage>,names=[hf('hf_fs'),hf('hub_repo_details'),hf('hf_jobs')]) {
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models'),refreshOnCreate:false});
 runtime.registerProvider('ml-offline',{api:'openai-completions',apiKey:'offline',baseUrl:'https://invalid.example',models:[{id:'offline',name:'offline',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2000}],streamSimple:(_m,context,options)=>{
  const stream=createAssistantMessageEventStream();
  const message:AssistantMessage={role:'assistant',content:[],api:'openai-completions',provider:'ml-offline',model:'offline',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now(),...reply(context,options)};
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push(message.stopReason==='error'||message.stopReason==='aborted'?{type:'error',reason:message.stopReason,error:message}:{type:'done',reason:message.stopReason==='pending'?'stop':message.stopReason,message});});
  return stream;
 }});
 const pi:any={getAllTools:()=>names.map(name=>({name,description:'Offline tool',parameters:Type.Object({}, {additionalProperties:true}),exposure:'direct'})),getActiveTools:()=>names,getThinkingLevel:()=> 'high'};
 const executeTool=vi.fn(async(name:string,_input:any)=>{
  const isError=name===hf('hf_fs');
  return {isError,result:{content:[{type:'text',text:isError?'Recoverable lookup error':'Offline result'}],details:{}}};
 });
 const ctx:any={cwd:dir,model:runtime.getModel('ml-offline','offline')!,modelRegistry:new ModelRegistry(runtime),executeTool};
 return {pi,ctx,executeTool};
}
it('forwards only active role tools with canonical names',async()=>{
 const {pi,ctx,executeTool}=await setup(context=>{
  const text=JSON.stringify(context.messages);expect(text).not.toContain('github_read_file');expect(text).not.toContain('unrelated_tool');expect(text).not.toContain('github_list_repos');expect(text).not.toContain('"name":"hf_fs"');
  return {content:[{type:'text',text:'Only allowed tools.'}]};
 });
 const base=pi.getAllTools();pi.getAllTools=()=>[...base,{name:'github_read_file',exposure:'direct'},{name:'unrelated_tool',exposure:'direct'},{name:'github_list_repos',exposure:'model-only'},{name:'hf_fs',exposure:'direct'}];
 const active=pi.getActiveTools();pi.getActiveTools=()=>[...active,'unrelated_tool','github_list_repos','hf_fs'];
 expect((await delegate(pi,'research',{task:'Research'},ctx,undefined)).content[0].text).toBe('Only allowed tools.');expect(executeTool).not.toHaveBeenCalled();
},20000);
it('forwards active native Exa research tools conditionally',async()=>{
 const exa='mcp__exa__web_search_exa';
 const {pi,ctx}=await setup(context=>{const text=JSON.stringify(context.messages);expect(text).toContain(exa);expect(text).toContain('web_search_exa');return {content:[{type:'text',text:'Web-aware summary.'}]};},[hf('hf_fs'),hf('hub_repo_details'),exa]);
 expect((await delegate(pi,'research',{task:'Research current web sources'},ctx,undefined)).content[0].text).toBe('Web-aware summary.');
},20000);
it('inherits inference settings, preserves errors and returns only a summary',async()=>{
 let calls=0;
 const {pi,ctx,executeTool}=await setup((context,options)=>{
  expect(options.reasoning).toBe('high');
  if(calls++===0)return tool(hf('hf_fs'),{operations:[]});
  const previous=context.messages.findLast((m:any)=>m.role==='toolResult');expect(previous.isError).toBe(true);expect(previous.content[0].text).toContain('Recoverable');
  return {content:[{type:'text',text:'Attributed summary; lookup unavailable.'}]};
 });
 const value=await delegate(pi,'research',{task:'Research'},ctx,undefined);expect(value.content[0].text).toBe('Attributed summary; lookup unavailable.');expect(value.usage.totalTokens).toBe(30);expect(executeTool).toHaveBeenCalledOnce();
},20000);
it.each([['research','github_read_file',{path:'README.md'}],['check_job','read',{path:'train.py'}]] as const)('forwards %s local tools through the parent rather than reloading source files',async(role,name,args)=>{
 let calls=0;
 const {pi,ctx,executeTool}=await setup(()=>calls++===0?tool(name,args):{content:[{type:'text',text:'Read summary.'}]},[hf('hf_fs'),hf('hub_repo_details'),hf('hf_jobs'),name]);
 const delegateArgs={task:'Read',job_id:'job',...(role==='check_job'?{script_path:'train.py'}:{})};
 await delegate(pi,role,delegateArgs,ctx,undefined);expect(executeTool).toHaveBeenCalledWith(name,args,expect.objectContaining({signal:expect.any(AbortSignal)}));
},20000);
it('blocks check_job reads outside its supplied immutable path',async()=>{
 let calls=0;
 const {pi,ctx,executeTool}=await setup(()=>calls++===0?tool('read',{path:'other.py'}):{content:[{type:'text',text:'Scoped summary.'}]},[hf('hf_jobs'),'read']);
 await delegate(pi,'check_job',{task:'Read traceback',job_id:'job',script_path:'train.py'},ctx,undefined);expect(executeTool).not.toHaveBeenCalled();
},20000);
it('blocks destructive check_job calls before reaching the parent',async()=>{
 let calls=0;
 const {pi,ctx,executeTool}=await setup(context=>{
  if(calls++===0)return tool(hf('hf_jobs'),{operation:'cancel',args:{job_id:'job'}});
  const previous=context.messages.findLast((m:any)=>m.role==='toolResult');expect(previous.isError).toBe(true);expect(previous.content[0].text).toContain('only');return {content:[{type:'text',text:'Parent must cancel.'}]};
 });
 await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined);expect(executeTool).not.toHaveBeenCalled();
},20000);
it('enforces captured sandbox grammar and exposes no local mutation tools',async()=>{
 let calls=0;const handle='hfsb2:owner:0123456789abcdef01234567';
 const {pi,ctx,executeTool}=await setup(context=>{
  const serialized=JSON.stringify(context.messages);expect(serialized).not.toContain('"name":"write"');expect(serialized).not.toContain('"name":"edit"');
  if(calls++===0)return tool(hf('hf_sandbox_exec'),{cmd:'exec',args:['exec',handle,"python -c 'print(1)'"]});
  expect(context.messages.findLast((m:any)=>m.role==='toolResult').isError).toBe(false);return {content:[{type:'text',text:'Outcome: worked.'}]};
 },[hf('hf_sandbox_exec'),hf('hf_sandbox_fs')]);
 expect((await delegate(pi,'sandbox_task',{task:'Check import',handle},ctx,undefined)).content[0].text).toContain('worked');expect(executeTool.mock.calls[0][1].args[1]).toBe(handle);
},20000);
it('truncates the combined text result rather than every block independently',()=>{
 const content=truncateContent([{type:'text',text:'a'.repeat(6000)},{type:'text',text:'b'.repeat(6000)}],1200,4800);
 expect(content).toHaveLength(1);expect(content[0].text).toHaveLength(1200+4800+'\n...(truncated)...\n'.length);
});
it('does not force another turn when the final allowed turn already summarized',async()=>{
 let calls=0;
 const {pi,ctx}=await setup(()=>calls++<7?tool(hf('hf_jobs'),{operation:'logs',args:{job_id:'job'}}):{content:[{type:'text',text:'Summary on turn eight.'}]});
 expect((await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined)).content[0].text).toBe('Summary on turn eight.');expect(calls).toBe(8);
},20000);
it('stops after eight iterations and requests a tool-free summary',async()=>{
 let calls=0;
 const {pi,ctx,executeTool}=await setup(context=>{
  if(calls++<8)return tool(hf('hf_jobs'),{operation:'logs',args:{job_id:'job'}});
  expect(JSON.stringify(context.messages)).toContain('ITERATION LIMIT');expect(JSON.stringify(context.messages)).toContain('same thing three times');return {content:[{type:'text',text:'One-pass summary.'}]};
 });
 expect((await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined)).content[0].text).toBe('One-pass summary.');expect(calls).toBe(9);expect(executeTool).toHaveBeenCalledTimes(8);
},20000);
it.each([[28000,'85% of your context budget'],[31000,'CONTEXT LIMIT REACHED']])('nudges/stops using Pi context usage (%s tokens)',async(tokens,phrase)=>{
 let calls=0;
 const {pi,ctx}=await setup(context=>{
  if(calls++===0)return {...tool(hf('hf_jobs'),{operation:'logs',args:{job_id:'job'}}),usage:{input:tokens,output:1,cacheRead:0,cacheWrite:0,totalTokens:tokens+1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  expect(JSON.stringify(context.messages)).toContain(phrase);return {content:[{type:'text',text:'Context-limited summary.'}]};
 });
 await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined);expect(calls).toBe(2);
},20000);
it('uses the upstream output-limit recovery prompt',async()=>{
 let calls=0;
 const prompt='[SYSTEM: Your previous response hit the output limit before it finished. Continue: finish the step or produce the summary now, with minimal further reasoning.]';
 const {pi,ctx}=await setup(context=>{
  if(calls++===0)return {stopReason:'length',content:[{type:'text',text:'Partial'}]};
  expect(JSON.stringify(context.messages)).toContain(prompt);return {content:[{type:'text',text:'Finished summary.'}]};
 });
 expect((await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined)).content[0].text).toBe('Finished summary.');
},20000);
it('does not return partial text as success after a provider error',async()=>{
 const {pi,ctx}=await setup(()=>({stopReason:'error',errorMessage:'offline failure',content:[{type:'text',text:'Partial summary'}]}));await expect(delegate(pi,'research',{task:'Research'},ctx,undefined)).rejects.toThrow('offline failure');
},20000);
it('does not call the model or parent for already-cancelled work',async()=>{
 const {pi,ctx,executeTool}=await setup(()=>{throw Error('Must not call model');});const controller=new AbortController();controller.abort();
 await expect(delegate(pi,'research',{task:'Research'},ctx,controller.signal)).rejects.toThrow();expect(executeTool).not.toHaveBeenCalled();
},20000);
it('propagates cancellation to an in-flight forwarded call',async()=>{
 let calls=0;const controller=new AbortController();
 const {pi,ctx,executeTool}=await setup(()=>calls++===0?tool(hf('hf_jobs'),{operation:'logs',args:{job_id:'job'}}):{content:[{type:'text',text:'Must not succeed'}]});
 ctx.executeTool=vi.fn(async(_name,_args,{signal}:any)=>{
  const aborted=new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  controller.abort();return aborted;
 });
 await expect(delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,controller.signal)).rejects.toThrow();expect(ctx.executeTool).toHaveBeenCalledOnce();expect(executeTool).not.toHaveBeenCalled();
},20000);
