import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('node:process',()=>({loadEnvFile:vi.fn()}));
import mlIntern from '../index';
import fixture from './fixtures/hf-intern-tools.json';
import {STATE,emptyState,plan} from '../runtime/state';
import {observeLifecycle,reconcileNamedAttempts} from '../runtime/lifecycle';
import {modePrompt,delegatePrompt} from '../runtime/prompts';
import {roleError,truncate} from '../runtime/delegate';
import {applyBilling,applySessionIsolation,checkCapabilities,expandFiles,resultContent,structured,verifyHfMcpConfig} from '../runtime/contracts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const hf=(name:string)=>`mcp__hf_intern__${name}`;
const remote=()=>structuredClone(fixture.tools).map(t=>({...t,name:hf(t.name),exposure:'direct',sourceInfo:{path:'builtin:mcp'}}));
function harness(options:{missing?:boolean;entries?:any[];flag?:boolean}={}) {
 const handlers=new Map<string,Function[]>(),tools=new Map<string,any>(),commands=new Map<string,any>(),mcpServers=new Map<string,any>();
 let active=['read','bash','unrelated'];
 const entries=options.entries??[];
 const pi:any={
  on:(n:string,f:Function)=>handlers.set(n,[...(handlers.get(n)??[]),f]),
  registerTool:(t:any)=>{tools.set(t.name,t);active.push(t.name);},
  registerMcpServer:(n:string,c:any)=>mcpServers.set(n,c),
  registerFlag:vi.fn(),registerCommand:(n:string,c:any)=>commands.set(n,c),getFlag:()=>options.flag,
  getAllTools:()=>[...(options.missing?[]:remote()),...tools.values(),{name:'read'},{name:'bash'},{name:'unrelated'},{name:'disabled'}],
  getActiveTools:()=>active,setActiveTools:(n:string[])=>{active=[...n];},
  appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data}),sendMessage:vi.fn(),sendUserMessage:vi.fn(),getThinkingLevel:()=> 'high',
 };
 const ctx:any={cwd:process.cwd(),hasUI:true,isIdle:()=>true,isProjectTrusted:()=>true,ui:{notify:vi.fn(),select:vi.fn(),confirm:vi.fn().mockResolvedValue(true),input:vi.fn()},sessionManager:{getBranch:()=>entries}};
 mlIntern(pi);
 const emit=async(n:string,e:any={})=>{let last;for(const f of handlers.get(n)??[])last=await f(e,ctx);return last;};
 const start=async()=>{const prompt=await emit('before_agent_start',{systemPrompt:'Pi'});await emit('agent_start');return prompt;};
 const command=(s='')=>commands.get('ml-intern').handler(s,ctx);
 const state=()=>entries.findLast(e=>e.customType===STATE)?.data;
 // Native result shape, including the complete server result beside display text.
 const result=(name:string,input:any,data:any,extra:any={})=>emit('tool_result',{toolName:hf(name),input,content:[{type:'text',text:'Display text'}],structuredContent:{content:[],structuredContent:data},isError:false,...extra});
 const call=(name:string,input:any,id?:string)=>emit('tool_call',{toolName:hf(name),input,toolCallId:id});
 return {pi,ctx,emit,start,command,state,result,call,tools,mcpServers,entries,active:()=>active};
}
beforeEach(()=>{delete process.env.ML_INTERN_FORCE;delete process.env.GITHUB_TOKEN;delete process.env.HF_BILL_TO;delete process.env.HF_BILLING_RESOURCE_GROUP;});

