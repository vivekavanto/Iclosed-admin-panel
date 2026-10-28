import {workflowBody,workflowResult} from "@/lib/orchestrator/hosted/payload";
import {NextResponse} from 'next/server';
import {getStaff} from '@/lib/orchestrator/server-auth';
import {getSnapshot} from '@/lib/orchestrator/store';
import {attachCooTransfer,cooDriveDocuments} from '@/lib/coo/drive-documents';
import {cooTransferHeading} from '@/lib/coo/transfer-heading';
import {prepopulateCoo} from '@/lib/coo/prepopulate';
import {initialCooDraft} from '@/lib/coo/prepare';
const headers={'Cache-Control':'private, no-store'};
export const runtime='nodejs';
export async function GET(request:Request){
 if(!await getStaff())return NextResponse.json({error:'Staff access required.'},{status:403});
 const params=new URL(request.url).searchParams;
 const matter=(await getSnapshot()).matters.find(m=>m.id===params.get('fileId'));
 if(!matter?.driveFolderId)return NextResponse.json({error:'A verified property folder is required.'},{status:404,headers});
 try{
  const id=params.get('documentId');
  const candidates=id?[{id}]:(await cooDriveDocuments(matter.driveFolderId)).documents.filter(d=>d.kind==='transfer');
  if(!candidates.length||candidates.length>6)throw Error('Choose the complete registered deed from this property’s Drive folder.');
  const matches=[];
  for(const candidate of candidates){
   try{
    const result=await attachCooTransfer(matter.driveFolderId,candidate.id).catch(()=>{throw Error('The Drive deed is unavailable, changed, or exceeds the size limit. Re-select it or upload the complete copy.');});
    const facts=await cooTransferHeading(result.base64);
    if(!facts)throw Error('The registered deed could not be read. Choose a searchable registered copy.');
    prepopulateCoo(initialCooDraft(matter),facts);
    matches.push({...result,facts,documentId:candidate.id});
   }catch(error){if(id)throw error;}
  }
  const unique=[...new Map(matches.map(m=>[m.base64,m])).values()];
  if(unique.length!==1)throw Error(unique.length?'More than one registered deed matches this file. Select the correct deed.':'No complete registered deed matched this matter. Select a deed or upload a searchable registered copy.');
  return NextResponse.json(await workflowResult(unique[0]),{headers});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'The selected deed could not be read.'},{status:409,headers});}
}
export async function POST(request:Request){
 if(!await getStaff())return NextResponse.json({error:'Staff access required.'},{status:403});
 if(request.headers.get('origin')!==new URL(request.url).origin)return NextResponse.json({error:'Request origin could not be verified.'},{status:403});
 try{
  const body=await workflowBody(request);
  const matter=(await getSnapshot()).matters.find(m=>m.id===body.fileId);
  if(!matter||typeof body.base64!=='string')throw Error('File or deed not found.');
  const facts=await cooTransferHeading(body.base64);if(!facts)throw Error('The registered deed could not be read. Choose a searchable registered copy.');
  prepopulateCoo(initialCooDraft(matter),facts);
  return NextResponse.json({facts},{headers});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'The deed could not be read.'},{status:409,headers});}
}

export const maxDuration = 300;
