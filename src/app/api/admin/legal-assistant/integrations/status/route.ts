import {NextResponse} from 'next/server';
import {getStaff} from '@/lib/orchestrator/server-auth';
import {documentBackend,hostedDocumentsEnabled,requireHostedBaseline} from '@/lib/orchestrator/hosted/document';
import type {TeamState} from '@/lib/orchestrator/team-events';
import type {PortalSyncRecord} from '@/lib/orchestrator/portal-sync';
export const dynamic='force-dynamic';
export async function GET(){
 if(!await getStaff())return NextResponse.json({error:'Staff sign-in required.'},{status:401});
 const headers={'Cache-Control':'private, no-store'};
 if(!hostedDocumentsEnabled())return NextResponse.json({hosted:false},{headers});
 try{await requireHostedBaseline();const backend=documentBackend();const [team,portal]=await Promise.all([backend.read<TeamState>('team-notifications'),backend.read<Record<string,PortalSyncRecord>>('portal-sync')]);const deliveries=Object.values(team?.value.deliveries??{});return NextResponse.json({hosted:true,health:team?.value.health??null,slack:{sent:deliveries.filter(d=>d.status==='sent').length,attention:deliveries.filter(d=>['uncertain','blocked'].includes(d.status)).length,pending:deliveries.filter(d=>['pending','sending'].includes(d.status)).length},portal:{verified:Object.values(portal?.value??{}).filter(r=>r.status==='verified').length,attention:Object.values(portal?.value??{}).filter(r=>r.status==='attention').length}},{headers});}catch{return NextResponse.json({error:'Integration status is unavailable.'},{status:503,headers});}
}
