import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {access,mkdir,stat} from 'node:fs/promises';import path from 'node:path';import {constants} from 'node:fs';
const exec=promisify(execFile);
export async function nativePreflight(){
 const python=process.env.ORCHESTRATOR_AUDIT_PYTHON??process.env.ORCHESTRATOR_COO_PYTHON,ocr=process.env.ORCHESTRATOR_AUDIT_OCR,cache=process.env.ORCHESTRATOR_WORKER_CACHE_DIR;
 if(!python||!path.isAbsolute(python)||!ocr||!path.isAbsolute(ocr)||!cache||!path.isAbsolute(cache))throw Error('Explicit Python, OCR and private worker cache paths are required.');
 await access(python,constants.X_OK);await access(ocr,constants.X_OK);await mkdir(cache,{mode:0o700,recursive:true});if((await stat(cache)).mode&0o077)throw Error('Worker cache permissions must be owner-only.');
 const code=`import base64,io\nfrom reportlab.pdfgen.canvas import Canvas\nfrom reportlab.lib.utils import ImageReader\nfrom PIL import Image,ImageDraw\nimport pypdf,pypdfium2,pdfplumber\nb=io.BytesIO();c=Canvas(b);c.drawString(72,720,'Hosted readiness synthetic page 123456');c.showPage()\nim=Image.new('RGB',(1000,300),'white');d=ImageDraw.Draw(im);d.text((30,70),'Hosted OCR readiness test 123456',fill='black',font_size=38)\nc.drawImage(ImageReader(im),72,400,width=470,height=141);c.showPage();c.save();print(base64.b64encode(b.getvalue()).decode())`;
 const {stdout}=await exec(python,['-c',code],{timeout:20000,maxBuffer:2_000_000});
 const {inspectPdf}=await import('../../src/lib/orchestrator/audit-capture.ts');const result=await inspectPdf(Buffer.from(stdout.trim(),'base64'));
 if(process.env.ORCHESTRATOR_NATIVE_PREFLIGHT_DEBUG==='true')console.log(JSON.stringify({pages:result.pages.map(p=>({number:p.number,rendered:p.rendered,text:p.text,ocr:p.ocr})),limitations:result.limitations}));
 if(result.pages.length!==2||result.pages.some(p=>!p.rendered)||!result.pages[1].text.includes('123456')||result.limitations.some(l=>/failed|could not be rendered/i.test(l)))throw Error('Native PDF/OCR readiness test failed. No worker heartbeat was published.');
 return {nativePdf:true,scannedPageOcr:true,pages:2};
}
if(process.argv.includes('--check'))console.log(JSON.stringify(await nativePreflight()));
