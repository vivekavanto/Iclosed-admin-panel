const START='<!--iclosed-notice-content:start-->',END='<!--iclosed-notice-content:end-->';
export const escapeEmailText=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function notificationEmailContent(html:string){const start=html.indexOf(START),end=html.lastIndexOf(END);return start>=0&&end>start?html.slice(start+START.length,end):html;}
export function notificationEmailFrame(html:string){
 const styles:Record<string,string>={p:'margin:0 0 16px;',h3:'font-size:17px;line-height:1.4;font-weight:700;margin:24px 0 12px;color:#172b40;',ul:'margin:10px 0 18px;padding-left:24px;',ol:'margin:10px 0 18px;padding-left:24px;',li:'margin:0 0 8px;padding-left:2px;',a:'color:#2356a8;text-decoration:underline;'};
 const body=notificationEmailContent(html).replace(/<(p|h3|ul|ol|li|a)\b([^>]*)>/gi,(tag,name:string,attrs:string)=>{if(attrs.includes('data-iclosed-email-style'))return tag;const old=attrs.match(/\sstyle=(['"])(.*?)\1/i)?.[2]??'';return '<'+name+attrs.replace(/\sstyle=(['"])(.*?)\1/i,'')+' data-iclosed-email-style="1" style="'+styles[name.toLowerCase()]+old+'">';});
 return '<table data-iclosed-notification-email="v1" role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;border-collapse:collapse;background:#ffffff;"><tr><td style="padding:20px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#243244;text-align:left;">'+START+body+END+'</td></tr></table>';
}
export function decodeEmailEntities(text:string){return text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&nbsp;/g,' ');}
export function notificationPlainText(html:string){return decodeEmailEntities(notificationEmailContent(html).replace(/<a\b[^>]*href=['"](https:\/\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi,'$2 ($1)').replace(/<li\b[^>]*>/gi,'\n• ').replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi,'\n\n').replace(/<[^>]*>/g,'')).trim();}
/** Small safe formatting vocabulary; arbitrary HTML is always escaped. */
export function notificationInline(text:string){
 const pattern=/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|https:\/\/[^\s<>]+/g;let html='',position=0;
 for(const match of text.matchAll(pattern)){html+=escapeEmailText(text.slice(position,match.index));
  if(match[1])html+='<a href="'+escapeEmailText(match[2])+'">'+escapeEmailText(match[1])+'</a>';
  else if(match[3])html+='<strong>'+escapeEmailText(match[3])+'</strong>';
  else{const url=match[0],target=url.replace(/[).,;!?*]+$/,'');html+='<a href="'+escapeEmailText(target)+'">'+escapeEmailText(target)+'</a>'+escapeEmailText(url.slice(target.length));}
  position=match.index!+match[0].length;
 }
 return html+escapeEmailText(text.slice(position));
}
export function notificationEditedBody(text:string){
 let html='',list=false;const close=()=>{if(list){html+='</ul>';list=false;}};
 for(const raw of text.trim().split(/\r?\n/)){const line=raw.trim();if(!line){close();continue;}if(/^[-•]\s+/.test(line)){if(!list){html+='<ul>';list=true;}html+='<li>'+notificationInline(line.replace(/^[-•]\s+/,''))+'</li>';continue;}close();html+=/^#{1,3}\s+/.test(line)?'<h3>'+notificationInline(line.replace(/^#{1,3}\s+/,''))+'</h3>':'<p>'+notificationInline(line)+'</p>';}
 close();return html;
}
export function internalNotificationTestHtml(html:string){return notificationEmailFrame('<p style="font-size:12px;line-height:1.5;background:#fff7df;border:1px solid #efdfaa;padding:10px 12px;margin:0 0 20px;"><strong>INTERNAL TEST ONLY</strong> — no client notice has been sent.</p>'+notificationEmailContent(html));}