describe('native MCP activation and resume',()=>{
 it('registers the OAuth-ready server and activates native names without disturbing unrelated tools',async()=>{
  const h=harness();
  expect(h.mcpServers.get('hf-intern')).toMatchObject({url:'https://huggingface.co/mcp?login&bouquet=intern',exposure:'direct'});
  await h.emit('session_start');expect(h.active()).toEqual(['read','bash','unrelated']);
  await h.command('research something');expect(h.pi.sendUserMessage).toHaveBeenCalledWith('research something');
  expect(h.active()).toContain(hf('hf_jobs'));expect(h.active()).not.toContain('hf_jobs');expect(h.active()).not.toContain('disabled');
  const prompt=(await h.emit('before_agent_start',{systemPrompt:'Pi generic tool guidance'})).systemPrompt;
  expect(prompt.startsWith('Pi generic tool guidance')).toBe(true);expect(prompt).toContain('RUNNING JOBS');expect(prompt).toContain(`hf_jobs → ${hf('hf_jobs')}`);
  await h.emit('agent_end');expect(h.state().active).toBe(true);
  await h.command('off');expect(h.active()).toEqual(['read','bash','unrelated']);expect(h.state().active).toBe(false);
 });
 it('restores only the current-process activation delta',async()=>{
  const h=harness();h.pi.setActiveTools([...h.active(),hf('hf_jobs')]);
  await h.emit('session_start');await h.command();await h.command('off');
  expect(h.active()).toEqual(['read','bash','unrelated',hf('hf_jobs')]);
 });
 it('migrates existing session state without discarding saved intent',async()=>{
  const legacy={active:true,namespaces:[],jobs:['job-old'],finished:[],attempts:[],publications:[],waits:0,destinations:{},added:['research']};
  const h=harness({entries:[{type:'custom',customType:STATE,data:legacy}]});await h.emit('session_start');
  expect(h.state()).toMatchObject({active:true,jobs:['job-old'],harness:{build:'0.3.0'}});expect(h.state().sessionId).toEqual(expect.any(String));expect(h.state().added).toBeUndefined();
 });
 it('restores saved intent and answers questions even while discovery is pending',async()=>{
  const initial=harness();await initial.command();initial.ctx.hasUI=false;
  const questions={questions:[{question:'Continue?',header:'Decision',multiSelect:false,options:[{label:'Yes',description:'Proceed'}]}]};
  await initial.tools.get('ask_user_question').execute('q',questions,undefined,undefined,initial.ctx);
  const h=harness({entries:initial.entries});const all=h.pi.getAllTools;
  h.pi.getAllTools=()=>all().filter((t:any)=>!t.name.startsWith('mcp__'));
  await h.emit('session_start');expect(h.state().active).toBe(true);
  expect((await h.call('hf_jobs',{operation:'ps',args:{}})).block).toBe(true);
  await h.emit('input',{source:'interactive',text:'Yes'});expect(h.state().question).toBeUndefined();expect(h.state().active).toBe(true);
  await h.start();
  expect((await h.emit('context',{messages:[{role:'user',content:'Yes'}]})).messages[0].content).toContain('ML tools are not ready');
  expect((await h.call('hf_jobs',{operation:'ps',args:{}})).block).toBe(true);
  h.pi.getAllTools=all;
  expect((await h.start()).systemPrompt).toContain(`hf_jobs → ${hf('hf_jobs')}`);
  expect(await h.call('hf_jobs',{operation:'ps',args:{}})).toBeUndefined();
  const fresh=harness();await fresh.emit('session_start');expect(await fresh.emit('before_agent_start',{})).toBeUndefined();
 });
 it('does not poll or erase intent for missing tools or incompatible schemas',async()=>{
  const h=harness({missing:true,flag:true});await h.emit('session_start');expect(h.state().active).toBe(true);
  const timer=vi.spyOn(globalThis,'setTimeout');
  try {await h.start();expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('has not exposed it yet'),'error');expect(timer).not.toHaveBeenCalled();}
  finally {timer.mockRestore();}
  h.pi.getAllTools=()=>remote().map(t=>({...t,exposure:'codemode'}));
  await h.start();expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('exposure direct'),'error');expect(h.state().active).toBe(true);
  await h.command('off');h.pi.getAllTools=remote;
  expect(await h.emit('before_agent_start',{systemPrompt:'Pi'})).toBeUndefined();expect(h.active()).not.toContain('research');
 });
 it('keeps policies active when a previously available native tool disappears',async()=>{
  const h=harness();await h.command();h.pi.getAllTools=()=>[];await h.start();expect(h.state().active).toBe(true);
  const creation:any={uri:'hf://models/owner/private'};await h.call('create_repo',creation);expect(creation.private).toBe(true);
  expect((await h.call('hf_jobs',{operation:'uv',args:{name:'unapproved'}})).block).toBe(true);
 });
 it('supports flag/force entry after discovery and keeps optional tools disabled',async()=>{
  const flagged=harness({flag:true});await flagged.emit('session_start');await flagged.emit('before_agent_start',{systemPrompt:'Pi'});expect(flagged.active()).toContain('research');
  process.env.ML_INTERN_FORCE='1';const force=harness();await force.emit('session_start');await force.emit('before_agent_start',{systemPrompt:'Pi'});expect(force.active()).toContain('research');
  expect(force.active()).not.toContain(hf('hf_sandbox'));expect(force.active()).not.toContain('sandbox_task');
  await force.command('off');force.pi.setActiveTools([...force.active(),hf('hf_sandbox_exec')]);await force.command();expect(force.active()).not.toContain('sandbox_task');
  await force.command('off');force.pi.setActiveTools([...force.active(),hf('hf_sandbox_fs')]);await force.command();expect(force.active()).toContain('sandbox_task');
  await force.command('off');expect(force.active()).toEqual(expect.arrayContaining([hf('hf_sandbox_exec'),hf('hf_sandbox_fs')]));
 });
 it('gates GitHub tools on the token and activates them only in ML mode',async()=>{
  const absent=harness();expect(absent.tools.has('github_find_examples')).toBe(false);
  process.env.GITHUB_TOKEN='test-token';const present=harness();await present.emit('session_start');expect(present.active()).not.toContain('github_find_examples');
  await present.command();expect(present.active()).toContain('github_find_examples');
 });
});

