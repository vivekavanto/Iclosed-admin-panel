import {NextRequest,NextResponse} from "next/server";
import {getStaff} from "@/lib/orchestrator/server-auth";
import {getSnapshot} from "@/lib/orchestrator/store";
import {mortgageTemplate} from "@/lib/orchestrator/mortgage-template";
import {renderMortgageEmail} from "@/lib/orchestrator/mortgage-email";
import {senderOAuthReadiness} from "@/lib/orchestrator/sender-oauth";
import {sendMortgageInternalTest} from "@/lib/orchestrator/mortgage-email-outbox";
import {sendGmail} from "@/lib/orchestrator/gmail-sender";
export const runtime='nodejs';export const dynamic='force-dynamic';
const json=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
async function preview(fileId:unknown){const matter=(await getSnapshot()).matters.find(m=>m.id===fileId);if(!matter)throw Error('File not found.');return renderMortgageEmail(matter,await mortgageTemplate());}
export async function GET(request:NextRequest){if(!await getStaff())return json({error:'Staff sign-in required.'},401);try{return json({...await preview(request.nextUrl.searchParams.get('fileId')),senderConnected:(await senderOAuthReadiness()).connected});}catch(e){return json({error:e instanceof Error?e.message:'Email preview unavailable.'},409);}}
export async function POST(request:NextRequest){const user=await getStaff();if(!user)return json({error:'Staff sign-in required.'},401);if(request.headers.get('origin')!==request.nextUrl.origin)return json({error:'Invalid origin.'},403);try{const raw=await request.text();if(raw.length>3000)throw Error('Oversized email request.');const input=JSON.parse(raw);if(input.action!=='internal-test')return json({error:'Only internal test sends are enabled.'},400);const email=await preview(input.fileId);if(email.hash!==input.hash)throw Error('The template or file details changed. Reopen the preview before sending.');if(!(await senderOAuthReadiness()).connected)return json({error:'Connect the Gmail sender before sending the internal test.'},409);return json({receipt:await sendMortgageInternalTest(email,input.requestId,user.id,sendGmail),testOnly:true,recipient:email.testTo});}catch(e){return json({error:e instanceof Error?e.message:'The internal test could not be confirmed.'},409);}}
