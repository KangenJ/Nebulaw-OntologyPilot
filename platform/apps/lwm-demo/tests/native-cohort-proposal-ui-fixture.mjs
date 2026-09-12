import {createNativeCohortProposal} from '../public-plus/native-cohort-proposal-ui.js';

// Controlled DOM, not a browser. Cross-layer tests supply the real HTTP gateway.
export function cohortProposalUiFixture({api,principal={id:'trainer',roles:['trainer']},root={type:'InvestigationTask',id:'task_1'}}){
  let html='',last=Promise.resolve(),busy=false,error,actor=principal,reference=root;
  const nodes=new Map(),$=s=>nodes.get(s),node=s=>{const value={};nodes.set(s,value);return value;};
  Object.defineProperty(node('#cohort-proposal'),'innerHTML',{get:()=>html,set:value=>{
    html=value;for(const key of [...nodes.keys()])if(key!=='#cohort-proposal')nodes.delete(key);
    for(const m of value.matchAll(/id="([^"]+)"/g))node('#'+m[1]);
    for(const [id,n]of nodes){n.checked=new RegExp('id="'+id.slice(1)+'"[^>]*checked').test(value);}
    for(const id of ['cohort-protocol','cohort-reserve-input']){const n=$('#'+id);if(n){const body=value.match(new RegExp('id="'+id+'"[^>]*>([\\s\\S]*?)</select>'))?.[1]??'';
      n.value=body.match(/value="([^"]+)" selected/)?.[1]??body.match(/value="([^"]*)"/)?.[1]??'';}}
  }});
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeCohortProposal({document:{querySelector:$},api,run,isBusy:()=>busy,getPrincipal:()=>actor,getDetail:()=>reference?{reference}:undefined});ui.render();
  return {ui,$,html:()=>html,error:()=>error,settle:()=>last,actor:p=>actor=p,root:r=>reference=r,
    refresh:async()=>{$('#cohort-options-refresh').onclick();await last;},choose:key=>{const n=$('#cohort-protocol');n.value=key;n.onchange();},
    select:(i,checked=true)=>{const n=$('#cohort-input-'+i);n.checked=checked;n.onchange();},
    reserve:async(id,confirm=true)=>{$('#cohort-reserve-input').value=id;$('#cohort-reserve-confirm').checked=confirm;$('#cohort-reserve-form').onsubmit({preventDefault(){}});await last;},
    propose:async(confirm=true)=>{$('#cohort-propose-confirm').checked=confirm;$('#cohort-propose-form').onsubmit({preventDefault(){}});await last;}};
}
