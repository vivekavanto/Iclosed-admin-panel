import {createHash} from 'node:crypto';
import {emailAddresses,validEmails} from '../coo/model.ts';
import type {MortgageEmailPreview} from './mortgage-email.ts';
import {notificationEmailContent,notificationEmailFrame,notificationEditedBody,notificationPlainText,decodeEmailEntities} from './notification-email-layout.ts';
export interface EmailEdits{to?:string;cc?:string;subject:string;body:string;}
/** Keep editable headings, lists, emphasis and friendly links through the review round trip. */
export function editableEmailText(html:string){return decodeEmailEntities(notificationEmailContent(html).split(/<p[^>]*>\s*Warm regards,/i)[0]
 .replace(/<a\b[^>]*href=['"](https:\/\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi,'[$2]($1)')
 .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi,'\n\n## $1\n\n')
 .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,'**$1**')
 .replace(/<li\b[^>]*>/gi,'\n- ').replace(/<\/li>/gi,'\n').replace(/<\/(?:ul|ol)>/gi,'\n\n')
 .replace(/<\/(?:p|div)>/gi,'\n\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/\n{3,}/g,'\n\n').replace(/\n{2,}(?=- )/g,'\n')).trim();}
/** Edits are file-specific; validated recipients and content are bound to the base revision. The branded signature remains server-owned. */
export function editedNotification(base:Omit<MortgageEmailPreview,'senderConnected'>,input:unknown){
 const edit=input as EmailEdits;if(!edit||typeof edit.subject!=='string'||typeof edit.body!=='string'||!edit.subject.trim()||edit.subject.length>400||/[\r\n]/.test(edit.subject)||!edit.body.trim()||edit.body.length>12000)throw Error('Enter a subject and message of up to 12,000 characters.');
 const to=edit.to??base.intendedTo.join(", "),cc=edit.cc??base.intendedCc.join(", ");
 if(typeof to!=='string'||typeof cc!=='string'||!validEmails(to,true,20)||!validEmails(cc,true,20))throw Error('Enter valid To and CC email addresses, separated by commas or semicolons (up to 20 in each field).');
 const unique=(value:string)=>[...new Map(emailAddresses(value).map(email=>[email.toLowerCase(),email])).values()];
 const intendedTo=unique(to),intendedCc=unique(cc).filter(email=>!intendedTo.some(to=>to.toLowerCase()===email.toLowerCase()));
 const signature=notificationEmailContent(base.html).match(/<p[^>]*>\s*Warm regards,[\s\S]*$/i)?.[0]??'<p>Warm regards,</p>';
 const html=notificationEmailFrame(notificationEditedBody(edit.body)+signature),edits={to:intendedTo.join(", "),cc:intendedCc.join(", "),subject:edit.subject.trim(),body:edit.body.trim()};
 return {...base,intendedTo,intendedCc,subject:edits.subject,html,text:notificationPlainText(html),hash:createHash('sha256').update(JSON.stringify({baseHash:base.hash,edits,html,intendedTo,intendedCc})).digest('hex'),baseHash:base.hash,edits,editableText:edits.body};
}
