import {NextRequest,NextResponse} from "next/server";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {getSnapshot} from "@/lib/orchestrator/store";
import {approveAndSendCoo} from "@/lib/coo/delivery-store";
import {cooSendReadiness,sendCooMessage} from "@/lib/coo/send";
import {cooSubmissionGuidance} from "@/lib/coo/submission-guidance";
export const runtime="nodejs";export const maxDuration=90;
export async function POST(request:NextRequest){const user=await getStaff();if(!user)return NextResponse.json({error:'Staff sign-in required.'},{status:401});if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Invalid origin.'},{status:403});try{const raw=await request.text();if(raw.length>3000)throw Error('Oversized approval.');const input=JSON.parse(raw);const matter=(await getSnapshot()).matters.find(m=>m.id===input.fileId);if(!matter)throw Error('File not found.');if(cooSubmissionGuidance(matter.address))throw Error('Mississauga uses client submission; firm sending is unavailable.');if(!cooSendReadiness().enabled)return NextResponse.json({error:cooSendReadiness().message},{status:409});const review=await approveAndSendCoo({...input,actor:user.id},sendCooMessage);return NextResponse.json({review:{id:review.id,hash:review.hash,status:review.status,createdAt:review.createdAt,sentAt:review.sentAt}},{headers:{'Cache-Control':'no-store'}});}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'COO sending could not be confirmed.'},{status:409});}}
