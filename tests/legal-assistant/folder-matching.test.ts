import test from "node:test";
import assert from "node:assert/strict";
import { folderMatchesMatter } from "../../src/lib/orchestrator/folder-matching.ts";
import { selectReport } from "../../src/lib/orchestrator/report-selection.ts";
const m={number:"26P-0901",address:"306-8 Harbour Street, Toronto, ON"};
test("folder match needs exact file number, address and unit",()=>{
 assert.equal(folderMatchesMatter(m,"26P-0901 - 306-8 Harbour St - Oct 21"),true);
 assert.equal(folderMatchesMatter(m,"26P-0901 - 307-8 Harbour St - Oct 21"),false);
 assert.equal(folderMatchesMatter(m,"26P-09010 - 306-8 Harbour St"),false);
 assert.equal(folderMatchesMatter(m,"26P-0901 - 306-9 Harbour St"),false);
 assert.equal(folderMatchesMatter(m,"Signing audit 26P-0901 - 306-8 Harbour St"),false);
});
test("common street suffixes normalize without changing property identity",()=>{
 assert.equal(folderMatchesMatter({number:"26S-0902",address:"42 Cedar Court, Markham"},"26S-0902 - 42 Cedar Crt - Nov 2"),true);
});
test("daily refresh refuses partial coverage instead of presenting a full-year count",()=>{
 const files=[{id:"a",name:"Closer_Report_Closing_2026-10-12_to_2026-11-30_run_2026-10-20.csv"}];
 assert.throws(()=>selectReport(files,"2026-10-20","2026-10-21","2026-12-31",true),/full-coverage/);
 assert.equal(selectReport(files,"2026-10-20","2026-10-21","2026-12-31",false).id,"a");
});
test("ambiguous reports and future-dated extracts are not silently selected",()=>{
 const file={id:"a",name:"Closer_Report_Closing_2026-10-01_to_2026-12-31_run_2026-10-20.csv"};
 assert.throws(()=>selectReport([file,{...file,id:"b"}],"2026-10-20","2026-10-21","2026-12-31",true),/Multiple/);
 assert.throws(()=>selectReport([{...file,name:file.name.replace("run_2026-10-20","run_2026-10-21")}],"2026-10-20","2026-10-21","2026-12-31",false),/No detailed/);
});

test('omitted road types retain file number, street name, building and unit identity',()=>{
 const matter={number:'26P-0904',address:'606-100 Sample Road, Mississauga, ON'};
 assert.equal(folderMatchesMatter(matter,'26P-0904 - 606-100 Sample - Oct 26'),true);
 assert.equal(folderMatchesMatter(matter,'26P-0904 - 607-100 Sample - Oct 26'),false);
 assert.equal(folderMatchesMatter(matter,'26P-0904 - 606-100 Sample Avenue'),false);
 assert.equal(folderMatchesMatter({number:'26P-0905',address:'1807-29 Example Trail Court, North York'},'26P-0905 - 1807-29 Example tr - Sep 25'),true);
});
