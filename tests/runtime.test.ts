import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('node:process',()=>({loadEnvFile:vi.fn()}));
import mlIntern from '../index';
import fixture from './fixtures/hf-intern-tools.json';
import {STATE,emptyState,plan} from '../runtime/state';
import {modePrompt,delegatePrompt} from '../runtime/prompts';
import {roleError,truncate} from '../runtime/delegate';
import {applyBilling,checkCapabilities,expandFiles,isHfProxyCall,structured} from '../runtime/contracts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function harness(options:{missing?:boolean;entries?:any[];flag?:boolean}={}) {
 const handlers=new Map<string,Function[]>(),tools=new Map<string,any>(),commands=new Map<string,any>();
 let active=['read','bash','unrelated'];
 const entries=options.entries??[];
 const remote=options.missing?[]:fixture.tools.map(t=>({...t,sourceInfo:{path:'/external-adapter.ts'}}));
 const pi:any={
  on:(n:string,f:Function)=>handlers.set(n,[...(handlers.get(n)??[]),f]),
  registerTool:(t:any)=>{tools.set(t.name,t);active.push(t.name);},
  registerFlag:vi.fn(),registerCommand:(n:string,c:any)=>commands.set(n,c),getFlag:()=>options.flag,
  getAllTools:()=>[...remote,...tools.values(),{name:'read'},{name:'bash'},{name:'unrelated'},{name:'disabled'}],
  getActiveTools:()=>active,setActiveTools:(n:string[])=>{active=[...n];},
  appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data}),sendUserMessage:vi.fn(),getThinkingLevel:()=> 'high',
 };
 const ctx:any={cwd:process.cwd(),hasUI:true,isIdle:()=>true,ui:{notify:vi.fn(),select:vi.fn(),confirm:vi.fn().mockResolvedValue(true)},sessionManager:{getBranch:()=>entries}};
 mlIntern(pi);
 const emit=async(n:string,e:any={})=>{let last;for(const f of handlers.get(n)??[])last=await f(e,ctx);return last;};
 const command=(s='')=>commands.get('ml-intern').handler(s,ctx);
 const state=()=>entries.findLast(e=>e.customType===STATE)?.data;
 return {pi,ctx,emit,command,state,tools,entries,active:()=>active};
}
beforeEach(()=>{delete process.env.ML_INTERN_FORCE;delete process.env.GITHUB_TOKEN;delete process.env.HF_BILL_TO;delete process.env.HF_BILLING_RESOURCE_GROUP;});

