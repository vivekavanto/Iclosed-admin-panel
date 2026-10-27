import type {CooMessage} from "./delivery-store.ts";
export function cooSendReadiness(){return {enabled:process.env.ORCHESTRATOR_COO_SEND_ENABLED==='true'&&!!process.env.ORCHESTRATOR_COO_RESEND_API_KEY&&!!process.env.ORCHESTRATOR_COO_FROM,message:'COO sending requires a verified firm sender and private email-provider configuration.'};}
export async function sendCooMessage(message:CooMessage,key:string){
 if(message.from!==process.env.ORCHESTRATOR_COO_FROM)throw Error('The configured sender changed. Generate a new review before approval.');
 if(!cooSendReadiness().enabled)throw Error(cooSendReadiness().message);
 const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.ORCHESTRATOR_COO_RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from:message.from,to:message.to,...(message.cc.length?{cc:message.cc}:{}),subject:message.subject,text:message.text,attachments:[{filename:message.packet.filename,content:message.packet.pdfBase64}]}),signal:AbortSignal.timeout(20000)});
 const result=await response.json();if(!response.ok||typeof result.id!=='string')throw Error(`The email provider did not confirm acceptance (HTTP ${response.status}).`);return {id:result.id};
}
