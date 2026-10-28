import type {CooDraft} from './model.ts';
import type {TransferFacts} from './transfer-heading.ts';
/** Explicit source fields only. File-role identity is mandatory before applying facts. */
export function prepopulateCoo(draft:CooDraft,facts:TransferFacts){
 const role=draft.transaction==='sale'?'transferor':'transferee';
 const normalize=(s:string)=>s.toUpperCase().replace(/[^A-Z0-9]/g,'');
 if(normalize(facts.fileNumbers[role]??'')!==normalize(draft.fileNumber))throw Error('The deed’s client file number does not match this matter and transaction role. Select the correct registered deed.');
 if(!facts.complete)throw Error('The deed page count does not match its registered heading. Attach the complete transfer.');
 const owners=facts.transferees;
 if(!owners.length||owners.some(p=>!p.name)||!facts.transferors.length||!facts.properties.length)throw Error('The deed’s labelled party or property sections could not be read. Review a clearer registered copy.');
 const propertyNumbers:string[]=draft.property.match(/\d+/g)??[];
 const sourceNumbers=facts.properties[0].address.match(/\b\d+\b/g)??[];
 if(!sourceNumbers.length||!sourceNumbers.every(n=>propertyNumbers.includes(n)))throw Error('The deed’s property address differs from this matter. Review the linked folder and deed.');
 const parts=draft.property.split(',').map(s=>s.trim());
 const cityIndex=parts.findIndex(p=>/^(?:ON|Ontario)\b/i.test(p));
 const civic=parts.slice(0,cityIndex>0?cityIndex-1:Math.max(1,parts.length-1)).join(' ').toUpperCase();
 const generic=new Set(['UNIT','SUITE','STREET','ROAD','DRIVE','AVENUE','COURT','CRESCENT','TERRACE','BOULEVARD','NORTH','SOUTH','EAST','WEST']);
 const streetWords=(civic.match(/[A-Z]{3,}/g)??[]).filter(w=>!generic.has(w));
 if(streetWords.length&&!streetWords.some(w=>facts.properties[0].address.includes(w)))throw Error('The deed’s street name differs from this matter. Select the correct deed.');
 const purchaser=facts.solicitors.find(s=>s.role==='transferee');
 const addresses=[...new Set(owners.map(p=>p.address).filter(Boolean))];
 const exceptions:string[]=[];
 if(addresses.length>1)exceptions.push('The owners have different addresses for service. Both are prefilled with the owner names; confirm the mailing instruction.');
 if(owners.some(p=>!p.address))exceptions.push('An owner’s address for service is absent from the deed.');
 const shares=owners.map(o=>o.share);
 if(shares.every(s=>typeof s==='number')&&Math.abs(shares.reduce<number>((sum,s)=>sum+(s??0),0)-100)>0.01)exceptions.push('The ownership percentages recorded in the deed do not total 100%. Review the registered entries; no percentages have been corrected.');
 const registrationDiffers=!!draft.effectiveDate&&draft.effectiveDate!==facts.registrationDate;
 if(registrationDiffers)exceptions.push('The Closer closing date differs from registration. Confirm which date the notice should use.');
 const description=facts.properties.map(p=>p.description).join('\n');
 const plan=description.match(/([A-Z ]+?(?:STANDARD )?CONDOMINIUM) PLAN NO\.\s*(\d+)/);
 const forwarding=addresses.length===1?addresses[0]:owners.map(p=>`${p.name}: ${p.address}`).join('\n');
 const updated:CooDraft={...draft,instrument:facts.instrument,registrationDate:facts.registrationDate,
  effectiveDate:draft.effectiveDate||facts.registrationDate,differentDatesConfirmed:false,
  newOwners:owners.map(p=>p.name).join('\n'),
  clients:(draft.transaction==='sale'?facts.transferors:owners).map(p=>p.name).join('\n'),
  forwardingAddress:draft.transaction==='sale'&&purchaser?.email?'':forwarding,
  purchaserSolicitor:draft.transaction==='sale'&&purchaser?[purchaser.contact,purchaser.firm,purchaser.email,purchaser.phone].filter(Boolean).join('\n'):draft.purchaserSolicitor,
  // The full legal description is in the attached deed. Do not overflow the cover letter.
  legalDescription:description.length<=220?description:'',
  completeTransferConfirmed:false,
  condominium:draft.condominium||!!plan,
  condoCorporation:draft.condoCorporation|| (plan?`${plan[1].trim()} CORPORATION NO. ${plan[2]}`:''),
 };
 return {draft:updated,exceptions,source:{instrument:facts.instrument,pages:facts.pages,fields:['Registered owners','Client names','Addresses for service','Instrument','Registration date',...(draft.transaction==='sale'&&purchaser?['Purchaser’s solicitor']:[])]}};
}
