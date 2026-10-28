import type {CooDraft} from './model.ts';
import {validEmails} from './model.ts';
export interface CondoContactResult {
 message:string;
 contact?:{corporation:string;organization:string;attention:string;email:string;address:string;};
 sources:{id:string;name:string;sha256:string;page:number;}[];
}
export function corporationIdentity(value:string){
 const full=value.toUpperCase().replace(/[^A-Z0-9]/g,'');
 const match=full.match(/^(TORONTOSTANDARD|TORONTO|YORKREGIONSTANDARD|YORKREGION|PEELSTANDARD|PEEL|DURHAMSTANDARD|DURHAM|HALTONSTANDARD|HALTON|METROPOLITANTORONTO|OTTAWACARLETONSTANDARD|OTTAWACARLETON)CONDOMINIUMCORPORATION(?:NO)?(\d+)$/);
 const short=full.match(/^(TSCC|TCC|YRSCC|YRCC|PSCC|PCC|DSCC|DCC|HSCC|HCC|MTCC|OCSCC|OCC)(\d+)$/);
 const prefixes:Record<string,string>={TORONTOSTANDARD:'TSCC',TORONTO:'TCC',YORKREGIONSTANDARD:'YRSCC',YORKREGION:'YRCC',PEELSTANDARD:'PSCC',PEEL:'PCC',DURHAMSTANDARD:'DSCC',DURHAM:'DCC',HALTONSTANDARD:'HSCC',HALTON:'HCC',METROPOLITANTORONTO:'MTCC',OTTAWACARLETONSTANDARD:'OCSCC',OTTAWACARLETON:'OCC'};
 return match?prefixes[match[1]]+Number(match[2]):short?short[1]+Number(short[2]):full;
}
export function applyCondoContact(draft:CooDraft,result:CondoContactResult,overwrite=false):CooDraft{
 const c=result.contact;if(!c||!draft.condominium||!draft.condoCorporation||corporationIdentity(c.corporation)!==corporationIdentity(draft.condoCorporation)||!validEmails(c.email,true))return draft;
 const prior=draft.recipients.condo;
 // An explicit user action may replace a filled contact; background loads never do.
 if(prior.email.trim()&&!overwrite)return draft;
 return {...draft,recipients:{...draft.recipients,condo:{...prior,enabled:validEmails(c.email),organization:c.organization,attention:c.attention,email:c.email,address:c.address}}};
}
