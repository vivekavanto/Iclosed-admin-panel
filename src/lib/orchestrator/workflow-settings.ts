import {hostedDocumentsEnabled,readHostedDocument,changeHostedDocument} from "./hosted/document.ts";
import {mkdir,readFile,writeFile,rename,rm} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {localStateDirectory} from "./local-store.ts";
import {municipalRecipients,recipientSources} from "../coo/prepare.ts";
import {validEmails,sameServiceDepartment,type CooRecipient} from "../coo/model.ts";
export interface Municipality {id:string;name:string;aliases:string[];tax:CooRecipient;water:CooRecipient;combine:boolean;sources:string[];updatedAt?:string;updatedBy?:string;}
export interface MortgageReceipt {at:string;actor:string;email:string;}
export type FeedbackStatus="pending"|"approved"|"implemented"|"declined";
export interface FeedbackReview {status:FeedbackStatus;actor:string;email:string;at:string;note:string;}
export interface ReportComment {status?:FeedbackStatus;reviews?:FeedbackReview[];id:string;fileId:string;reportRevision:number|null;comment:string;at:string;actor:string;email:string;}
interface State {mortgageClientsInformed?:Record<string,MortgageReceipt>;revision:number;municipalities:Municipality[];mortgage:Record<string,MortgageReceipt>;comments:ReportComment[];municipalityHistory?:{revision:number;before:Municipality|null;after:Municipality;actor:string;at:string}[];}
export function seedMunicipalities():Municipality[]{return [
 ['toronto','Toronto',['Toronto','Scarborough','North York','Etobicoke','East York','York'],[recipientSources.toronto]],
 ['ottawa','Ottawa',['Ottawa'],[recipientSources.ottawa]],['ajax','Ajax',['Ajax'],[recipientSources.ajax,recipientSources.durham]],
 ['pickering','Pickering',['Pickering'],[recipientSources.pickering,recipientSources.durham]],['oshawa','Oshawa',['Oshawa'],[recipientSources.oshawa,recipientSources.durham]],['london','London',['London'],[recipientSources.london]],
 ['mississauga','Mississauga',['Mississauga'],[recipientSources.mississauga,"https://peelregion.ca/services/water-billing-accounts"]],
 ['markham','Markham',['Markham'],[recipientSources.markham,"https://www.markham.ca/neighbourhood-services/water-sewer/rates-meters-billing-fees","https://alectrautilities.com/water-and-wastewaterstormwater-billing-rates"]],
 ['oakville','Oakville',['Oakville'],[recipientSources.oakville,"https://www.halton.ca/for-residents/water-and-wastewater-services/water-meters-rates-and-billing/water-bills-rates-and-fees","https://www.oakvillehydro.com/accounts-services/financial-assistance"]],
 ].map(([id,name,aliases,sources])=>({id:id as string,name:name as string,aliases:aliases as string[],sources:sources as string[],...municipalRecipients(`Example address, ${name}, ON`)}));}
