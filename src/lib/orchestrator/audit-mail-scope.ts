import type {AuditJob} from './audit-model.ts';
const canonical=(s:string)=>s.toLowerCase().replace(/\bdrive\b/g,'dr').replace(/\bstreet\b/g,'st').replace(/\broad\b/g,'rd').replace(/\bavenue\b/g,'ave').replace(/\bboulevard\b/g,'blvd').replace(/\bcourt\b/g,'ct').replace(/[^a-z0-9]+/g,' ').trim();
export function auditAddressAlias(address:string){
 const street=address.split(',')[0].trim();
 return /^\d[\w\s#./-]{4,200}$/.test(street)?street:'';
}
export function hasAuditAddress(text:string,address:string){const alias=auditAddressAlias(address);return !!alias&&(` ${canonical(text)} `).includes(` ${canonical(alias)} `);}
export function auditMailQuery(job:AuditJob){
 const number=job.matterNumber.replace(/[^a-zA-Z0-9-]/g,''),terms=[`"${number}"`,`"${number.replace(/-/g,'')}"`];
 const street=auditAddressAlias(job.mailScope?.address??'');
 if(street){const words=street.replace(/[^a-zA-Z0-9\s-]/g,' ').split(/\s+/);if(words.length>=3)terms.push(`"${words.slice(0,-1).join(' ')}"`);}
 return `{${terms.join(' ')}} before:${Math.ceil(Date.parse(job.cutoff)/1000)}`;
}
/** Address search is only discovery. Client corroboration and no competing file number establish scope. */
export function verifiedAddressThread(messages:{subject:string;text:string;contacts:string}[],job:AuditJob){
 if(!job.mailScope)return false;
 const all=messages.map(m=>m.subject+'\n'+m.text+'\n'+m.contacts).join('\n');
 const own=job.matterNumber.replace(/[^a-z0-9]/gi,'').toLowerCase();
 const fileNumbers=all.match(/\b\d{2}[\s-]*[PSRD][\s-]*\d{4}\b/gi)??[];
 if(fileNumbers.some(n=>n.replace(/[^a-z0-9]/gi,'').toLowerCase()!==own))return false;
 if(!messages.some(m=>hasAuditAddress(m.subject,job.mailScope!.address)||hasAuditAddress(m.text,job.mailScope!.address)))return false;
 const lower=all.toLowerCase();
 const emailMatch=job.mailScope.clientEmails.some(email=>email.length>5&&lower.includes(email.toLowerCase()));
 const tokens=canonical(all).split(' ');
 const nameMatch=job.mailScope.clients.split(/,|;|\band\b/i).some(name=>{const words=canonical(name).split(' ').filter(w=>w.length>1);return words.length>=2&&words.every(w=>tokens.includes(w));});
 return emailMatch||nameMatch;
}
