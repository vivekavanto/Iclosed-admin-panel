import {hostedDocumentsEnabled} from "./hosted/document.ts";
import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {localStateDirectory} from './local-store.ts';
import {digest,type AuditPage} from './audit-model.ts';
export interface PdfInspection {pages:AuditPage[];limitations:string[];}
const VERSION='native-pdfium-v4';
function healthy(value:PdfInspection){
 return Array.isArray(value?.pages)&&value.pages.length>0&&value.pages.length<=200&&value.pages.every((p,i)=>p.number===i+1&&p.rendered===true&&typeof p.text==='string'&&p.text.length<=30000&&typeof p.inkRatio==='number'&&Number.isFinite(p.inkRatio)&&p.inkRatio>=0&&p.inkRatio<=1)&&Array.isArray(value.limitations)&&value.limitations.every(l=>typeof l==='string'&&l.length<=4000&&!/OCR failed|could not be rendered/i.test(l));
}
async function location(hash:string){
 const root=hostedDocumentsEnabled()?(process.env.ORCHESTRATOR_HOSTED_WORKER==="true"?process.env.ORCHESTRATOR_WORKER_CACHE_DIR:null):localStateDirectory();if(!root||!path.isAbsolute(root))return null;
 const runtime=await Promise.all([process.env.ORCHESTRATOR_AUDIT_PYTHON??process.env.ORCHESTRATOR_COO_PYTHON,process.env.ORCHESTRATOR_AUDIT_OCR].map(async file=>{const s=file?await stat(file).catch(()=>null):null;return [file??null,s?.size??null,s?.mtimeMs??null];}));
 return path.join(root,'audits','inspection-cache',digest(JSON.stringify([VERSION,runtime])),hash+'.json');
}
export async function readPdfInspection(bytes:Buffer):Promise<PdfInspection|null>{
 try{const hash=digest(bytes),file=await location(hash);if(!file)return null;const saved=JSON.parse(await readFile(file,'utf8'));return saved.hash===hash&&saved.version===VERSION&&saved.checksum===digest(JSON.stringify(saved.result))&&healthy(saved.result)?saved.result:null;}catch{return null;}
}
export async function savePdfInspection(bytes:Buffer,result:PdfInspection){
 if(bytes.subarray(0,5).toString()!=='%PDF-'||!healthy(result))return false;
 const hash=digest(bytes),file=await location(hash);if(!file)return false;
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';
 await writeFile(temp,JSON.stringify({version:VERSION,hash,checksum:digest(JSON.stringify(result)),result}),{mode:0o600});await rename(temp,file);return true;
}
