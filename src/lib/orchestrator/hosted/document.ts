import {createHash} from "node:crypto";
/** Revisioned private documents. Callbacks may be retried: no external side effects. */
export interface DocumentVersion<T> {revision:number;value:T;}
export interface DocumentBackend {
 read<T>(name:string):Promise<DocumentVersion<T>|null>;
 compareAndSwap<T>(name:string,revision:number,value:T):Promise<boolean>;
}
export function encodeHostedDocument(value:unknown){const json=JSON.stringify(value);if(typeof json!=="string")throw Error("Workflow document cannot be serialized.");return {encoding:"json-v1",json,sha256:createHash("sha256").update(json).digest("hex")};}
export function decodeHostedDocument(value:unknown):unknown{const envelope=value as {encoding?:string;json?:string;sha256?:string};if(!envelope||envelope.encoding!=="json-v1"||typeof envelope.json!=="string"||envelope.sha256!==createHash("sha256").update(envelope.json).digest("hex"))throw Error("Hosted workflow document integrity check failed.");return JSON.parse(envelope.json);}
export class DocumentConflict extends Error {constructor(){super('Workflow changed concurrently. Reload and retry the same request.');}}
export async function changeDocument<T,R>(backend:DocumentBackend,name:string,initial:()=>T,change:(value:T)=>R,attempts=8):Promise<R>{
 for(let attempt=0;attempt<attempts;attempt++){
  const saved=await backend.read<T>(name);
  const value=structuredClone(saved?.value??initial());
  const result=change(value);
  // Transaction callbacks must be synchronous; sending/network work belongs after commit.
  if(result instanceof Promise)throw Error('Workflow transaction callbacks must be synchronous.');
  if(await backend.compareAndSwap(name,saved?.revision??0,value))return result;
 }
 throw new DocumentConflict();
}
export function hostedConfiguration(env:NodeJS.ProcessEnv=process.env){
 if(env.ORCHESTRATOR_STATE_BACKEND!=='supabase')return null;
 if(env.ORCHESTRATOR_LOCAL_STATE_DIR)throw Error('Hosted and local workflow storage cannot be combined.');
 const namespace=env.ORCHESTRATOR_STATE_NAMESPACE;
 if(!namespace||!/^dev-[a-z0-9-]{1,48}$/.test(namespace))throw Error('An explicit isolated dev workflow namespace is required.');
 const url=env.ORCHESTRATOR_SUPABASE_URL,key=env.ORCHESTRATOR_SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw Error('The dedicated workflow database is not configured.');
 const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw Error('Invalid workflow database origin.');
 const projectRef=env.ORCHESTRATOR_DEV_PROJECT_REF;if(!projectRef||!/^[a-z0-9]{3,40}$/.test(projectRef)||parsed.hostname!==projectRef+".supabase.co")throw Error("Select the verified isolated dev workflow project explicitly.");
 return {url:parsed.origin,key,namespace};
}
export function hostedDocumentsEnabled(){return process.env.ORCHESTRATOR_STATE_BACKEND==='supabase';}
export function documentBackend():DocumentBackend {
 const config=hostedConfiguration();if(!config)throw Error('Hosted workflow storage is not selected.');
 const request=async (pathname:string,init:RequestInit)=>{
  const response=await fetch(config.url+'/rest/v1/'+pathname,{...init,headers:{apikey:config.key,Authorization:'Bearer '+config.key,'Content-Type':'application/json'},cache:'no-store',signal:AbortSignal.timeout(20_000)});
  if(!response.ok)throw Error('Hosted workflow storage is unavailable. Existing records were retained.');
  return response.json();
 };
 return {
  async read<T>(name:string){checkName(name);const query=new URLSearchParams({namespace:'eq.'+config.namespace,name:'eq.'+name,select:'revision,value'});const rows=await request('legal_assistant_documents?'+query,{method:'GET'});if(!Array.isArray(rows)||rows.length>1)throw Error('Invalid workflow storage response.');const row=rows[0];if(!row)return null;if(!Number.isSafeInteger(row.revision)||row.revision<1)throw Error("Invalid workflow revision.");return {revision:row.revision,value:decodeHostedDocument(row.value) as T};},
  async compareAndSwap(name,revision,value){checkName(name);const result=await request('rpc/legal_assistant_document_cas',{method:'POST',body:JSON.stringify({p_namespace:config.namespace,p_name:name,p_revision:revision,p_value:encodeHostedDocument(value)})});if(typeof result!=='boolean')throw Error('Invalid workflow transaction response.');return result;},
 };
}
function checkName(name:string){if(!/^[a-z0-9][a-z0-9/._-]{0,180}$/.test(name)||name.includes('..'))throw Error('Invalid private workflow document name.');}
export async function requireHostedBaseline(){
 const expected=process.env.ORCHESTRATOR_BASELINE_SHA256;
 if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw Error('A verified hosted baseline receipt is required before activation.');
 const receipt=await documentBackend().read<{manifestSha256:string;verified:boolean}>('baseline-receipt');
 if(!receipt||receipt.value.verified!==true||receipt.value.manifestSha256!==expected)throw Error('The hosted baseline has not been imported and verified. Existing local records were retained.');
}
export async function readHostedDocument<T>(name:string,initial:()=>T):Promise<T>{await requireHostedBaseline();return (await documentBackend().read<T>(name))?.value??initial();}
export async function changeHostedDocument<T,R>(name:string,initial:()=>T,change:(state:T)=>R){await requireHostedBaseline();return changeDocument(documentBackend(),name,initial,change);}
