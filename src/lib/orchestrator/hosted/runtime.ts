import {randomUUID} from 'node:crypto';
import {changeHostedDocument,readHostedDocument,hostedDocumentsEnabled} from './document.ts';
import {putHostedBlob,getHostedBlob} from './blob.ts';
export type Operation='coo-render'|'deed-inspect'|'condo-contact';
interface Job{id:string;operation:Operation;input:string;status:'queued'|'running'|'completed'|'failed';createdAt:string;lease?:string;leaseUntil?:string;output?:string;}
interface Runtime{workers?:Record<string,{at:string;version:string}>;jobs:Job[];}
const initial=():Runtime=>({jobs:[]});
export function onHostedWorker(){return process.env.ORCHESTRATOR_HOSTED_WORKER==='true';}
export async function hostedWorkerHealth(role='operations'){const s=await readHostedDocument('runtime',initial),worker=s.workers?.[role];return {ready:worker?.version==='hosted-v1'&&Date.now()-Date.parse(worker.at)>=-30_000&&Date.now()-Date.parse(worker.at)<180_000,lastSeen:worker?.at??null};}
export async function assertHostedWorker(role='operations'){if(hostedDocumentsEnabled()&&!(await hostedWorkerHealth(role)).ready)throw Error('The hosted PDF/audit worker is unavailable. No new work was submitted.');}
export async function heartbeatHostedWorker(role='operations'){return changeHostedDocument('runtime',initial,s=>{(s.workers??={})[role]={at:new Date().toISOString(),version:'hosted-v1'};});}
export async function hostedOperation<T>(operation:Operation,input:unknown):Promise<T>{
 await assertHostedWorker();const hash=await putHostedBlob(Buffer.from(JSON.stringify(input))),id=randomUUID();
 await changeHostedDocument('runtime',initial,s=>{s.jobs.push({id,operation,input:hash,status:'queued',createdAt:new Date().toISOString()});});
 const until=Date.now()+240_000;
 while(Date.now()<until){const job=(await readHostedDocument('runtime',initial)).jobs.find(j=>j.id===id);if(!job)throw Error('The hosted operation record is missing.');if(job.status==='failed')throw Error('The hosted document operation did not complete. Existing records were retained.');if(job.status==='completed'){if(!job.output)throw Error('The hosted operation has no verified result.');return JSON.parse((await getHostedBlob(job.output)).toString('utf8'));}await new Promise(r=>setTimeout(r,1500));}
 throw Error('Document processing is still pending. No notice has been sent. Retry after checking the worker.');
}
export async function claimHostedOperation(){return changeHostedDocument('runtime',initial,s=>{for(const job of s.jobs)if(job.status==='running'&&Date.parse(job.leaseUntil??'')<Date.now())job.status='failed';const job=s.jobs.find(j=>j.status==='queued');if(!job)return null;job.status='running';job.lease=randomUUID();job.leaseUntil=new Date(Date.now()+15*60_000).toISOString();return job;});}
function check(job:Job|undefined,lease:string){if(!job||job.status!=='running'||job.lease!==lease||Date.parse(job.leaseUntil??'')<=Date.now())throw Error('Hosted worker lease expired. Publication refused.');}
export async function finishHostedOperation(id:string,lease:string,output:unknown){const hash=await putHostedBlob(Buffer.from(JSON.stringify(output)));return changeHostedDocument('runtime',initial,s=>{const job=s.jobs.find(j=>j.id===id);check(job,lease);job!.output=hash;job!.status='completed';delete job!.lease;});}
export async function failHostedOperation(id:string,lease:string){return changeHostedDocument('runtime',initial,s=>{const job=s.jobs.find(j=>j.id===id);check(job,lease);job!.status='failed';delete job!.lease;});}
export async function hostedOperationInput(job:{input:string}){return JSON.parse((await getHostedBlob(job.input)).toString('utf8'));}
