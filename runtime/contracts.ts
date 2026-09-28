import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';

export const REQUIRED = ['hf_whoami','hf_fs','hf_fs_write','create_repo','hub_repo_details','hf_jobs'];
export const OPTIONAL = ['hf_sandbox','hf_sandbox_exec','hf_sandbox_fs','hub_repo_search'];
const HF_NAMES=[...REQUIRED,...OPTIONAL];
const PRE_DISPATCH=new Set(['init_timeout','init_failed','not_initialized','server_disabled','auth_required','server_unavailable','not_connected','approval_denied','approval_required','url_elicitation_required']);
const UNCERTAIN_DISPATCH=new Set(['tool_error','call_failed','aborted']);

export function dispatchOutcome(details:unknown,isError:boolean):'ok'|'pre-dispatch'|'uncertain'|'error' {
  const code=details&&typeof details==='object'&&typeof (details as any).error==='string'?(details as any).error:undefined;
  if(code&&PRE_DISPATCH.has(code))return 'pre-dispatch';
  if(isError||(code&&UNCERTAIN_DISPATCH.has(code)))return 'uncertain';
  return code?'error':'ok';
}
export function hubRepoRoot(uri:unknown) {
  if(typeof uri!=='string')return;
  const match=uri.match(/^hf:\/\/(models|datasets|spaces|buckets)\/([^/@]+)\/([^/@]+)/);
  if(match)return `hf://${match[1]}/${match[2]}/${match[3]}`;
}
export function whoamiNamespaces(data:any):string[] {
  const names:string[]=[];
  const add=(value:any)=>{const name=typeof value==='string'?value:value?.name;if(typeof name==='string'&&/^[A-Za-z0-9][\w.-]*$/.test(name))names.push(name);};
  add(data?.account);
  for(const group of [data?.organizations,data?.orgs,data?.account?.organizations,data?.account?.orgs])if(Array.isArray(group))group.forEach(add);
  return [...new Set(names)];
}
export function isHfProxyCall(name:string,input:Record<string,any>) {
  if(!['mcp','mcpScript'].includes(name))return false;
  const text=JSON.stringify(input);
  return input.server==='hf-intern'||HF_NAMES.some(tool=>input.tool===tool||text.includes(tool))||text.includes('hf-intern');
}
export function checkCapabilities(tools:ToolInfo[]) {
  const missing=REQUIRED.filter(n=>!tools.some(t=>t.name===n));
  if(missing.length) throw Error(`ML mode requires direct MCP tools: ${missing.join(', ')}. Configure the HF intern bouquet with upstream names, reconnect the adapter, then retry /ml-intern. Normal Pi remains available.`);
  const jobs=tools.find(t=>t.name==='hf_jobs')!.parameters as any;
  if(jobs.properties?.args?.type!=='object'||!jobs.properties?.operation)
    throw Error('hf_jobs must expose operation + nested args. Remove the legacy extension/tool collision and reconnect MCP.');
  const create=tools.find(t=>t.name==='create_repo')!.parameters as any;
  if(create.properties?.private?.type!=='boolean') throw Error('create_repo must support private creation. Refresh the MCP schema before activating ML mode.');
  for(const name of ['hf_fs','hub_repo_details','hf_jobs']) {
    const path=tools.find(t=>t.name===name)?.sourceInfo?.path;
    if(!path||path.startsWith('<'))throw Error(`${name} needs a loadable extension source for Pi delegates. Install/configure the adapter as a Pi extension, then retry.`);
  }
}
export async function expandFiles(name:string,input:Record<string,any>,cwd:string) {
  const expand=async(value:unknown)=>{
    if(typeof value!=='string'||!value.startsWith('file://'))return value;
    const path=value.slice(7);
    if(!path)throw Error('file:// needs a local path. Write the script first.');
    return readFile(resolve(cwd,path),'utf8');
  };
  if(name==='hf_jobs'&&input.operation==='uv'&&input.args) input.args.script=await expand(input.args.script);
  if(name==='hf_fs_write'&&input.cmd==='put') input.content=await expand(input.content);
  if(name==='hf_sandbox_fs'&&input.cmd==='write'&&Array.isArray(input.args)) {
    const i=input.args.indexOf('--text');
    if(i>=0)input.args[i+1]=await expand(input.args[i+1]);
  }
}
export function applyBilling(name:string,input:Record<string,any>,namespace=process.env.HF_BILL_TO,group=process.env.HF_BILLING_RESOURCE_GROUP) {
  if(!namespace)return;
  if(name==='hf_jobs') {
    if(typeof input.operation!=='string')return;
    input.args??={};
    if(typeof input.args!=='object'||Array.isArray(input.args))return;
    const submit=['run','uv'].includes(input.operation);
    if(submit&&input.args.namespace&&input.args.namespace!==namespace)throw Error(`Configured payer is ${namespace}; correct args.namespace or change HF_BILL_TO before submitting.`);
    if(submit||!input.args.namespace)input.args.namespace=namespace;
    if(submit&&group)input.args.resource_group_id=group;
  }
  if(name==='hf_sandbox'&&input.cmd==='create'&&Array.isArray(input.args)) {
    for(const [flag,value] of [['--namespace',namespace],['--resource-group-id',group]]) {
      if(!value)continue;
      const found=[];
      for(let i=0;i<input.args.length;i++)if(input.args[i]===flag)found.push(input.args[i+1]);
      if(found.some(v=>v!==value))throw Error(`Configured ${flag} is ${value}; correct the sandbox arguments.`);
      input.args=input.args.filter((v:any,i:number,a:any[])=>v!==flag&&a[i-1]!==flag);
      input.args.push(flag,value);
    }
  }
}
export function structured(content:{type:string;text?:string}[]) {
  for(const part of content) {
    const text=part.text;
    if(!text)continue;
    try {return JSON.parse(text.startsWith('structuredContent:\n')?text.slice(19):text);} catch {}
  }
}
