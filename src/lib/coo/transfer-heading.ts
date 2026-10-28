import {hostedDocumentsEnabled} from "../orchestrator/hosted/document.ts";
import {hostedOperation,onHostedWorker} from "../orchestrator/hosted/runtime.ts";
import {spawn} from 'node:child_process';
import path from 'node:path';
export interface TransferFacts {
 instrument:string; registrationDate:string; pages:number; complete:boolean;
 properties:{description:string;address:string}[];
 transferors:{name:string;address:string}[];transferees:{name:string;address:string;share?:number}[];
 solicitors:{role:string;contact:string;email:string;phone:string;firm?:string}[];
 fileNumbers:Record<string,string>;
}
export async function cooTransferHeading(pdf:string):Promise<TransferFacts|null>{
 if(hostedDocumentsEnabled()&&!onHostedWorker())return hostedOperation("deed-inspect",{pdf});
 const python=process.env.ORCHESTRATOR_COO_PYTHON;if(!python||!path.isAbsolute(python))return null;
 return new Promise(resolve=>{
  const child=spawn(python,[path.join(process.cwd(),'scripts/coo/inspect_transfer.py')],{stdio:['pipe','pipe','pipe'],env:{NODE_ENV:process.env.NODE_ENV,PATH:process.env.PATH??'',PYTHONNOUSERSITE:'1',PYTHONIOENCODING:'utf-8'},signal:AbortSignal.timeout(20_000)});
  let output='';child.stdout.on('data',b=>{output+=b;if(output.length>100_000)child.kill();});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('error',()=>resolve(null));
  child.on('close',()=>{try{const v=JSON.parse(output);resolve(v&&/^[A-Z]{1,4}\d{3,15}$/.test(v.instrument)&&/^\d{4}-\d{2}-\d{2}$/.test(v.registrationDate)&&Array.isArray(v.transferees)&&Array.isArray(v.properties)?v:null);}catch{resolve(null);}});
  child.stdin.end(JSON.stringify({pdf}));
 });
}
