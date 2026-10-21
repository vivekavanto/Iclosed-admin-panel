import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);createRequire(require.resolve('next/package.json'))('@next/env').loadEnvConfig(process.cwd(),true);
const {OpenAIAuditReviewer,auditReadiness}=await import('../src/lib/orchestrator/audit-openai.ts');
const {runAuditWorker}=await import('../src/lib/orchestrator/audit-worker.ts');
if(!auditReadiness().enabled){console.error('Audit worker is not enabled. Complete private provider, storage, PDF runtime and shadow-mode configuration.');process.exit(1);}
do {const result=await runAuditWorker(new OpenAIAuditReviewer());console.log(JSON.stringify(result));if(process.argv.includes('--once'))break;if(!result.processed)await new Promise(r=>setTimeout(r,3000));}while(true);
