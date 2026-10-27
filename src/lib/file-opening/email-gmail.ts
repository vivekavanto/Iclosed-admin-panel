import {auditGoogleToken,AUDIT_MAILBOX} from '../orchestrator/google-audit-auth.ts';
import type {MailMessage,MailThread} from './email-model.ts';
const base='https://gmail.googleapis.com/gmail/v1/users/me';
export class IntakeGmail {
 private token:string;
 constructor(token:string){this.token=token;}
 static async connect(){const g=new IntakeGmail(await auditGoogleToken('gmailRead'));const p=await g.get('/profile');if(p.emailAddress?.toLowerCase()!==AUDIT_MAILBOX)throw Error('Mailbox identity mismatch.');return g;}
 async get(suffix:string){const r=await fetch(base+suffix,{headers:{Authorization:`Bearer ${this.token}`},cache:'no-store',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(r.status===404?(suffix.startsWith('/history?')?'gmail_history_expired':'gmail_message_unavailable'):`Gmail read failed (${r.status}).`);return r.json();}
 async profile():Promise<{historyId:string}>{return this.get('/profile');}
 async history(start:string){const ids=new Set<string>(),messageThreads:Record<string,string>={};let page='';let latest=start;do{const p=new URLSearchParams({startHistoryId:start,historyTypes:'messageAdded',maxResults:'500'});if(page)p.set('pageToken',page);const data=await this.get('/history?'+p);for(const record of data.history??[])for(const m of record.messagesAdded??[]){ids.add(m.message.id);if(m.message.threadId)messageThreads[m.message.id]=m.message.threadId;}latest=data.historyId;page=data.nextPageToken??'';if(ids.size>10000)throw Error('Mailbox catch-up exceeds checked coverage. Checkpoint retained.');}while(page);return {ids:[...ids],historyId:latest,messageThreads};}
 async backfill(){const ids=new Set<string>();let page='';do{const p=new URLSearchParams({q:'newer_than:30d {carriage "open the file" "open a file" "take care of"} -in:spam -in:trash',maxResults:'100'});if(page)p.set('pageToken',page);const data=await this.get('/messages?'+p);for(const m of data.messages??[])ids.add(m.id);page=data.nextPageToken??'';if(ids.size>2000)throw Error('Opening backfill exceeds checked coverage. No checkpoint advanced.');}while(page);return [...ids];}
 message(id:string):Promise<MailMessage>{return this.get('/messages/'+encodeURIComponent(id)+'?format=full');}
 thread(id:string):Promise<MailThread>{return this.get('/threads/'+encodeURIComponent(id)+'?format=full');}
 async attachment(messageId:string,id:string){const data=await this.get('/messages/'+encodeURIComponent(messageId)+'/attachments/'+encodeURIComponent(id));if(typeof data.data!=='string')throw Error('Attachment bytes unavailable.');return Buffer.from(data.data,'base64url');}
}
