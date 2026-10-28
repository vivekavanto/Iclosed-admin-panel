import {spawn} from 'node:child_process';
import {mkdir,chmod} from 'node:fs/promises';
const cache=process.env.ORCHESTRATOR_WORKER_CACHE_DIR;
if(process.env.ORCHESTRATOR_STATE_BACKEND!=='supabase'||process.env.ORCHESTRATOR_HOSTED_WORKER!=='true'||!cache||process.env.ORCHESTRATOR_LOCAL_STATE_DIR)throw Error('Explicit hosted worker configuration is required.');
await mkdir(cache,{mode:0o700,recursive:true});await chmod(cache,0o700);
const root=new URL('../legal-assistant-hosted/',import.meta.url);
const programs=[['worker.mjs','--role=operations'],['worker.mjs','--role=audits'],['discovery.mjs'],['daily-sync.mjs']];
const children=[];let stopping=false;
function stop(code){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(code);},25000).unref();Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);}))).then(()=>process.exit(code));}
for(const [name,...args]of programs){const child=spawn(process.execPath,['--experimental-strip-types',new URL(name,root).pathname,...args],{env:{...process.env},stdio:'inherit'});children.push(child);child.on('error',()=>stop(1));child.on('exit',()=>{if(!stopping)stop(1);});}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop(0));
