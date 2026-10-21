"use client";
import { useEffect, useRef, useState } from "react";
interface PdfPage {
 getViewport(options:{scale:number}):{width:number;height:number};
 render(options:{canvasContext:CanvasRenderingContext2D;canvas:HTMLCanvasElement;viewport:{width:number;height:number}}):{promise:Promise<void>;cancel():void};
}
interface PdfDocument {numPages:number;getPage(n:number):Promise<PdfPage>;}
interface PdfLoading {promise:Promise<PdfDocument>;destroy():Promise<void>;}
interface PdfLibrary {GlobalWorkerOptions:{workerSrc:string};getDocument(options:{data:Uint8Array;standardFontDataUrl:string;cMapUrl:string;cMapPacked:boolean;wasmUrl:string;isEvalSupported:boolean}):PdfLoading;}
function Page({document,page}:{document:PdfDocument;page:number}){
 const container=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
 const[failed,setFailed]=useState(false);
 useEffect(()=>{
  let cancelled=false,started=false,renderTask:ReturnType<PdfPage["render"]>|undefined;
  const observer=new IntersectionObserver(entries=>{
   if(started||!entries.some(e=>e.isIntersecting))return;started=true;
   document.getPage(page).then(pdfPage=>{
    if(cancelled||!canvas.current)return;const target=canvas.current;
    const natural=pdfPage.getViewport({scale:1}),viewport=pdfPage.getViewport({scale:Math.min(2,1200/natural.width)});
    target.width=viewport.width;target.height=viewport.height;const context=target.getContext("2d");if(!context)throw new Error("Canvas unavailable");
    renderTask=pdfPage.render({canvasContext:context,canvas:target,viewport});return renderTask.promise;
   }).catch(()=>{if(!cancelled)setFailed(true);});
  },{rootMargin:"700px"});
  if(container.current)observer.observe(container.current);
  return()=>{cancelled=true;observer.disconnect();renderTask?.cancel();};
 },[document,page]);
 return <div className="coo-rendered-page" ref={container}>{failed?<p>Page {page} could not be displayed. Download the PDF to review it.</p>:<canvas ref={canvas} role="img" aria-label={`PDF page ${page}`}/>}</div>;
}
export default function PdfPreview({base64,label}:{base64:string;label:string}){
 const[document,setDocument]=useState<PdfDocument|null>(null),[error,setError]=useState(false);
 useEffect(()=>{
  let cancelled=false,loading:PdfLoading|undefined;
  const moduleUrl="/vendor/pdfjs/pdf.mjs";
  import(/* webpackIgnore: true */ /* turbopackIgnore: true */ moduleUrl).then((pdf:PdfLibrary)=>{
   if(cancelled)return;pdf.GlobalWorkerOptions.workerSrc="/vendor/pdfjs/pdf.worker.mjs";
   loading=pdf.getDocument({data:Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),standardFontDataUrl:"/vendor/pdfjs/standard_fonts/",cMapUrl:"/vendor/pdfjs/cmaps/",cMapPacked:true,wasmUrl:"/vendor/pdfjs/wasm/",isEvalSupported:false});
   return loading.promise;
  }).then(doc=>{if(!cancelled&&doc)setDocument(doc);}).catch(()=>{if(!cancelled)setError(true);});
  return()=>{cancelled=true;void loading?.destroy().catch(()=>{});};
 },[base64]);
 return <div className="coo-pdf-pages" role="region" aria-label={label} tabIndex={0}>{error?<p role="alert">The PDF preview could not load. Download the PDF to review it.</p>:document?Array.from({length:document.numPages},(_,i)=><Page key={i} document={document} page={i+1}/>):<p role="status">Loading PDF…</p>}</div>;
}
