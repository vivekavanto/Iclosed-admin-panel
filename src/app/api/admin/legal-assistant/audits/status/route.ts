import {NextResponse} from 'next/server';
import {getStaff} from '@/lib/orchestrator/server-auth';
import {auditDashboardSummaries} from '@/lib/orchestrator/audit-store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(){
  if(!await getStaff())return NextResponse.json({error:'Staff access required.'},{status:401});
  try{return NextResponse.json({summaries:await auditDashboardSummaries()},{headers:{'Cache-Control':'no-store'}});}
  catch{return NextResponse.json({error:'Audit status is unavailable.'},{status:503});}
}
