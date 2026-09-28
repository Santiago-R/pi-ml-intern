import {appendFileSync} from 'node:fs';
import {Type} from 'typebox';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export default function fixture(pi:ExtensionAPI) {
  for(const name of ['hf_fs','hub_repo_details','hf_jobs','hf_sandbox_exec','hf_sandbox_fs'])pi.registerTool({name,label:name,description:'Offline delegate fixture',parameters:Type.Object({}, {additionalProperties:true}),
    async execute(_id,args:any) {
      appendFileSync(process.env.ML_TEST_EVENTS!,JSON.stringify({name,args})+'\n');
      const text=name==='hf_fs'
        ? 'Recoverable service error'
        : name==='hf_jobs'&&args.operation==='inspect'
          ? `structuredContent:\n${JSON.stringify({outcome:{kind:'inspections',inspections:[{job_id:args.args?.job_id,job:{status:{stage:'COMPLETED'}}}]}})}`
          : 'offline tool output';
      return {content:[{type:'text',text}],details:name==='hf_fs'?{error:'tool_error'}:{}};
    }});
  pi.on('tool_result',event=>{if((event.details as any)?.error)return {isError:true};});
  pi.on('session_shutdown',()=>{appendFileSync(process.env.ML_TEST_EVENTS!,'shutdown\n');});
}
