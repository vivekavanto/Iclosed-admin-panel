import { timingSafeEqual } from 'node:crypto';
import type { ImportBatch } from './model.ts';
import { torontoDate, nextMonthEnd } from './closing-views.ts';
interface Snapshot {revision:number;sourceDate:string|null;coverageStart?:string|null;coverageEnd?:string|null;}
interface Dependencies {
  snapshot():Promise<Snapshot>;
  extract(today:string):Promise<{batch:ImportBatch;csv:string;sourceId:string}>;
  checksum(filename:string,csv:string):string;
  apply(batch:ImportBatch,checksum:string,revision:number,actor:string):Promise<Snapshot & {duplicate?:boolean}>;
}
/** Cron is outside staff middleware, so verify its machine credential before any data access. */
export async function dailyCloserRefresh(authorization:string|null,config:{secret?:string;enabled:boolean;scheduled?:boolean},deps:Dependencies,now=new Date()) {
  const expected=Buffer.from(`Bearer ${config.secret??''}`),got=Buffer.from(authorization??'');
  if(!config.secret || expected.length!==got.length || !timingSafeEqual(expected,got))return {status:401,body:{error:'Unauthorized'}};
  if(!config.enabled)return {status:200,body:{enabled:false,imported:false,reason:'Daily Closer import is not enabled.'}};
  const today=torontoDate(now);
  // 06:15 and 07:15 UTC cover Toronto 02:15 in both seasons. On spring-forward
  // day the later run is 03:15. Never import before the 02:00 source deadline.
  if(config.scheduled && Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Toronto',hour:'2-digit',hourCycle:'h23'}).format(now))<2)return {status:200,body:{imported:false,reason:'Waiting until after 02:00 Toronto time.'}};
  try {
    const before=await deps.snapshot();
    if(config.scheduled && before.sourceDate===today && !!before.coverageStart && before.coverageStart<=today && !!before.coverageEnd && before.coverageEnd>=nextMonthEnd(today))return {status:200,body:{imported:false,sourceDate:today,revision:before.revision,reason:'Today’s extract is already incorporated.'}};
    const {batch,csv,sourceId}=await deps.extract(today);
    if(batch.kind!=='detailed' || batch.sourceDate!==today || !batch.coverageStart || batch.coverageStart>today || batch.coverageEnd<nextMonthEnd(today))throw new Error('Incomplete extract');
    const result=await deps.apply(batch,deps.checksum(batch.filename,csv),before.revision,`daily-drive:${sourceId}`);
    return {status:200,body:{imported:!result.duplicate,sourceDate:result.sourceDate,revision:result.revision}};
  }catch{
    // Provider bodies and client details must not appear in scheduler health output.
    return {status:409,body:{error:'Daily Closer import failed or today’s full-coverage extract is unavailable. Existing data retained.'}};
  }
}
