'use client';
import {useEffect,useState} from 'react';
type Status={hosted:boolean;health?:{at:string;slackEnabled:boolean;portalEnabled:boolean};slack?:{sent:number;attention:number;pending:number};portal?:{verified:number;attention:number}};
export default function TeamIntegrationStatus(){
 const [now,setNow]=useState(0);
 const [status,setStatus]=useState<Status|null>(null);
 useEffect(()=>{let active=true;const load=()=>fetch('/api/admin/legal-assistant/integrations/status',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(v=>{if(active){setStatus(v);setNow(Date.now());}}).catch(()=>{});void load();const timer=setInterval(()=>void load(),30000);return()=>{active=false;clearInterval(timer);};},[]);
 if(!status?.hosted)return null;
 const fresh=!!status.health&&now-Date.parse(status.health.at)<180000;
 return <section className="orch-card" style={{margin:'20px 32px',padding:20}} aria-label="Team integration status"><h2>Team notifications and portal updates</h2><p>{fresh?'Cloud service connected.':'Cloud service has not reported a recent heartbeat.'}</p><p>Slack: {status.health?.slackEnabled?'enabled':'not enabled'} · {status.slack?.sent??0} delivered · {status.slack?.pending??0} pending · {status.slack?.attention??0} need attention.</p><p>Portal milestones: {status.health?.portalEnabled?'enabled':'not enabled'} · {status.portal?.verified??0} verified · {status.portal?.attention??0} need attention.</p><p>Portal updates follow confirmed client emails. Internal tests leave milestones unchanged. Uncertain Slack deliveries require receipt reconciliation.</p></section>;
}