describe('real registered extension lifecycle',()=>{
 it('preserves unrelated disabled tools and remains active across turns',async()=>{
  const h=harness();await h.emit('session_start');expect(h.active()).toEqual(['read','bash','unrelated']);
  await h.command('research something');expect(h.pi.sendUserMessage).toHaveBeenCalledWith('research something');
  expect(h.active()).not.toContain('disabled');
  expect((await h.emit('before_agent_start',{systemPrompt:'Pi harness'})).systemPrompt).toContain('Pi harness');
  await h.emit('agent_end');
  expect((await h.emit('before_agent_start',{systemPrompt:'Pi harness'})).systemPrompt).toContain('HALLUCINATED IMPORTS');
  await h.command('off');expect(h.active()).toEqual(['read','bash','unrelated']);expect(h.state().active).toBe(false);expect(h.state()).not.toHaveProperty('added');
 });
 it('restores only the current-process activation delta',async()=>{
  const h=harness();h.pi.setActiveTools([...h.active(),'hf_jobs']);
  await h.emit('session_start');await h.command();await h.command('off');
  expect(h.active()).toEqual(['read','bash','unrelated','hf_jobs']);
  const resumed=harness({entries:h.entries});await resumed.emit('session_start');await resumed.command();await resumed.command('off');
  expect(resumed.active()).toEqual(['read','bash','unrelated']);
 });
 it('restores mode on resume, not on an unrelated new session',async()=>{
  const first=harness();await first.emit('session_start');await first.command();
  const resumed=harness({entries:first.entries});await resumed.emit('session_start');expect(resumed.state().active).toBe(true);
  const fresh=harness();await fresh.emit('session_start');expect(await fresh.emit('before_agent_start',{})).toBeUndefined();
 });
 it('allows only namespaces from the latest whoami result and forgets them on resume',async()=>{
  const first=harness();await first.emit('session_start');await first.command();
  await expect(first.tools.get('create_trackio').execute('t',{project:'example',namespace:'guessed'})).rejects.toThrow('Run hf_whoami now');
  await first.emit('tool_call',{toolName:'hf_whoami',input:{}});
  await first.emit('tool_result',{toolName:'hf_whoami',input:{},content:[{type:'text',text:'structuredContent:\n{"account":{"name":"current-user"},"organizations":[{"name":"current-org"}]}'}],details:{},isError:false});
  expect((await first.tools.get('create_trackio').execute('t',{project:'example',namespace:'current-org'})).details.uri).toContain('/current-org/');
  await expect(first.tools.get('create_trackio').execute('t',{project:'example',namespace:'other-org'})).rejects.toThrow('not returned');
  const resumed=harness({entries:first.entries});await resumed.emit('session_start');
  expect((await resumed.emit('before_agent_start',{systemPrompt:'Pi'})).systemPrompt).toContain('User=unknown');
  await expect(resumed.tools.get('create_trackio').execute('t',{project:'example',namespace:'current-user'})).rejects.toThrow('Run hf_whoami now');
 });
 it('gates GitHub tools on the token and activates them only in ML mode',async()=>{
  const absent=harness();await absent.emit('session_start');expect(absent.tools.has('github_find_examples')).toBe(false);
  process.env.GITHUB_TOKEN='test-token';const present=harness();expect(present.tools.has('github_find_examples')).toBe(true);
  await present.emit('session_start');expect(present.active()).not.toContain('github_find_examples');
  await present.command();expect(present.active()).toContain('github_find_examples');
 });
 it('wires flag/force entry and fails missing prerequisites without enabling ML tools',async()=>{
  const flagged=harness({flag:true});await flagged.emit('session_start');expect(flagged.state().active).toBe(true);
  const missing=harness({missing:true,flag:true});await missing.emit('session_start');expect(missing.state().active).toBe(false);await missing.command();expect(missing.active()).not.toContain('research');expect(missing.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('requires direct MCP'), 'error');
  process.env.ML_INTERN_FORCE='1';const force=harness();await force.emit('session_start');expect(force.state().active).toBe(true);
 });
 it('validates capabilities on activation without failing open during a later turn',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  h.pi.getAllTools=()=>[];
  expect((await h.emit('before_agent_start',{systemPrompt:'Pi'})).systemPrompt).toContain('Pi');
  expect(h.state().active).toBe(true);
  expect((await h.emit('tool_call',{toolCallId:'proxy',toolName:'mcp',input:{tool:'hf_jobs'}})).block).toBe(true);
 });
 it('keeps optional tools disabled and exposes sandbox_task only with both child tools',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  expect(h.active()).not.toContain('hf_sandbox');expect(h.active()).not.toContain('sandbox_task');
  await h.command('off');h.pi.setActiveTools([...h.active(),'hf_sandbox_exec']);
  await h.command();expect(h.active()).not.toContain('sandbox_task');
  await h.command('off');h.pi.setActiveTools([...h.active(),'hf_sandbox_fs']);
  await h.command();expect(h.active()).toContain('sandbox_task');
  await h.command('off');expect(h.active()).toEqual(expect.arrayContaining(['hf_sandbox_exec','hf_sandbox_fs']));expect(h.active()).not.toContain('sandbox_task');
 });
 it('preserves job references and warns on exit without cancelling',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  await h.emit('tool_result',{toolName:'hf_jobs',input:{operation:'uv',args:{}},content:[{type:'text',text:'structuredContent:\n{"outcome":{"job":{"id":"job-1"}}}'}],details:{},isError:false});
  await h.command('off');expect(h.state().jobs).toContain('job-1');expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('NOT cancelled'),'warning');
 });
 it('defaults creation to private and refuses writes without known creation',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  const input:any={uri:'hf://models/owner/model'};await h.emit('tool_call',{toolName:'create_repo',input});expect(input.private).toBe(true);
  const explicit:any={uri:'hf://models/owner/public',private:false};
  expect((await h.emit('tool_call',{toolName:'create_repo',input:explicit})).block).toBe(true);
  await h.tools.get('request_authorization').execute('a',{kind:'publish',scope:'hf://models/owner/public',reason:'The requested model should be public.'},undefined,undefined,h.ctx);
  expect(h.ctx.ui.confirm).toHaveBeenCalledWith('Authorize public artifact?',expect.stringContaining('hf://models/owner/public'));
  expect(await h.emit('tool_call',{toolName:'create_repo',input:explicit})).toBeUndefined();
  expect((await h.emit('tool_call',{toolName:'hf_fs_write',input:{cmd:'put',args:['hf://models/owner/model/file.txt'],content:'x'}})).block).toBe(true);
  await h.emit('tool_result',{toolName:'create_repo',input,content:[{type:'text',text:'structuredContent:\n{"action":"created"}'}],details:{},isError:false});
  expect(await h.emit('tool_call',{toolName:'hf_fs_write',input:{cmd:'put',args:['hf://models/owner/model/file.txt'],content:'x'}})).toBeUndefined();
  expect(await h.emit('tool_call',{toolName:'hf_fs_write',input:{cmd:'put',args:['hf://models/owner/model@dev/file.txt'],content:'x'}})).toBeUndefined();
  await h.emit('tool_result',{toolName:'create_repo',input:{uri:'hf://models/owner/other',private:false},content:[{type:'text',text:'structuredContent:\n{"action":"created"}'}],details:{},isError:false});
  expect((await h.emit('tool_call',{toolName:'hf_fs_write',input:{cmd:'put',args:['hf://models/owner/other/file.txt'],content:'x'}})).block).toBe(true);
  await h.emit('tool_result',{toolName:'create_repo',input:explicit,content:[{type:'text',text:'structuredContent:\n{"action":"created"}'}],details:{},isError:false});
  expect(await h.emit('tool_call',{toolName:'hf_fs_write',input:{cmd:'put',args:['hf://models/owner/public/file.txt'],content:'x'}})).toBeUndefined();
 });
 it('forgets private creation receipts across process and branch changes',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  const uri='hf://datasets/owner/metrics';
  await h.emit('tool_result',{toolName:'create_repo',input:{uri,private:true},content:[{type:'text',text:'structuredContent:\n{"action":"created"}'}],details:{},isError:false});
  const input={cmd:'put',args:[`${uri}/metrics.db`],content:'bytes'};
  expect(await h.emit('tool_call',{toolName:'hf_fs_write',input})).toBeUndefined();
  const resumed=harness({entries:h.entries});await resumed.emit('session_start');
  expect((await resumed.emit('tool_call',{toolName:'hf_fs_write',input})).block).toBe(true);
  await h.emit('session_tree');expect((await h.emit('tool_call',{toolName:'hf_fs_write',input})).block).toBe(true);
 });
 it('requires direct user controls for paid operations without blocking free reads',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  expect(await h.emit('tool_call',{toolName:'hf_jobs',input:{operation:'ps',args:{}}})).toBeUndefined();
  for(const [toolName,input] of [['hf_jobs',{operation:'uv',args:{script:'print(1)'}}],['hf_sandbox',{cmd:'create',args:['create']}],['create_repo',{uri:'hf://spaces/owner/demo'}]] as const)
    expect((await h.emit('tool_call',{toolName,input})).block).toBe(true);
  h.entries.push({type:'message',message:{role:'user',content:'Do not rent compute for smoke experiment.'}});
  expect((await h.emit('tool_call',{toolName:'hf_jobs',input:{operation:'uv',args:{name:'smoke-experiment-check',script:'print(1)'}}})).block).toBe(true);
  await h.tools.get('request_authorization').execute('a',{kind:'compute',scope:'smoke experiment',reason:'Run one same-shape smoke and the bounded training job.',estimate:'about 10 minutes on T4-small'},undefined,undefined,h.ctx);
  expect(h.ctx.ui.confirm).toHaveBeenCalledWith('Authorize paid ML resources?',expect.stringContaining('smoke experiment'));
  expect((await h.emit('tool_call',{toolName:'hf_jobs',input:{operation:'uv',args:{name:'another-experiment',script:'print(1)'}}})).block).toBe(true);
  expect((await h.emit('tool_call',{toolName:'hf_jobs',input:{operation:'uv',args:{script:'print(1)'}}})).block).toBe(true);
  expect((await h.emit('tool_call',{toolName:'create_repo',input:{uri:'hf://spaces/owner/other-demo'}})).block).toBe(true);
  expect(await h.emit('tool_call',{toolName:'hf_jobs',input:{operation:'uv',args:{name:'smoke-experiment-check',script:'print(1)'}}})).toBeUndefined();
  expect(await h.emit('tool_call',{toolName:'hf_sandbox',input:{cmd:'create',args:['create','--name','smoke-experiment-import']}})).toBeUndefined();
  expect(await h.emit('tool_call',{toolName:'create_repo',input:{uri:'hf://spaces/owner/smoke-experiment-viewer'}})).toBeUndefined();
  await h.command('off');expect(h.state().allowance).toBeUndefined();
 });
 it('does not authorize from headless chat text or a denied confirmation',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  h.ctx.hasUI=false;
  const pending=await h.tools.get('request_authorization').execute('a',{kind:'compute',scope:'headless-run',reason:'Rent a GPU.'},undefined,undefined,h.ctx);
  expect(pending.terminate).toBe(true);expect(h.state().allowance).toBeUndefined();
  h.entries.push({type:'message',message:{role:'user',content:'Yes, do it.'}});
  expect((await h.emit('tool_call',{toolName:'hf_jobs',input:{operation:'uv',args:{name:'headless-run-smoke'}}})).block).toBe(true);
  h.ctx.hasUI=true;h.ctx.ui.confirm.mockResolvedValueOnce(false);
  const denied=await h.tools.get('request_authorization').execute('a',{kind:'compute',scope:'headless-run',reason:'Rent a GPU.'},undefined,undefined,h.ctx);
  expect(denied.details.authorized).toBe(false);expect(denied.terminate).toBe(true);expect(h.state().allowance).toBeUndefined();
  await h.command('allow headless-run');
  expect(await h.emit('tool_call',{toolName:'hf_jobs',input:{operation:'uv',args:{name:'headless-run-smoke'}}})).toBeUndefined();
 });
 it('preserves a headless question until a new user turn',async()=>{
  const h=harness();await h.emit('session_start');await h.command();h.ctx.hasUI=false;
  const questions={questions:[{question:'Use GPU?',header:'Compute',multiSelect:false,options:[{label:'No',description:'Local only'}]}]};
  await h.tools.get('ask_user_question').execute('q',questions,undefined,undefined,h.ctx);
  await h.emit('before_agent_start',{systemPrompt:'Pi'});expect(h.state().question).toEqual(questions);
  const resumed=harness({entries:h.entries});await resumed.emit('session_start');
  expect((await resumed.emit('tool_call',{toolName:'hf_jobs',input:{operation:'ps',args:{}}})).block).toBe(true);
  const reply=await resumed.emit('input',{source:'interactive',text:'No'});
  expect(reply).toBeUndefined();expect(resumed.state().question).toBeUndefined();
  resumed.ctx.hasUI=false;await resumed.tools.get('ask_user_question').execute('q',questions,undefined,undefined,resumed.ctx);
  resumed.ctx.hasUI=true;await resumed.command('off');await resumed.command();
  expect(await resumed.emit('tool_call',{toolName:'hf_jobs',input:{operation:'ps',args:{}}})).toBeUndefined();
 });
 it('hides only confirmed terminal jobs from exit warnings',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  for(const id of ['job-1','job-2'])await h.emit('tool_result',{toolName:'hf_jobs',input:{operation:'uv',args:{}},content:[{type:'text',text:`structuredContent:\n{"outcome":{"job":{"id":"${id}"}}}`}],details:{},isError:false});
  await h.emit('tool_result',{toolName:'hf_jobs',input:{operation:'inspect',args:{job_id:'job-2'}},content:[{type:'text',text:'structuredContent:\n{"outcome":{"kind":"inspections","inspections":[{"job_id":"job-2","job":{"status":{"stage":"RUNNING"}}}]}}'}],details:{},isError:false});
  await h.emit('tool_result',{toolName:'hf_jobs',input:{operation:'inspect',args:{job_id:'job-1'}},content:[{type:'text',text:'structuredContent:\n{"outcome":{"kind":"inspections","inspections":[{"job_id":"job-1","job":{"status":{"stage":"COMPLETED"}}}]}}'}],details:{},isError:false});
  expect(h.state().finished).not.toContain('job-2');expect(h.state().jobs).toContain('job-1');expect(h.state().finished).toContain('job-1');
  await h.command('off');const warning=h.ctx.ui.notify.mock.calls.find(([message,level]:any[])=>level==='warning'&&message.includes('NOT cancelled'))?.[0];
  expect(warning).toContain('job-2');expect(warning).not.toContain('job-1');
 });
 it('reconciles delegate checks and successful cancellation or sandbox termination',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  for(const id of ['job-1','job-2'])await h.emit('tool_result',{toolName:'hf_jobs',input:{operation:'uv',args:{}},content:[{type:'text',text:`structuredContent:\n{"outcome":{"job":{"id":"${id}"}}}`}],details:{},isError:false});
  await h.emit('tool_result',{toolName:'hf_jobs',input:{operation:'ps',args:{}},content:[{type:'text',text:'https://huggingface.co/jobs/owner/aaaaaaaaaaaaaaaaaaaaaaaa'}],details:{},isError:false});
  expect(h.state().jobs).not.toContain('https://huggingface.co/jobs/owner/aaaaaaaaaaaaaaaaaaaaaaaa');
  await h.emit('tool_result',{toolName:'check_job',input:{job_id:'job-1'},content:[{type:'text',text:'finished'}],details:{role:'check_job',turns:2,lifecycle:{references:['job-1'],terminal:['job-1']}},isError:false});
  expect(h.state().finished).toContain('job-1');
  await h.emit('tool_result',{toolName:'hf_jobs',input:{operation:'cancel',args:{job_id:'job-2'}},content:[{type:'text',text:'cancelled'}],details:{},isError:false});
  expect(h.state().finished).toContain('job-2');
  const handle='hfsb2:owner:0123456789abcdef01234567';
  await h.emit('tool_result',{toolName:'hf_sandbox',input:{cmd:'create',args:['create','--name','scope-sandbox']},content:[{type:'text',text:`structuredContent:\n{"handle":"${handle}"}`}],details:{},isError:false});
  await h.emit('tool_result',{toolName:'hf_sandbox',input:{cmd:'terminate',args:['terminate',handle]},content:[{type:'text',text:'terminated'}],details:{},isError:false});
  expect(h.state().finished).toContain(handle);
 });
 it('persists submissions before dispatch and restores unresolved attempts after a crash gap',async()=>{
  const h=harness();await h.emit('session_start');await h.command();await h.command('allow standing');
  const input={operation:'uv',args:{name:'crash-gap',script:'print(1)'}};
  await h.emit('tool_call',{toolCallId:'crash-call',toolName:'hf_jobs',input});
  expect(h.state().attempts).toEqual([expect.objectContaining({id:'crash-call',kind:'job',name:'crash-gap',status:'dispatching'})]);
  const resumed=harness({entries:h.entries});await resumed.emit('session_start');
  expect(resumed.state().attempts).toEqual([expect.objectContaining({name:'crash-gap',status:'dispatching'})]);
  await resumed.emit('session_shutdown');expect(resumed.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('crash-gap'),'warning');
 });
 it('distinguishes pre-dispatch failures from uncertain billable attempts',async()=>{
  const h=harness();await h.emit('session_start');await h.command();await h.command('allow standing');
  const safe={operation:'uv',args:{name:'safe-retry',script:'print(1)'}};
  await h.emit('tool_call',{toolCallId:'safe',toolName:'hf_jobs',input:safe});
  expect(await h.emit('tool_result',{toolCallId:'safe',toolName:'hf_jobs',input:safe,content:[{type:'text',text:'Authenticate'}],details:{error:'auth_required',isError:true},isError:false})).toBeUndefined();
  expect(h.state().attempts).toEqual([]);
  const job={operation:'uv',args:{name:'smoke-experiment-check',script:'print(1)'}};
  await h.emit('tool_call',{toolCallId:'job-unknown',toolName:'hf_jobs',input:job});
  const changed=await h.emit('tool_result',{toolCallId:'job-unknown',toolName:'hf_jobs',input:job,content:[{type:'text',text:'Connection lost'}],details:{error:'call_failed'},isError:true});
  expect(changed.content.at(-1).text).toContain('do not automatically replay');
  expect(h.state().attempts).toContainEqual(expect.objectContaining({name:'smoke-experiment-check',status:'unknown'}));
  const sandboxInput={cmd:'create',args:['create','--name','smoke-experiment-sandbox']};
  await h.emit('tool_call',{toolCallId:'sandbox-unknown',toolName:'hf_sandbox',input:sandboxInput});
  const sandbox=await h.emit('tool_result',{toolCallId:'sandbox-unknown',toolName:'hf_sandbox',input:sandboxInput,content:[{type:'text',text:'Aborted'}],details:{error:'aborted'},isError:false});
  expect(sandbox.content.at(-1).text).toContain('do not automatically replay');
  expect(h.state().attempts).toContainEqual(expect.objectContaining({kind:'sandbox',name:'smoke-experiment-sandbox',status:'unknown'}));
  await h.command('off');expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('smoke-experiment-check'),'warning');
 });
 it('marks ID-less successes unknown and reconciles only exact named ps results',async()=>{
  const h=harness();await h.emit('session_start');await h.command();await h.command('allow standing');
  const input={operation:'uv',args:{name:'smoke',script:'print(1)'}};
  await h.emit('tool_call',{toolCallId:'ambiguous',toolName:'hf_jobs',input});
  const changed=await h.emit('tool_result',{toolCallId:'ambiguous',toolName:'hf_jobs',input,content:[{type:'text',text:'Accepted'}],details:{server:'hf-intern'},isError:false});
  expect(changed.isError).toBe(true);expect(changed.content.at(-1).text).toContain('Do not automatically replay');
  expect(h.state().attempts).toContainEqual(expect.objectContaining({name:'smoke',status:'unknown'}));
  const sandboxInput={cmd:'create',args:['create','--name','sandbox-smoke']};
  await h.emit('tool_call',{toolCallId:'sandbox-list',toolName:'hf_sandbox',input:sandboxInput});
  await h.emit('tool_result',{toolCallId:'sandbox-list',toolName:'hf_sandbox',input:sandboxInput,content:[{type:'text',text:'Connection lost'}],details:{error:'call_failed'},isError:true});
  const id='0123456789abcdef01234567';
  const sandboxId='bbbbbbbbbbbbbbbbbbbbbbbb';
  const other='aaaaaaaaaaaaaaaaaaaaaaaa';
  await h.emit('tool_result',{toolCallId:'list',toolName:'hf_jobs',input:{operation:'ps',args:{}},content:[{type:'text',text:`structuredContent:\n${JSON.stringify({outcome:{jobs:[{id,name:'smoke',owner:{name:'owner'}},{id:sandboxId,name:'sandbox-smoke',owner:{name:'owner'}},{id:other,name:'smoke-other',owner:{name:'owner'}}]}})}`}],details:{},isError:false});
  expect(h.state().attempts).toEqual([]);
  expect(h.state().jobs).toContain(`https://huggingface.co/jobs/owner/${id}`);
  expect(h.state().jobs).toContain(`hfsb2:owner:${sandboxId}`);
  expect(h.state().jobs).not.toContain(`https://huggingface.co/jobs/owner/${other}`);
 });
 it('does not treat a failed creation as authorization to upload',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  await h.emit('tool_result',{toolName:'create_repo',input:{uri:'hf://models/x/y'},content:[],details:{error:'tool_error'},isError:false});
  expect(h.state().destinations).toEqual({});
  const existing=await h.emit('tool_result',{toolName:'create_repo',input:{uri:'hf://datasets/x/y',private:true},content:[{type:'text',text:'structuredContent:\n{"action":"exists"}'}],details:{},isError:false});
  expect(existing.isError).toBe(true);expect(h.state().destinations).toEqual({});
 });
 it('normalizes the real plan tool',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  await h.tools.get('update_plan').execute('p',{goal:'Test',steps:[{step:'a',status:'in_progress'},{step:'b',status:'in_progress'}]});
  expect(h.state().plan.steps[1].status).toBe('pending');
 });
 it('wait cancellation propagates and Trackio uses reviewable project IDs',async()=>{
  const h=harness();await h.emit('session_start');await h.command();
  const controller=new AbortController();controller.abort();
  await expect(h.tools.get('wait').execute('w',{seconds:15,reason:'job'},controller.signal)).rejects.toThrow();
  await h.emit('tool_call',{toolName:'hf_whoami',input:{}});
  await h.emit('tool_result',{toolName:'hf_whoami',input:{},content:[{type:'text',text:'structuredContent:\n{"account":{"name":"owner"}}'}],details:{},isError:false});
  await expect(h.tools.get('create_trackio').execute('t',{project:'Private Check',namespace:'owner'})).rejects.toThrow('ASCII');
  expect(h.tools.get('create_trackio').parameters.required).toContain('namespace');
  const reservation=await h.tools.get('create_trackio').execute('t',{project:'private-check',namespace:'owner'});
  expect(reservation.details).toEqual({uri:'hf://datasets/owner/private-check-metrics',project:'private-check'});
  expect(reservation.content[0].text).toContain('No hosted dashboard');
 });
});

