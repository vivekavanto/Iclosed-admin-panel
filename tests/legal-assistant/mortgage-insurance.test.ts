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
 assert.ok(auto.html.includes('2026-11-01'));assert.ok(auto.html.includes('cost guaranteed insurance'));assert.ok(auto.html.includes('not needed for condos'));
 assert.equal(changed.lenderId,'td');assert.ok(!changed.html.includes(INSURANCE_LENDERS[0].address));assert.notEqual(changed.hash,auto.hash);
 assert.equal(renderMortgageEmail(matter,undefined,'mortgage','').lenderId,'');
 assert.ok(renderMortgageEmail(matter,undefined,'mortgage','').html.includes('contact your law clerk'));
 assert.throws(()=>renderMortgageEmail(matter,undefined,'mortgage','made-up'),/valid lender/);
 assert.ok(insuranceEmailDetails('','<script>bad</script>').includes('&lt;script&gt;'));
});
