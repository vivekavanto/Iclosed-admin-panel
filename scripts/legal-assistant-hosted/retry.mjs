// Recoverable dependency failures must not take down unrelated worker roles.
// Never replay a job or provider side effect here: each cycle claims durable work.
export async function workerCycle(run,{sleep=ms=>new Promise(r=>setTimeout(r,ms)),onFailure=()=>{},once=false}={}){
 let failures=0;
 do{
  let delay;
  try{delay=await run();failures=0;if(once)return;}
  catch{onFailure();if(once)throw Error('Hosted worker cycle unavailable; existing records retained.');delay=Math.min(60000,2000*2**Math.min(failures++,5));}
  await sleep(delay??2000);
 }while(true);
}
