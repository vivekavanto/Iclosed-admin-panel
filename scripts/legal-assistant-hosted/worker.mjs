// Run under a service manager with a private environment file. No incoming network port.
if(process.env.ORCHESTRATOR_STATE_BACKEND!=='supabase'||process.env.ORCHESTRATOR_HOSTED_WORKER!=='true')throw Error('Select hosted worker mode explicitly.');
const {heartbeatHostedWorker,claimHostedOperation,hostedOperationInput,finishHostedOperation,failHostedOperation}=await import('../../src/lib/orchestrator/hosted/runtime.ts');
const {renderCooReview}=await import('../../src/lib/coo/render.ts');
const {cooTransferHeading}=await import('../../src/lib/coo/transfer-heading.ts');
const {condoContactForMatter}=await import('../../src/lib/coo/condo-contact.ts');
const {runAuditWorker}=await import('../../src/lib/orchestrator/audit-worker.ts');
const {OpenAIAuditReviewer,auditReadiness}=await import('../../src/lib/orchestrator/audit-openai.ts');
if(!auditReadiness().enabled)throw Error('Complete hosted storage, model and PDF runtime configuration.');
const role=process.argv.find(a=>a.startsWith('--role='))?.slice(7);if(!['audits','operations'].includes(role))throw Error('Specify --role=audits or --role=operations.');
const {nativePreflight}=await import('./preflight-native.mjs');await nativePreflight();
const timer=setInterval(()=>heartbeatHostedWorker(role).catch(()=>{}),30_000);timer.unref();
const {workerCycle}=await import('./retry.mjs');
try{await workerCycle(async()=>{
 await heartbeatHostedWorker(role);
 if(role==='audits'){await runAuditWorker(new OpenAIAuditReviewer());return 3000;}
 const job=await claimHostedOperation();if(!job)return 2000;
 try{
  const args=await hostedOperationInput(job);let output;
  switch(job.operation){
   case 'coo-render':output=await renderCooReview(args.draft,args.transferBase64,args.demo,args.deliveryReady);break;
   case 'deed-inspect':output=await cooTransferHeading(args.pdf);break;
   case 'condo-contact':output=await condoContactForMatter(args.matter);break;
   default:throw Error('Unsupported hosted operation.');
  }
  await finishHostedOperation(job.id,job.lease,output);
 }catch{await failHostedOperation(job.id,job.lease);}
 return 2000;
},{once:process.argv.includes('--once'),onFailure:()=>console.error(JSON.stringify({service:role,ok:false,retrying:true}))});}
finally{clearInterval(timer);}
