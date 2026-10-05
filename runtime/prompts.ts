import { mlAssistantPreprompt, mlAssistantSessionContext, mlAssistantToolDoctrineBlocks, ML_ASSISTANT_TOOL_DOCTRINE } from '../upstream/prompts/mlAssistantPrompt';
import { buildResearchSystemPrompt } from '../upstream/prompts/researchPrompt';
import { sandboxSystemPrompt, SANDBOX_DELEGATION_DOCTRINE } from '../upstream/prompts/sandboxPrompt';
import { jobCheckSystemPrompt, JOB_CHECK_DELEGATION_DOCTRINE } from '../upstream/prompts/jobCheckPrompt';
import builtins from '../upstream/builtins.json';
import {logicalName,toolNameMap} from './contracts';

const FILES = `# Scripts are local files
Write each script once with write; fix it with edit, not whole-file rewrites. Use read for targeted lines. Pass "file://train.py" as the whole hf_jobs args.script or hf_fs_write content value, or the token after --text in hf_sandbox_fs write. Pi expands it before dispatch; do not paste scripts into calls. Paths are relative to the working directory; absolute file paths also work. Use distinct immutable filenames for submitted versions and pass that path to check_job. Never assume the current edited file is what a previous job ran.
A script requested for the user to read, edit, keep or run is a local deliverable: submit nothing. Asking for code is not permission to execute it.
After fixing a sandbox copy, return the exact remote path and command. The parent must retrieve that tested copy before submitting; do not pretend the local copy was updated.`;

const POLICY = `# Private outputs and spending
All outputs are private by default: models/checkpoints, datasets, source, Spaces/demos, metrics and backing storage, reports, collections, logs. Public inputs do not authorize public outputs. Use create_repo with private=true and hub_private_repo=True in training code. Inspect existing destinations before writing; exist_ok does not make a public destination private. After Pi restarts or switches branches, previous creation receipts are invalidated because Hub MCP metadata cannot recheck visibility: use a newly created private destination, or stop rather than assuming the old one is still private. Stop an upload to a public destination unless the user explicitly authorized publication of that artifact through the Pi control. Never change existing visibility silently. A matching /ml-intern publish command or accepted confirmation is final and needs no second confirmation; ordinary chat text alone is not authority.
Private hosted Trackio may require a subscription, and static Trackio cannot be private. Log Trackio metrics locally inside the job, with early and final SQLite snapshots uploaded to a new PRIVATE HF dataset reserved by create_trackio. Run hf_whoami with the current credential and pass the desired namespace explicitly; never infer output ownership from an old session or test fixture. This is NOT a live hosted dashboard. Verify the persisted loss rows by authenticated readback; do not silently publish, omit monitoring, or treat init success as proof of persistence.
New rented compute (including smoke jobs and paid CPU sandboxes) and paid hosting/storage require a task allowance or explicit standing authorization. Printing a preflight or interpreting chat language is not consent. Before submitting or creating paid resources, use request_authorization with the concrete reason and best available estimate; only the user's Pi confirmation button records authority. In headless mode, stop and ask the user to enter /ml-intern allow <scope>. Name every paid Job, sandbox or new Space/bucket with the scope as a lowercase hyphenated prefix (e.g. 'small smoke' -> 'small-smoke-check'); only an explicitly granted 'standing' allowance is exempt. Never reuse an allowance for a new experiment. For explicit public artifacts, request_authorization needs the exact hf:// URI and a user confirmation, or the user can enter /ml-intern publish <URI>. Ordinary cheap lookups, local compute and existing Pi inference need no extra allowance; unusually large paid batches warrant asking. Checks, smoke tests, failed attempts and retries all count against the same experiment allowance. New experiments need new permission unless standing authorization covers them. Record authorization scope, estimates, observed costs and pending IDs in the plan; ask before uncertain, unpriced or over-allowance work. No hard spending cap or ledger is enforced here; infrastructure owns enforcement and execution isolation.
In a saved session mode persists until /ml-intern off; a new command-only session must receive an assistant reply before Pi writes it to disk. Exiting or closing Pi DOES NOT cancel jobs. Report outstanding IDs/URLs and continuing charges. Cancel only when asked. Waits work only while this process is running; after reopening inspect fresh status. There is no daemon, automatic wakeup or authoritative background state feed. Stored references are historical, not current status.
Questions use Pi UI. Headless unanswered decisions stop work and preserve the blocking question; resume this session with the answer. If the reply does not answer it, ask again. Do not guess material choices. Models/providers are the user's selection and delegates inherit them.`;