describe('native workflow policy',()=>{
 it('defines current question and private metrics schemas directly',()=>{
  const h=harness();
  const questions=h.tools.get('ask_user_question').parameters.properties.questions;
  expect(questions).toMatchObject({minItems:1,maxItems:4});
  expect(questions.items.properties.options).toMatchObject({minItems:2,maxItems:4});
  expect(JSON.stringify(questions)).not.toContain('setBudgetUsd');
  expect(h.tools.get('update_plan').parameters.properties.steps.items.required).toContain('label');
  const metrics=h.tools.get('create_trackio').parameters;
  expect(metrics.required).toEqual(['project','namespace']);expect(JSON.stringify(metrics)).not.toContain('Space');
 });
 it('uses fresh whoami namespaces and forgets identity on resume',async()=>{
  const h=harness();await h.command();
  await expect(h.tools.get('create_trackio').execute('t',{project:'example',namespace:'guessed'})).rejects.toThrow('Run hf_whoami');
  await h.call('hf_whoami',{});await h.result('hf_whoami',{}, {account:{name:'owner'},organizations:[{name:'org'}]});
  expect((await h.tools.get('create_trackio').execute('t',{project:'example',namespace:'org'})).details.uri).toContain('/org/');
  await expect(h.tools.get('create_trackio').execute('t',{project:'example',namespace:'other'})).rejects.toThrow('not returned');
  const resumed=harness({entries:h.entries});await resumed.emit('session_start');await resumed.start();
  await expect(resumed.tools.get('create_trackio').execute('t',{project:'example',namespace:'owner'})).rejects.toThrow('Run hf_whoami');
 });
 it('defaults private creation and requires exact publication permission',async()=>{
  const h=harness();await h.command();const input:any={uri:'hf://models/owner/private'};
  await h.call('create_repo',input);expect(input.private).toBe(true);
  const publicRepo={uri:'hf://models/owner/public',private:false};expect((await h.call('create_repo',publicRepo)).block).toBe(true);
  await h.tools.get('request_authorization').execute('a',{kind:'publish',scope:publicRepo.uri,reason:'Publish the requested model.'},undefined,undefined,h.ctx);
  expect(await h.call('create_repo',publicRepo)).toBeUndefined();
  const write={cmd:'put',args:[`${input.uri}/file.txt`],content:'x'};expect((await h.call('hf_fs_write',write)).block).toBe(true);
  await h.result('create_repo',input,{action:'created'});expect(await h.call('hf_fs_write',write)).toBeUndefined();
  await h.result('create_repo',{uri:'hf://models/owner/other',private:false},{action:'created'});
  expect((await h.call('hf_fs_write',{...write,args:['hf://models/owner/other/file.txt']})).block).toBe(true);
  await h.result('create_repo',publicRepo,{action:'created'});expect(await h.call('hf_fs_write',{...write,args:[`${publicRepo.uri}/file.txt`]})).toBeUndefined();
  expect(await h.call('hf_fs_write',{...write,args:[`${input.uri}@dev/file.txt`]})).toBeUndefined();
 });
 it('forgets destination receipts across process and branch changes',async()=>{
  const h=harness();await h.command();const uri='hf://datasets/owner/metrics';await h.result('create_repo',{uri,private:true},{action:'created'});
  const write={cmd:'put',args:[`${uri}/metrics.db`],content:'bytes'};expect(await h.call('hf_fs_write',write)).toBeUndefined();
  const resumed=harness({entries:h.entries});await resumed.emit('session_start');await resumed.start();expect((await resumed.call('hf_fs_write',write)).block).toBe(true);
  await h.emit('session_tree');await h.start();expect((await h.call('hf_fs_write',write)).block).toBe(true);
 });
 it('does not accept failed or existing creation as proof of private visibility',async()=>{
  const h=harness();await h.command();await h.result('create_repo',{uri:'hf://models/x/y'},{action:'created'},{isError:true});expect(h.state().destinations).toEqual({});
  const existing=await h.result('create_repo',{uri:'hf://datasets/x/y',private:true},{action:'exists'});expect(existing.isError).toBe(true);expect(h.state().destinations).toEqual({});
 });
 it('requires scoped user authorization for paid operations without blocking free reads',async()=>{
  const h=harness();await h.command();expect(await h.call('hf_jobs',{operation:'ps',args:{}})).toBeUndefined();
  for(const [name,input] of [['hf_jobs',{operation:'uv',args:{script:'print(1)'}}],['hf_sandbox',{cmd:'create',args:['create']}],['create_repo',{uri:'hf://spaces/owner/demo'}]] as const)expect((await h.call(name,input)).block).toBe(true);
  h.entries.push({type:'message',message:{role:'user',content:'Yes, rent a GPU.'}});expect((await h.call('hf_jobs',{operation:'uv',args:{name:'smoke-check'}})).block).toBe(true);
  await h.tools.get('request_authorization').execute('a',{kind:'compute',scope:'smoke experiment',reason:'Run one bounded job.',estimate:'10 minutes on T4-small'},undefined,undefined,h.ctx);
  expect(h.ctx.ui.confirm).toHaveBeenCalledWith('Authorize paid ML resources?',expect.stringContaining('smoke experiment'));
  for(const args of [{name:'another-experiment'},{}])expect((await h.call('hf_jobs',{operation:'uv',args})).block).toBe(true);
  await h.result('hf_whoami',{}, {account:{name:'owner'}});
  const job:any={operation:'uv',args:{name:'smoke-experiment-check'}};expect(await h.call('hf_jobs',job)).toBeUndefined();expect(job.args).toMatchObject({namespace:'owner',labels:{'ml-intern-session':h.state().sessionId}});
  const sandbox:any={cmd:'create',args:['create','--name','smoke-experiment-import']};expect(await h.call('hf_sandbox',sandbox)).toBeUndefined();expect(sandbox.args).toContain(`ml-intern-session=${h.state().sessionId}`);
  expect(await h.call('create_repo',{uri:'hf://spaces/owner/smoke-experiment-viewer'})).toBeUndefined();
  expect((await h.call('hf_jobs',{operation:'scheduled_run',args:{}})).block).toBe(true);
  await h.command('off');expect(h.state().allowance).toBeUndefined();
 });
 it('resumes the agent after an explicit authorization command',async()=>{
  const h=harness();await h.command();await h.command('allow smoke experiment');
  expect(h.pi.sendMessage).toHaveBeenCalledWith({customType:'ml-intern-authorization',content:'Recorded allow authorization for smoke experiment through /ml-intern.',display:true},{triggerTurn:true});
  expect(h.state().allowance).toBe('smoke experiment');
 });
 it('does not authorize from headless chat text or denied confirmation',async()=>{
  const h=harness();await h.command();h.ctx.hasUI=false;
  const pending=await h.tools.get('request_authorization').execute('a',{kind:'compute',scope:'headless',reason:'Rent a GPU.'},undefined,undefined,h.ctx);expect(pending.terminate).toBe(true);expect(h.state().allowance).toBeUndefined();
  h.ctx.hasUI=true;h.ctx.ui.confirm.mockResolvedValueOnce(false);
  const denied=await h.tools.get('request_authorization').execute('a',{kind:'compute',scope:'headless',reason:'Rent a GPU.'},undefined,undefined,h.ctx);expect(denied.details.authorized).toBe(false);
  expect((await h.call('hf_jobs',{operation:'uv',args:{name:'headless-smoke'}})).block).toBe(true);
  await h.command('allow headless');await h.result('hf_whoami',{}, {account:{name:'owner'}});expect(await h.call('hf_jobs',{operation:'uv',args:{name:'headless-smoke'}})).toBeUndefined();
 });
 it('preserves questions until user input and clears them on explicit exit',async()=>{
  const h=harness();await h.command();h.ctx.hasUI=false;
  const questions={questions:[{question:'Use GPU?',header:'Compute',multiSelect:false,options:[{label:'No',description:'Local only'}]}]};
  await h.tools.get('ask_user_question').execute('q',questions,undefined,undefined,h.ctx);await h.emit('before_agent_start',{systemPrompt:'Pi'});expect(h.state().question).toEqual(questions);
  expect((await h.call('hf_jobs',{operation:'ps',args:{}})).block).toBe(true);
  await h.emit('input',{source:'extension',text:'No'});expect(h.state().question).toEqual(questions);
  await h.emit('input',{source:'interactive',text:'Unrelated update'});expect(h.state().question).toEqual(questions);
  expect(await h.emit('input',{source:'interactive',text:'No'})).toBeUndefined();expect(h.state().question).toBeUndefined();
  await h.tools.get('ask_user_question').execute('q',questions,undefined,undefined,h.ctx);await h.command('off');await h.command();expect(h.state().question).toBeUndefined();
 });
 it('offers an Other answer and does not accept an empty multi-selection',async()=>{
  const h=harness();await h.command();const args={questions:[{question:'Which?',header:'Choice',multiSelect:false,options:[{label:'A',description:'First'},{label:'B',description:'Second'}]}]};
  h.ctx.ui.select.mockResolvedValueOnce('Other (type an answer)');h.ctx.ui.input.mockResolvedValueOnce('Custom');
  expect((await h.tools.get('ask_user_question').execute('q',args,undefined,undefined,h.ctx)).details.answers[0].answer).toBe('Custom');
  h.ctx.ui.confirm.mockResolvedValue(false);const multi={questions:[{...args.questions[0],multiSelect:true}]};
  const unanswered=await h.tools.get('ask_user_question').execute('q2',multi,undefined,undefined,h.ctx);expect(unanswered.terminate).toBe(true);expect(h.state().question).toEqual(multi);
 });
 it('applies billing and expands supported file references before recording dispatch',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ml-policy-'));
  try {
   await writeFile(join(dir,'train.py'),'print(1)');process.env.HF_BILL_TO='payer';process.env.HF_BILLING_RESOURCE_GROUP='group';
   const h=harness();h.ctx.cwd=dir;await h.command();await h.command('allow smoke');const input={operation:'uv',args:{name:'smoke-check',script:'file://train.py'}} as any;
   await h.call('hf_jobs',input,'submit');expect(input.args).toMatchObject({script:'print(1)',namespace:'payer',resource_group_id:'group'});
   expect(h.state().attempts).toEqual([expect.objectContaining({id:'submit',name:'smoke-check',status:'dispatching'})]);
   const resumed=harness({entries:h.entries});await resumed.emit('session_start');await resumed.emit('session_shutdown');expect(resumed.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('smoke-check'),'warning');
  } finally {await rm(dir,{recursive:true,force:true});}
 });
 it('keeps errored and ID-less submissions unknown until exact-name reconciliation',async()=>{
  const h=harness();await h.command();await h.command('allow standing');const input={operation:'uv',args:{name:'smoke',script:'print(1)'}};
  await h.call('hf_jobs',input,'job');const failed=await h.result('hf_jobs',input,{}, {toolCallId:'job',isError:true});expect(failed.content.at(-1).text).toContain('do not automatically replay');
  expect(h.state().attempts[0].status).toBe('unknown');
  const sb={cmd:'create',args:['create','--name','sandbox-smoke']};await h.call('hf_sandbox',sb,'sandbox');await h.result('hf_sandbox',sb,{}, {toolCallId:'sandbox',isError:true});
  const idless={operation:'uv',args:{name:'idless'}};await h.call('hf_jobs',idless,'idless');expect((await h.result('hf_jobs',idless,{}, {toolCallId:'idless'})).isError).toBe(true);
  const id='0123456789abcdef01234567',sandboxId='bbbbbbbbbbbbbbbbbbbbbbbb',other='aaaaaaaaaaaaaaaaaaaaaaaa';
  const labels={'ml-intern-session':h.state().sessionId};
  await h.result('hf_jobs',{operation:'ps',args:{}},{outcome:{jobs:[{id,name:'smoke',owner:{name:'owner'},labels},{id:sandboxId,name:'sandbox-smoke',owner:{name:'owner'},labels},{id:other,name:'smoke-other',owner:{name:'owner'},labels}]}});
  expect(h.state().attempts).toEqual([expect.objectContaining({name:'idless',status:'unknown'})]);expect(h.state().jobs).toContain(`https://huggingface.co/jobs/owner/${id}`);expect(h.state().jobs).toContain(`hfsb2:owner:${sandboxId}`);expect(h.state().jobs).not.toContain(`https://huggingface.co/jobs/owner/${other}`);
 });
 it('tracks full structured lifecycle, cancellation and sandbox termination without importing history',async()=>{
  const h=harness();await h.command();
  for(const id of ['job-1','job-2'])await h.result('hf_jobs',{operation:'uv',args:{}},{outcome:{job:{id}}});
  await h.result('hf_jobs',{operation:'inspect',args:{job_id:'job-2'}},{outcome:{kind:'inspections',inspections:[{job_id:'job-2',job:{status:{stage:'RUNNING'}}}]}});
  await h.result('hf_jobs',{operation:'inspect',args:{job_id:'job-1'}},{outcome:{kind:'inspections',inspections:[{job_id:'job-1',job:{status:{stage:'COMPLETED'}}}]}});
  await h.result('hf_jobs',{operation:'ps',args:{}},{outcome:{jobs:[{id:'unrelated',name:'old-job'}]}});expect(h.state().jobs).not.toContain('unrelated');
  await h.command('off');const warning=h.ctx.ui.notify.mock.calls.find(([m,l]:any[])=>l==='warning'&&m.includes('NOT cancelled'))?.[0];expect(warning).toContain('job-2');expect(warning).not.toContain('job-1');
  await h.command();await h.result('hf_jobs',{operation:'cancel',args:{job_id:'job-2'}},{});expect(h.state().finished).toContain('job-2');
  const handle='hfsb2:owner:0123456789abcdef01234567';await h.result('hf_sandbox',{cmd:'create',args:['create','--name','sandbox']},{handle});await h.result('hf_sandbox',{cmd:'terminate',args:['terminate',handle]},{});expect(h.state().finished).toContain(handle);
 });
 it('normalizes plans, propagates wait cancellation and reserves reviewable Trackio projects',async()=>{
  const h=harness();await h.command();await h.tools.get('update_plan').execute('p',{goal:'Test',steps:[{step:'a',label:'First',status:'in_progress'},{step:'b',label:'Second',status:'in_progress'}]});expect(h.state().plan.steps[1].status).toBe('pending');
  const controller=new AbortController();controller.abort();await expect(h.tools.get('wait').execute('w',{seconds:15,reason:'job'},controller.signal)).rejects.toThrow();
  await h.result('hf_whoami',{}, {account:{name:'owner'}});await expect(h.tools.get('create_trackio').execute('t',{project:'Private Check',namespace:'owner'})).rejects.toThrow('ASCII');
  const reservation=await h.tools.get('create_trackio').execute('t',{project:'private-check',namespace:'owner'});expect(reservation.details).toEqual({uri:'hf://datasets/owner/private-check-metrics',project:'private-check'});expect(reservation.content[0].text).toContain('No hosted dashboard');
 });
});

