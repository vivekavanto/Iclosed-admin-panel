import { emailForClerk, type Matter } from "../orchestrator/model.ts";
import { initialLetters, unionEmails, type CooDraft, type CooRecipient } from "./model.ts";

// Routes are explicit, not inferred from similarly named organizations or email domains.
// Contacts checked 2026-10-21. Unknown providers require clerk confirmation.
const toronto={organization:"City of Toronto Revenue Services",attention:"Account Administration",address:"PO Box 4300, STN A\nToronto ON M5W 3B5"};
const ottawa={organization:"City of Ottawa Revenue Services",attention:"",address:"100 Constellation Drive, 4th Floor East\nOttawa ON K2G 6J8"};
const durham={organization:"Regional Municipality of Durham",attention:"Water Billing",email:"waterbilling@durham.ca",address:"605 Rossland Road East\nWhitby ON L1N 0B1"};
export const recipientSources={
 toronto:"https://www.toronto.ca/services-payments/property-taxes-utilities/property-tax/buying-selling-or-moving/",
 ottawa:"https://ottawa.ca/en/living-ottawa/taxes/property-taxes/manage-account-and-billing-details/change-ownership",
 durham:"https://www.durham.ca/living-here/my-property/water-billing/",
 ajax:"https://ajax.ca/life-in-ajax/town-services/property-tax-services/property-tax-portal/",
 pickering:"https://www.pickering.ca/property-roads-safety/property-taxes/tax-deferrals-grants-and-rebates/",
 oshawa:"https://www.oshawa.ca/living-here/property-taxes/property-tax-certificates-and-ownership-changes/",
 mississauga:"https://www.mississauga.ca/services-and-programs/property-taxes/",
 markham:"https://www.markham.ca/permits-licences-taxes/property-taxes/contact-us",
 oakville:"https://www.oakville.ca/home-environment/property-tax-assessments/property-ownership-changes/",
 london:"https://london.ca/government/property-taxes-finance/property-taxes",
};
export function municipalRecipients(address:string){
 const blank=():CooRecipient=>({enabled:true,organization:"",attention:"",email:"",address:""});
 const result={tax:blank(),water:blank(),combine:false};
 // Match whole comma-separated locality components, never a street-name substring.
 const places=address.toLowerCase().split(",").map(s=>s.trim());
 const is=(...names:string[])=>names.some(n=>places.includes(n));
 if(is("toronto","scarborough","north york","etobicoke","east york","york")){
  result.tax={...toronto,enabled:true,email:"propertytax@toronto.ca"};result.water={...toronto,enabled:true,email:"utilitybill@toronto.ca"};result.combine=true;
 }else if(is("ottawa")){
  result.tax={...ottawa,enabled:true,email:"revenue@ottawa.ca"};result.water={...result.tax};result.combine=true;
 }else if(is("ajax","pickering","oshawa")){
  result.water={...durham,enabled:true};
  if(is("ajax"))result.tax={enabled:true,organization:"Town of Ajax",attention:"Tax Department",email:"tax@ajax.ca",address:"65 Harwood Avenue South\nAjax ON L1S 2H9"};
  if(is("pickering"))result.tax={enabled:true,organization:"City of Pickering",attention:"Tax Department",email:"propertytaxes@pickering.ca",address:"One The Esplanade\nPickering ON L1V 6K7"};
  if(is("oshawa"))result.tax={enabled:true,organization:"City of Oshawa",attention:"Tax Department",email:"taxownership@oshawa.ca",address:"50 Centre Street South\nOshawa ON L1H 3Z7"};
 }else if(is("mississauga")){result.water={enabled:true,organization:"Peel Region",attention:"Billing Account Management",email:"waterbillingaccountmanagement@peelregion.ca",address:""};result.tax={enabled:true,organization:"City of Mississauga Tax Office",attention:"",email:"tax@mississauga.ca",address:"300 City Centre Drive, Floor 11\nMississauga ON L5B 3C1"};}
 else if(is("markham")){result.water={enabled:true,organization:"Alectra Utilities",attention:"Water Billing",email:"customerservice@alectrautilities.com",address:""};result.tax={enabled:true,organization:"City of Markham",attention:"Tax Department",email:"etax@markham.ca",address:"101 Town Centre Boulevard\nMarkham ON L3R 9W3"};}
 else if(is("oakville")){result.water={enabled:true,organization:"Oakville Hydro",attention:"Water Billing",email:"customerservice@oakvillehydro.com",address:""};result.tax={enabled:true,organization:"Town of Oakville",attention:"Tax Department",email:"tax@oakville.ca",address:""};}
 else if(is("london"))result.tax={enabled:true,organization:"City of London",attention:"Tax Department",email:"taxoffice@london.ca",address:"300 Dufferin Avenue\nLondon ON N6B 1Z2"};
 return result;
}
export function initialCooDraft(m:Matter,route=municipalRecipients(m.address)):CooDraft{
 const counsel=m.opposingCounsel;
 const readyWater=route.water.enabled&&!!route.water.organization.trim()&&!!route.water.email.trim();
 return {fileId:m.id,fileNumber:m.number,firm:m.firm,transaction:m.type,property:m.address,clients:m.clients,newOwners:m.type==="purchase"?m.clients:"",forwardingAddress:"",legalDescription:"",effectiveDate:m.closingDate,registrationDate:"",noticeDate:new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),instrument:"",clerk:m.clerk,initials:initialLetters(m.clerk),cc:unionEmails(...(m.clientEmails??[m.clientEmail??""]),...(m.referralAgentEmails??[]),emailForClerk(m.clerk)),condominium:m.condominium===true,condoCorporation:m.condoCorporation??"",ownershipTransfer:m.type!=="refinance",completeTransferConfirmed:false,differentDatesConfirmed:false,combineTaxWater:route.combine&&readyWater,purchaserSolicitor:m.type==="sale"&&counsel?[counsel.lawyer,counsel.firm,counsel.email,counsel.phone].filter(Boolean).join("\n"):"",recipients:{tax:route.tax,water:{...route.water,enabled:readyWater},condo:{enabled:m.condominium===true&&!!m.condoCorporation?.trim()&&!!m.condoEmail?.trim(),organization:m.condoCorporation??"",attention:"",email:m.condoEmail??"",address:""}}};
}
