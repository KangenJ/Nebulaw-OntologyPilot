import {createNativeTrainingWorkbench} from '../public-plus/native-training-ui.js';

// Explicit DOM adapter, not browser acceptance. The API may be a unit double
// or the actual authenticated private control host used by integration tests.
export function trainingUiFixture({api,principal={id:'trainer',tenantId:'test',roles:['trainer']},dataset={id:'dataset-a',partition:'TRAIN',readiness:'READY'},root={type:'InvestigationTask',id:'task-a'}}){
  const nodes=new Map(),$=s=>nodes.get(s);let html='',buttons=[],last=Promise.resolve(),busy=false,error,actor=principal,data=dataset,reference=root,sequence=0;
  const container={};nodes.set('#training-workbench',container);
  Object.defineProperty(container,'innerHTML',{get:()=>html,set:value=>{
    html=value;for(const key of [...nodes.keys()])if(key!=='#training-workbench')nodes.delete(key);
    for(const m of value.matchAll(/id="([^"]+)"/g))nodes.set('#'+m[1],{});
    buttons=[...value.matchAll(/data-training-history-id="([^"]+)"/g)].map(m=>({dataset:{trainingHistoryId:m[1]}}));
    if($('#training-option'))$('#training-option').value=value.match(/value="([a-f0-9]{64})" selected/)?.[1]??'';
    if($('#training-confirm'))$('#training-confirm').checked=/id="training-confirm"[^>]*checked/.test(value);
  }});
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeTrainingWorkbench({document:{querySelector:$,querySelectorAll:selector=>selector==='[data-training-history-id]'?buttons:[]},api,run,isBusy:()=>busy,getPrincipal:()=>actor,
    getDataset:()=>data?{dataset:data,root:reference}:null,newKey:()=>`native-training-key-${++sequence}`});ui.render();
  return {ui,$,html:()=>html,error:()=>error,settle:()=>last,actor:p=>actor=p,root:r=>reference=r,dataset:d=>data=d,
    refresh:async()=>{$('#training-refresh').onclick();await last;},
    choose:key=>{$('#training-option').value=key;$('#training-option').onchange();},
    submit:async(confirm=true)=>{$('#training-confirm').checked=confirm;$('#training-submit').onsubmit({preventDefault(){}});await last;},
    readJob:async()=>{$('#training-job-refresh').onclick();await last;},
    history:async()=>{$('#training-history-refresh').onclick();await last;},
    chooseHistory:async id=>{buttons.find(b=>b.dataset.trainingHistoryId===id).onclick();await last;},
    lookup:async()=>{$('#training-lookup').onclick();await last;}};
}
