// Reviewed source only; never run at extension startup.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import vm from 'node:vm';

export const sha = '1c9c9bcbd92da1c4bdcc7d4a20354191c747709e';
const root = process.argv[2];
if (!root || execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim() !== sha)
  throw Error(`Supply a Chat UI checkout at ${sha}`);
const server = 'src/lib/server/';
const builtin = server + 'textGeneration/builtinTools/';
// The exact-SHA Git checkout is the verbatim reference; only generated files
// imported or tested by this package are kept here.
const read = path => readFileSync(join(root,path),'utf8');
mkdirSync('upstream/prompts', {recursive:true});
for (const name of ['mlAssistantPrompt','researchPrompt','sandboxPrompt','jobCheckPrompt']) {
  let text=read(name==='mlAssistantPrompt'?server+name+'.ts':builtin+name+'.ts');
  text=text.replace(/import[\s\S]*?from "\$lib\/server\/[^"\n]+";/g, statement=>{
    const names=statement.match(/\{([\s\S]*?)\}/)[1].split(',').map(s=>s.trim()).filter(Boolean);
    return names.map(n=>`const ${n} = ${JSON.stringify({ASK_USER_QUESTION_TOOL_NAME:'ask_user_question',GITHUB_FIND_EXAMPLES:'github_find_examples',GITHUB_LIST_REPOS:'github_list_repos',GITHUB_READ_FILE:'github_read_file',EDIT_FILE_TOOL_NAME:'edit_file',IMPORT_FILE_TOOL_NAME:'import_file',READ_FILE_TOOL_NAME:'read_file',WRITE_FILE_TOOL_NAME:'write_file',VIRTUAL_FILE_REFERENCE_RULES:''}[n])};`).join('\n');
  });
  // The actual reference rules must remain verbatim, not an empty substitute.
  if(text.includes('const VIRTUAL_FILE_REFERENCE_RULES = "";'))
    text=text.replace('const VIRTUAL_FILE_REFERENCE_RULES = "";', 'import { VIRTUAL_FILE_REFERENCE_RULES } from "./filePrompt";');
  writeFileSync('upstream/prompts/'+name+'.ts',`// Hugging Face Chat UI, Apache-2.0. ${sha}\n// Generated: imports only adapted. See upstream/README.md.\n`+text);
}
writeFileSync('upstream/prompts/filePrompt.ts',`// Hugging Face Chat UI, Apache-2.0. ${sha}\n// Modified: local scheme constant replaces the web-store import.\n`+read(server+'mlFiles/prompt.ts').replace('import { VIRTUAL_FILE_SCHEME } from "./refs";', 'const VIRTUAL_FILE_SCHEME = "v-file://";'));

// Extract model-facing definitions/doctrine without importing the web server.
const constants={ASK_USER_QUESTION_TOOL_NAME:'ask_user_question',RESEARCH_TOOL_NAME:'research',SANDBOX_TOOL_NAME:'sandbox_task',JOB_CHECK_TOOL_NAME:'check_job',CREATE_TRACKIO_TOOL_NAME:'create_trackio',PLAN_TOOL_NAME:'update_plan',WAIT_TOOL_NAME:'wait',GITHUB_FIND_EXAMPLES:'github_find_examples',GITHUB_READ_FILE:'github_read_file',MAX_STEPS:20,MAX_QUESTIONS:4,MAX_OPTIONS:4,MIN_OPTIONS:2,MIN_WAIT_SECONDS:15,MAX_WAIT_SECONDS:1800,serviceEvents:false};
function expression(path,name){
 const text=read(path), file=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
 let found;
 function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(file)===name)found=n.initializer.getText(file);ts.forEachChild(n,visit);}
 visit(file); if(!found)throw Error('Missing '+name);
 const js=ts.transpile(`(${found})`,{target:ts.ScriptTarget.ES2022});
 return vm.runInNewContext(js,constants);
}
const definitions={};
for(const [file,name] of [['researchTool','definition'],['sandboxTool','definition'],['jobCheckTool','definition'],['createTrackioTool','definition'],['planTool','planToolDefinition']]){
 const d=expression(builtin+file+'.ts',name).function; definitions[d.name]=d;
}
definitions.ask_user_question=expression(server+'askUserQuestion.ts','askUserQuestionTool').function;
const doctrine={research:expression(builtin+'researchTool.ts','RESEARCH_DOCTRINE'),github_find_examples:expression(builtin+'githubGrounding.ts','GROUNDING_DOCTRINE'),wait:expression(builtin+'waitTool.ts','WAITING_PREPROMPT')};
for(const [name,file] of [['update_plan','planTool'],['ask_user_question','askUserQuestion'],['create_trackio','createTrackioTool']]) {
  const path=builtin+file+'.ts',text=read(path),tree=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
  function visit(n){if(ts.isPropertyAssignment(n)&&n.name.getText(tree)==='preprompt')doctrine[name]=vm.runInNewContext(ts.transpile('('+n.initializer.getText(tree)+')',{target:ts.ScriptTarget.ES2022}),constants);ts.forEachChild(n,visit);}
  visit(tree);
}
writeFileSync('upstream/builtins.json',JSON.stringify({definitions,doctrine},null,2)+'\n');
writeFileSync('upstream/LICENSE',readFileSync(join(root,'LICENSE')));
for(const path of readdirSync(join(root,server+'github'),{recursive:true}).filter(p=>/\.(ts|json)$/.test(p))) {
  const source=server+'github/'+path;
  const dest='upstream/github/'+path;
  mkdirSync(dest.slice(0,dest.lastIndexOf('/')),{recursive:true});
  const original=read(source);
  const adapted=original.replaceAll('"$lib/server/config"','"./config"').replaceAll('\0','\\0');
  writeFileSync(dest,adapted===original?adapted:`// Hugging Face Chat UI, Apache-2.0. ${sha}\n// Modified: local configuration import / reviewable NUL spelling.\n${adapted}`);
}
writeFileSync('upstream/github/config.ts','// Local token adapter; not the Chat UI configuration service.\nexport const config = { get GITHUB_TOKEN() { return process.env.GITHUB_TOKEN ?? ""; }, set GITHUB_TOKEN(value: string) { process.env.GITHUB_TOKEN = value; } };\n');
