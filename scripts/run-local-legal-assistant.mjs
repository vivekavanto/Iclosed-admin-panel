// Local-only supervised development runtime. Credentials remain in ignored .env.local.
import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!existsSync(path.join(root,'.env.local'))){console.error('Private local environment is missing. Refusing to start.');process.exit(1);}
const worker=process.argv.includes('--worker');
if(!worker){const assets=spawnSync(process.execPath,['scripts/sync-pdfjs-assets.mjs'],{cwd:root,stdio:'inherit'});if(assets.status!==0)process.exit(1);}
const args=worker?['--experimental-strip-types','scripts/run-audit-worker.mjs']:['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3004'];
const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,PATH:path.dirname(process.execPath)+':'+(process.env.PATH??'/usr/bin:/bin')}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>process.exit(1));child.on('close',code=>process.exit(code??1));
