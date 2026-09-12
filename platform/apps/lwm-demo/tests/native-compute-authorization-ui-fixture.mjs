import {createNativeComputeAuthorizationWorkbench} from '../public-plus/native-compute-authorization-ui.js';

// Explicit DOM adapter; API can be recording doubles or real private HTTP.
export function computeAuthorizationUiFixture({api,principal={id:'trainer',tenantId:'test',roles:['trainer']},root={type:'InvestigationTask',id:'task-a'},bookmarkStore}={}){
 const nodes=new Map(),$=s=>nodes.get(s),saved=new Map();let html='',last=Promise.resolve(),busy=false,error,actor=principal,reference=root;
 const store=bookmarkStore??{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
 const container={};nodes.set('#compute-authorization-workbench',container);
 Object.defineProperty(container,'innerHTML',{get:()=>html,set:value=>{html=value;for(const k of [...nodes.keys()])if(k!=='#compute-authorization-workbench')nodes.delete(k);
  for(const m of value.matchAll(/id="([^"]+)"/g))nodes.set('#'+m[1],{});
  for(const m of value.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g))$('#'+m[1]).value=m[2].match(/value="([^"]*)" selected/)?.[1]??m[2].match(/value="([^"]*)"/)?.[1]??'';
 }});
 const run=fn=>{if(busy)return;busy=true;error=undefined;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
 const ui=createNativeComputeAuthorizationWorkbench({document:{querySelector:$},api,run,isBusy:()=>busy,getPrincipal:()=>actor,getDetail:()=>reference?{reference}:null,bookmarkStore:store});ui.render();
 const click=async id=>{$(id)?.onclick?.();await last;};
 const change=(id,value)=>{$(id).value=value;$(id).onchange();};
 return {ui,$,store,html:()=>html,error:()=>error,settle:()=>last,actor:p=>actor=p,root:r=>reference=r,
  purposes:()=>click('#ca-refresh'),choosePurpose:k=>change('#ca-purpose',k),options:()=>click('#ca-options'),history:()=>click('#ca-history'),details:()=>click('#ca-details'),useBase:()=>click('#ca-use-base'),
  chooseDataset:(index,on=true)=>{$('#ca-dataset-'+index).checked=on;$('#ca-dataset-'+index).onchange();},chooseRecipe:hash=>change('#ca-recipe',hash),chooseRecord:id=>change('#ca-record',id),
  propose:async(confirm=true)=>{$('#ca-propose-confirm').checked=confirm;$('#ca-propose').onsubmit({preventDefault(){}});await last;},
  decide:async(decision,reason='Independent reviewed scope',confirm=true)=>{$('#ca-decision-kind').value=decision;$('#ca-reason').value=reason;$('#ca-decision-confirm').checked=confirm;$('#ca-decision').onsubmit({preventDefault(){}});await last;},
 };
}