describe('contracts and fidelity',()=>{
 it('requires native names, direct exposure and captured Jobs/private schemas',()=>{
  expect(()=>checkCapabilities(remote() as any)).not.toThrow();
  expect(()=>checkCapabilities(fixture.tools as any)).toThrow('has not exposed it yet');
  for(const exposure of ['hidden','codemode','deferred'])expect(()=>checkCapabilities(remote().map(t=>({...t,exposure})) as any)).toThrow();
  const old=remote();old.find(t=>t.name===hf('hf_jobs'))!.parameters={type:'object',properties:{}} as any;expect(()=>checkCapabilities(old as any)).toThrow('nested args');
  const unsafe=remote();delete (unsafe.find(t=>t.name===hf('create_repo'))!.parameters as any).properties.private;expect(()=>checkCapabilities(unsafe as any)).toThrow('private creation');
 });
 it('rejects same-named non-Hugging-Face MCP overrides',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ml-provenance-'));
  try {
   await writeFile(join(dir,'mcp.json'),JSON.stringify({mcpServers:{'hf-intern':{url:'https://evil.example/mcp?bouquet=intern'}}}));
   expect(()=>verifyHfMcpConfig('/unused',false,dir)).toThrow('not the Hugging Face intern endpoint');
   await writeFile(join(dir,'mcp.json'),JSON.stringify({mcpServers:{'hf-intern':{url:'https://huggingface.co/mcp?login&bouquet=intern'}}}));
   expect(()=>verifyHfMcpConfig('/unused',false,dir)).not.toThrow();
  } finally {await rm(dir,{recursive:true,force:true});}
 });
 it('stamps session isolation and parses canonical and fallback lifecycle results',()=>{
  const job:any={operation:'uv',args:{name:'run.v1',labels:{custom:'yes','model.id':'qwen/0.6'}}};applySessionIsolation('hf_jobs',job,'session.1','scope v1');
  expect(job.args.name).toBe('run_v1');expect(job.args.labels).toMatchObject({custom:'yes',model_id:'qwen_0_6','ml-intern-session':'session_1','ml-intern-build':'0_3_0','ml-intern-authorization':'scope_v1'});
  const listing:any={operation:'ps',args:{labels:{custom:'release.1'}}};applySessionIsolation('hf_jobs',listing,'session.1','changed-scope');expect(listing.args.labels).toEqual({custom:'release_1','ml-intern-session':'session_1'});
  const sandbox:any={cmd:'create',args:['create','--name','box.v1','--label','release=0.3.0','--label','ml-intern-session=forged']};applySessionIsolation('hf_sandbox',sandbox,'session.1');
  expect(sandbox.args).toEqual(expect.arrayContaining(['--name','box_v1','--label','release=0_3_0','--label','ml-intern-session=session_1']));expect(sandbox.args).not.toContain('ml-intern-session=forged');
  expect(observeLifecycle('hf_jobs',{operation:'uv',args:{namespace:'owner'}},[{type:'text',text:'Started https://huggingface.co/jobs/owner/0123456789abcdef01234567'}]).references).toContain('https://huggingface.co/jobs/owner/0123456789abcdef01234567');
  expect(observeLifecycle('hf_sandbox',{cmd:'create',args:['create']},[{type:'text',text:JSON.stringify({job_id:'0123456789abcdef01234567',namespace:'owner'})}]).references).toEqual(['hfsb2:owner:0123456789abcdef01234567']);
  expect(observeLifecycle('hf_sandbox',{cmd:'status',args:['status','box']},[{type:'text',text:JSON.stringify({status:{stage:'DELETED'}})}]).terminal).toEqual(['box']);
  const state=emptyState();state.sessionId='session.1';state.attempts=[{id:'a',kind:'job',name:'run',attemptedAt:'now',status:'unknown'}];
  reconcileNamedAttempts(state,[{type:'text',text:JSON.stringify({jobs:[{id:'job-1',name:'run',labels:{'ml-intern-session':'session_1'}}]})}]);expect(state.attempts).toEqual([]);
 });
 it('applies payer settings without changing explicit read namespaces or output ownership',()=>{
  const submit:any={operation:'uv',args:{script:'print(1)'}};applyBilling('hf_jobs',submit,'payer','group');expect(submit.args.namespace).toBe('payer');expect(submit.args.resource_group_id).toBe('group');
  const read:any={operation:'logs',args:{namespace:'original',job_id:'job'}};applyBilling('hf_jobs',read,'payer','group');expect(read.args).toEqual({namespace:'original',job_id:'job'});
  expect(()=>applyBilling('hf_jobs',{operation:'run',args:{namespace:'other'}},'payer')).toThrow('Configured payer');
  const sandbox:any={cmd:'create',args:['create','--namespace','payer','--namespace','payer']};applyBilling('hf_sandbox',sandbox,'payer','group');expect(sandbox.args).toEqual(['create','--namespace','payer','--resource-group-id','group']);
  const malformed:any={args:{}};applyBilling('hf_jobs',malformed,'payer');expect(malformed).toEqual({args:{}});
  const output:any={uri:'hf://models/user/result',private:true};applyBilling('create_repo',output,'payer');expect(output.uri).toContain('/user/');
 });
 it('retains the reviewed upstream prompt and explicit Pi adaptations',()=>{
  const names=remote().map(t=>t.name).concat('research','check_job','sandbox_task','update_plan','wait','ask_user_question','create_trackio');
  const text=modePrompt(names,{},new Date('2026-09-25T12:00:00Z'));
  expect(text.replace(/\[Session context:.*\]/,'[Session context: fixed test time, User=unknown]')).toMatchSnapshot();expect(text.match(/push_to_hub/g)!.length).toBeGreaterThanOrEqual(3);
  for(const rule of ['SILENT DATASET SUBSTITUTION','same flavor, batch size and sequence length','CURRENT release','cost to FINISH','short wait','User=unknown'])expect(text.toLowerCase()).toContain(rule.toLowerCase());
  expect(text).not.toContain('wakes you the moment');expect(text).not.toContain("user's dashboard is wired to that Space");expect(text).not.toContain('v-file://');expect(text).toContain('file://train.py');expect(text).toContain('protected session, build, prompt, and authorization labels');expect(text.trim().endsWith('User=unknown]')).toBe(true);
  expect(modePrompt([],{})).not.toContain('RUNNING JOBS (hf_jobs)');expect(delegatePrompt('research',[hf('hf_fs'),hf('hub_repo_details')])).toContain('Recipe table (REQUIRED)');
  const sandboxPrompt=delegatePrompt('sandbox_task',[hf('hf_sandbox_exec'),hf('hf_sandbox_fs')]);expect(sandboxPrompt).toContain('You have two tools');expect(sandboxPrompt).not.toContain('Write each script once with write');
 });
 it('restricts delegate operations',()=>{
  expect(roleError('research','bash',{})).toContain('unavailable');
  expect(roleError('check_job',hf('hf_jobs'),{operation:'cancel'})).toContain('only');expect(roleError('check_job',hf('hf_jobs'),{operation:'logs'})).toBeUndefined();
  expect(roleError('sandbox_task',hf('hf_sandbox_exec'),{cmd:'exec',args:['exec','other','ls']},'expected')).toContain('handle');
  expect(roleError('sandbox_task',hf('hf_sandbox_exec'),{cmd:'exec',args:['other','expected','ls']},'expected')).toContain('repeat cmd');
  expect(roleError('sandbox_task',hf('hf_sandbox_fs'),{cmd:'write',args:['write','expected','/work/file','--text','x']},'expected')).toBeUndefined();expect(truncate('a'.repeat(9000),4800,3200)).toHaveLength(4800+3200+'\n...(truncated)...\n'.length);
 });
 it('expands only supported whole-value file references',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ml-files-'));
  try {await writeFile(join(dir,'train.py'),'print(1)');
   const job={operation:'uv',args:{script:'file://train.py'}};await expandFiles('hf_jobs',job,dir);expect(job.args.script).toBe('print(1)');
   const put={cmd:'put',content:'file://train.py'};await expandFiles('hf_fs_write',put,dir);expect(put.content).toBe('print(1)');
   const sandbox={cmd:'write',args:['write','handle','/train.py','--text','file://train.py']};await expandFiles('hf_sandbox_fs',sandbox,dir);expect(sandbox.args[4]).toBe('print(1)');
   await expect(expandFiles('hf_jobs',{operation:'uv',args:{script:'file://absent.py'}},dir)).rejects.toThrow();
  } finally {await rm(dir,{recursive:true,force:true});}
 });
 it('reads full native results or plain JSON text and validates plans',()=>{
  expect(structured(resultContent({content:[{type:'text',text:'Truncated'}],structuredContent:{content:[],structuredContent:{account:{name:'owner'}}}}))).toEqual({account:{name:'owner'}});
  expect(structured(resultContent({content:[],structuredContent:{content:[{type:'text',text:'{"account":{"name":"owner"}}'}]}}))).toEqual({account:{name:'owner'}});
  expect(structured([{type:'text',text:'{"account":{"name":"owner"}}'}])).toEqual({account:{name:'owner'}});
  expect(()=>plan({goal:'',steps:[]},1)).toThrow();expect(()=>plan({goal:'x',steps:[{step:'x',status:'pending'}]},1)).toThrow('label');expect(emptyState().jobs).toEqual([]);
 });
});
