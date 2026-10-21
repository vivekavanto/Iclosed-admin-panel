import { spawn } from "node:child_process";
import path from "node:path";
import type { CooDraft, CooPacket } from "./model";
export async function renderCooReview(draft:CooDraft,transferBase64:string|undefined,demo:boolean):Promise<{packets:CooPacket[];sourcePages:number;sendingEnabled:false;signed:false}> {
  const executable=process.env.ORCHESTRATOR_COO_PYTHON;
  if(!executable||!path.isAbsolute(executable))throw new Error("COO review generation is not configured in this environment.");
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,[path.join(process.cwd(),"scripts/coo/render_preview.py")],{stdio:["pipe","pipe","pipe"],env:{NODE_ENV:process.env.NODE_ENV,PATH:process.env.PATH??"",PYTHONNOUSERSITE:"1",PYTHONIOENCODING:"utf-8"},signal:AbortSignal.timeout(20_000)});
    const chunks:Buffer[]=[];let size=0;let settled=false;
    const fail=(e:Error)=>{if(!settled){settled=true;reject(e);}};
    child.on("error",()=>fail(new Error("COO review generation could not start or timed out.")));
    child.stdout.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>45_000_000){child.kill();fail(new Error("The generated review packets exceed the preview size limit."));}else chunks.push(chunk);});
    child.stderr.on("data",()=>{/* Never log document text or subprocess internals. */});
    child.stdin.on("error",()=>fail(new Error("COO review generation was interrupted.")));
    child.on("close",code=>{if(settled)return;try{const result=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(code!==0||result.error)throw new Error(result.error||"COO review generation failed.");if(!Array.isArray(result.packets)||result.sendingEnabled!==false||result.signed!==false)throw new Error("Invalid review packet response.");settled=true;resolve(result);}catch(e){fail(e instanceof Error?e:new Error("COO review generation failed."));}});
    child.stdin.end(JSON.stringify({draft,transferBase64,demo}));
  });
}
