import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai';
import {ModelRuntime,ModelRegistry} from '@earendil-works/pi-coding-agent';
import {delegate} from '../runtime/delegate';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'ml-delegate-'));process.env.ML_TEST_EVENTS=join(dir,'events');});
afterEach(async()=>{delete process.env.ML_TEST_EVENTS;await rm(dir,{recursive:true,force:true});});

async function setup(reply:(context:any,options:any)=>Partial<AssistantMessage>,names=['hf_fs','hub_repo_details','hf_jobs']) {
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models'),refreshOnCreate:false});
 runtime.registerProvider('ml-offline',{api:'openai-completions',apiKey:'offline',baseUrl:'https://invalid.example',models:[{id:'offline',name:'offline',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2000}],streamSimple:(_m,context,options)=>{
  const stream=createAssistantMessageEventStream();
  const message:AssistantMessage={role:'assistant',content:[],api:'openai-completions',provider:'ml-offline',model:'offline',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now(),...reply(context,options)};
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push(message.stopReason==='error'||message.stopReason==='aborted'?{type:'error',reason:message.stopReason,error:message}:{type:'done',reason:message.stopReason==='pending'?'stop':message.stopReason,message});});
  return stream;
 }});
 const model=runtime.getModel('ml-offline','offline')!;
 const path=resolve('tests/fixtures/delegate-extension.ts');
 const pi:any={getAllTools:()=>names.map(name=>({name,sourceInfo:{path}})),getActiveTools:()=>names,getThinkingLevel:()=> 'high'};
 const ctx:any={cwd:dir,model,modelRegistry:new ModelRegistry(runtime)};
 return {pi,ctx};
}
it('does not expose a registered but inactive optional tool',async()=>{
 const {pi,ctx}=await setup(context=>{
  expect(JSON.stringify(context.messages)).not.toContain('web_search_exa');
  return {content:[{type:'text',text:'No disabled tools.'}]};
 });
 const base=pi.getAllTools();
 pi.getAllTools=()=>[...base,{name:'web_search_exa',sourceInfo:{path:'/disabled-extension.ts'}}];
 const value=await delegate(pi,'research',{task:'Research'},ctx,undefined);
 expect(value.content[0].text).toBe('No disabled tools.');
},20000);
it('uses the real SDK loop, inherits inference settings, keeps errors and returns only a summary',async()=>{
 let calls=0;
 const {pi,ctx}=await setup((context,options)=>{
  expect(options.reasoning).toBe('high');
  if(calls++===0)return {stopReason:'toolUse',content:[{type:'toolCall',id:'lookup',name:'hf_fs',arguments:{operations:[]}}]};
  const tool=context.messages.findLast((m:any)=>m.role==='toolResult');
  expect(tool.isError).toBe(true);expect(tool.content[0].text).toContain('Recoverable');
  return {content:[{type:'text',text:'Attributed summary; service lookup unavailable.'}]};
 });
 const value=await delegate(pi,'research',{task:'Research'},ctx,undefined);
 expect(value.content[0].text).toBe('Attributed summary; service lookup unavailable.');
 expect(value.usage.totalTokens).toBe(30);
 expect(await readFile(process.env.ML_TEST_EVENTS!,'utf8')).toContain('shutdown');
},20000);
it('blocks a destructive operation inside check_job even though the MCP tool exists',async()=>{
 let calls=0;
 const {pi,ctx}=await setup(context=>{
  if(calls++===0)return {stopReason:'toolUse',content:[{type:'toolCall',id:'cancel',name:'hf_jobs',arguments:{operation:'cancel',args:{job_id:'job'}}}]};
  const tool=context.messages.findLast((m:any)=>m.role==='toolResult');expect(tool.isError).toBe(true);expect(tool.content[0].text).toContain('only');
  return {content:[{type:'text',text:'Parent must cancel.'}]};
 });
 await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined);
 expect(await readFile(process.env.ML_TEST_EVENTS!,'utf8')).toBe('shutdown\n');
},20000);
it('uses captured sandbox token grammar and exposes no local mutation tools',async()=>{
 let calls=0;
 const handle='hfsb2:owner:0123456789abcdef01234567';
 const {pi,ctx}=await setup(context=>{
  const serialized=JSON.stringify(context.messages);
  expect(serialized).not.toContain('"name":"write"');expect(serialized).not.toContain('"name":"edit"');
  if(calls++===0)return {stopReason:'toolUse',content:[{type:'toolCall',id:'exec',name:'hf_sandbox_exec',arguments:{cmd:'exec',args:['exec',handle,"python -c 'print(1)'"]}}]};
  const tool=context.messages.findLast((m:any)=>m.role==='toolResult');expect(tool.isError).toBe(false);
  return {content:[{type:'text',text:'- Outcome: worked.\n- Files: none.\n- Names: none.\n- Command: python -c print(1)'}]};
 },['hf_sandbox_exec','hf_sandbox_fs']);
 const output=await delegate(pi,'sandbox_task',{task:'Check import',handle},ctx,undefined);
 expect(output.content[0].text).toContain('Outcome: worked');
 expect(await readFile(process.env.ML_TEST_EVENTS!,'utf8')).toContain('"args":["exec","hfsb2:owner:');
},20000);
it('returns structured lifecycle observations from check_job',async()=>{
 let calls=0;
 const {pi,ctx}=await setup(()=>calls++===0
  ? {stopReason:'toolUse',content:[{type:'toolCall',id:'inspect',name:'hf_jobs',arguments:{operation:'inspect',args:{job_id:'job-complete'}}}]}
  : {content:[{type:'text',text:'- Status: finished.'}]});
 const output=await delegate(pi,'check_job',{task:'Check completion',job_id:'job-complete'},ctx,undefined);
 expect(output.details.lifecycle.references).toContain('job-complete');
 expect(output.details.lifecycle.terminal).toContain('job-complete');
},20000);
it('does not force another turn when the final allowed turn already summarized',async()=>{
 let calls=0;
 const {pi,ctx}=await setup(()=>calls++<7
  ? {stopReason:'toolUse',content:[{type:'toolCall',id:'read-'+calls,name:'hf_jobs',arguments:{operation:'logs',args:{job_id:'job'}}}]}
  : {content:[{type:'text',text:'Summary on turn eight.'}]});
 const output=await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined);
 expect(output.content[0].text).toBe('Summary on turn eight.');expect(calls).toBe(8);
},20000);
it('stops check_job after eight iterations and requests a tool-free summary',async()=>{
 let calls=0;
 const {pi,ctx}=await setup(context=>{
  if(calls++<8)return {stopReason:'toolUse',content:[{type:'toolCall',id:'read-'+calls,name:'hf_jobs',arguments:{operation:'logs',args:{job_id:'job'}}}]};
  expect(JSON.stringify(context.messages)).toContain('[SYSTEM: ITERATION LIMIT]');
  expect(JSON.stringify(context.messages)).toContain('same thing three times');
  return {content:[{type:'text',text:'One-pass summary.'}]};
 });
 const output=await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined);
 expect(output.content[0].text).toBe('One-pass summary.');expect(calls).toBe(9);
 expect((await readFile(process.env.ML_TEST_EVENTS!,'utf8')).split('\n').filter(l=>l.startsWith('{'))).toHaveLength(8);
},20000);
it.each([[28000,'85%'],[31000,'CONTEXT LIMIT REACHED']])('nudges/stops using Pi context usage (%s tokens)',async(tokens,phrase)=>{
 let calls=0;
 const {pi,ctx}=await setup(context=>{
  if(calls++===0)return {stopReason:'toolUse',content:[{type:'toolCall',id:'read',name:'hf_jobs',arguments:{operation:'logs',args:{job_id:'job'}}}],usage:{input:tokens,output:1,cacheRead:0,cacheWrite:0,totalTokens:tokens+1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  expect(JSON.stringify(context.messages)).toContain(phrase);
  return {content:[{type:'text',text:'Context-limited summary.'}]};
 });
 await delegate(pi,'check_job',{task:'Check',job_id:'job'},ctx,undefined);
 expect(calls).toBe(2);
},20000);
it('does not return partial text as success after a provider error',async()=>{
 const {pi,ctx}=await setup(()=>({stopReason:'error',errorMessage:'offline failure',content:[{type:'text',text:'Partial summary'}]}));
 await expect(delegate(pi,'research',{task:'Research'},ctx,undefined)).rejects.toThrow('offline failure');
 expect(await readFile(process.env.ML_TEST_EVENTS!,'utf8')).toContain('shutdown');
},20000);
it('aborts an already-cancelled delegation and closes its extensions',async()=>{
 const {pi,ctx}=await setup(()=>{throw Error('Must not call model');});
 const controller=new AbortController();controller.abort();
 await expect(delegate(pi,'research',{task:'Research'},ctx,controller.signal)).rejects.toThrow();
 expect(await readFile(process.env.ML_TEST_EVENTS!,'utf8')).toContain('shutdown');
},20000);
