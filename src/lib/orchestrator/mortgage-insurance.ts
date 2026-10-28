/** Common mortgagee addresses supplied from the client portal checklist.
 * File-specific lender instructions take precedence; the clerk reviews the selection. */
export const INSURANCE_LENDERS = [
 {id:'rbc',name:'Royal Bank of Canada',aliases:['RBC','Royal Bank of Canada'],address:'Royal Bank of Canada, 10 York Mills Road, 3rd Floor, Toronto, ON M2P 0A2'},
 {id:'scotia',name:'Scotiabank',aliases:['Scotiabank','Bank of Nova Scotia','BNS'],address:'The Bank of Nova Scotia, c/o Property Insurance Tracking Centre, 4715 Tahoe Blvd, Mississauga, ON L4W 0B4'},
 {id:'td',name:'TD Bank',aliases:['TD','TD Bank','Toronto Dominion Bank','Toronto-Dominion Bank','TD Canada Trust'],address:'The Toronto-Dominion Bank, 4720 Tahoe Boulevard, Mississauga, ON L4W 5P2'},
 {id:'cibc',name:'CIBC',aliases:['CIBC','Canadian Imperial Bank of Commerce'],address:'Canadian Imperial Bank of Commerce, National Servicing Centre, P.O. Box 115, Commerce Court, Postal Station, Toronto, ON M5L 1E5'},
 {id:'bmo',name:'BMO',aliases:['BMO','Bank of Montreal'],address:'Bank of Montreal, 2465 Argentia Road, 8th Floor, Mississauga, ON L5N 0B4'},
 {id:'national',name:'National Bank of Canada',aliases:['National Bank','National Bank of Canada'],address:'National Bank of Canada, 800 Saint-Jacques Street, Suite 60001, Montreal, QC H3C 1A3'},
 {id:'equitable',name:'Equitable Bank',aliases:['Equitable Bank','EQ Bank'],address:'Equitable Bank, 25 Ontario Street, Suite 2200, Toronto, ON M5A 0Y9'},
 {id:'highclere',name:'Highclere Capital',aliases:['Highclere Capital'],address:'Highclere Capital, 16 York St, Toronto, ON M5J 0E6'},
 {id:'home',name:'Home Trust',aliases:['Home Trust','Home Trust Company'],address:'Home Trust Company, 145 King Street West, Suite 2300, Toronto, ON M5H 1J8'},
 {id:'computershare',name:'Computershare c/o Home Trust',aliases:['Computershare','Computershare Trust Company of Canada'],address:'Computershare Trust Company of Canada, c/o Home Trust Company, 145 King Street West, Suite 2300, Toronto, ON M5H 1J8'},
] as const;
const normalized=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
export function defaultInsuranceLender(names:readonly string[]=[]){
 const matches=INSURANCE_LENDERS.filter(l=>names.some(n=>l.aliases.some(a=>normalized(n)===normalized(a))));
 return matches.length===1?matches[0].id:'';
}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function insuranceEmailDetails(lenderId:string,address:string,closingDate?:string){
 const lender=INSURANCE_LENDERS.find(l=>l.id===lenderId);
 if(lenderId&&!lender)throw Error('Select a valid lender.');
 const checklist=[`Policy effective date matches the closing date${closingDate?' ('+closingDate+')':''}.`,'Coverage amount meets your lender’s requirements.',`Property address on the policy: ${address}.`,'Policy contains a “cost guaranteed insurance” clause (not needed for condos).','Your lender is listed as the 1st mortgagee, unless its instructions specify a different priority.','Your lender’s mortgagee address appears on the policy.'];
 return '<h3>Home insurance requirements</h3><p>Before releasing your mortgage funds, your lender requires proof that your home is insured as of the closing date, with them listed on the policy. Please share this checklist with your insurance broker.</p><ul>'+checklist.map(item=>'<li>'+escape(item)+'</li>').join('')+'</ul>'+(lender?'<p><strong>Mortgagee: '+escape(lender.name)+'</strong><br/>'+escape(lender.address)+'</p>':'<p>Please contact your law clerk for the mortgagee name and address required by your lender before finalizing the policy.</p>')+'<p>Your lender’s instructions for this file take precedence over this general checklist. You can send the insurance confirmation by replying to this email; you do not need to log in to read these requirements.</p>';
}

export function notificationEligible(type:string){return type==='purchase'||type==='refinance';}
