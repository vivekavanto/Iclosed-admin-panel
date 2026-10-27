import {changeHostedDocument,readHostedDocument} from './document.ts';
type Secrets=Record<string,string>;
export function readConnectionSecret(channel:string,name:string){return readHostedDocument<Secrets>('oauth/'+channel,()=>({})).then(s=>s[name]??null);}
export async function saveConnectionSecret(channel:string,name:string,value:string,exclusive=false){return changeHostedDocument<Secrets,void>('oauth/'+channel,()=>({}),state=>{if(exclusive&&state[name])throw Error('Authorization state already exists. Start again.');state[name]=value;});}
export async function consumeConnectionSecret(channel:string,name:string){return changeHostedDocument<Secrets,string>('oauth/'+channel,()=>({}),state=>{const value=state[name];if(!value)throw Error('Authorization attempt expired or was already used.');delete state[name];return value;});}
