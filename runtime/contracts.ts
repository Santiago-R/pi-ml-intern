import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getAgentDir, type ToolInfo } from '@earendil-works/pi-coding-agent';
import { BUILD_VERSION, PROMPT_VERSION } from './state';

export const REQUIRED = ['hf_whoami','hf_fs','hf_fs_write','create_repo','hub_repo_details','hf_jobs'];
export const OPTIONAL = ['hf_sandbox','hf_sandbox_exec','hf_sandbox_fs','hub_repo_search'];
export const HF_SERVER='hf-intern';
export const HF_MCP_URL='https://huggingface.co/mcp?login&bouquet=intern';
const HF_NATIVE_PREFIX=`mcp__${HF_SERVER.replace(/[^A-Za-z0-9_]/g,'_')}__`;
const OPTIONAL_RESEARCH_NAMES=['web_search_exa','get_code_context_exa','crawling_exa'];
export const logicalName=(name:string)=>{
  if(name.startsWith(HF_NATIVE_PREFIX))return name.slice(HF_NATIVE_PREFIX.length);
  return OPTIONAL_RESEARCH_NAMES.find(tool=>name.endsWith(`__${tool}`))??name;
};
export const nativeName=(name:string)=>`${HF_NATIVE_PREFIX}${name}`;
const sameServer=(name:string)=>name.replaceAll('-','_')===HF_SERVER.replaceAll('-','_');
const isHfEndpoint=(value:unknown)=>{
  if(typeof value!=='string')return false;
  try {
    const url=new URL(value);
    return url.origin==='https://huggingface.co'&&(url.pathname==='/mcp'||url.pathname==='/mcp/')&&url.searchParams.get('bouquet')==='intern';
  } catch {return false;}
};
/** Reject a file override that would route trusted workflow calls or credentials away from Hugging Face. */
export function verifyHfMcpConfig(cwd:string,includeProject=true,agentDir=getAgentDir()) {
  const paths=[join(agentDir,'mcp.json'),...(includeProject?[join(cwd,'.pi','mcp.json')]:[])];
  for(const path of paths) {
    if(!existsSync(path))continue;
    let config:any;
    try {config=JSON.parse(readFileSync(path,'utf8'));} catch {continue;}
    for(const [name,server] of Object.entries(config?.mcpServers??{})) {
      if(sameServer(name)&&!isHfEndpoint((server as any)?.url))
        throw Error(`Refusing ${path}: server ${name} overrides hf-intern but is not the Hugging Face intern endpoint. Remove or rename that override before using ML mode.`);
    }
  }
}
export function toolNameMap(names:string[]) {
  const mapped=names.filter(n=>logicalName(n)!==n);
  return mapped.length?'\n# Registered tool names\nUse these exact names when calling tools:\n'+mapped.map(n=>`${logicalName(n)} → ${n}`).join('\n'):'';
}
export function hubRepoRoot(uri:unknown) {
  if(typeof uri!=='string')return;
  const match=uri.match(/^hf:\/\/(models|datasets|spaces|buckets)\/([^/@]+)\/([^/@]+)/);
  if(match)return `hf://${match[1]}/${match[2]}/${match[3]}`;
}
export function whoamiNamespaces(data:any):string[] {
  const names=[data?.account?.name,...(data?.organizations??[]).map((organization:any)=>organization.name)];
  return [...new Set(names.filter((name):name is string=>typeof name==='string'&&/^[A-Za-z0-9][\w.-]*$/.test(name)))];
}
export function checkCapabilities(tools:ToolInfo[]) {
  const registered=new Map(tools.map(tool=>[tool.name,tool]));
  for(const name of REQUIRED) {
    const tool=registered.get(nativeName(name));
    if(!tool)throw Error(`ML mode requires native MCP tool ${name}, but hf-intern has not exposed it yet. Wait for the connection or run /mcp reconnect hf-intern, then retry /ml-intern. Normal Pi remains available.`);
    if(tool.exposure!=='direct')throw Error(`${tool.name} requires native MCP exposure direct. Hidden/codemode/deferred exposure is not supported by ML mode yet.`);
  }
  const jobs=registered.get(nativeName('hf_jobs'))!.parameters as any;
  if(jobs.properties?.args?.type!=='object'||!jobs.properties?.operation)
    throw Error('hf_jobs must expose operation + nested args. Refresh the MCP schema and reconnect hf-intern.');
  const create=registered.get(nativeName('create_repo'))!.parameters as any;
  if(create.properties?.private?.type!=='boolean') throw Error('create_repo must support private creation. Refresh the MCP schema before activating ML mode.');
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
export const jobLabelValue=(value:string)=>value.replace(/[^A-Za-z0-9_-]/g,'_');
const normalizeJobLabels=(value:Record<string,unknown>)=>{
  const labels:Record<string,string>={};
  const sources=new Map<string,string>();
  for(const [rawKey,rawValue] of Object.entries(value)) {
    if(typeof rawValue!=='string')throw Error(`Job label ${rawKey} must have a string value.`);
    const key=jobLabelValue(rawKey);
    if(!key)throw Error('Job label keys cannot be empty.');
    const previous=sources.get(key);
    if(previous&&previous!==rawKey)throw Error(`Job labels ${previous} and ${rawKey} normalize to the same key (${key}).`);
    sources.set(key,rawKey);labels[key]=jobLabelValue(rawValue);
  }
  return labels;
};
const sessionLabels=(sessionId:string,authorization?:string)=>({
  'ml-intern-session':jobLabelValue(sessionId),
  'ml-intern-build':jobLabelValue(BUILD_VERSION),
  'ml-intern-prompt':jobLabelValue(PROMPT_VERSION),
  ...(authorization?{'ml-intern-authorization':jobLabelValue(authorization)}:{}),
});
/** Stamp submissions and list queries so unresolved work cannot bind to another session's history. */
export function applySessionIsolation(name:string,input:Record<string,any>,sessionId:string,authorization?:string) {
  const labels=sessionLabels(sessionId,authorization);
  if(name==='hf_jobs'&&['run','uv','ps'].includes(input.operation)) {
    input.args??={};
    if(!input.args||typeof input.args!=='object'||Array.isArray(input.args))throw Error('hf_jobs args must be an object.');
    if(input.args.labels!==undefined&&(!input.args.labels||typeof input.args.labels!=='object'||Array.isArray(input.args.labels)))throw Error('hf_jobs labels must be an object.');
    if(typeof input.args.name==='string')input.args.name=jobLabelValue(input.args.name);
    const protectedLabels=input.operation==='ps'?{'ml-intern-session':labels['ml-intern-session']}:labels;
    input.args.labels={...normalizeJobLabels(input.args.labels??{}),...protectedLabels};
  }
  if(name==='hf_sandbox'&&input.cmd==='create'&&Array.isArray(input.args)) {
    const protectedKeys=new Set(Object.keys(labels));
    const kept:string[]=[];
    for(let i=0;i<input.args.length;i++) {
      const token=input.args[i];
      if((token==='--label'||token==='-l')) {
        const raw=input.args[++i];
        if(typeof raw!=='string')throw Error(`${token} needs a label string.`);
        const separator=raw.indexOf('=');
        const key=jobLabelValue(separator<0?raw:raw.slice(0,separator));
        if(!key)throw Error('Job label keys cannot be empty.');
        if(protectedKeys.has(key))continue;
        const value=separator<0?key:`${key}=${jobLabelValue(raw.slice(separator+1))}`;
        kept.push(token,value);continue;
      }
      if(token==='--name'&&typeof input.args[i+1]==='string') {
        kept.push(token,jobLabelValue(input.args[++i]));continue;
      }
      kept.push(token);
    }
    for(const [key,value] of Object.entries(labels))kept.push('--label',`${key}=${value}`);
    input.args=kept;
  }
}
// Native MCP carries the complete CallToolResult, even if displayed text was truncated.
export function resultContent(event:{content:any[];structuredContent?:unknown}) {
  const raw=event.structuredContent as any;
  if(raw&&Array.isArray(raw.content)) {
    return raw.structuredContent!==undefined
      ? [{type:'text',text:JSON.stringify(raw.structuredContent)},...raw.content]
      : raw.content;
  }
  return event.content;
}
export function structured(content:{type:string;text?:string}[]) {
  for(const part of content) {
    const text=part.text;
    if(!text)continue;
    try {return JSON.parse(text.startsWith('structuredContent:\n')?text.slice(19):text);} catch {}
  }
}
