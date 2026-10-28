import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {latestDetailedExtract} from './google-extracts.ts';
import {localSnapshot,applyLocalBatch} from './local-store.ts';
import {reconcile} from './closer-import.ts';
import {torontoDate} from './closing-views.ts';
const state=()=>readFile(path.join(process.env.ORCHESTRATOR_LOCAL_STATE_DIR, 'state.json'),'utf8').then(JSON.parse);
export async function synchronize({verifyOnly=false, today=torontoDate(), extract=latestDetailedExtract}={}) {
 try {
 const before=await localSnapshot();
 const history=await state();
 if(!before.matters.length||!history.imports.length)throw Error('Approved local baseline is absent; do not recreate automatically');
 if(verifyOnly){
  return ({destination:'private-local-register',verified:true,revision:before.revision,files:before.matters.length,sourceDate:before.sourceDate,receipts:history.imports.length});
 }else{
  const {batch,csv,sourceId}=await extract(today);
  const checksum=createHash('sha256').update(batch.filename).update('\0').update(csv).digest('hex');
  if(history.imports.some(i=>i.checksum===checksum)){
   if(before.sourceDate!==batch.sourceDate)throw Error('Receipt/source-date mismatch');
   return ({destination:'private-local-register',verified:true,duplicate:true,revision:before.revision,sourceDate:before.sourceDate});
  }else{
   const initial=reconcile(before.matters,batch);
   const semantic=m=>{const {sourceDate,...rest}=m;return JSON.stringify(rest)};
   for(const incoming of batch.matters){
    const prior=before.matters.find(m=>m.id===incoming.id||m.number===incoming.number);
    const merged=initial.matters.find(m=>m.id===incoming.id);
    if(prior&&merged&&semantic(prior)===semantic(merged))incoming.sourceDate=prior.sourceDate;
   }
   const expected=reconcile(before.matters,batch);
   const backup=path.join(process.env.ORCHESTRATOR_LOCAL_STATE_DIR,'.daily-sync-backups');
   await mkdir(backup,{recursive:true,mode:0o700});
   await writeFile(path.join(backup,`revision-${before.revision}-${checksum}.json`),JSON.stringify(history),{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
   await applyLocalBatch(batch,checksum,before.revision,'daily-local-drive:'+sourceId);
   const after=await localSnapshot();const receipt=(await state()).imports.find(i=>i.checksum===checksum);
   if(!receipt||after.revision!==before.revision+1||after.sourceDate!==batch.sourceDate||JSON.stringify(after.matters)!==JSON.stringify(expected.matters))throw Error('Persisted rows or receipt failed verification');
   return ({destination:'private-local-register',verified:true,sourceDate:after.sourceDate,revision:after.revision,files:after.matters.length,created:expected.created,updated:expected.updated,unchanged:expected.unchanged,notPresent:expected.notPresent,receiptVerified:true});
  }
 }
}catch(error){return ({verified:false,error:error.message==='Today\'s full-coverage detailed extract is not available. Existing data retained.'?'Fresh full-coverage Closer extract unavailable; existing register retained.':'Sync failed validation or readback. Existing data must be reviewed; no success claimed.'});}

}
