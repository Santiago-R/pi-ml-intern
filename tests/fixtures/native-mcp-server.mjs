// Offline JSON-RPC stdio fixture: no credentials, network or paid operations.
import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('./hf-intern-tools.json',import.meta.url),'utf8'));
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.id===undefined)return;
  let result;
  if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline-hf',version:'1'}};
  else if(request.method==='tools/list')result={tools:fixture.tools.map(t=>({name:t.name,description:t.description,inputSchema:t.parameters}))};
  else if(request.method==='tools/call') {
    const {name,arguments:args}=request.params;
    appendFileSync(process.env.ML_TEST_EVENTS,JSON.stringify({name,args})+'\n');
    if(name==='hf_whoami')result={content:[],structuredContent:{account:{name:'owner'}}};
    else if(name==='create_repo')result={content:[],structuredContent:{action:'created'}};
    else if(name==='hf_jobs'&&(args.args?.job_id==='missing'||args.args?.name==='smoke-error'))result={content:[{type:'text',text:'Recoverable service error'}],isError:true};
    else if(name==='hf_jobs'&&args.operation==='uv')result={content:[{type:'text',text:'Accepted without an ID'}]};
    else if(name==='hf_jobs')result={content:[{type:'text',text:'Status is in structuredContent.'}],structuredContent:{outcome:{kind:'inspections',inspections:[{job_id:args.args.job_id,job:{status:{stage:'COMPLETED'}}}]}}};
    else result={content:[{type:'text',text:'Offline lookup'}]};
  } else if(request.method==='ping')result={};
  else {send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}});return;}
  const delay=request.method==='tools/list'?Number(process.env.ML_TEST_DISCOVERY_DELAY_MS??0):request.params?.arguments?.args?.job_id==='slow'?5000:0;
  if(delay)setTimeout(()=>send({jsonrpc:'2.0',id:request.id,result}),delay);
  else send({jsonrpc:'2.0',id:request.id,result});
});
