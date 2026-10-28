export type CooDepartment = "tax" | "water" | "condo";
export interface CooRecipient { enabled: boolean; organization: string; attention: string; email: string; address: string; }
export interface CooDraft {
  fileId: string; fileNumber: string; firm: "navawilson" | "iclosed"; transaction: "purchase" | "sale" | "refinance";
  property: string; clients: string; newOwners: string; forwardingAddress: string; legalDescription: string; purchaserSolicitor?: string; combineTaxWater?: boolean;
  effectiveDate: string; registrationDate: string; noticeDate: string; instrument: string;
  clerk: string; initials: string; condominium: boolean; ownershipTransfer: boolean; completeTransferConfirmed: boolean; differentDatesConfirmed: boolean;
  cc?: string;
  condoCorporation?: string;
  recipients: Record<CooDepartment,CooRecipient>;
}
export interface CooPacket { department: CooDepartment; filename: string; pdfBase64: string; sha256: string; pages: number; coveredDepartments?: CooDepartment[]; }
export const departmentLabels: Record<CooDepartment,string> = {tax:"Municipal tax",water:"Water",condo:"Condo management"};
export const initialLetters = (name: string) => name.trim().split(/\s+/).filter(Boolean).map(s=>s[0]).join("").toUpperCase();
export function emailAddresses(value:string){return value.split(/[,;]/).map(s=>s.trim()).filter(Boolean);}
export function validEmails(value:string,optional=false,maxAddresses=8){const addresses=emailAddresses(value);return !/[\r\n]/.test(value)&& (optional||addresses.length>0)&&addresses.length<=maxAddresses&&addresses.every(s=>s.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s));}
export function unionEmails(...values:string[]){return [...new Map(values.flatMap(emailAddresses).map(s=>[s.toLowerCase(),s])).values()].join(", ");}
export function sameServiceDepartment(a:CooRecipient,b:CooRecipient){const norm=(v:string)=>v.trim().toLowerCase().replace(/\s+/g," ");return !!a.organization.trim()&&["organization","attention","address"].every(k=>norm(a[k as "organization"|"attention"|"address"])===norm(b[k as "organization"|"attention"|"address"]));}
export function deliveryRecipient(d:CooDraft,k:CooDepartment){return d.combineTaxWater&&(k==="tax"||k==="water")?{...d.recipients.tax,email:unionEmails(d.recipients.tax.email,d.recipients.water.email)}:d.recipients[k];}
const validDate=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s+"T12:00:00Z").toISOString().slice(0,10)===s;
export function validateCooDraft(d: CooDraft): string[] {
  const errors:string[]=[];
  if(d.firm!=="navawilson")errors.push("The iClosed notice template needs to be configured before preparing this file.");
  if(!/^[0-9]{2}[PSR]-[0-9]{4,5}$/.test(d.fileNumber))errors.push("A valid firm file number is required.");
  if(!["purchase","sale","refinance"].includes(d.transaction))errors.push("Select a valid transaction type.");
  if(({purchase:"P",sale:"S",refinance:"R"}as Record<string,string>)[d.transaction]!==d.fileNumber[2])errors.push("The file number and transaction type do not agree.");
  if(d.transaction==="refinance"&&!d.ownershipTransfer)errors.push("A charge-only refinance does not require a change-of-ownership notice.");
  for(const [key,label]of [["property","Property address"],["clients","Client name(s)"],["newOwners","New owner(s)"],["clerk","Assigned clerk"],["initials","Clerk initials"]]as const){if(!d[key]?.trim())errors.push(`${label} is required.`);else if(d[key].length>1200)errors.push(`${label} is too long for the notice.`);}
  if(d.transaction!=="sale"&&!d.forwardingAddress.trim())errors.push("Correspondence address is required.");
  if(d.forwardingAddress.length>1200)errors.push("Correspondence address is too long for the notice.");
  if(d.transaction==="sale"&&!d.forwardingAddress.trim()&&!d.purchaserSolicitor?.trim())errors.push("Add the purchaser's solicitor contact or a confirmed correspondence address for this sale.");
  if((d.purchaserSolicitor?.length??0)>1200)errors.push("The purchaser's solicitor contact is too long for the notice.");
  if(d.legalDescription.length>1800)errors.push("The legal description is too long for a one-page notice.");
  for(const key of ["effectiveDate","registrationDate","noticeDate"]as const)if(!validDate(d[key]))errors.push("Valid effective, registration and notice dates are required.");
  if(!/^[A-Z]{1,4}\d{3,15}$/.test(d.instrument.trim().toUpperCase()))errors.push("Enter the registered transfer instrument number.");
  if(!d.completeTransferConfirmed)errors.push("Confirm that the attachment is the complete registered transfer.");
  if(d.effectiveDate!==d.registrationDate&&!d.differentDatesConfirmed)errors.push("Confirm the effective date differs from the registration date.");
  const selected=(Object.keys(departmentLabels)as CooDepartment[]).filter(k=>d.recipients[k].enabled);
  if(!selected.length)errors.push("Select at least one notice to prepare.");
  if(!validEmails(d.cc??"",true,20))errors.push("Enter valid CC email addresses.");
  if(d.condominium&&d.recipients.condo.enabled&&!d.condoCorporation?.trim())errors.push("Condo corporation name is required.");
  for(const k of selected){const r=d.recipients[k];if(k==="condo"&&!d.condominium)errors.push("Condo management notices require a condominium file.");if(!r.organization.trim())errors.push(`${departmentLabels[k]}: recipient organization is required.`);if(!validEmails(r.email))errors.push(`${departmentLabels[k]}: enter a valid recipient email.`);if([r.organization,r.attention,r.address].some(v=>v.length>600))errors.push(`${departmentLabels[k]}: shorten the recipient details.`);}
  if(d.combineTaxWater){const a=d.recipients.tax,b=d.recipients.water;if(!a.enabled||!b.enabled||!sameServiceDepartment(a,b))errors.push("A combined tax and water notice requires both services and the same verified recipient details.");}
  return [...new Set(errors)];
}
export function decodeCooDraft(value: unknown): CooDraft {
  if(!value||typeof value!=="object")throw new Error("Notice details are required.");
  const v=value as Record<string,unknown>;
  const text=(o:Record<string,unknown>,k:string,max=2000)=>{if(typeof o[k]!=="string"||(o[k]as string).length>max)throw new Error("Invalid or oversized notice details.");return(o[k]as string).trim();};
  const r=v.recipients as Record<string,unknown>;if(!r||typeof r!=="object")throw new Error("Recipient details are required.");
  const recipients={}as CooDraft["recipients"];
  for(const k of ["tax","water","condo"]as const){const item=r[k]as Record<string,unknown>;if(!item||typeof item!=="object")throw new Error("All notice categories must be present.");recipients[k]={enabled:item.enabled===true,organization:text(item,"organization",600),attention:text(item,"attention",600),email:text(item,"email",1200),address:text(item,"address",600)};}
  return{fileId:text(v,"fileId",160),fileNumber:text(v,"fileNumber",24),firm:text(v,"firm",30)as CooDraft["firm"],transaction:text(v,"transaction",30)as CooDraft["transaction"],property:text(v,"property"),clients:text(v,"clients"),newOwners:text(v,"newOwners"),forwardingAddress:text(v,"forwardingAddress"),purchaserSolicitor:v.purchaserSolicitor===undefined?"":text(v,"purchaserSolicitor",1200),combineTaxWater:v.combineTaxWater===true,cc:v.cc===undefined?"":text(v,"cc",1200),condoCorporation:v.condoCorporation===undefined?"":text(v,"condoCorporation",600),legalDescription:text(v,"legalDescription"),effectiveDate:text(v,"effectiveDate",10),registrationDate:text(v,"registrationDate",10),noticeDate:text(v,"noticeDate",10),instrument:text(v,"instrument",24).toUpperCase(),clerk:text(v,"clerk",200),initials:text(v,"initials",20),condominium:v.condominium===true,ownershipTransfer:v.ownershipTransfer===true,completeTransferConfirmed:v.completeTransferConfirmed===true,differentDatesConfirmed:v.differentDatesConfirmed===true,recipients};
}
