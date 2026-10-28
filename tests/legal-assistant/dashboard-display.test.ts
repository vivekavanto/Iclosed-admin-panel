import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardMatters,propertyLabel,closingLabel,type DashboardFilters} from '../../src/lib/orchestrator/dashboard-display.ts';
import type {Matter} from '../../src/lib/orchestrator/model.ts';
const make=(id:string,clerk:string,status:string,closingDate:string)=>({id,number:id,address:'1 Maple Rd, Toronto, ON, M1A 1A1',clients:'Sample Client',clerk,status,closingDate,type:'purchase',firm:'navawilson'} as Matter);
const filters:DashboardFilters={view:'five-days',today:'2026-10-26',mine:false,assignedClerk:null,clerks:[],types:[],firms:[],query:''};
const rows=[make('26P-0901','Clerk A','active','2026-10-26'),make('26P-0902','Clerk B','closed','2026-11-01'),make('26P-0903','Clerk A','inactive','2026-10-27'),make('26S-0904','Clerk A','closed','2026-10-23')];
test('all files spans clerks and includes closed files within the selected window',()=>{
 assert.deepEqual(dashboardMatters(rows,filters).map(m=>m.number),['26P-0901','26P-0902']);
 assert.deepEqual(dashboardMatters(rows,{...filters,mine:true,assignedClerk:'Clerk A'}).map(m=>m.number),['26P-0901']);
 assert.equal(dashboardMatters(rows,{...filters,mine:true}).length,0);
 assert.deepEqual(dashboardMatters(rows,{...filters,view:'past',mine:true,assignedClerk:'Clerk A'}).map(m=>m.number),['26S-0904']);
});
test('search and explicit filters apply equally to All Files and My Files',()=>{
 for(const mine of [false,true])assert.equal(dashboardMatters(rows,{...filters,mine,assignedClerk:'Clerk A',clerks:['Clerk B']}).length,mine?0:1);
 assert.equal(dashboardMatters(rows,{...filters,query:'26P0901'}).length,1);
 assert.equal(dashboardMatters(rows,{...filters,query:'Toronto',firms:['iclosed']}).length,0);
});
test('table address omits province and postal code without changing source data',()=>{
 assert.equal(propertyLabel('606-100 Sample Rd, Mississauga, ON, L5B 1H7'),'606-100 Sample Rd, Mississauga');
 assert.equal(propertyLabel('1 Ontario Street, Toronto, Ontario M1A 1A1'),'1 Ontario Street, Toronto');
 assert.equal(propertyLabel('2 Sample Rd, London'),'2 Sample Rd, London');
 assert.equal(closingLabel('2027-01-03').includes('2027'),false);
});

test('Antrim exclusion uses lender identity across every view and clerk tab',()=>{
 for(const view of ['five-days','next-month','past'] as const){
  const closingDate=view==='past'?'2026-10-23':view==='next-month'?'2026-11-10':'2026-10-27';
  const excluded={...make('antrim','Clerk A','active',closingDate),lenders:['Antrim Investments Ltd.']};
  const retained={...make('other','Clerk A','active',closingDate),type:'refinance' as const,address:'1 Antrim Road, Toronto',lenders:['Another Lender']};
  for(const mine of [true,false])assert.deepEqual(dashboardMatters([excluded,retained],{...filters,view,mine,assignedClerk:'Clerk A'}).map(m=>m.id),['other']);
 }
});
