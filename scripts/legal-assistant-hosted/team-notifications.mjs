if(process.env.ORCHESTRATOR_STATE_BACKEND!=='supabase')throw Error('Hosted storage is required.');
const {runTeamNotifications}=await import('../../src/lib/orchestrator/team-notifications.ts');
const {workerCycle}=await import('./retry.mjs');
const {teamTransaction}=await import('../../src/lib/orchestrator/team-events.ts');
const {runPortalSync}=await import('../../src/lib/orchestrator/portal-sync.ts');
await workerCycle(async()=>{await teamTransaction(s=>{if(!s.health||Date.now()-Date.parse(s.health.at)>60000){if(s.health?.slackEnabled===false&&process.env.ORCHESTRATOR_SLACK_ENABLED==='true')s.startedAt=new Date().toISOString();s.health={at:new Date().toISOString(),slackEnabled:process.env.ORCHESTRATOR_SLACK_ENABLED==='true',portalEnabled:process.env.ORCHESTRATOR_PORTAL_SYNC_ENABLED==='true'};}});await runPortalSync();await runTeamNotifications();return 15000;},{once:process.argv.includes('--once'),onFailure:()=>console.error(JSON.stringify({service:'team-notifications',ok:false,retrying:true}))});