export function withMunicipalityDefaults(entries:Municipality[]){return [...entries.map(entry=>{const seed=seedMunicipalities().find(s=>s.id===entry.id);return seed&&!entry.updatedAt&&!entry.water.organization&&!entry.water.email?{...entry,water:seed.water,sources:[...new Set([...entry.sources,...seed.sources])]}:entry;}),...seedMunicipalities().filter(m=>!entries.some(e=>e.id===m.id||e.aliases.some(a=>m.aliases.some(b=>a.trim().toLowerCase()===b.toLowerCase()))))];}
const initial=():State=>({revision:0,municipalities:seedMunicipalities(),mortgage:{},comments:[]});
function root(){const directory=localStateDirectory();if(!directory)throw new Error("Shared workflow settings storage is not configured. Configure a persistent backend before deployment.");return directory;}
export async function workflowSettings():Promise<State>{if(hostedDocumentsEnabled()){const saved=await readHostedDocument("workflow-settings",initial);return {...saved,municipalities:withMunicipalityDefaults(saved.municipalities)};}try{const saved=JSON.parse(await readFile(path.join(root(),"workflow-settings.json"),"utf8")) as State;return {...saved,municipalities:withMunicipalityDefaults(saved.municipalities)};}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return initial();}}
async function transaction<T>(fn:(s:State)=>T){if(hostedDocumentsEnabled())return changeHostedDocument("workflow-settings",initial,s=>{s.municipalities=withMunicipalityDefaults(s.municipalities);return fn(s);});const dir=root();await mkdir(dir,{recursive:true,mode:0o700});const lock=path.join(dir,".settings-lock"),temp=path.join(dir,`.settings-${randomUUID()}.tmp`);await mkdir(lock,{mode:0o700});try{const s=await workflowSettings();const result=fn(s);await writeFile(temp,JSON.stringify(s),{mode:0o600});await rename(temp,path.join(dir,"workflow-settings.json"));return result;}finally{await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}}
export function resolveMunicipality(address:string,entries:Municipality[]){const places=address.toLowerCase().split(',').map(s=>s.trim());const merged=withMunicipalityDefaults(entries);const matches=merged.filter(m=>m.aliases.some(a=>places.includes(a.trim().toLowerCase())));return matches.length===1?matches[0]:{...municipalRecipients(''),id:'',name:'',aliases:[],sources:[]};}
export function validateMunicipality(input:unknown):Municipality{
 if(!input||typeof input!=="object")throw new Error("Municipality details are required.");const v=input as Municipality;
 if(!/^[a-z0-9-]{1,80}$/.test(v.id)||typeof v.name!=="string"||!v.name.trim()||v.name.length>150||!Array.isArray(v.aliases)||!v.aliases.length||v.aliases.length>20||v.aliases.some(a=>typeof a!=="string"||!a.trim()||a.length>100))throw new Error("Enter a name and locality names for this municipality.");
 for(const k of ['tax','water']as const){const r=v[k];if(!r||['organization','attention','address','email'].some(key=>typeof r[key as keyof CooRecipient]!=="string"||(r[key as keyof CooRecipient]as string).length>(key==="email"?1200:600)))throw new Error("Invalid recipient details.");if(r.email&&!validEmails(r.email))throw new Error("Enter valid municipal contact email addresses.");}
 if(v.combine&&!sameServiceDepartment(v.tax,v.water))throw new Error("Combined notices require the same organization, attention and mailing address.");
 if(!Array.isArray(v.sources)||v.sources.length>10||v.sources.some(s=>typeof s!=="string"||s.length>1000||!/^https:\/\//.test(s)))throw new Error("Source links must use HTTPS.");
 return {id:v.id,name:v.name.trim(),aliases:v.aliases.map(a=>a.trim()),tax:{...v.tax,enabled:true},water:{...v.water,enabled:true},combine:v.combine===true,sources:v.sources};
}
export async function saveMunicipality(input:unknown,expectedRevision:number,actor:string){const entry=validateMunicipality(input);return transaction(s=>{if(s.revision!==expectedRevision)throw new Error("The directory changed. Reload before saving.");const aliases=entry.aliases.map(a=>a.toLowerCase());if(s.municipalities.some(m=>m.id!==entry.id&&m.aliases.some(a=>aliases.includes(a.toLowerCase()))))throw new Error("A locality is already assigned to another municipality.");const saved={...entry,updatedAt:new Date().toISOString(),updatedBy:actor};(s.municipalityHistory??=[]).push({revision:s.revision+1,before:s.municipalities.find(m=>m.id===entry.id)??null,after:saved,actor,at:saved.updatedAt});s.municipalities=s.municipalities.filter(m=>m.id!==entry.id).concat(saved);s.revision++;return {entries:s.municipalities,revision:s.revision};});}
export async function recordMortgageReceipt(fileId:string,actor:string,email:string){return transaction(s=>{if(s.mortgage[fileId])return s.mortgage[fileId];return s.mortgage[fileId]={at:new Date().toISOString(),actor,email};});}
export async function addReportComment(fileId:string,reportRevision:number|null,comment:unknown,actor:string,email:string){if(typeof comment!=="string"||!comment.trim()||comment.length>6000)throw new Error("Enter an overall comment of up to 6,000 characters.");return transaction(s=>{const entry={status:"pending" as const,id:randomUUID(),fileId,reportRevision,comment:comment.trim(),at:new Date().toISOString(),actor,email};s.comments.push(entry);return entry;});}

/** Separate from receipt of lender instructions. Existing receipts never imply client notification. */
export async function recordMortgageClientsInformed(fileId:string,actor:string,email:string,confirmed:unknown){
 if(confirmed!==true)throw new Error("Confirm that clients have been informed before saving.");
 return transaction(s=>{const receipts=s.mortgageClientsInformed??={};return receipts[fileId]??(receipts[fileId]={at:new Date().toISOString(),actor,email});});
}

export async function reviewReportComment(id:unknown,status:unknown,expectedStatus:unknown,note:unknown,actor:string,email:string){
 if(typeof id!=="string"||!['pending','approved','implemented','declined'].includes(String(status))||typeof note!=="string"||note.length>2000)throw new Error("Enter a valid feedback review and a note of up to 2,000 characters.");
 return transaction(s=>{const comment=s.comments.find(c=>c.id===id);if(!comment)throw new Error("Feedback not found.");const current=comment.status??'pending';if(current!==expectedStatus)throw new Error("Feedback changed. Reload before reviewing.");if(current===status)return comment;if(status==='implemented'&&current!=='approved')throw new Error("Approve feedback before marking it implemented.");comment.status=status as FeedbackStatus;(comment.reviews??=[]).push({status:comment.status,actor,email,at:new Date().toISOString(),note:note.trim()});return comment;});
}
