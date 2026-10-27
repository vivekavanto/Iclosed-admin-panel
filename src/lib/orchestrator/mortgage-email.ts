import {createHash} from "node:crypto";
import {renderTemplateSafe} from "../renderEmailTemplate.ts";
import {emailAddresses,unionEmails,validEmails} from "../coo/model.ts";
import type {Matter} from "./model.ts";
export const MORTGAGE_TEMPLATE=`<p>Dear {{ user.first_name }},</p>
<p>We are pleased to inform you that we have received your mortgage instructions for {{ lead_address }} from your lender.</p>
<p>Our law clerk is currently reviewing the instructions and will be reaching out to you shortly to schedule an appointment for signing.</p>
<p style="margin: 24px 0 2px 0;">Warm regards,</p>
<img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />`;
export const MORTGAGE_TEST_RECIPIENT='communication@navawilson.law';
export interface MortgageTemplate{body:string;subject:string|null;source:string;}
export interface MortgageEmailPreview{fileId:string;hash:string;subject:string;html:string;text:string;greeting:string;intendedTo:string[];testTo:string;source:string;senderConnected:boolean;}
export function renderMortgageEmail(matter:Pick<Matter,'id'|'number'|'address'|'clients'|'clientEmail'|'clientEmails'>,template:MortgageTemplate={body:MORTGAGE_TEMPLATE,subject:null,source:'Provided mortgage-instructions template'}):Omit<MortgageEmailPreview,'senderConnected'>{
 const names=[...new Set(matter.clients.split(/[,;\n]+/).map(name=>name.trim().split(/\s+/)[0]).filter(Boolean))];
 if(!names.length||!matter.address.trim())throw Error('Confirm client names and the property address before preparing this email.');
 const greeting=names.length===1?names[0]:names.slice(0,-1).join(', ')+' and '+names.at(-1);
 const intendedTo=emailAddresses(unionEmails(...(matter.clientEmails??[]),matter.clientEmail??''));
 const values:Record<string,string>={'user.first_name':greeting,lead_address:matter.address,file_number:matter.number,'lead.file_number':matter.number};
 const resolve=(name:string)=>name in values?{value:values[name]}:null;
 const body=renderTemplateSafe(template.body,resolve),baseSubject=renderTemplateSafe(template.subject||'Mortgage instructions received — {{ lead_address }}',resolve,{escape:false});
 if(/\{\{[^{}]+\}\}/.test(body+baseSubject))throw Error('The email template contains unsupported placeholders. Review it before sending.');
 if(/[\r\n]/.test(baseSubject))throw Error('The template subject contains an invalid line break.');
 const subject=`[INTERNAL TEST] ${matter.number} — ${baseSubject}`;
 const html='<p style="padding:12px;background:#fff3cd;"><strong>INTERNAL TEST ONLY</strong> — This message was sent to the shared mailbox for review. No client notification has been sent.</p>'+body;
 const text=html.replace(/<\/(p|div)>|<br\s*\/?>/gi,'\n\n').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
 const hash=createHash('sha256').update(JSON.stringify({fileId:matter.id,subject,html,intendedTo,source:template.source,testTo:MORTGAGE_TEST_RECIPIENT})).digest('hex');
 if(intendedTo.length&&!validEmails(intendedTo.join(','),true,20))throw Error('The register contains invalid client email addresses. Review the file before preparing notifications.');
 return {fileId:matter.id,hash,subject,html,text,greeting,intendedTo,testTo:MORTGAGE_TEST_RECIPIENT,source:template.source};
}
