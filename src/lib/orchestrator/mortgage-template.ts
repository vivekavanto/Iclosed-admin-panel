import supabaseAdmin from "../supabaseAdmin";
import {MORTGAGE_TEMPLATE,type MortgageTemplate} from "./mortgage-email";
export async function mortgageTemplate():Promise<MortgageTemplate>{
 const {data,error}=await supabaseAdmin.from('email_templates').select('id,name,body,subject').eq('deleted',false).eq('is_active',true).ilike('body','%We are pleased to inform you that we have received your mortgage instructions%').limit(2);
 if(!error&&data?.length===1&&typeof data[0].body==='string')return {body:data[0].body.replace('Our law clerk is currently reviewing the instructions and will be reaching out to you shortly to schedule an appointment for signing.','Please login to iclosed.ca and complete your home insurance task and schedule your signing appointment.'),subject:data[0].subject,source:`Saved template: ${data[0].name}`};
 if(!error&&data&&data.length>1)throw Error('More than one active mortgage-instructions template matches. Select the intended template before sending.');
 return {body:MORTGAGE_TEMPLATE,subject:null,source:'Provided mortgage-instructions template'};
}
