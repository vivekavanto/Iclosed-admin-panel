import {NextResponse} from 'next/server';
import {getStaff} from '@/lib/orchestrator/server-auth';
import {hostedDocumentsEnabled} from '@/lib/orchestrator/hosted/document';
import {getHostedBlob} from '@/lib/orchestrator/hosted/blob';
import {uploadPayloadUrl} from '@/lib/orchestrator/hosted/payload';
export async function POST(request:Request){
 if(!await getStaff())return NextResponse.json({error:'Staff access required.'},{status:403});
 if(request.headers.get('origin')!==new URL(request.url).origin)return NextResponse.json({error:'Request origin could not be verified.'},{status:403});
 if(!hostedDocumentsEnabled())return NextResponse.json({hosted:false});
 try{const text=await request.text();if(text.length>500)throw Error('Invalid upload request.');const {hash}=JSON.parse(text);if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw Error('Invalid hash');try{await getHostedBlob(hash);return NextResponse.json({exists:true},{headers:{'Cache-Control':'no-store'}});}catch{}return NextResponse.json({uploadUrl:await uploadPayloadUrl(hash)},{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'Private upload could not be prepared.'},{status:400});}
}
