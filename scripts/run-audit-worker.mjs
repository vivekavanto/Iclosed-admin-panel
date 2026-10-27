import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);createRequire(require.resolve('next/package.json'))('@next/env').loadEnvConfig(process.cwd(),true);
const {OpenAIAuditReviewer,auditReadiness}=await import('../src/lib/orchestrator/audit-openai.ts');
const {runAuditWorker}=await import('../src/lib/orchestrator/audit-worker.ts');
if(!auditReadiness().enabled){console.error('Audit worker is not enabled. Complete private provider, storage, PDF runtime and audit configuration.');process.exit(1);}
console.log(JSON.stringify({ready:true,model:process.env.ORCHESTRATOR_AUDIT_MODEL}));
do {const result=await runAuditWorker(new OpenAIAuditReviewer());if(result.processed)console.log(JSON.stringify(result));if(process.argv.includes('--once'))break;if(!result.processed)await new Promise(r=>setTimeout(r,3000));}while(true);
