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
try{do{await heartbeatHostedWorker(role);if(role==='audits'){await runAuditWorker(new OpenAIAuditReviewer());if(process.argv.includes('--once'))break;await new Promise(r=>setTimeout(r,3000));continue;}const job=await claimHostedOperation();if(job){try{const args=await hostedOperationInput(job);let output;switch(job.operation){case 'coo-render':output=await renderCooReview(args.draft,args.transferBase64,args.demo,args.deliveryReady);break;case 'deed-inspect':output=await cooTransferHeading(args.pdf);break;case 'condo-contact':output=await condoContactForMatter(args.matter);break;default:throw Error('Unsupported hosted operation.');}await finishHostedOperation(job.id,job.lease,output);}catch{await failHostedOperation(job.id,job.lease);}if(process.argv.includes('--once'))break;continue;}if(process.argv.includes('--once'))break;await new Promise(r=>setTimeout(r,2000));}while(true);}finally{clearInterval(timer);}
