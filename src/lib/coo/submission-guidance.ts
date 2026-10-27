/** Client handoff is this firm's requested workflow, not a claim that all lawyer submissions are prohibited. */
export function cooSubmissionGuidance(address:string){
 if(!address.split(',').some(p=>p.trim().toLowerCase()==='mississauga'))return null;
 return {
  title:'Mississauga: client submission required',
  message:'Use the client-submission workflow for this file. Prepare the details for the client; do not treat a firm letter as a completed ownership update. The client must complete the owner-signed tax form and the Peel water account form where applicable.',
  note:'The City’s tax form requires the owner’s signature. The published guidance does not establish a blanket ban on a lawyer forwarding a signed form. Water is handled separately by Peel Region.',
  links:[{label:'Owner-signed tax form',url:'https://www.mississauga.ca/wp-content/uploads/2023/11/2185-Tax-account-information-change.pdf'},{label:'Peel water account instructions',url:'https://peelregion.ca/services/water-billing-accounts'}]
 };
}
