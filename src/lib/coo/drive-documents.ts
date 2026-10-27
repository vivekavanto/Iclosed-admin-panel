import { ReadOnlyDrive, type DriveItem } from '../orchestrator/google-drive.ts';

export interface CooDriveDocument { id:string; name:string; url:string; kind:'notice'|'transfer'; location:string; parentId:string; }
export function cooDocumentKind(name:string,inCooFolder=false):CooDriveDocument['kind']|null {
  if(/draft|sample|unsigned|\bin[\s-]*prep(?:aration)?\b/i.test(name))return null;
  if(/\bcoo\b|change.of.ownership/i.test(name))return 'notice';
  if(/^(?:registered\s+)?(?:transfer|deed)(?:[\s._-]|$)/i.test(name))return 'transfer';
  if(inCooFolder)return 'notice';
  // A land-transfer-tax form is not the registered transfer.
  return /^(?:registered\s+)?(?:transfer|deed)(?:[\s._-]|$)/i.test(name)?'transfer':null;
}
/** Read only the linked matter and its explicit COO/final-report containers. */
export async function cooDriveDocuments(folderId:string|null,reader?:Pick<ReadOnlyDrive,'children'>) {
  if(!folderId)return {documents:[] as CooDriveDocument[],message:'No verified property folder is linked. Use Link Drive folders on the dashboard.'};
  const drive=reader??await ReadOnlyDrive.connect(),documents:CooDriveDocument[]=[];
  const root=await drive.children(folderId);
  const collect=(files:DriveItem[],location:string,parentId:string,coo=false)=>{
    for(const f of files){
      if(f.mimeType!=='application/pdf')continue;
      const kind=cooDocumentKind(f.name,coo);
      if(kind)documents.push({id:f.id,name:f.name,url:`https://drive.google.com/file/d/${f.id}/view`,kind,location,parentId});
    }
  };
  collect(root,'Property folder',folderId);
  for(const folder of root.filter(f=>f.mimeType==='application/vnd.google-apps.folder'&&/^(?:change of ownership|coo|final report|documents)$/i.test(f.name)).slice(0,8)){
    collect(await drive.children(folder.id),folder.name,folder.id,/^(?:change of ownership|coo)$/i.test(folder.name));
  }
  return {documents,message:documents.length?'':'No existing COO notice or registered-transfer PDF was found in the linked property folder, Change of Ownership, Final Report or Documents.'};
}
export async function attachCooTransfer(folderId:string,documentId:string,reader?:Pick<ReadOnlyDrive,'children'|'metadata'|'pdf'>){
  const drive=reader??await ReadOnlyDrive.connect();
  const inventory=await cooDriveDocuments(folderId,drive);
  const source=inventory.documents.find(d=>d.kind==='transfer'&&d.id===documentId);
  if(!source)throw Error('Choose a deed candidate from this property’s verified folder.');
  const before=await drive.metadata(source.id);
  if(Number(before.size)>10_000_000||!before.parents?.includes(source.parentId))throw Error('The deed is oversized or no longer in the verified folder.');
  const bytes=await drive.pdf(before),after=await drive.metadata(source.id);
  if(before.modifiedTime!==after.modifiedTime||before.size!==after.size||!after.parents?.includes(source.parentId))throw Error('The Drive document changed. Select it again.');
  return {name:source.name,base64:bytes.toString('base64')};
}
