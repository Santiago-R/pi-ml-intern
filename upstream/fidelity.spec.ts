import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import builtins from './builtins.json';
import {mlAssistantPreprompt,mlAssistantToolDoctrineBlocks} from './prompts/mlAssistantPrompt';
import {buildResearchSystemPrompt} from './prompts/researchPrompt';
import {jobCheckSystemPrompt} from './prompts/jobCheckPrompt';

// These checks cover the generated prompt/tool artifacts themselves. The runtime suite
// separately snapshots Pi's assembled adaptation.
describe('pinned Chat UI artifacts',()=>{
  it('matches the reviewed generated files byte for byte',()=>{
    const expected={
      'builtins.json':'2e57a6a2a218c0437638877affbd043a6e7d0f08956e3831c80bf7f6bbdfbd92',
      'prompts/filePrompt.ts':'78f351cfb3ad6c7b3afcc0a82beeb08c85c2d9d5504e56086c01eb03c926fe05',
      'prompts/mlAssistantPrompt.ts':'c69c344118ea25b78f29fa3ee8e2fdbb5b92744054ccf34faae67da2eb7093b6',
      'prompts/researchPrompt.ts':'27066d496c740360bb993deb919e7bc3f3bced86306b31bee0e11607aa73d18f',
      'prompts/sandboxPrompt.ts':'3ce650e04b866e17df71df58288766c0ce37ec8924935737f4e13335f9fc291e',
      'prompts/jobCheckPrompt.ts':'c410e9ab37c3fd2986ca89fb27f41033db61c1c8b0a24a9292109b96afc209c4',
    };
    for(const [path,hash] of Object.entries(expected))expect(createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex'),path).toBe(hash);
  });
  it('retains required workflow and plan contracts',()=>{
    const definitions=builtins.definitions;
    expect(definitions.research.description).toContain('ALWAYS use this first');
    expect(definitions.update_plan.parameters.properties.steps.items.required).toEqual(['step','status','label']);
    expect(definitions.ask_user_question.parameters.properties.questions.items.properties.options).toMatchObject({minItems:2,maxItems:4});
  });
  it('retains conditional research and one-pass job guidance',()=>{
    const prompt=buildResearchSystemPrompt(new Set(['hf_fs','hub_repo_details','hub_repo_search','web_search_exa','crawling_exa','get_code_context_exa','github_find_examples','github_read_file']));
    for(const name of ['hub_repo_search','web_search_exa','crawling_exa','get_code_context_exa','github_find_examples'])expect(prompt).toContain(name);
    expect(jobCheckSystemPrompt({virtualFiles:false})).toContain('You also cannot wait');
  });
  it('retains deliberate repetition and tool-conditioned doctrine',()=>{
    const prompt=mlAssistantPreprompt({virtualFiles:true,stateBlock:true});
    expect(prompt.match(/push_to_hub/g)?.length).toBeGreaterThanOrEqual(2);
    const doctrine=mlAssistantToolDoctrineBlocks(['hf_jobs'],{serviceEvents:false}).join('\n');
    expect(doctrine).toContain('push_to_hub');expect(doctrine).toContain('same flavor, batch size and sequence length');
  });
});
