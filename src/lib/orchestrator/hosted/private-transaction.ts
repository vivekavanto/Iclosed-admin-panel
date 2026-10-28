import {AsyncLocalStorage} from 'node:async_hooks';
import {documentBackend,DocumentConflict,requireHostedBaseline} from './document.ts';
/** Only private storage operations are permitted inside this callback. Never call a sender/provider action. */
const context=new AsyncLocalStorage<{name:string;value:unknown}>();
export function privateTransactionValue<T>(name:string):T|undefined{const active=context.getStore();return active?.name===name?active.value as T:undefined;}
export async function privateStorageTransaction<T,R>(name:string,initial:()=>T,fn:(state:T)=>Promise<R>):Promise<R>{
 await requireHostedBaseline();
 if(context.getStore())throw Error('Nested private workflow transactions are unsupported.');
 const backend=documentBackend();
 for(let attempt=0;attempt<8;attempt++){
  const saved=await backend.read<T>(name),value=structuredClone(saved?.value??initial());
  const result=await context.run({name,value},()=>fn(value));
  if(await backend.compareAndSwap(name,saved?.revision??0,value))return result;
 }
 throw new DocumentConflict();
}
