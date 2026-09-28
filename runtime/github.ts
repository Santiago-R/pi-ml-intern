import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { githubTools, runGithubTool } from '../upstream/github';

export default function registerGithub(pi:ExtensionAPI) {
  for(const {function:d} of githubTools()) pi.registerTool({name:d.name,label:d.name,description:d.description,parameters:d.parameters as any,
    async execute(_id,args,signal) {
      const value=await runGithubTool(d.name,args as Record<string,unknown>, {signal});
      if(value.isError)throw Error(value.text);
      return {content:[{type:'text',text:value.text}],details:undefined};
    }});
}
