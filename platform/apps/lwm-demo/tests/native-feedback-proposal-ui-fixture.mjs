import {createNativeFeedbackProposal} from '../public-plus/native-feedback-proposal-ui.js';

// DOM-only adapter. Cross-layer callers supply the actual authenticated HTTP API.
export function feedbackProposalUiFixture({api,principal={id:'trainer',roles:['trainer']},root={type:'Machine',id:'machine_1'}}){
  let html='',last=Promise.resolve(),busy=false,error,actor=principal,reference=root;
  const nodes=new Map(),$=s=>nodes.get(s),node=s=>{const v={};nodes.set(s,v);return v;};
  Object.defineProperty(node('#feedback-proposal'),'innerHTML',{get:()=>html,set:value=>{
    html=value;for(const k of [...nodes.keys()])if(k!=='#feedback-proposal')nodes.delete(k);
    for(const m of value.matchAll(/id="([^"]+)"/g))node('#'+m[1]);
    for(const name of ['feedback-input','feedback-label','feedback-event']){const select=$('#'+name);if(select){
      const body=value.match(new RegExp('id="'+name+'"[^>]*>([\\s\\S]*?)</select>'))?.[1]??'';select.value=body.match(/value="([^"]+)" selected/)?.[1]??'';
    }}
    for(const name of ['feedback-reserve-confirm','feedback-propose-confirm'])if($('#'+name))$('#'+name).checked=new RegExp('id="'+name+'"[^>]*checked').test(value);
  }});
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeFeedbackProposal({document:{querySelector:$},api,run,isBusy:()=>busy,getPrincipal:()=>actor,getDetail:()=>reference?{reference}:undefined});ui.render();
  const choose=(input,label,event)=>{for(const [name,id]of [['feedback-input',input],['feedback-label',label],['feedback-event',event]]){const n=$('#'+name);n.value=id;n.onchange();}};
  return {ui,$,html:()=>html,error:()=>error,settle:()=>last,actor:p=>actor=p,root:r=>reference=r,choose,
    refresh:async()=>{$('#feedback-options-refresh').onclick();await last;},preview:async()=>{$('#feedback-preview').onclick();await last;},
    reserve:async(confirm=true)=>{$('#feedback-reserve-confirm').checked=confirm;$('#feedback-reserve-form').onsubmit({preventDefault(){}});await last;},
    propose:async(confirm=true)=>{$('#feedback-propose-confirm').checked=confirm;$('#feedback-propose-form').onsubmit({preventDefault(){}});await last;}};
}
