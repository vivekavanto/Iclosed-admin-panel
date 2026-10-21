import {notFound} from "next/navigation";
import AuditWorkspace from "@/components/orchestrator/AuditWorkspace";
import type {Matter} from "@/lib/orchestrator/model";
import {AUDIT_RULESET,type AuditReport,type AuditJob} from "@/lib/orchestrator/audit-model";
export default function PreviewAudit(){if(process.env.NODE_ENV!=="development"||process.env.ORCHESTRATOR_PREVIEW!=="true")notFound();
 const matter:Matter={id:"demo-audit",number:"26P0901",name:"Fictional purchase",type:"purchase",firm:"navawilson",address:"42 Example Avenue, Toronto",clients:"Sample clients",clientEmail:"",clientPhone:"",clerk:"Marcela Pitella",lawyer:"",closingDate:"2026-10-30",openingDate:"2026-10-01",status:"active",closerUrl:null,driveFolderId:null,sourceDate:"2026-10-20",sourcePresent:true};
 const at="2026-10-20T20:00:00Z",hash="a".repeat(64);
 const report:AuditReport={matterId:matter.id,revision:2,nextFinding:5,history:[{jobId:"demo-job",at,packageHash:hash,ruleset:AUDIT_RULESET,cutoff:at}],findings:[
 {id:"F-001",key:"payment-date",kind:"discrepancy",summary:"First payment dates differ",action:"Confirm the lender’s controlling schedule and align the signing documents.",claim:"text",proposedBlocker:true,evidence:[{sourceId:"package",page:21,quote:"First payment: November 1, 2026"},{sourceId:"package",page:38,quote:"First Payment Date: November 12, 2026"}],disposition:"Needs lawyer review",notes:"Please confirm with the lender.",movement:"Unchanged",validation:[]},
 {id:"F-002",key:"occupancy",kind:"question",summary:"Confirm the intended occupancy and leasing plan",action:"Ask whether the clients will occupy the whole property or rent part of it.",claim:"manual",proposedBlocker:false,evidence:[],disposition:"Open",notes:"",movement:"New",validation:[]},
 {id:"F-003",key:"condo-notice",kind:"follow_up",summary:"Condo ownership notice after registration",action:"Send the registered transfer to the verified property manager after closing.",claim:"manual",proposedBlocker:false,evidence:[],disposition:"Open",notes:"",movement:"Unchanged",validation:[]},
 {id:"F-004",key:"funds-request",kind:"unable_to_assess",summary:"Lender portal submission is outside reviewed coverage",action:"Verify the accepted request for funds in the lender portal.",claim:"missing_evidence",proposedBlocker:false,evidence:[],disposition:"Open",notes:"",movement:"Unable to reassess",validation:["A missing mailbox receipt does not establish non-submission."]}]};
 const job:AuditJob={id:"demo-job",matterId:matter.id,matterNumber:matter.number,packageId:"demo-package",packageHash:hash,packageName:"Sample signing package.pdf",folderId:"demo-folder",cutoff:at,ruleset:AUDIT_RULESET,status:"completed",actor:"demo",createdAt:at,updatedAt:at};
 return <AuditWorkspace matter={matter} demo initial={{jobs:[job],report,sources:[{id:"demo-package",name:"Sample signing package.pdf"}],readiness:{enabled:true,reasons:[]}}}/>;
}
