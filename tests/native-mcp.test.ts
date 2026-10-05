import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('node:process',()=>({loadEnvFile:vi.fn()}));
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai';
import {createAgentSession,createMcpExtension,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,type ExtensionFactory} from '@earendil-works/pi-coding-agent';
import mlIntern from '../index';
import {emptyState,STATE} from '../runtime/state';

const hf=(name:string)=>`mcp__hf_intern__${name}`;
let toolId=0;
const tool=(name:string,args:any):Partial<AssistantMessage>=>({stopReason:'toolUse',content:[{type:'toolCall',id:`call-${toolId++}`,name,arguments:args}]});
const done=(text='Done.'):Partial<AssistantMessage>=>({content:[{type:'text',text}]});
const cleanup:(()=>Promise<void>)[]=[];
beforeEach(()=>{vi.stubEnv('HF_BILL_TO','payer');vi.stubEnv('HF_BILLING_RESOURCE_GROUP','group');vi.stubEnv('GITHUB_TOKEN','');vi.stubEnv('ML_INTERN_FORCE','');});
afterEach(async()=>{try {for(const close of cleanup.splice(0))await close();}finally {vi.unstubAllEnvs();}});
async function setup(reply:(context:any)=>Partial<AssistantMessage>,extra?:ExtensionFactory,startupWaitMs=10000) {
 const dir=await mkdtemp(join(tmpdir(),'ml-native-')),events=join(dir,'events');
 await writeFile(events,'');await writeFile(join(dir,'train.py'),'print(1)');
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models'),refreshOnCreate:false});
 runtime.registerProvider('ml-offline',{api:'openai-completions',apiKey:'offline',baseUrl:'https://invalid.example',models:[{id:'offline',name:'offline',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2000}],streamSimple:(_m,context)=>{
  const stream=createAssistantMessageEventStream();
  const message:AssistantMessage={role:'assistant',content:[],api:'openai-completions',provider:'ml-offline',model:'offline',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now(),...reply(context)};
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});});return stream;
 }});
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false}});
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[
  // Match CLI order: package extensions precede built-in MCP.
  mlIntern,...(extra?[extra]:[]),
  createMcpExtension({startupWaitMs,loadConfig:()=>({errors:[],autoEnableCodemode:false,servers:[{name:'hf-intern',source:'offline',config:{command:process.execPath,args:[resolve('tests/fixtures/native-mcp-server.mjs')],env:{ML_TEST_EVENTS:events,ML_TEST_DISCOVERY_DELAY_MS:'100'},exposure:'direct'}}]}),logPath:join(dir,'mcp.log')}),
 ]});
 const manager=SessionManager.inMemory(dir);manager.appendCustomEntry(STATE,{...emptyState(),active:true});
 await loader.reload();
 const {session}=await createAgentSession({cwd:dir,resourceLoader:loader,settingsManager,sessionManager:manager,modelRuntime:runtime,model:runtime.getModel('ml-offline','offline')});
 cleanup.push(async()=>{try {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});}finally {session.dispose();await rm(dir,{recursive:true,force:true});}});
 await session.bindExtensions({mode:'print'});
 const state=()=>manager.getBranch().findLast((e:any)=>e.type==='custom'&&e.customType===STATE) as any;
 const calls=async()=>(await readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 return {session,state:()=>state().data,calls};
}
it('uses production policy for native discovery, private writes, denied submissions and delegate forwarding',async()=>{
 let parentTurns=0,childTurns=0,nestedCalls=0,blockedReads=0;
 const {session,state,calls}=await setup(context=>{
  const previous=context.messages.findLast((m:any)=>m.role==='toolResult');
  if(JSON.stringify(context.messages).includes('Task: Native lifecycle')) {
   switch(childTurns++) {
    case 0:return tool(hf('hf_jobs'),{operation:'cancel',args:{job_id:'job-native'}});
    case 1:expect(previous.isError).toBe(true);expect(previous.content[0].text).toContain('only');return tool('read',{path:'train.py'});
    case 2:expect(previous.isError).toBe(true);expect(previous.content[0].text).toContain('Parent read denied');return tool(hf('hf_jobs'),{operation:'inspect',args:{job_id:'missing'}});
    case 3:expect(previous.isError).toBe(true);expect(previous.content[0].text).toContain('Recoverable');return tool(hf('hf_jobs'),{operation:'inspect',args:{job_id:'job-native'}});
    default:expect(previous.isError).toBe(false);return done('Native completion summary.');
   }
  }
  switch(parentTurns++) {
   case 0:expect(JSON.stringify(context.messages)).toContain(`hf_jobs → ${hf('hf_jobs')}`);expect(JSON.stringify(context.messages)).toContain('"name":"check_job"');return tool(hf('hf_whoami'),{});
   case 1:return tool(hf('create_repo'),{uri:'hf://datasets/owner/public',private:false});
   case 2:expect(previous.isError).toBe(true);return tool(hf('create_repo'),{uri:'hf://datasets/owner/private'});
   case 3:expect(previous.isError).toBe(false);return tool(hf('hf_fs_write'),{cmd:'put',args:['hf://datasets/owner/private/train.py'],content:'file://train.py'});
   case 4:expect(previous.isError).toBe(false);return tool(hf('hf_jobs'),{operation:'uv',args:{name:'unauthorized',script:'file://train.py'}});
   case 5:expect(previous.isError).toBe(true);expect(previous.content[0].text).toContain('authorization');return tool('check_job',{task:'Native lifecycle',job_id:'job-native',script_path:'train.py'});
   default:expect(previous.content[0].text).toBe('Native completion summary.');return done();
  }
 },pi=>{
  pi.on('tool_call',event=>{
   if(!event.parentToolCallId)return;
   expect(event.parentToolCallId).toMatch(/^call-\d+$/);
   if(event.toolName==='read'){blockedReads++;return {block:true,reason:'Parent read denied'};}
   if(event.toolName===hf('hf_jobs')){nestedCalls++;expect((event.input as any).args).toMatchObject({namespace:'payer'});}
  });
 });
 await session.prompt('Native policy test');
 expect(state().namespaces).toContain('owner');expect(state().harness).toMatchObject({build:'0.3.0',prompt:'1c9c9bcbd',model:'ml-offline/offline'});expect(state().destinations['hf://datasets/owner/private']).toBe(true);expect(state().attempts).toEqual([]);expect(state().finished).toEqual(['https://huggingface.co/jobs/payer/job-native']);
 expect(blockedReads).toBe(1);expect(nestedCalls).toBe(2);
 const dispatched=await calls();expect(dispatched).toHaveLength(5);
 expect(dispatched.find(c=>c.name==='create_repo').args.private).toBe(true);expect(dispatched.find(c=>c.name==='hf_fs_write').args.content).toBe('print(1)');
 expect(dispatched.filter(c=>c.name==='hf_jobs').every(c=>c.args.operation==='inspect'&&c.args.args.namespace==='payer')).toBe(true);
},30000);
it('resumes after command authorization, records uncertain submissions and never replays them',async()=>{
 let turns=0;
 const {session,state,calls}=await setup(context=>{
  if(!JSON.stringify(context.messages).includes('Recorded allow authorization for smoke through /ml-intern.'))return done('Waiting for authorization.');
  const previous=context.messages.findLast((m:any)=>m.role==='toolResult');
  switch(turns++) {
   case 0:return tool(hf('hf_jobs'),{operation:'uv',args:{name:'smoke-unknown',script:'file://train.py'}});
   case 1:expect(previous.isError).toBe(true);expect(previous.content.at(-1).text).toContain('No job or sandbox ID');return tool(hf('hf_jobs'),{operation:'uv',args:{name:'smoke-error',script:'file://train.py'}});
   default:expect(previous.isError).toBe(true);expect(previous.content.at(-1).text).toContain('do not automatically replay');return done();
  }
 });
 await session.prompt('Prepare the offline submissions, but wait for authorization.');
 await session.prompt('/ml-intern allow smoke');
 await vi.waitFor(()=>expect(state().attempts.map((a:any)=>[a.name,a.status])).toEqual([['smoke-unknown','unknown'],['smoke-error','unknown']]),{timeout:5000});
 const dispatched=await calls();expect(dispatched).toHaveLength(2);expect(dispatched.every(c=>c.args.args.namespace==='payer'&&c.args.args.resource_group_id==='group'&&c.args.args.script==='print(1)')).toBe(true);
},30000);
it('retains ML intent and retries validation after native discovery outlasts the startup wait',async()=>{
 let turns=0;
 const {session,state,calls}=await setup(context=>{
  const previous=context.messages.findLast((m:any)=>m.role==='toolResult');
  switch(turns++) {
   case 0:expect(JSON.stringify(context.messages)).toContain('ML tools are not ready');return tool('check_job',{task:'Not ready',job_id:'job-native'});
   case 1:expect(previous.isError).toBe(true);expect(previous.content[0].text).toContain('not ready');return done('Waiting for discovery.');
   case 2:return tool(hf('hf_jobs'),{operation:'inspect',args:{job_id:'job-native'}});
   default:expect(previous.isError).toBe(false);return done();
  }
 },undefined,1);
 await session.prompt('First turn before discovery');expect(state().active).toBe(true);expect(await calls()).toEqual([]);
 await vi.waitFor(()=>expect(session.getAllTools().some(t=>t.name===hf('hf_jobs'))).toBe(true));
 await session.prompt('Retry after discovery');expect((await calls()).map(c=>c.args.operation)).toEqual(['inspect']);expect(state().finished).toContain('https://huggingface.co/jobs/payer/job-native');
},30000);
it('cancels an in-flight native delegate without returning a success summary',async()=>{
 let parentTurns=0,childTurns=0;
 const {session,state,calls}=await setup(context=>{
  if(JSON.stringify(context.messages).includes('Task: Slow check')) {
   childTurns++;return tool(hf('hf_jobs'),{operation:'logs',args:{job_id:'slow'}});
  }
  return parentTurns++===0?tool('check_job',{task:'Slow check',job_id:'slow'}):done();
 });
 const unsubscribe=session.subscribe(event=>{
  if(event.type==='tool_execution_start'&&event.toolName===hf('hf_jobs'))setTimeout(()=>{void session.abort();},50);
 });
 try {await session.prompt('Cancel the offline check');}finally {unsubscribe();}
 expect(childTurns).toBe(1);expect((await calls()).some(c=>c.args.args.job_id==='slow')).toBe(true);expect(state().finished).not.toContain('slow');
 expect(session.messages.some((m:any)=>m.role==='toolResult'&&m.toolName==='check_job'&&!m.isError)).toBe(false);
},30000);
