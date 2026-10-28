import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);createRequire(require.resolve('next/package.json'))('@next/env').loadEnvConfig(process.cwd(),true);
const {runEmailMonitor}=await import('../src/lib/file-opening/email-monitor.ts');
const {updateMonitor}=await import('../src/lib/file-opening/email-store.ts');
await updateMonitor(s=>{s.extractionEnabled=!process.argv.includes('--discover-only');});
if(process.argv.includes('--once')){console.log(JSON.stringify(await runEmailMonitor(process.argv.includes('--discover-only')?'discover':'all')));}else{
 // Independent loops: slow extraction never postpones the next Gmail check.
 async function loop(mode,interval){while(true){const start=Date.now();try{const result=await runEmailMonitor(mode);if(mode==='discover'||result.failed||result.processed)console.log(JSON.stringify({at:new Date().toISOString(),mode,...result}));}catch{console.error(JSON.stringify({at:new Date().toISOString(),mode,error:'Email intake unavailable. Existing state retained.'}));}await new Promise(r=>setTimeout(r,Math.max(1000,interval-(Date.now()-start))));}}
 await Promise.all([loop('discover',120000),...(process.argv.includes('--discover-only')?[]:[loop('process',15000)])]);
}
