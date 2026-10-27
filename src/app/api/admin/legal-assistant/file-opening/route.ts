import {NextRequest,NextResponse} from 'next/server';
import {getStaff} from '@/lib/orchestrator/server-auth';
import {buildPlan} from '@/lib/file-opening/model';
import {readTickler} from '@/lib/file-opening/tickler';
import {openingDrafts,saveOpeningDraft} from '@/lib/file-opening/store';
import {torontoDate} from '@/lib/orchestrator/closing-views';
export const runtime='nodejs';export const dynamic='force-dynamic';
const json=(v:unknown,s=200)=>NextResponse.json(v,{status:s,headers:{'Cache-Control':'no-store'}});
export async function GET(){if(!await getStaff())return json({error:'Staff sign-in required.'},401);try{return json({drafts:await openingDrafts()});}catch{return json({error:'Saved opening requests could not be loaded. Existing records retained.'},503);}}
export async function POST(request:NextRequest){const user=await getStaff();if(!user)return json({error:'Staff sign-in required.'},401);if(request.headers.get('origin')!==request.nextUrl.origin)return json({error:'Invalid origin.'},403);try{const text=await request.text();if(text.length>16000)throw Error('Opening request is too large.');const body=JSON.parse(text);if(!['preview','save'].includes(body.action))throw Error('Unknown opening action.');const tickler=await readTickler();const plan=buildPlan(body.input,tickler.rows,torontoDate(),tickler.fingerprint);const blockers=[...(!tickler.canEdit?['The connected Google account can read Tickler but cannot edit it.']:[]),'Firm-specific Drive folder writers and the shared number allocator are not connected.','The Mac mini Closer script is not connected or validated.'];if(body.action==='preview')return json({plan,blockers,ticklerName:tickler.name});if(body.hash!==plan.hash)throw Error('Tickler or file details changed. Check the plan again before saving.');return json({draft:await saveOpeningDraft(plan,user.id,body.requestId),blockers});}catch(e){return json({error:e instanceof Error?e.message:'Could not check the opening request.'},409);}}
