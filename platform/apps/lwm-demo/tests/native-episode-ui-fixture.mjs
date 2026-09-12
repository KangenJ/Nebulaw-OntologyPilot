import {createNativeEpisodeWorkbench} from '../public-plus/native-episode-ui.js';

// DOM-only fixture; HTTP tests supply actual native control and gateway services.
export function episodeUiFixture({api,principal={id:'trainer',roles:['trainer']},root={type:'InvestigationTask',id:'task_1'}}){
  let html='',last=Promise.resolve(),busy=false,error,actor=principal,reference=root,sequence=0;
  const nodes=new Map(),$=s=>nodes.get(s),node=s=>{const v={};nodes.set(s,v);return v;};
  Object.defineProperty(node('#episode-workbench'),'innerHTML',{get:()=>html,set:value=>{
    html=value;for(const k of [...nodes.keys()])if(k!=='#episode-workbench')nodes.delete(k);
    for(const m of value.matchAll(/id="([^"]+)"/g))node('#'+m[1]);
    for(const [key,n]of nodes){const id=key.slice(1);n.checked=new RegExp('id="'+id+'"[^>]*checked').test(value);
      n.value=value.match(new RegExp('id="'+id+'"[^>]*value="([^"]*)"'))?.[1]??'';}
    for(const id of ['episode-definition','episode-select','episode-stream','episode-snapshot']){const n=$('#'+id);if(n){const body=value.match(new RegExp('id="'+id+'"[^>]*>([\\s\\S]*?)</select>'))?.[1]??'';
      n.value=body.match(/value="([^"]+)" selected/)?.[1]??'';}}
  }});
  const run=fn=>{if(busy)return;busy=true;error=undefined;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeEpisodeWorkbench({document:{querySelector:$},api,run,isBusy:()=>busy,getPrincipal:()=>actor,getDetail:()=>reference?{reference}:undefined,newKey:()=> 'episode-ui-key-'+(++sequence)});ui.render();
  const choose=(id,value)=>{const n=$('#'+id);n.value=value;n.onchange();};
  const input=(id,value)=>{const n=$('#'+id);n.value=value;n.oninput?.();};
  const submit=async(kind,confirm=true)=>{$('#episode-'+kind+'-confirm').checked=confirm;$('#episode-'+kind+'-form').onsubmit({preventDefault(){}});await last;};
  return {ui,$,html:()=>html,error:()=>error,settle:()=>last,actor:p=>actor=p,root:r=>reference=r,input,
    definitions:async()=>{$('#episode-definitions').onclick();await last;},definition:key=>choose('episode-definition',key),
    refresh:async()=>{$('#episode-index-refresh').onclick();await last;},episode:id=>choose('episode-select',id),
    stream:async id=>{choose('episode-stream',id);await last;},snapshot:async id=>{choose('episode-snapshot',id);await last;},
    open:async(time,confirm=true)=>{input('episode-start',time);await submit('open',confirm);},capture:confirm=>submit('capture',confirm),
    createSnapshot:async(time,confirm=true)=>{input('episode-target',time);await submit('snapshot',confirm);}};
}