describe('contracts and fidelity',()=>{
 it('applies payer settings without changing explicit read namespaces or output ownership',()=>{
  const submit:any={operation:'uv',args:{script:'print(1)'}};applyBilling('hf_jobs',submit,'payer','group');expect(submit.args.namespace).toBe('payer');expect(submit.args.resource_group_id).toBe('group');
  const read:any={operation:'logs',args:{namespace:'original',job_id:'job'}};applyBilling('hf_jobs',read,'payer','group');expect(read.args).toEqual({namespace:'original',job_id:'job'});
  expect(()=>applyBilling('hf_jobs',{operation:'run',args:{namespace:'other'}},'payer')).toThrow('Configured payer');
  const sandbox:any={cmd:'create',args:['create','--namespace','payer','--namespace','payer']};applyBilling('hf_sandbox',sandbox,'payer','group');expect(sandbox.args).toEqual(['create','--namespace','payer','--resource-group-id','group']);
  const malformed:any={args:{}};applyBilling('hf_jobs',malformed,'payer');expect(malformed).toEqual({args:{}});
  const output:any={uri:'hf://models/user/result',private:true};applyBilling('create_repo',output,'payer');expect(output.uri).toContain('/user/');
 });
 it('blocks only generic MCP calls that target the HF workflow',async()=>{
  expect(isHfProxyCall('mcp',{server:'hf-intern'})).toBe(true);
  expect(isHfProxyCall('mcpScript',{script:"call('hf_jobs', {})"})).toBe(true);
  expect(isHfProxyCall('mcp',{server:'other',tool:'calendar'})).toBe(false);
  const h=harness();await h.emit('session_start');await h.command();
  expect((await h.emit('tool_call',{toolName:'mcp',input:{tool:'hf_jobs'}})).block).toBe(true);
  expect(await h.emit('tool_call',{toolName:'mcp',input:{server:'other',tool:'calendar'}})).toBeUndefined();
 });
 it('checks the captured nested Jobs/private schemas',()=>{
  expect(()=>checkCapabilities(fixture.tools.map(t=>({...t,sourceInfo:{path:'/external-adapter.ts'}})) as any)).not.toThrow();
  const old=structuredClone(fixture.tools);old.find(t=>t.name==='hf_jobs')!.parameters={type:'object',properties:{}} as any;
  expect(()=>checkCapabilities(old as any)).toThrow('nested args');
 });
 it('retains deliberate repetition, shapes, pinning and conditional doctrine',()=>{
  const text=modePrompt(fixture.tools.map(t=>t.name).concat('research','check_job','sandbox_task','update_plan','wait','ask_user_question','create_trackio'),{},new Date('2026-09-25T12:00:00Z'));
  expect(text.replace(/\[Session context:.*\]/,'[Session context: fixed test time, User=unknown]')).toMatchSnapshot();
  expect(text.match(/push_to_hub/g)!.length).toBeGreaterThanOrEqual(3);
  for(const rule of ['SILENT DATASET SUBSTITUTION','same flavor, batch size and sequence length','CURRENT release','cost to FINISH','short wait','User=unknown'])expect(text.toLowerCase()).toContain(rule.toLowerCase());
  expect(text).not.toContain('wakes you the moment');expect(text).not.toContain("user's dashboard is wired to that Space");expect(text).toContain('create_trackio reserves a private metrics dataset URI');expect(text).not.toContain('v-file://');expect(text).toContain('file://train.py');expect(text.trim().endsWith('User=unknown]')).toBe(true);
  expect(modePrompt([],{})).not.toContain('RUNNING JOBS (hf_jobs)');
  expect(delegatePrompt('research',['hf_fs','hub_repo_details'])).not.toContain('web_search_exa');
  expect(delegatePrompt('research',['hf_fs','hub_repo_details'])).toContain('Recipe table (REQUIRED)');
  const sandboxPrompt=delegatePrompt('sandbox_task',['hf_sandbox_exec','hf_sandbox_fs']);
  expect(sandboxPrompt).toContain('You have two tools');expect(sandboxPrompt).not.toContain('Write each script once with write');
 });
 it('restricts delegate operations independently of adapter activation',()=>{
  expect(roleError('research','bash',{})).toContain('unavailable');
  expect(roleError('check_job','hf_jobs',{operation:'cancel'})).toContain('only');
  expect(roleError('check_job','hf_jobs',{operation:'logs'})).toBeUndefined();
  expect(roleError('sandbox_task','hf_sandbox_exec',{cmd:'exec',args:['exec','other','ls']},'expected')).toContain('handle');
  expect(roleError('sandbox_task','hf_sandbox_exec',{cmd:'exec',args:['other','expected','ls']},'expected')).toContain('repeat cmd');
  expect(roleError('sandbox_task','hf_sandbox_fs',{cmd:'write',args:['write','expected','/work/file','--text','x']},'expected')).toBeUndefined();
  expect(truncate('a'.repeat(9000),4800,3200)).toHaveLength(4800+3200+'\n...(truncated)...\n'.length);
 });
 it('expands only supported whole-value file references',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ml-files-'));
  try {
   await writeFile(join(dir,'train.py'),'print(1)');
   const job={operation:'uv',args:{script:'file://train.py'}};await expandFiles('hf_jobs',job,dir);expect(job.args.script).toBe('print(1)');
   const put={cmd:'put',content:'file://train.py'};await expandFiles('hf_fs_write',put,dir);expect(put.content).toBe('print(1)');
   const sandbox={cmd:'write',args:['write','handle','/train.py','--text','file://train.py']};await expandFiles('hf_sandbox_fs',sandbox,dir);expect(sandbox.args[4]).toBe('print(1)');
   await expect(expandFiles('hf_jobs',{operation:'uv',args:{script:'file://absent.py'}},dir)).rejects.toThrow();
  } finally {await rm(dir,{recursive:true,force:true});}
 });
 it('parses structured MCP text and validates plans without corrupting state',()=>{
  expect(structured([{type:'text',text:'structuredContent:\n{"account":{"name":"owner"}}'}])).toEqual({account:{name:'owner'}});
  expect(()=>plan({goal:'',steps:[]},1)).toThrow();expect(emptyState().jobs).toEqual([]);
 });
});
