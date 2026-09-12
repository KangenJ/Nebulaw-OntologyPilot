import {createNativeDatasetWorkbench} from '../public-plus/native-dataset-ui.js';

// DOM-only adapter, not browser acceptance. API can be a declared unit double
// or the actual authenticated HTTP service used by the cross-layer tests.
export function datasetUiFixture({api,principal={id:'reviewer',roles:['data_reviewer']},root={type:'Machine',id:'machine_1'}}){
  let html='',buttons=[],frozenButtons=[],last=Promise.resolve(),busy=false,error,actor=principal,reference=root;
  const nodes=new Map(),$=s=>nodes.get(s),node=s=>{const v={};nodes.set(s,v);return v;};
  Object.defineProperty(node('#dataset-workbench'),'innerHTML',{get:()=>html,set:value=>{
    html=value;for(const k of [...nodes.keys()])if(k!=='#dataset-workbench')nodes.delete(k);
    for(const m of value.matchAll(/id="([^"]+)"/g))node('#'+m[1]);
    buttons=[...value.matchAll(/data-cohort-id="([^"]+)"/g)].map(m=>({dataset:{cohortId:m[1]}}));
    frozenButtons=[...value.matchAll(/data-frozen-dataset-id="([^"]+)"/g)].map(m=>({dataset:{frozenDatasetId:m[1]}}));
    if($('#cohort-review-form')){
      $('#cohort-decision').value=value.includes('value="APPROVE" selected')?'APPROVE':'REJECT';
      $('#cohort-reason').value=value.match(/id="cohort-reason"[^>]*>([^<]*)</)?.[1]??'';
      $('#cohort-confirm').checked=/id="cohort-confirm"[^>]*checked/.test(value);
    }
    if($('#dataset-freeze-confirm'))$('#dataset-freeze-confirm').checked=/id="dataset-freeze-confirm"[^>]*checked/.test(value);
  }});
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeDatasetWorkbench({document:{querySelector:$,querySelectorAll:s=>s==='[data-cohort-id]'?buttons:s==='[data-frozen-dataset-id]'?frozenButtons:[]},api,run,isBusy:()=>busy,
    getPrincipal:()=>actor,getDetail:()=>reference?{reference}:undefined});ui.render();
  return {ui,$,html:()=>html,error:()=>error,settle:()=>last,actor:p=>actor=p,root:r=>reference=r,
    refresh:async()=>{$('#cohorts-refresh').onclick();await last;},choose:async id=>{buttons.find(b=>b.dataset.cohortId===id).onclick();await last;},
    history:async()=>{$('#datasets-history-refresh').onclick();await last;},chooseFrozen:id=>{frozenButtons.find(b=>b.dataset.frozenDatasetId===id).onclick();},
    review:async(decision='APPROVE',reason='Independent prospective membership',confirm=true)=>{
      $('#cohort-decision').value=decision;$('#cohort-reason').value=reason;$('#cohort-confirm').checked=confirm;$('#cohort-review-form').onsubmit({preventDefault(){}});await last;
    },freeze:async(confirm=true)=>{$('#dataset-freeze-confirm').checked=confirm;$('#dataset-freeze-form').onsubmit({preventDefault(){}});await last;},
    inspect:async()=>{$('#dataset-inspect').onclick();await last;}};
}
