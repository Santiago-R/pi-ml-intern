import { setTimeout as delay } from 'node:timers/promises';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import definitions from '../upstream/builtins.json';
import { plan, renderPlan, type State } from './state';
import { delegate } from './delegate';
import { authorizationPrompt, recordAuthorization, validateAuthorization } from './policy';

export const OWNED=['research','sandbox_task','check_job','create_trackio','update_plan','wait','ask_user_question','request_authorization','github_find_examples','github_read_file','github_list_repos'];
export const availableOwned=(active:string[])=>OWNED.filter(name=>name!=='sandbox_task'||['hf_sandbox_exec','hf_sandbox_fs'].every(tool=>active.includes(tool)));
const result=(text:string,details:unknown=undefined)=>({content:[{type:'text' as const,text}],details});

export function registerTools(pi:ExtensionAPI,get:()=>State,save:()=>void) {
  for(const role of ['research','sandbox_task','check_job'] as const) {
    const tool=structuredClone(definitions.definitions[role]) as any;
    if(role==='check_job')tool.parameters.properties.script_path={type:'string',description:'Optional immutable local script path that this delegate alone may read for traceback context.'};
    pi.registerTool({name:role,label:role,description:tool.description,parameters:tool.parameters,
      async execute(_id,args,signal,onUpdate,ctx) {
        if(!get().active)throw Error('Enter /ml-intern first.');
        return delegate(pi,role,args as Record<string,any>,ctx,signal,onUpdate);
      }});
  }
  const planDefinition=definitions.definitions.update_plan;
  pi.registerTool({name:'update_plan',label:'Plan',description:planDefinition.description,parameters:planDefinition.parameters as any,executionMode:'sequential',
    async execute(_id,args) {
      const s=get(); if(!s.active)throw Error('Enter /ml-intern first.');
      s.plan=plan(args as Record<string,any>,(s.plan?.version??0)+1);save();return result(renderPlan(s.plan),s.plan);
    }});
  pi.registerTool({name:'wait',label:'Wait',description:'Wait while Pi is running, then check the job. Cancellable; no wakeup after process exit. Check early, then lengthen waits as the run proves itself.',
    parameters:Type.Object({seconds:Type.Integer({minimum:15,maximum:1800}),reason:Type.String({minLength:1})}),executionMode:'sequential',
    async execute(_id,args,signal,onUpdate) {
      const s=get();if(!s.active)throw Error('Enter /ml-intern first.');
      if(s.waits>=100)throw Error('100 waits reached. Report pending work and let the user decide.');
      s.waits++;save();onUpdate?.(result(`Waiting ${args.seconds}s: ${args.reason}`));await delay(args.seconds*1000,undefined,{signal});return result('Wait finished. Inspect current status; elapsed time does not establish success.');
    }});
  const questionDefinition=structuredClone(definitions.definitions.ask_user_question) as any;
  delete questionDefinition.parameters.properties.questions.items.properties.options.items.properties.setBudgetUsd;
  questionDefinition.parameters.properties.questions.items.properties.options.items.properties.label.description='The choice, in a few words; details belong in the description.';
  pi.registerTool({name:'ask_user_question',label:'Ask user',description:questionDefinition.description+' In headless mode, stop and resume with an answer.',parameters:questionDefinition.parameters,executionMode:'sequential',
    async execute(_id,args:any,_signal,_update,ctx) {
      const s=get();if(!s.active)throw Error('Enter /ml-intern first.');
      const answers=[];
      for(const question of args.questions) {
        if(!ctx.hasUI) {
          s.question=args;save();
          return {...result(`Input required: ${JSON.stringify(args.questions)}\nWork stopped. Resume this Pi session with your answer; no choice was assumed.`,{question:args}),terminate:true};
        }
        const choices=question.options.map((o:any)=>`${o.label}: ${o.description}`);
        const other='Other (type an answer)';
        const title=`${question.header}: ${question.question}`;
        let answer:string|string[]|undefined;
        if(question.multiSelect) {
          const selected:string[]=[];
          for(const option of choices)if(await ctx.ui.confirm(title,option))selected.push(option);
          if(await ctx.ui.confirm(title,other)) {
            const custom=await ctx.ui.input(title,'Type another answer');
            if(custom?.trim())selected.push(custom.trim());
          }
          answer=selected.length?selected:undefined;
        } else {
          const selected=await ctx.ui.select(title,[...choices,other]);
          answer=selected===other?(await ctx.ui.input(title,'Type another answer'))?.trim()||undefined:selected;
        }
        if(answer===undefined) {s.question=args;save();return {...result('Question unanswered. Resume with your choice.',{question:args}),terminate:true};}
        answers.push({question:question.question,answer});
      }
      s.question=undefined;save();return result(JSON.stringify(answers),{answers});
    }});
  pi.registerTool({name:'request_authorization',label:'Request authorization',description:'Present a Pi confirmation dialog for one paid experiment scope or one exact public hf:// destination. The user button or an explicit /ml-intern allow|publish command is the only authority; never infer authorization from chat text. State the concrete reason and, for compute, the best available cost/time estimate.',
    parameters:Type.Object({kind:Type.Union([Type.Literal('compute'),Type.Literal('publish')]),scope:Type.String({minLength:3}),reason:Type.String({minLength:3}),estimate:Type.Optional(Type.String({minLength:1}))}),executionMode:'sequential',
    async execute(_id,args,_signal,_update,ctx) {
      const s=get();if(!s.active)throw Error('Enter /ml-intern first.');
      const scope=validateAuthorization(args.kind,args.scope);
      if(!ctx.hasUI) return {...result(`Authorization not recorded. A user must run /ml-intern ${args.kind==='compute'?'allow':'publish'} ${scope} in this session; chat replies are not interpreted as payment or publication authority.`,{authorized:false,kind:args.kind,scope}),terminate:true};
      const prompt=authorizationPrompt(args.kind,scope,args.reason,args.estimate);
      const authorized=await ctx.ui.confirm(prompt.title,prompt.message);
      if(!authorized)return {...result(`User denied ${args.kind} authorization for ${scope}. Do not perform the operation.`,{authorized:false,kind:args.kind,scope}),terminate:true};
      recordAuthorization(s,args.kind,scope);save();
      return result(`User authorized ${args.kind} scope ${scope} with the Pi confirmation control. This does not enforce a spending cap.`,{authorized:true,kind:args.kind,scope});
    }});
  const trackio=definitions.definitions.create_trackio;
  const safe={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_.-]*$'};
  const parameters={...trackio.parameters,properties:{...trackio.parameters.properties,project:{...trackio.parameters.properties.project,...safe,maxLength:80,description:'Safe Trackio project ID (letters, digits, dot, underscore, or hyphen).'},namespace:{...safe,description:'Exact Hub account or organization namespace from the latest successful hf_whoami call.'}},required:['project','namespace']};
  pi.registerTool({name:'create_trackio',label:'Trackio',description:'Reserve a private metrics dataset for an account or organization returned by a fresh hf_whoami call. No hosted Space or subscription.',parameters:parameters as any,
    async execute(_id,args) {
      const s=get();if(!s.active)throw Error('Enter /ml-intern first.');
      const input=args as Record<string,unknown>;
      const project=typeof input.project==='string'?input.project.trim():'';
      if(!/^[A-Za-z0-9][\w.-]*$/.test(project)||project.length>80)throw Error('Project must be 1–80 ASCII letters, digits, dots, underscores, or hyphens.');
      const namespace=typeof input.namespace==='string'?input.namespace.trim():'';
      if(!s.namespaces.length)throw Error('Run hf_whoami now, then pass an account or organization namespace from that result.');
      if(!s.namespaces.includes(namespace))throw Error(`Namespace ${JSON.stringify(namespace)} was not returned by the latest hf_whoami call.`);
      const slug=project.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
      const uri=`hf://datasets/${namespace}/${slug}-metrics`;
      return result(`Private Trackio metrics destination reserved: ${uri}. Create this dataset with create_repo(private=true) before any job; if it exists already, inspect visibility or choose a fresh name. In the training job set TRACKIO_DIR to a known local directory BEFORE importing trackio, then trackio.init(project=${JSON.stringify(project)}, name=<run-name>, embed=False), trackio.log(...), and trackio.finish(). After an early step and again after finish, use sqlite3.Connection.backup() to snapshot the project's .db into a separate file, upload that snapshot with huggingface_hub.HfApi.upload_file(repo_type="dataset", repo_id=${JSON.stringify(`${namespace}/${slug}-metrics`)}) and HF_TOKEN as a job secret. Read it back and check metric rows; logs alone or init success are not proof. Do not use a Space or publish the DB. No hosted dashboard is available on the free account.`,{uri,project});
    }});
}
