import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultInsuranceLender,insuranceEmailDetails,INSURANCE_LENDERS} from '../../src/lib/orchestrator/mortgage-insurance.ts';
import {renderMortgageEmail} from '../../src/lib/orchestrator/mortgage-email.ts';
const matter={id:'synthetic-insurance',number:'26P-0999',address:'42 Sample St, Toronto',clients:'Alex Example',clientEmail:'alex@example.test',lenders:['Royal Bank of Canada'],closingDate:'2026-11-01'};
test('only a single recognized lender defaults; aliases are exact and competing or unknown lenders require selection',()=>{
 assert.equal(defaultInsuranceLender(['RBC']),'rbc');assert.equal(defaultInsuranceLender(['BNS']),'scotia');
 assert.equal(defaultInsuranceLender(['Toronto-Dominion Bank']),'td');
 assert.equal(defaultInsuranceLender(['RBC','TD']),'');
 assert.equal(defaultInsuranceLender(['RBC','Unrecognized second lender']),'');
 assert.equal(defaultInsuranceLender(['RBC','Royal Bank of Canada']),'rbc');
 assert.equal(defaultInsuranceLender(['Unknown Bank']),'');
 assert.equal(defaultInsuranceLender(['Fake RBC']),'');
 assert.equal(defaultInsuranceLender(['Computershare Trust Company of Canada']),'computershare');
});
test('lender selection freezes mortgagee address and checklist in the preview; funds never includes insurance',()=>{
 const auto=renderMortgageEmail(matter),changed=renderMortgageEmail(matter,undefined,'mortgage','td');
 assert.equal(auto.lenderId,'rbc');assert.ok(auto.html.includes(INSURANCE_LENDERS[0].address));
 assert.ok(auto.html.includes('November 1, 2026'));assert.ok(auto.html.includes('cost guaranteed insurance'));assert.ok(auto.html.includes('not needed for condos'));
 assert.equal(changed.lenderId,'td');assert.ok(!changed.html.includes(INSURANCE_LENDERS[0].address));assert.notEqual(changed.hash,auto.hash);
 assert.equal(renderMortgageEmail(matter,undefined,'mortgage','').lenderId,'');
 assert.ok(renderMortgageEmail(matter,undefined,'mortgage','').html.includes('contact Aliya'));
 assert.throws(()=>renderMortgageEmail(matter,undefined,'mortgage','made-up'),/valid lender/);
 assert.ok(insuranceEmailDetails('','<script>bad</script>').includes('&lt;script&gt;'));
});

test('client insurance email uses the exact legal mortgagee once in the final bold checklist item',()=>{
 const html=insuranceEmailDetails('scotia',matter.address,matter.closingDate);
 assert.ok(!html.includes('Mortgagee: Scotiabank'));
 assert.ok(!html.includes('Mortgagee:'));
 assert.ok(html.includes('<li><strong>Your lender’s name and address must appear on the policy as follows: The Bank of Nova Scotia, c/o Property Insurance Tracking Centre, 4715 Tahoe Blvd, Mississauga, ON L4W 0B4</strong></li></ul>'));
 assert.equal(html.split('Your lender’s name and address must appear on the policy as follows').length-1,1);
});
test('notification presentation upgrades saved/fallback login links and uses a proportionate high resolution logo',()=>{
 const p=renderMortgageEmail(matter,undefined,'mortgage','scotia','client');
 assert.ok(p.html.includes('href="https://www.iclosed.ca/login"'));
 assert.ok(!p.html.includes('login to iclosed.ca'));
 assert.match(p.html,/<img[^>]+legal-assistant-email-logo\.png[^>]+width="160" height="69"/);
 const saved=renderMortgageEmail(matter,{body:'<p>Please login to iclosed.ca.</p><a href="https://iclosed.ca">Portal</a><img src="https://admin.iclosed.ca/email-logo.png" width="900" height="20" style="width:900px;height:20px" />',subject:null,source:'synthetic legacy template'},'mortgage','scotia','client');
 assert.ok(!saved.html.includes('width="900"'));
 assert.ok(!saved.html.includes('height="20"'));
 assert.equal(saved.html.split('href="https://www.iclosed.ca/login"').length-1,2);
 assert.ok(!saved.html.includes('https://www.iclosed.ca/login.'));
});
