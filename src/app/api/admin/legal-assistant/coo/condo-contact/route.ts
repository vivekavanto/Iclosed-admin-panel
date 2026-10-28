import {withOperationContext} from '@/lib/orchestrator/hosted/runtime';
import {NextResponse} from 'next/server';
import {getStaff} from '@/lib/orchestrator/server-auth';
import {getSnapshot} from '@/lib/orchestrator/store';
import {condoContactForMatter} from '@/lib/coo/condo-contact';
import {attachCooTransfer} from '@/lib/coo/drive-documents';
import {cooTransferHeading} from '@/lib/coo/transfer-heading';
import {prepopulateCoo} from '@/lib/coo/prepopulate';
import {initialCooDraft} from '@/lib/coo/prepare';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
export async function POST(request:Request){
 const user=await getStaff();if(!user)return NextResponse.json({error:'Staff access required.'},{status:403,headers});
 if(request.headers.get('origin')!==new URL(request.url).origin)return NextResponse.json({error:'Request origin could not be verified.'},{status:403,headers});
 try{const body=await request.json();const matter=(await getSnapshot()).matters.find(m=>m.id===body.fileId);if(!matter)return NextResponse.json({error:'File not found.'},{status:404,headers});let verified=matter;
 if(!matter.condoCorporation&&matter.driveFolderId&&typeof body.documentId==='string'){
  const pdf=await attachCooTransfer(matter.driveFolderId,body.documentId),facts=await withOperationContext({requester:user.id,fileId:matter.id,fileNumber:matter.number,workflow:'coo'},()=>cooTransferHeading(pdf.base64));
  if(!facts)throw Error('Registered deed unavailable.');
  const populated=prepopulateCoo(initialCooDraft(matter),facts).draft;
  verified={...matter,condominium:populated.condominium,condoCorporation:populated.condoCorporation};
 }
 return NextResponse.json(await withOperationContext({requester:user.id,fileId:matter.id,fileNumber:matter.number,workflow:'coo'},()=>condoContactForMatter(verified)),{headers});}
 catch{return NextResponse.json({error:'The status-certificate contact could not be verified. Review the source or enter a verified contact.'},{status:409,headers});}
}

export const maxDuration = 300;
