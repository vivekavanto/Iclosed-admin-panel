// Discovery only. This service never calls the model or opens external files.
if(process.env.ORCHESTRATOR_STATE_BACKEND!=='supabase')throw Error('Hosted workflow storage is required.');
const {runEmailMonitor}=await import('../../src/lib/file-opening/email-monitor.ts');
const {updateMonitor}=await import('../../src/lib/file-opening/email-store.ts');
await updateMonitor(s=>{s.extractionEnabled=false;});
do{try{const result=await runEmailMonitor('discover');console.log(JSON.stringify({service:'email-discovery',ok:!result.failed,busy:!!result.busy}));}catch{console.error(JSON.stringify({service:'email-discovery',ok:false}));}if(process.argv.includes('--once'))break;await new Promise(r=>setTimeout(r,120000));}while(true);
