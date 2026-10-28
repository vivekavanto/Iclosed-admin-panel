import {defaultInsuranceLender,insuranceEmailDetails,notificationEligible} from "./mortgage-insurance.ts";
import {createHash} from "node:crypto";
import {renderTemplateSafe} from "../renderEmailTemplate.ts";
import {emailAddresses,unionEmails,validEmails} from "../coo/model.ts";
import type {Matter} from "./model.ts";
export const MORTGAGE_TEMPLATE=`<p>Dear {{ user.first_name }},</p>
<p>We are pleased to inform you that we have received your mortgage instructions for {{ lead_address }} from your lender.</p>
<p>Please login to iclosed.ca and complete your home insurance task and schedule your signing appointment.</p>
<p style="margin: 24px 0 2px 0;">Warm regards,</p>
<img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />`;
export type ClientNotificationKind='mortgage'|'funds';
export {notificationEligible} from './mortgage-insurance.ts';
export const FUNDS_TEMPLATE=MORTGAGE_TEMPLATE.replace('We are pleased to inform you that we have received your mortgage instructions for {{ lead_address }} from your lender.','We are pleased to inform you that we have received your mortgage funds for {{ lead_address }} from your lender.').replace('Please login to iclosed.ca and complete your home insurance task and schedule your signing appointment.','Our law clerk will contact you about the next steps for your closing.');
export const MORTGAGE_TEST_RECIPIENT='communication@navawilson.law';
export interface MortgageTemplate{body:string;subject:string|null;source:string;}
export interface MortgageEmailPreview{kind?:ClientNotificationKind;lenderId:string;fileId:string;hash:string;subject:string;html:string;text:string;greeting:string;intendedTo:string[];intendedCc:string[];testTo:string;source:string;senderConnected:boolean;}
export function renderMortgageEmail(matter:Pick<Matter,'id'|'number'|'address'|'clients'|'clientEmail'|'clientEmails'> & Partial<Pick<Matter,'type'|'referralAgentEmails'|'lenders'|'closingDate'>>,template:MortgageTemplate={body:MORTGAGE_TEMPLATE,subject:null,source:'Provided mortgage-instructions template'},kind:ClientNotificationKind='mortgage',lenderChoice?:string):Omit<MortgageEmailPreview,'senderConnected'>{
 if(matter.type&&!notificationEligible(matter.type))throw Error('Client notifications are available only for purchases and refinances.');
 const lenderId=kind==='mortgage'?(lenderChoice??defaultInsuranceLender(matter.lenders)):'';
 const names=[...new Set(matter.clients.split(/[,;\n]+/).map(name=>name.trim().split(/\s+/)[0]).filter(Boolean))];
 if(!names.length||!matter.address.trim())throw Error('Confirm client names and the property address before preparing this email.');
 const greeting=names.length===1?names[0]:names.slice(0,-1).join(', ')+' and '+names.at(-1);
 const intendedTo=emailAddresses(unionEmails(...(matter.clientEmails??[]),matter.clientEmail??''));
 const intendedCc=emailAddresses(unionEmails(...(matter.referralAgentEmails??[]),'aliya@navawilson.law')).filter(email=>!intendedTo.some(to=>to.toLowerCase()===email.toLowerCase()));
 if(intendedCc.length&&!validEmails(intendedCc.join(','),true,20))throw Error('The register contains invalid referral email addresses. Review the file before preparing notifications.');
 const values:Record<string,string>={'user.first_name':greeting,lead_address:matter.address,file_number:matter.number,'lead.file_number':matter.number};
 const resolve=(name:string)=>name in values?{value:values[name]}:null;
 let body=renderTemplateSafe(template.body,resolve);
 if(kind==='mortgage'){const details=insuranceEmailDetails(lenderId,matter.address,matter.closingDate);const signature=body.search(/<p[^>]*>\s*Warm regards,/i);body=signature<0?body+details:body.slice(0,signature)+details+body.slice(signature);}
 const baseSubject=renderTemplateSafe(template.subject||(kind==='funds'?'Funds received — {{ lead_address }}':'Mortgage instructions received — {{ lead_address }}'),resolve,{escape:false});
 if(/\{\{[^{}]+\}\}/.test(body+baseSubject))throw Error('The email template contains unsupported placeholders. Review it before sending.');
 if(/[\r\n]/.test(baseSubject))throw Error('The template subject contains an invalid line break.');
 const subject=`[INTERNAL TEST] ${matter.number} — ${baseSubject}`;
 const html='<p style="padding:12px;background:#fff3cd;"><strong>INTERNAL TEST ONLY</strong> — This message was sent to the shared mailbox for review. No client notification has been sent.</p>'+body;
 const text=html.replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi,'\n\n').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
 const hash=createHash('sha256').update(JSON.stringify({fileId:matter.id,subject,html,intendedTo,intendedCc,kind,source:template.source,testTo:MORTGAGE_TEST_RECIPIENT})).digest('hex');
 if(intendedTo.length&&!validEmails(intendedTo.join(','),true,20))throw Error('The register contains invalid client email addresses. Review the file before preparing notifications.');
 return {kind,lenderId,fileId:matter.id,hash,subject,html,text,greeting,intendedTo,intendedCc,testTo:MORTGAGE_TEST_RECIPIENT,source:template.source};
}

export function renderFundsEmail(matter:Parameters<typeof renderMortgageEmail>[0]){return renderMortgageEmail(matter,{body:FUNDS_TEMPLATE,subject:null,source:'Funds-received template'},'funds');}