function replace(text: string, old: string, value: string) {
  if (!text.includes(old)) throw Error('Upstream prompt changed; review adaptation: '+old.slice(0,70));
  return text.replace(old,value);
}

export function modePrompt(names: string[], identity: {username?:string; billTo?:string; billingResourceGroup?:string}, now = new Date()) {
  const mapping=toolNameMap(names);names=names.map(logicalName);
  let main = mlAssistantPreprompt({virtualFiles:false,stateBlock:false});
  const start = main.indexOf('# Scripts: artifact or payload');
  const end = main.indexOf('# When a run fails',start);
  main = main.slice(0,start)+FILES+'\n\n'+main.slice(end);
  main = replace(main,'"<the whole script>"','"file://train.py"');
  const doctrine = mlAssistantToolDoctrineBlocks(names,{serviceEvents:false}).map(text=>{
    if(text.includes('confirm the dashboard has rows in it'))text = replace(text,'confirm the dashboard has rows in it','confirm a private metrics snapshot has early rows in it');
    if(text.startsWith('RUNNING JOBS')) {
      text = replace(text,'The name goes out prefixed with ml-intern-, and every submission carries an ml-intern-session label; never set or remove that label. update-labels replaces the whole set, so send every label the job should keep; the name and the session label are kept for you.', 'Name jobs clearly. Pi stamps jobs and sandboxes with protected session, build, prompt, and authorization labels; label replacement is disabled so those provenance labels cannot be removed.');
      text = replace(text,'and the server sets it on every hf_jobs call.', 'and you must pass that namespace explicitly on every hf_jobs call.');
      const metricsStart=text.indexOf('- Metrics.');
      const metricsEnd=text.indexOf('\n- Data.',metricsStart);
      if(metricsStart<0||metricsEnd<0)throw Error('Upstream Trackio doctrine changed; review the private metrics integration.');
      text=text.slice(0,metricsStart)+`- Metrics. Every training job logs early and final values through Trackio. Run hf_whoami, then call create_trackio with an explicit namespace before submission to reserve the exact PRIVATE dataset URI. Create it with create_repo(private=true), then use trackio.init(project=..., name=...) locally in the job without space_id. Upload an early SQLite backup and a final one to the private dataset using HF_TOKEN as a job secret. Inspect logs AND authenticated readback of metric rows: Trackio init and a local-only database do not establish persistence. Monitor job logs during the run; without a subscription there is no hosted live dashboard.\n`+text.slice(metricsEnd+1);
    }
    if(text.startsWith('WRITING TO THE HUB')) text = replace(text,'Work in repos you created. Your access covers what this assistant makes, not what the user already had: writing to a repo or bucket that something else created fails with an authorization error, and no retry, rename or different tool gets around it. Make your own, named for what it holds.', 'Work in private repos you created, named for what they hold. Use only permissions available through the configured MCP credentials. Inspect an existing destination and its visibility before writing.');
    return text;
  });
  const builtinDoctrine = Object.entries(builtins.doctrine).filter(([n])=>names.includes(n)).map(([name,text])=>name==='create_trackio'
    ? 'PRIVATE TRACKIO: create_trackio reserves a private metrics dataset URI, not a Space. Run hf_whoami and supply an explicit namespace. Create a new private dataset, log via local trackio in the job, persist an early and final SQLite snapshot, and verify metric rows by authenticated readback. Do not construct a space_id, publish metrics or promise a hosted live dashboard on a free account.'
    : text);
  if(names.includes('sandbox_task')) builtinDoctrine.push(SANDBOX_DELEGATION_DOCTRINE('sandbox_task',{virtualFiles:false}));
  if(names.includes('check_job')) builtinDoctrine.push(JOB_CHECK_DELEGATION_DOCTRINE('check_job',{virtualFiles:false}));
  return [main,...Object.values(ML_ASSISTANT_TOOL_DOCTRINE),...doctrine,...builtinDoctrine,POLICY,mapping,mlAssistantSessionContext({...identity,now})].join('\n\n');
}

export function delegatePrompt(role: string, names: string[]) {
  const mapping=toolNameMap(names);names=names.map(logicalName);
  if(role==='research') return buildResearchSystemPrompt(new Set(names))+mapping;
  if(role==='sandbox_task') return sandboxSystemPrompt({virtualFiles:false})+mapping;
  return jobCheckSystemPrompt({virtualFiles:false})+(names.includes('read')?'\n\nYou may also read only the immutable script_path supplied by the parent; inspect only the lines relevant to the error.':'')+mapping;
}
