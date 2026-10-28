// Maintenance after deploying blob-v1 readers on every web/worker runtime.
// Pause hosted writers. Supply the owner-only management read backup; no resets.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {documentBackend,hostedConfiguration,decodeHostedDocument} from '../../src/lib/orchestrator/hosted/document.ts';
const option=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const snapshot=option('--snapshot'),expected=option('--expected-sha256');
if(!snapshot||!expected||!/^[a-f0-9]{64}$/.test(expected))throw Error('Supply a private snapshot and its exact reviewed document checksum.');
const rows=JSON.parse(await readFile(snapshot,'utf8'));
if(!Array.isArray(rows)||rows.length!==1)throw Error('Expected exactly one preserved audit document.');
const row=rows[0],state=decodeHostedDocument(row.value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
if(digest(state)!==expected||!Array.isArray(state.jobs)||!state.reports||!state.requests)throw Error('Audit backup checksum or shape is invalid.');
if(state.jobs.some(j=>['capturing','reviewing'].includes(j.status)&&Date.parse(j.leaseUntil??'')>Date.now()))throw Error('Wait for active audit leases before maintenance.');
const config=hostedConfiguration();if(!config)throw Error('Select isolated hosted dev storage.');
const query=new URLSearchParams({namespace:'eq.'+config.namespace,name:'eq.audit-jobs',select:'revision,sha256:value->>sha256'});
const r=await fetch(config.url+'/rest/v1/legal_assistant_documents?'+query,{headers:{apikey:config.key,Authorization:'Bearer '+config.key},signal:AbortSignal.timeout(30000)});
if(!r.ok)throw Error('Cannot verify current database metadata.');
const live=await r.json();if(live.length!==1||live[0].revision!==row.revision||live[0].sha256!==expected)throw Error('Audit history changed; preserve a fresh backup first.');
if(!process.argv.includes('--apply')){console.log(JSON.stringify({ready:true,revision:row.revision,sha256:expected}));process.exit(0);}
const backend=documentBackend();if(!await backend.compareAndSwap('audit-jobs',row.revision,state))throw Error('Audit history changed. No replacement accepted.');
const saved=await backend.read('audit-jobs');
if(!saved||digest(saved.value)!==expected)throw Error('Audit history readback verification failed.');
console.log(JSON.stringify({verified:true,revision:saved.revision,sha256:expected,jobs:state.jobs.length,reports:Object.keys(state.reports).length}));
