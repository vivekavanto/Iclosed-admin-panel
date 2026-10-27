import { NextResponse } from "next/server";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { getSnapshot } from "@/lib/orchestrator/store";
import { decodeCooDraft, initialLetters, validateCooDraft } from "@/lib/coo/model";
import { renderCooReview } from "@/lib/coo/render";
import {storeCooReview} from "@/lib/coo/delivery-store";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request:Request){
 const url=new URL(request.url),origin=request.headers.get("origin");
 const allowedOrigins=new Set([url.origin]);
 if(process.env.NODE_ENV==="development"){allowedOrigins.add("http://127.0.0.1:3002");allowedOrigins.add("http://localhost:3002");}
 if(!origin||!allowedOrigins.has(origin))return NextResponse.json({error:"Request origin could not be verified."},{status:403});
 const demo=url.searchParams.get("demo")==="true";
 if(demo&&(process.env.NODE_ENV!=="development"||process.env.ORCHESTRATOR_PREVIEW!=="true"))return NextResponse.json({error:"Preview unavailable."},{status:404});
 const user=demo?null:await getStaff();
 if(!demo&&!user)return NextResponse.json({error:"Unauthorized"},{status:401});
 try{
  const reader=request.body?.getReader();if(!reader)throw new Error("Notice details are required.");const chunks:Uint8Array[]=[];let length=0;
  while(true){const{done,value}=await reader.read();if(done)break;length+=value.length;if(length>14_000_000){await reader.cancel();return NextResponse.json({error:"Choose a transfer PDF smaller than 10 MB."},{status:413});}chunks.push(value);}
  const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));const draft=decodeCooDraft(body.draft);
  if(demo){if(!/^demo:26[PSR]-090[123]$/.test(draft.fileId)||draft.fileNumber!==draft.fileId.slice(5)||body.transferBase64)throw new Error("Use the fictional transfer in the development preview. Real files require staff sign-in.");draft.firm="navawilson";draft.clerk="Marcela Pitella";draft.initials="MP";}
  else{const snapshot=await getSnapshot();const matter=snapshot.matters.find(m=>m.id===draft.fileId);if(!matter)throw new Error("File not found in the register.");draft.fileNumber=matter.number;draft.firm=matter.firm;draft.transaction=matter.type;draft.clerk=matter.clerk;draft.initials=initialLetters(matter.clerk);}
  const errors=validateCooDraft(draft);if(errors.length)return NextResponse.json({error:errors.join(" "),errors},{status:400});
  if(body.transferBase64!==undefined&&(typeof body.transferBase64!=="string"||body.transferBase64.length>13_333_340))throw new Error("Invalid transfer upload.");
  const result=await renderCooReview(draft,body.transferBase64,demo,!demo);
  const review=!demo?await storeCooReview(draft,result.packets,user!.id,body.transferBase64):null;
  return NextResponse.json({...result,reviewOnly:true,review:review?{id:review.id,hash:review.hash,status:review.status,createdAt:review.createdAt}:null},{headers:{"Cache-Control":"no-store"}});
 }catch(e){return NextResponse.json({error:e instanceof SyntaxError?"Invalid notice details.":e instanceof Error?e.message:"Unable to generate the review packet."},{status:400,headers:{"Cache-Control":"no-store"}});}
}
