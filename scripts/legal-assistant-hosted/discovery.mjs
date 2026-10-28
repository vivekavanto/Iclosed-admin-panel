// Discovery only. This service never calls the model or opens external files.
if(process.env.ORCHESTRATOR_STATE_BACKEND!=='supabase')throw Error('Hosted workflow storage is required.');
const {runEmailMonitor}=await import('../../src/lib/file-opening/email-monitor.ts');
const {updateMonitor}=await import('../../src/lib/file-opening/email-store.ts');
const {workerCycle}=await import('./retry.mjs');
await workerCycle(async()=>{
 await updateMonitor(s=>{s.extractionEnabled=false;});
 const result=await runEmailMonitor('discover');
 console.log(JSON.stringify({service:'email-discovery',ok:!result.failed,busy:!!result.busy}));
 return 120000;
},{once:process.argv.includes('--once'),onFailure:()=>console.error(JSON.stringify({service:'email-discovery',ok:false,retrying:true}))});
