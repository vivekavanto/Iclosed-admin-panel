import {createHash} from 'node:crypto';
import type {MortgageEmailPreview} from './mortgage-email.ts';
import {notificationEmailContent,notificationEmailFrame,notificationEditedBody,notificationPlainText,decodeEmailEntities} from './notification-email-layout.ts';
export interface EmailEdits{subject:string;body:string;}
/** Keep editable headings, lists, emphasis and friendly links through the review round trip. */
export function editableEmailText(html:string){return decodeEmailEntities(notificationEmailContent(html).split(/<p[^>]*>\s*Warm regards,/i)[0]
 .replace(/<a\b[^>]*href=['"](https:\/\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi,'[$2]($1)')
 .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi,'\n\n## $1\n\n')
 .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,'**$1**')
 .replace(/<li\b[^>]*>/gi,'\n- ').replace(/<\/li>/gi,'\n').replace(/<\/(?:ul|ol)>/gi,'\n\n')
 .replace(/<\/(?:p|div)>/gi,'\n\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/\n{3,}/g,'\n\n').replace(/\n{2,}(?=- )/g,'\n')).trim();}
/** Edits are file-specific; recipients, branded signature and base revision stay server-owned. */
export function editedNotification(base:Omit<MortgageEmailPreview,'senderConnected'>,input:unknown){
 const edit=input as EmailEdits;if(!edit||typeof edit.subject!=='string'||typeof edit.body!=='string'||!edit.subject.trim()||edit.subject.length>400||/[\r\n]/.test(edit.subject)||!edit.body.trim()||edit.body.length>12000)throw Error('Enter a subject and message of up to 12,000 characters.');
 const signature=notificationEmailContent(base.html).match(/<p[^>]*>\s*Warm regards,[\s\S]*$/i)?.[0]??'<p>Warm regards,</p>';
 const html=notificationEmailFrame(notificationEditedBody(edit.body)+signature),edits={subject:edit.subject.trim(),body:edit.body.trim()};
 return {...base,subject:edits.subject,html,text:notificationPlainText(html),hash:createHash('sha256').update(JSON.stringify({baseHash:base.hash,edits,html})).digest('hex'),baseHash:base.hash,edits,editableText:edits.body};
}
