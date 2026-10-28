// Vercel Preview does not run production cron schedules. Use this supervised service for dev.
import {randomBytes} from 'node:crypto';
const {dailyCloserRefresh}=await import('../../src/lib/orchestrator/daily-refresh.ts');
const {latestDetailedExtract}=await import('../../src/lib/orchestrator/google-extracts.ts');
const {applyBatch,getSnapshot,reportChecksum}=await import('../../src/lib/orchestrator/store.ts');
if(process.env.ORCHESTRATOR_STATE_BACKEND!=='supabase')throw Error('Hosted workflow storage is required.');
const secret=randomBytes(32).toString('hex');let successDate='';
const {workerCycle}=await import('./retry.mjs');
await workerCycle(async()=>{const now=new Date(),parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));const date=`${parts.year}-${parts.month}-${parts.day}`;if(date!==successDate&&(Number(parts.hour)*60+Number(parts.minute)>=150)){const result=await dailyCloserRefresh('Bearer '+secret,{secret,enabled:process.env.ORCHESTRATOR_IMPORT_ENABLED==='true',scheduled:true},{snapshot:getSnapshot,extract:latestDetailedExtract,checksum:reportChecksum,apply:applyBatch},now);if(result.status===200&&result.body.enabled!==false)successDate=date;console.log(JSON.stringify({service:'closer-sync',status:result.status,...result.body}));}return 300000;},{once:process.argv.includes('--once'),onFailure:()=>console.error(JSON.stringify({service:'closer-sync',ok:false,retrying:true}))});
