import {createHash} from "node:crypto";
import {senderAccessToken} from "./sender-oauth.ts";
import {AUDIT_MAILBOX} from "./google-audit-constants.ts";
import {validEmails} from "../coo/model.ts";
export interface OutgoingEmail{to:string[];cc?:string[];subject:string;text:string;html?:string;attachments?:{filename:string;content:string}[];}
const b64=(value:string)=>Buffer.from(value).toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
export function emailMessageId(key:string){return `<iclosed-${createHash('sha256').update(key).digest('hex')}@navawilson.law>`;}
export function gmailMime(message:OutgoingEmail,key:string){
 if(!validEmails(message.to.join(','))||!validEmails((message.cc??[]).join(','),true,20)||/[\r\n]/.test(message.subject)||message.subject.length>600)throw Error('Invalid email recipients or subject.');
 const boundary='iclosed-'+createHash('sha256').update(key).digest('hex').slice(0,24),parts=[`From: ${AUDIT_MAILBOX}`,`To: ${message.to.join(', ')}`,...(message.cc?.length?[`Cc: ${message.cc.join(', ')}`]:[]),`Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,`Message-ID: ${emailMessageId(key)}`,`Date: ${new Date().toUTCString()}`,'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',`--${boundary}`,`Content-Type: ${message.html?'text/html':'text/plain'}; charset=UTF-8`,'Content-Transfer-Encoding: base64','',b64(message.html??message.text)];
 for(const attachment of message.attachments??[]){if(!/^[a-zA-Z0-9._ -]{1,180}$/.test(attachment.filename)||attachment.content.length>14000000)throw Error('Invalid email attachment.');parts.push(`--${boundary}`,'Content-Type: application/pdf',`Content-Disposition: attachment; filename="${attachment.filename}"`,'Content-Transfer-Encoding: base64','',attachment.content.match(/.{1,76}/g)?.join('\r\n')??'');}
 parts.push(`--${boundary}--`,'');return parts.join('\r\n');
}
export async function sendGmail(message:OutgoingEmail,key:string){const raw=Buffer.from(gmailMime(message,key)).toString('base64url'),token=await senderAccessToken();const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({raw}),signal:AbortSignal.timeout(25000),cache:'no-store'});const data=await response.json();if(!response.ok||typeof data.id!=='string')throw Error(`Gmail did not confirm the send (HTTP ${response.status}).`);return {id:data.id as string,messageId:emailMessageId(key),threadId:data.threadId as string|undefined};}
