export interface AuditMailPart {mimeType?:string;filename?:string;body?:{data?:string;attachmentId?:string};parts?:AuditMailPart[];headers?:{name:string;value:string}[];}
function collect(part:AuditMailPart,type:string):string[]{if(part.mimeType===type&&part.body?.data)return [Buffer.from(part.body.data,'base64url').toString('utf8')];return (part.parts??[]).flatMap(p=>collect(p,type));}
export function auditMailBody(part:AuditMailPart){
 const plain=collect(part,'text/plain');if(plain.length)return plain.join('\n');
 return collect(part,'text/html').join('\n').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?\s*>|<\/p>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
/** Keep forwarded/quoted correspondence as evidence, never as instructions or independently received mail. */
export function auditMailEvidenceText(part:AuditMailPart){
 const body=auditMailBody(part),headers=(part.headers??[]).filter(h=>/^(from|to|cc|subject)$/i.test(h.name)).map(h=>`${h.name}: ${h.value.replace(/[\r\n]+/g,' ').slice(0,2000)}`).join('\n');
 return {hasBody:!!body.trim(),truncated:body.length>64000,text:headers+'\n\nMessage body (may include quoted or forwarded history; quoted dates and senders are not independently verified):\n'+body.slice(0,64000)};
}
